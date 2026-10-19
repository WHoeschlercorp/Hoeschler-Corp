import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const STATUSES = [
  { key: "none",  label: "Not started",   color: "var(--st-none)" },
  { key: "work",  label: "Working on it", color: "var(--st-work)" },
  { key: "stuck", label: "Stuck",         color: "var(--st-stuck)" },
  { key: "done",  label: "Done",          color: "var(--st-done)" },
];
const PRIORITIES = [
  { key: "low",  label: "Low",      color: "var(--pr-low)" },
  { key: "med",  label: "Medium",   color: "var(--pr-med)" },
  { key: "high", label: "High",     color: "var(--pr-high)" },
  { key: "crit", label: "Critical", color: "var(--pr-crit)" },
];
const GROUP_COLORS = ["#3b4cca", "#2f9e6a", "#d9434f", "#e6a118", "#8a4fc4", "#1f8fb3", "#c2570c"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const st = k => STATUSES.find(s => s.key === k) || STATUSES[0];
const pr = k => PRIORITIES.find(p => p.key === k);

/* ---------- Dates (whole days, counted from 1970-01-01) ---------- */
const DAY = 86400000;
const toDay = s => s ? Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY) : null;
const fromDay = n => new Date(n * DAY).toISOString().slice(0, 10);
const monthStart = (y, m) => Math.floor(Date.UTC(y, m, 1) / DAY);
const todayN = () => { const d = new Date(); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
const fmtShort = n => new Date(n * DAY).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const fmtLong = n => new Date(n * DAY).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const span = it => {
  let s = toDay(it.start || it.due), d = toDay(it.due || it.start);
  if (s == null) return null;
  return { s, d: Math.max(s, d) };
};

/* ---------- Dependency scheduling ----------
   A task can wait on other tasks. It can't start until each of those has finished.
   A task that isn't done by its due date is treated as finishing today, so whatever
   waits on it slides later, day by day, until it is marked Done. Tasks only ever
   move later automatically; nothing is pulled earlier. */
function computeSchedule(items, today) {
  const memo = {}, visiting = new Set(), changes = {};
  // Ignore any link that loops back on itself, so a loop can't push tasks later forever.
  const reaches = (a, b, seen = new Set()) => {
    if (seen.has(a)) return false; seen.add(a);
    return (items[a]?.dependsOn || []).some(p => p === b || reaches(p, b, seen));
  };
  function calc(id) {
    if (memo[id]) return memo[id];
    const it = items[id], sp = span(it);
    if (!sp) return (memo[id] = null);
    let { s, d } = sp;
    visiting.add(id);
    let earliest = null;
    for (const p of it.dependsOn || []) {
      if (!items[p] || visiting.has(p) || reaches(p, id)) continue;
      const r = calc(p);
      if (r && (earliest == null || r.finish + 1 > earliest)) earliest = r.finish + 1;
    }
    visiting.delete(id);
    if (it.status !== "done" && earliest != null && s < earliest) {
      const len = d - s; s = earliest; d = s + len;
    }
    const finish = it.status !== "done" && d < today ? today : d;
    return (memo[id] = { s, d, finish });
  }
  for (const id of Object.keys(items)) {
    const r = calc(id), sp = span(items[id]);
    if (r && sp && (r.s !== sp.s || r.d !== sp.d)) changes[id] = { start: fromDay(r.s), due: fromDay(r.d) };
  }
  return changes;
}

/* ---------- State ---------- */
const now = new Date();
const state = {
  groups: {}, items: {}, view: "table", q: "", collapsed: {}, hidden: {}, openId: null, loaded: false, dragging: false,
  tl: { zoom: "year", y: now.getFullYear(), m: now.getMonth() },
  cal: { mode: "month", y: now.getFullYear(), m: now.getMonth() },
};
let fs = null, pendingRender = false, tlScroll = null;

const load = (k, f) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
state.view = load("wb.view2", "table");
state.collapsed = load("wb.collapsed", {});
state.hidden = load("wb.hidden", {});
state.tl.zoom = load("wb.tlzoom", "year");

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
const svgEl = (tag, attrs = {}) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600);
}

/* ---------- Data writes (local first, then database) ---------- */
async function write(path, data, mode = "update", quiet = false) {
  const [col, id] = path.split("/");
  if (mode === "delete") delete state[col][id];
  else state[col][id] = { ...(mode === "set" ? {} : state[col][id]), ...data };
  render();
  if (!fs) return;
  try {
    const ref = doc(fs, col, id);
    if (mode === "delete") await deleteDoc(ref);
    else if (mode === "set") await setDoc(ref, data);
    else await updateDoc(ref, data);
  } catch (e) {
    if (!quiet) toast(e && e.code === "permission-denied" ? "Your account doesn't have access to change this board." : "Couldn't save that change. Try again.");
  }
}
const updateItem = (id, data, quiet) => write("items/" + id, { ...data, updatedAt: Date.now() }, "update", quiet);

let schedTimer;
function scheduleSoon() { clearTimeout(schedTimer); schedTimer = setTimeout(reschedule, 250); }
function reschedule() {
  if (!state.loaded) return;
  const changes = computeSchedule(state.items, todayN());
  const n = Object.keys(changes).length;
  for (const [id, v] of Object.entries(changes)) updateItem(id, v, true);
  return n;
}

// Dates typed or dragged by a person become the new plan (the baseline we measure delays from).
function setDates(id, start, due) {
  let s = start || "", d = due || "";
  if (s && d && s > d) d = s;
  if (s && !d) d = s;
  updateItem(id, { start: s, due: d, baselineDue: d });
  scheduleSoon();
}
const slipDays = it => (it.due && it.baselineDue && it.due > it.baselineDue) ? toDay(it.due) - toDay(it.baselineDue) : 0;
const isOverdue = it => it.due && it.status !== "done" && toDay(it.due) < todayN();

function sortedGroups() { return Object.entries(state.groups).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0)); }
function visibleGroups() { return sortedGroups().filter(([gid]) => !state.hidden[gid]); }
function itemsIn(gid) {
  return Object.entries(state.items).filter(([, it]) => it.groupId === gid).sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0));
}
function matches(it) {
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return (it.name || "").toLowerCase().includes(q) || (it.owner || "").toLowerCase().includes(q)
    || subs(it).some(x => (x.name || "").toLowerCase().includes(q) || (x.owner || "").toLowerCase().includes(q));
}

/* ---------- Subtasks (kept inside their task) ---------- */
const subs = it => Array.isArray(it.subtasks) ? it.subtasks : [];
const setSubs = (id, list) => updateItem(id, { subtasks: list });
const addSub = (id, name) => setSubs(id, [...subs(state.items[id]), { id: uid(), name, status: "none", owner: "", due: "" }]);
const updateSub = (id, sid, data) => setSubs(id, subs(state.items[id]).map(x => x.id === sid ? { ...x, ...data } : x));
const deleteSub = (id, sid) => setSubs(id, subs(state.items[id]).filter(x => x.id !== sid));
const subProgress = it => { const l = subs(it); return l.length ? `${l.filter(x => x.status === "done").length}/${l.length}` : ""; };
state.subOpen = load("wb.subopen", {});
const toggleSubs = id => { state.subOpen[id] = !state.subOpen[id]; if (!state.subOpen[id]) delete state.subOpen[id]; save("wb.subopen", state.subOpen); render(); };

// "Add" boxes: add the entry, then put the cursor back in the box so several can be typed in a row.
function addFromInput(input, fn) {
  const v = input.value.trim(); if (!v) return;
  input.value = ""; fn(v);
  render(true);
  document.getElementById(input.id)?.focus();
}
function visibleItems() {
  return Object.entries(state.items).filter(([, it]) => state.groups[it.groupId] && !state.hidden[it.groupId] && matches(it));
}
const groupOf = it => state.groups[it.groupId] || { name: "", color: "var(--muted)" };
const taskName = id => state.items[id]?.name || "Untitled task";

// Does task a wait on task b, directly or through other tasks?
function waitsOn(a, b, seen = new Set()) {
  if (seen.has(a)) return false; seen.add(a);
  for (const p of state.items[a]?.dependsOn || []) if (p === b || waitsOn(p, b, seen)) return true;
  return false;
}

function addGroup() {
  const id = uid();
  const n = Object.keys(state.groups).length;
  const maxOrder = Math.max(0, ...Object.values(state.groups).map(g => g.order ?? 0));
  write("groups/" + id, { name: "New project", color: GROUP_COLORS[n % GROUP_COLORS.length], order: maxOrder + 1 }, "set");
  if (state.view !== "table") setView("table");
  setTimeout(() => { const i = document.querySelector(`[data-gname="${id}"]`); if (i) { i.focus(); i.select(); } }, 30);
  return id;
}
function addItem(gid, name = "New task", extra = {}) {
  if (!gid) gid = visibleGroups()[0]?.[0] || sortedGroups()[0]?.[0] || addGroup();
  const id = uid();
  const maxOrder = Math.max(0, ...itemsIn(gid).map(([, it]) => it.order ?? 0));
  write("items/" + id, { name, groupId: gid, status: "none", priority: "", owner: "", start: "", due: "", baselineDue: "", dependsOn: [], notes: "", order: maxOrder + 1, createdAt: Date.now(), updatedAt: Date.now(), ...extra }, "set");
  return id;
}
function deleteItem(id) {
  write("items/" + id, null, "delete");
  for (const [oid, it] of Object.entries(state.items)) if ((it.dependsOn || []).includes(id)) updateItem(oid, { dependsOn: it.dependsOn.filter(x => x !== id) });
}
function deleteGroup(gid) {
  for (const [id] of itemsIn(gid)) deleteItem(id);
  write("groups/" + gid, null, "delete");
  toast("Project deleted");
}

/* ---------- Popover for status/priority ---------- */
function openMenu(anchor, options, onPick, allowClear) {
  const m = $("menu"); m.replaceChildren();
  for (const o of options) m.append(el("button", { style: `background:${o.color}`, onclick: () => { closeMenu(); onPick(o.key); } }, o.label));
  if (allowClear) m.append(el("button", { class: "clear", onclick: () => { closeMenu(); onPick(""); } }, "Clear"));
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const h = m.offsetHeight, w = m.offsetWidth;
  let top = r.bottom + 4; if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 4);
  let left = r.left + r.width / 2 - w / 2; left = Math.min(Math.max(8, left), innerWidth - w - 8);
  m.style.top = top + "px"; m.style.left = left + "px";
  setTimeout(() => m.querySelector("button")?.focus(), 0);
}
function closeMenu() { $("menu").hidden = true; }
document.addEventListener("pointerdown", e => { if (!$("menu").hidden && !$("menu").contains(e.target)) closeMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeMenu(); if (state.openId || state.teamOpen) closeDrawer(); } });
const setStatus = (id, k) => { updateItem(id, { status: k || "none" }); scheduleSoon(); };

/* ---------- Rendering ---------- */
function setView(v) { state.view = v; save("wb.view2", v); render(); }

function render(force) {
  // Don't rebuild under someone's cursor or mid-drag; redraw once they're done.
  const a = document.activeElement;
  if (state.dragging || (!force && a && a.matches && a.matches("#board input, #board textarea, #drawer input, #drawer textarea"))) { pendingRender = true; return; }
  pendingRender = false;
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", b.dataset.view === state.view);
  renderSummary(); renderFilters();
  const sc = document.querySelector(".tl-scroll");
  if (sc) tlScroll = { key: sc.dataset.key, left: sc.scrollLeft, top: sc.scrollTop };
  const b = $("board"); b.replaceChildren();
  if (!Object.keys(state.groups).length) {
    b.append(el("div", { class: "empty" },
      el("h2", {}, "No projects yet"),
      el("p", {}, "A project holds the tasks needed to finish it, like a purchase, a listing or a renovation. Create a project, then add tasks with dates, owners and the tasks they wait on."),
      el("button", { class: "btn primary", onclick: () => addGroup() }, "Create your first project")));
    return;
  }
  ({ table: renderTable, timeline: renderTimeline, calendar: renderCalendar, kanban: renderKanban }[state.view] || renderTable)(b);
  if (state.openId) renderDrawer();
  else if (state.teamOpen) renderTeam();
}
document.addEventListener("focusout", () => setTimeout(() => { if (pendingRender) render(); }, 0));

function renderSummary() {
  const all = visibleItems().map(([, i]) => i);
  const s = $("summary"); s.replaceChildren();
  s.append(el("span", {}, el("b", {}, String(all.length)), "tasks"));
  for (const x of STATUSES) {
    const n = all.filter(i => (i.status || "none") === x.key).length;
    s.append(el("span", {}, el("span", { class: "dot", style: `background:${x.color}` }), el("b", {}, String(n)), x.label.toLowerCase()));
  }
  const od = all.filter(isOverdue).length;
  if (od) s.append(el("span", { style: "color:var(--overdue)" }, el("b", { style: "color:var(--overdue)" }, String(od)), "overdue"));
  const pushed = all.filter(i => i.status !== "done" && slipDays(i) > 0).length;
  if (pushed) s.append(el("span", { style: "color:var(--overdue)" }, el("b", { style: "color:var(--overdue)" }, String(pushed)), "pushed back by delays"));
}

function renderFilters() {
  const f = $("filters"); f.replaceChildren();
  const gs = sortedGroups();
  if (gs.length < 2) return;
  f.append(el("span", { class: "lbl" }, "Projects"));
  for (const [gid, g] of gs) {
    f.append(el("button", { class: "fchip", "aria-pressed": String(!state.hidden[gid]), title: state.hidden[gid] ? "Show this project" : "Hide this project",
      onclick: () => { state.hidden[gid] = !state.hidden[gid]; if (!state.hidden[gid]) delete state.hidden[gid]; save("wb.hidden", state.hidden); render(); } },
      el("i", { style: `background:${g.color}` }), el("span", {}, g.name || "Untitled project")));
  }
  if (Object.keys(state.hidden).length) f.append(el("button", { class: "iconbtn", onclick: () => { state.hidden = {}; save("wb.hidden", {}); render(); } }, "Show all"));
}

function statusBar(items) {
  const bar = el("div", { class: "gbar", title: "Status breakdown" });
  if (!items.length) return bar;
  for (const x of STATUSES) {
    const n = items.filter(([, i]) => (i.status || "none") === x.key).length;
    if (n) bar.append(el("span", { style: `width:${n / items.length * 100}%;background:${x.color}`, title: `${x.label}: ${n}` }));
  }
  return bar;
}

function projectRange(gid) {
  let lo = null, hi = null;
  for (const [, it] of itemsIn(gid)) { const sp = span(it); if (!sp) continue; lo = lo == null ? sp.s : Math.min(lo, sp.s); hi = hi == null ? sp.d : Math.max(hi, sp.d); }
  return lo == null ? null : { s: lo, d: hi };
}

/* ----- Table ----- */
function renderTable(b) {
  for (const [gid, g] of visibleGroups()) {
    const all = itemsIn(gid);
    const items = all.filter(([, it]) => matches(it));
    if (state.q && !items.length) continue;
    const collapsed = !!state.collapsed[gid];
    const rng = projectRange(gid);
    const sec = el("section", { class: "group" + (collapsed ? " collapsed" : ""), style: `--gc:${g.color}` });
    const sw = el("span", { class: "swatches", hidden: true });
    for (const c of GROUP_COLORS) sw.append(el("button", { style: `background:${c}`, "aria-label": "Set project color", onclick: () => write("groups/" + gid, { color: c }) }));
    let armed = false;
    sec.append(el("div", { class: "ghead" },
      el("button", { class: "toggle", "aria-label": collapsed ? "Expand project" : "Collapse project", onclick: () => {
        state.collapsed[gid] = !collapsed; save("wb.collapsed", state.collapsed); render();
      } }, collapsed ? "▶" : "▼"),
      el("input", { class: "gname", value: g.name || "", "aria-label": "Project name", "data-gname": gid,
        onchange: e => write("groups/" + gid, { name: e.target.value.trim() || "Untitled project" }),
        onkeydown: e => { if (e.key === "Enter") e.target.blur(); } }),
      el("span", { class: "gcount" }, `${all.length} task${all.length === 1 ? "" : "s"}${rng ? " · " + fmtShort(rng.s) + " – " + fmtShort(rng.d) : ""}`),
      el("span", { class: "spacer" }),
      el("button", { class: "iconbtn", onclick: () => sw.hidden = !sw.hidden }, "Color"), sw,
      el("button", { class: "iconbtn", onclick: e => {
        if (!armed) { armed = true; e.target.textContent = "Click again to delete project and its tasks"; e.target.style.color = "var(--st-stuck)"; setTimeout(() => { armed = false; e.target.textContent = "Delete"; e.target.style.color = ""; }, 3000); return; }
        deleteGroup(gid);
      } }, "Delete")));

    const tbody = el("tbody");
    for (const [id, it] of items) { tbody.append(row(id, it)); if (state.subOpen[id]) tbody.append(...subRows(id, it)); }
    tbody.append(el("tr", { class: "addrow" }, el("td", { colspan: 8, class: "name" },
      el("input", { class: "cellin", id: "add-" + gid, placeholder: "+ Add task", "aria-label": "Add task to " + (g.name || "project"),
        onkeydown: e => { if (e.key === "Enter") addFromInput(e.target, v => addItem(gid, v)); },
        onblur: e => { if (e.target.value.trim()) { addItem(gid, e.target.value.trim()); e.target.value = ""; } } }))));
    sec.append(el("div", { class: "tablebox" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Task"), el("th", {}, "Owner"), el("th", { class: "c" }, "Status"), el("th", { class: "c" }, "Priority"),
        el("th", {}, "Start"), el("th", {}, "Due"), el("th", {}, "Waits on"), el("th", {}))),
      tbody)));
    sec.append(statusBar(all));
    b.append(sec);
  }
}

function subRows(id, it) {
  const enter = e => { if (e.key === "Enter") e.target.blur(); };
  const rows = subs(it).map(x => {
    const s = st(x.status), late = x.due && x.status !== "done" && toDay(x.due) < todayN();
    return el("tr", { class: "subrow" },
      el("td", { class: "name" }, el("div", { class: "namecell sub" }, el("span", { class: "subarrow" }, "↳"),
        el("input", { class: "cellin", value: x.name || "", "aria-label": "Subtask name",
          onchange: e => updateSub(id, x.id, { name: e.target.value.trim() || "Untitled subtask" }), onkeydown: enter }))),
      el("td", { class: "owner" }, el("input", { class: "cellin", value: x.owner || "", placeholder: "Unassigned", "aria-label": "Subtask owner",
        onchange: e => updateSub(id, x.id, { owner: e.target.value.trim() }), onkeydown: enter })),
      el("td", { class: "pill" }, el("button", { class: "pillbtn", style: `background:${s.color}`,
        onclick: e => openMenu(e.currentTarget, STATUSES, k => updateSub(id, x.id, { status: k || "none" })) }, s.label)),
      el("td"), el("td"),
      el("td", { class: "date" + (late ? " overdue" : "") }, el("input", { class: "cellin", type: "date", value: x.due || "", "aria-label": "Subtask due date",
        onchange: e => updateSub(id, x.id, { due: e.target.value }) })),
      el("td"),
      el("td", { class: "del" }, el("button", { class: "iconbtn delbtn", "aria-label": "Delete subtask", title: "Delete subtask",
        onclick: () => deleteSub(id, x.id) }, "✕")));
  });
  rows.push(el("tr", { class: "subrow addsub" }, el("td", { colspan: 8, class: "name" }, el("div", { class: "namecell sub" },
    el("span", { class: "subarrow" }, "↳"),
    el("input", { class: "cellin", id: "addsub-" + id, placeholder: "+ Add subtask", "aria-label": "Add subtask to " + (it.name || "task"),
      onkeydown: e => { if (e.key === "Enter") addFromInput(e.target, v => addSub(id, v)); },
      onblur: e => { if (e.target.value.trim()) { addSub(id, e.target.value.trim()); e.target.value = ""; } } })))));
  return rows;
}

function row(id, it) {
  const s = st(it.status), p = pr(it.priority), slip = slipDays(it);
  const deps = (it.dependsOn || []).filter(x => state.items[x]);
  const prog = subProgress(it), open = !!state.subOpen[id];
  return el("tr", {},
    el("td", { class: "name" }, el("div", { class: "namecell" },
      el("button", { class: "subtoggle" + (prog ? "" : " nosubs"), "aria-expanded": String(open),
        title: open ? "Hide subtasks" : prog ? "Show subtasks" : "Add subtasks", onclick: () => toggleSubs(id) }, open ? "▾" : "▸"),
      el("input", { class: "cellin", value: it.name || "", "aria-label": "Task name",
        onchange: e => updateItem(id, { name: e.target.value.trim() || "Untitled task" }),
        onkeydown: e => { if (e.key === "Enter") e.target.blur(); } }),
      prog ? el("button", { class: "subcount" + (prog.split("/")[0] === prog.split("/")[1] ? " all" : ""), title: "Subtasks done", onclick: () => toggleSubs(id) }, "☑ " + prog) : null,
      el("button", { class: "iconbtn openbtn" + (it.notes ? " has-notes" : ""), onclick: () => openDrawer(id) }, it.notes ? "Notes ●" : "Open"))),
    el("td", { class: "owner" }, el("input", { class: "cellin", value: it.owner || "", placeholder: "Unassigned", "aria-label": "Owner",
      onchange: e => updateItem(id, { owner: e.target.value.trim() }), onkeydown: e => { if (e.key === "Enter") e.target.blur(); } })),
    el("td", { class: "pill" }, el("button", { class: "pillbtn", style: `background:${s.color}`,
      onclick: e => openMenu(e.currentTarget, STATUSES, k => setStatus(id, k)) }, s.label)),
    el("td", { class: "pill" }, el("button", { class: "pillbtn" + (p ? "" : " none-pr"), style: p ? `background:${p.color}` : "",
      onclick: e => openMenu(e.currentTarget, PRIORITIES, k => updateItem(id, { priority: k }), true) }, p ? p.label : "Set priority")),
    el("td", { class: "date" }, el("input", { class: "cellin", type: "date", value: it.start || "", "aria-label": "Start date",
      onchange: e => setDates(id, e.target.value, it.due) })),
    el("td", { class: "date" + (isOverdue(it) ? " overdue" : "") }, el("div", { class: "datecell" },
      el("input", { class: "cellin", type: "date", value: it.due || "", "aria-label": "Due date", onchange: e => setDates(id, it.start, e.target.value) }),
      slip ? el("span", { class: "slip", title: `Pushed back ${slip} days from ${fmtShort(toDay(it.baselineDue))}` }, "+" + slip + "d") : null)),
    el("td", { class: "deps" }, el("button", { class: "depbtn" + (deps.length ? " has" : ""), onclick: () => openDrawer(id, true),
      title: deps.map(taskName).join(", ") || "Set tasks this waits on" },
      deps.length ? taskName(deps[0]) + (deps.length > 1 ? ` +${deps.length - 1}` : "") : "—")),
    el("td", { class: "del" }, el("button", { class: "iconbtn delbtn", "aria-label": "Delete task", title: "Delete task",
      onclick: () => { deleteItem(id); toast("Task deleted"); } }, "✕")));
}

/* ----- Timeline (Gantt) ----- */
function tlRange() {
  const z = state.tl.zoom;
  const months = z === "year" ? 12 : z === "quarter" ? 3 : 1;
  let { y, m } = state.tl;
  if (z === "year") m = 0; else if (z === "quarter") m = Math.floor(m / 3) * 3;
  const title = z === "year" ? String(y) : z === "quarter" ? `Q${m / 3 + 1} ${y}` : `${MONTHS[m]} ${y}`;
  return { y, m, months, start: monthStart(y, m), end: monthStart(y, m + months), title, ppd: z === "year" ? 3 : z === "quarter" ? 12 : 34 };
}
function shiftMonths(obj, n) { const t = obj.y * 12 + obj.m + n; obj.y = Math.floor(t / 12); obj.m = ((t % 12) + 12) % 12; }

function renderTimeline(b) {
  const R = tlRange(), today = todayN();
  const W = Math.round((R.end - R.start) * R.ppd);
  const box = el("div", { class: "viewbox" });
  const zoomBtn = (k, label) => el("button", { "aria-pressed": String(state.tl.zoom === k), onclick: () => { state.tl.zoom = k; save("wb.tlzoom", k); render(); } }, label);
  box.append(el("div", { class: "vbar" },
    el("button", { class: "btn", "aria-label": "Previous", onclick: () => { shiftMonths(state.tl, -R.months); render(); } }, "‹"),
    el("button", { class: "btn", onclick: () => { state.tl.y = now.getFullYear(); state.tl.m = new Date().getMonth(); render(); } }, "Today"),
    el("button", { class: "btn", "aria-label": "Next", onclick: () => { shiftMonths(state.tl, R.months); render(); } }, "›"),
    el("h2", {}, R.title),
    el("div", { class: "seg", role: "group", "aria-label": "Zoom" }, zoomBtn("year", "Year"), zoomBtn("quarter", "Quarter"), zoomBtn("month", "Month")),
    el("span", { class: "spacer" }),
    el("span", { class: "hint" }, "Drag a bar to move it, or its right edge to change the due date. Arrows show what each task waits on.")));

  // Rows: each visible project, then its dated tasks in start order.
  const rows = []; let undated = 0;
  for (const [gid, g] of visibleGroups()) {
    const tasks = itemsIn(gid).filter(([, it]) => matches(it));
    const dated = tasks.filter(([, it]) => span(it)).sort((a, b) => span(a[1]).s - span(b[1]).s || (a[1].order ?? 0) - (b[1].order ?? 0));
    undated += tasks.length - dated.length;
    if (state.q && !dated.length) continue;
    rows.push({ type: "proj", gid, g, rng: projectRange(gid) });
    for (const [id, it] of dated) rows.push({ type: "task", id, it, g });
  }

  const sc = el("div", { class: "tl-scroll", "data-key": state.tl.zoom + R.start });
  const inner = el("div", { class: "tl-inner" });
  const L = matchMedia("(max-width: 640px)").matches ? 140 : 240;
  inner.style.width = (L + W + 170) + "px"; // room for the labels of tasks ending near the right edge

  // Header
  const htrack = el("div", { class: "tl-track", style: `width:${W}px` });
  if (state.tl.zoom === "month") {
    for (let d = R.start; d < R.end; d++) {
      const dow = new Date(d * DAY).getUTCDay();
      htrack.append(el("div", { class: "tl-dlabel" + (dow === 0 || dow === 6 ? " we" : ""), style: `left:${(d - R.start) * R.ppd}px;width:${R.ppd}px` }, String(new Date(d * DAY).getUTCDate())));
    }
  } else {
    for (let k = 0; k < R.months; k++) {
      const a = monthStart(R.y, R.m + k), z = monthStart(R.y, R.m + k + 1);
      const label = state.tl.zoom === "year" ? MONTHS[(R.m + k) % 12].slice(0, 3) : MONTHS[(R.m + k) % 12];
      htrack.append(el("div", { class: "tl-mlabel", style: `left:${(a - R.start) * R.ppd}px;width:${(z - a) * R.ppd}px` }, label));
    }
  }
  inner.append(el("div", { class: "tl-head" }, el("div", { class: "tl-left" }, state.tl.zoom === "month" ? MONTHS[R.m] : "Project / task"), htrack));

  const body = el("div", { class: "tl-body" });
  const grid = el("div", { class: "tl-grid", style: `width:${W}px` });
  for (let d = R.start; d < R.end; d++) {
    const dt = new Date(d * DAY), x = (d - R.start) * R.ppd, dow = dt.getUTCDay();
    if (dt.getUTCDate() === 1 && d !== R.start) grid.append(el("div", { class: "ln", style: `left:${x}px` }));
    else if (state.tl.zoom === "quarter" && dow === 1) grid.append(el("div", { class: "wk", style: `left:${x}px` }));
    else if (state.tl.zoom === "month") {
      if (dow === 0 || dow === 6) grid.append(el("div", { class: "we", style: `left:${x}px;width:${R.ppd}px` }));
      else grid.append(el("div", { class: "wk", style: `left:${x}px` }));
    }
  }
  if (today >= R.start && today < R.end) grid.append(el("div", { class: "now", style: `left:${(today - R.start + .5) * R.ppd - 1}px`, title: "Today" }));
  body.append(grid);

  const rowIndex = {}, rowH = r => r.type === "proj" ? 36 : 32;
  let y = 0;
  for (const r of rows) { r.y = y; if (r.type === "task") rowIndex[r.id] = r; y += rowH(r) + 1; }

  for (const r of rows) {
    const track = el("div", { class: "tl-track", style: `width:${W}px` });
    if (r.type === "proj") {
      if (r.rng) track.append(el("div", { class: "tl-sum", style: `left:${(r.rng.s - R.start) * R.ppd}px;width:${Math.max(4, (r.rng.d - r.rng.s + 1) * R.ppd)}px` }));
      body.append(el("div", { class: "tl-row proj", style: `--gc:${r.g.color}` },
        el("div", { class: "tl-left", title: r.g.name }, el("span", { class: "nm" }, r.g.name || "Untitled project")), track));
    } else {
      const { id, it } = r, sp = span(it), slip = slipDays(it);
      const x = (sp.s - R.start) * R.ppd, w = Math.max(6, (sp.d - sp.s + 1) * R.ppd);
      const bar = el("div", { class: "bar" + (it.status === "done" ? " done" : "") + (isOverdue(it) ? " late" : ""),
        style: `left:${x}px;width:${w}px`, tabindex: "0", role: "button",
        title: `${it.name}\n${fmtShort(sp.s)} – ${fmtShort(sp.d)} · ${st(it.status).label}${slip ? `\nPushed back ${slip} days` : ""}`,
        onkeydown: e => { if (e.key === "Enter") openDrawer(id); } }, el("span", { class: "h" }));
      attachDrag(bar, id, it, R.ppd);
      const label = el("span", { class: "blabel", style: `left:${x + w + 6}px` }, it.name || "Untitled task", slip && it.status !== "done" ? el("span", { class: "slip" }, "+" + slip + "d") : null);
      track.append(bar, label);
      body.append(el("div", { class: "tl-row task", style: `--gc:${r.g.color}` },
        el("div", { class: "tl-left" }, el("span", { class: "sd", style: `background:${st(it.status).color}`, title: st(it.status).label }),
          el("button", { class: "nm", onclick: () => openDrawer(id), title: it.name }, it.name || "Untitled task")), track));
    }
  }

  // Dependency arrows: from the end of the earlier task to the start of the one that waits on it.
  const svg = svgEl("svg", { class: "tl-arrows", width: W, height: Math.max(y, 1) });
  const defs = svgEl("defs");
  for (const cls of ["", "late"]) {
    const mk = svgEl("marker", { id: "ah" + cls, class: cls, viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto" });
    mk.append(svgEl("path", { d: "M0,0 L8,4 L0,8 z" })); defs.append(mk);
  }
  svg.append(defs);
  for (const r of rows) {
    if (r.type !== "task") continue;
    for (const p of r.it.dependsOn || []) {
      const pr_ = rowIndex[p]; if (!pr_) continue;
      const a = span(pr_.it), bspan = span(r.it);
      const x1 = (a.d - R.start + 1) * R.ppd, y1 = pr_.y + 16, x2 = (bspan.s - R.start) * R.ppd - 1, y2 = r.y + 16;
      const late = isOverdue(pr_.it);
      const midx = Math.max(x1 + 5, Math.min(x2 - 5, x1 + 10));
      svg.append(svgEl("path", { d: `M${x1},${y1} H${midx} V${y2} H${x2}`, class: late ? "late" : "", "marker-end": `url(#ah${late ? "late" : ""})` }));
    }
  }
  body.append(svg);
  if (!rows.length) body.append(el("div", { class: "tl-empty" }, "No dated tasks match. Add start or due dates to tasks in the Table view and they'll appear here."));
  inner.append(body);
  sc.append(inner);
  box.append(sc);
  if (undated) box.append(el("span", { class: "hint", style: "color:var(--muted);font-size:12.5px" }, `${undated} task${undated === 1 ? "" : "s"} without dates ${undated === 1 ? "isn't" : "aren't"} shown.`));
  b.append(box);

  // Keep the scroll position across live updates; otherwise start near today.
  requestAnimationFrame(() => {
    if (tlScroll && tlScroll.key === sc.dataset.key) { sc.scrollLeft = tlScroll.left; sc.scrollTop = tlScroll.top; }
    else if (state.tl.zoom !== "year" && today >= R.start && today < R.end) sc.scrollLeft = Math.max(0, (today - R.start) * R.ppd - (sc.clientWidth - L) / 3);
  });
}

function attachDrag(bar, id, it, ppd) {
  bar.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const mode = e.target.classList.contains("h") ? "resize" : "move";
    const x0 = e.clientX, left0 = parseFloat(bar.style.left), w0 = parseFloat(bar.style.width);
    let dd = 0, moved = false;
    bar.setPointerCapture(e.pointerId); state.dragging = true;
    const mv = ev => {
      const dx = ev.clientX - x0; if (Math.abs(dx) > 3) moved = true;
      dd = Math.round(dx / ppd);
      if (mode === "move") bar.style.left = (left0 + dd * ppd) + "px";
      else bar.style.width = Math.max(ppd, w0 + dd * ppd) + "px";
    };
    const up = () => {
      bar.removeEventListener("pointermove", mv); bar.removeEventListener("pointerup", up); bar.removeEventListener("pointercancel", up);
      state.dragging = false;
      if (!moved) { render(); openDrawer(id); return; }
      const sp = span(it);
      if (dd && sp) {
        if (mode === "move") setDates(id, fromDay(sp.s + dd), fromDay(sp.d + dd));
        else setDates(id, fromDay(sp.s), fromDay(Math.max(sp.s, sp.d + dd)));
      } else render();
    };
    bar.addEventListener("pointermove", mv); bar.addEventListener("pointerup", up); bar.addEventListener("pointercancel", up);
  });
}

/* ----- Calendar ----- */
function dueMap() {
  const m = {};
  for (const [id, it] of visibleItems()) {
    const d = toDay(it.due); if (d != null) (m[d] = m[d] || []).push([id, it]);
    for (const x of subs(it)) {
      const sd = toDay(x.due);
      if (sd != null) (m[sd] = m[sd] || []).push([id, { ...x, name: "↳ " + (x.name || "Untitled subtask"), groupId: it.groupId }]);
    }
  }
  return m;
}
function renderCalendar(b) {
  const C = state.cal, today = todayN(), map = dueMap();
  const box = el("div", { class: "viewbox" });
  const step = C.mode === "year" ? 12 : 1;
  box.append(el("div", { class: "vbar" },
    el("button", { class: "btn", "aria-label": "Previous", onclick: () => { shiftMonths(C, -step); render(); } }, "‹"),
    el("button", { class: "btn", onclick: () => { C.y = now.getFullYear(); C.m = new Date().getMonth(); render(); } }, "Today"),
    el("button", { class: "btn", "aria-label": "Next", onclick: () => { shiftMonths(C, step); render(); } }, "›"),
    el("h2", {}, C.mode === "year" ? String(C.y) : `${MONTHS[C.m]} ${C.y}`),
    el("div", { class: "seg", role: "group", "aria-label": "Calendar range" },
      el("button", { "aria-pressed": String(C.mode === "month"), onclick: () => { C.mode = "month"; render(); } }, "Month"),
      el("button", { "aria-pressed": String(C.mode === "year"), onclick: () => { C.mode = "year"; render(); } }, "Year")),
    el("span", { class: "spacer" }),
    el("span", { class: "hint" }, C.mode === "year" ? "Dots are due dates, colored by project. Click a day to open that month." : "Tasks appear on their due date, colored by project.")));

  if (C.mode === "month") {
    const first = monthStart(C.y, C.m), last = monthStart(C.y, C.m + 1);
    const lead = new Date(first * DAY).getUTCDay();
    const gridStart = first - lead, cells = Math.ceil((lead + last - first) / 7) * 7;
    const g = el("div", { class: "cal-grid" });
    for (const w of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) g.append(el("div", { class: "cal-dow" }, w));
    for (let d = gridStart; d < gridStart + cells; d++) {
      const cell = el("div", { class: "cal-day" + (d < first || d >= last ? " out" : "") + (d === today ? " today" : "") },
        el("span", { class: "num" }, String(new Date(d * DAY).getUTCDate())));
      for (const [id, it] of (map[d] || []).sort((a, b) => (a[1].status === "done") - (b[1].status === "done"))) {
        const gc = groupOf(it).color;
        cell.append(el("button", { class: "chip" + (it.status === "done" ? " done" : "") + (isOverdue(it) ? " late" : ""),
          title: `${groupOf(it).name}: ${it.name} · ${st(it.status).label}`, onclick: () => openDrawer(id) },
          el("span", { class: "d", style: `background:${gc}` }), el("span", { class: "t" }, it.name || "Untitled task")));
      }
      g.append(cell);
    }
    box.append(g);
  } else {
    const yr = el("div", { class: "yr" });
    for (let m = 0; m < 12; m++) {
      const first = monthStart(C.y, m), last = monthStart(C.y, m + 1);
      let count = 0;
      const g = el("div", { class: "g" });
      for (const w of ["S", "M", "T", "W", "T", "F", "S"]) g.append(el("span", { class: "w" }, w));
      for (let k = 0; k < new Date(first * DAY).getUTCDay(); k++) g.append(el("span"));
      for (let d = first; d < last; d++) {
        const list = map[d] || []; count += list.length;
        const dots = el("span", { class: "dots" });
        const colors = [...new Set(list.map(([, it]) => groupOf(it).color))].slice(0, 3);
        for (const c of colors) dots.append(el("i", { style: `background:${c}` }));
        g.append(el("button", { class: "c" + (list.length ? " has" : "") + (d === today ? " today" : ""),
          title: list.length ? fmtLong(d) + "\n" + list.map(([, it]) => `• ${it.name} (${groupOf(it).name})`).join("\n") : fmtLong(d),
          onclick: () => { C.mode = "month"; C.m = m; render(); } },
          String(new Date(d * DAY).getUTCDate()), dots));
      }
      yr.append(el("div", { class: "mm" },
        el("div", { class: "mh" }, el("button", { onclick: () => { C.mode = "month"; C.m = m; render(); } }, MONTHS[m]),
          el("span", {}, count ? `${count} due` : "")), g));
    }
    box.append(yr);
  }
  b.append(box);
}

/* ----- Kanban ----- */
function renderKanban(b) {
  const board = el("div", { class: "kanban" });
  for (const s of STATUSES) {
    const items = visibleItems().filter(([, it]) => (it.status || "none") === s.key)
      .sort((a, b) => (a[1].due || "9999").localeCompare(b[1].due || "9999"));
    const col = el("div", { class: "col",
      ondragover: e => { e.preventDefault(); col.classList.add("over"); },
      ondragleave: () => col.classList.remove("over"),
      ondrop: e => { e.preventDefault(); col.classList.remove("over"); const id = e.dataTransfer.getData("text/plain"); if (id && state.items[id]) setStatus(id, s.key); } },
      el("div", { class: "colhead" }, el("span", { class: "bar2", style: `background:${s.color}` }), s.label, el("span", { class: "n" }, String(items.length))));
    for (const [id, it] of items) {
      const g = groupOf(it), p = pr(it.priority), slip = slipDays(it);
      col.append(el("div", { class: "card", draggable: "true", tabindex: "0", role: "button",
        ondragstart: e => e.dataTransfer.setData("text/plain", id),
        onclick: () => openDrawer(id), onkeydown: e => { if (e.key === "Enter") openDrawer(id); } },
        el("span", { class: "gtag", style: `color:${g.color}` }, g.name),
        el("span", { class: "t" }, it.name || "Untitled task"),
        el("div", { class: "meta" },
          p ? el("span", { class: "tag", style: `background:${p.color}` }, p.label) : null,
          it.owner ? el("span", {}, it.owner) : null,
          it.due ? el("span", { class: "due" + (isOverdue(it) ? " overdue" : "") }, fmtShort(toDay(it.due))) : null,
          slip && it.status !== "done" ? el("span", { class: "slip" }, "+" + slip + "d") : null,
          subProgress(it) ? el("span", { title: "Subtasks done" }, "☑ " + subProgress(it)) : null)));
    }
    board.append(col);
  }
  b.append(board);
}

/* ---------- Task drawer ---------- */
function openDrawer(id, focusDeps) {
  state.openId = id; state.teamOpen = false; $("scrim").hidden = false; $("drawer").hidden = false; renderDrawer();
  setTimeout(() => (focusDeps ? $("dAddDep") : $("dName"))?.focus(), 0);
}
function closeDrawer() { state.openId = null; state.teamOpen = false; $("scrim").hidden = true; $("drawer").hidden = true; render(); }
$("scrim").addEventListener("click", closeDrawer);

function renderDrawer() {
  const id = state.openId, it = state.items[id], d = $("drawer");
  if (!it) { state.openId = null; $("scrim").hidden = true; d.hidden = true; return; }
  const opt = (list, cur, blank) => [blank ? el("option", { value: "" }, blank) : null, ...list.map(o => el("option", { value: o.key, selected: o.key === cur }, o.label))];
  const deps = (it.dependsOn || []).filter(x => state.items[x]);
  const blocks = Object.entries(state.items).filter(([, o]) => (o.dependsOn || []).includes(id));
  const slip = slipDays(it);

  // Tasks this one could wait on: not itself, not already chosen, and not anything that already waits on it.
  const addSel = el("select", { id: "dAddDep", onchange: e => {
    if (!e.target.value) return;
    updateItem(id, { dependsOn: [...deps, e.target.value] }); scheduleSoon();
  } }, el("option", { value: "" }, "+ Add a task this waits on…"));
  for (const [gid, g] of sortedGroups()) {
    const og = el("optgroup", { label: g.name || "Untitled project" });
    for (const [oid, o] of itemsIn(gid)) if (oid !== id && !deps.includes(oid) && !waitsOn(oid, id)) og.append(el("option", { value: oid }, o.name || "Untitled task"));
    if (og.children.length) addSel.append(og);
  }

  let armed = false;
  d.replaceChildren(...[
    el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" },
      el("h2", {}, "Task details"), el("button", { class: "iconbtn", onclick: closeDrawer, "aria-label": "Close" }, "✕")),
    el("input", { id: "dName", value: it.name || "", "aria-label": "Task name", style: "font-weight:600;font-size:16px",
      onchange: e => updateItem(id, { name: e.target.value.trim() || "Untitled task" }) }),
    slip && it.status !== "done" ? el("div", { class: "slipnote" }, `Pushed back ${slip} day${slip === 1 ? "" : "s"} from the original due date of ${fmtLong(toDay(it.baselineDue))}, because a task it waits on ran late.`) : null,
    isOverdue(it) ? el("div", { class: "slipnote" }, `Overdue since ${fmtLong(toDay(it.due))}. Tasks that wait on this one move later each day until it's marked Done.`) : null,
    el("div", { class: "row" }, el("label", { for: "dGroup" }, "Project"),
      el("select", { id: "dGroup", onchange: e => updateItem(id, { groupId: e.target.value }) },
        sortedGroups().map(([gid, g]) => el("option", { value: gid, selected: gid === it.groupId }, g.name)))),
    el("div", { class: "row" }, el("label", { for: "dOwner" }, "Owner"),
      el("input", { id: "dOwner", value: it.owner || "", placeholder: "Unassigned", onchange: e => updateItem(id, { owner: e.target.value.trim() }) })),
    el("div", { class: "row" }, el("label", { for: "dStatus" }, "Status"),
      el("select", { id: "dStatus", onchange: e => setStatus(id, e.target.value) }, opt(STATUSES, it.status || "none"))),
    el("div", { class: "row" }, el("label", { for: "dPri" }, "Priority"),
      el("select", { id: "dPri", onchange: e => updateItem(id, { priority: e.target.value }) }, opt(PRIORITIES, it.priority, "None"))),
    el("div", { class: "row" }, el("label", { for: "dStart" }, "Start"),
      el("input", { id: "dStart", type: "date", value: it.start || "", onchange: e => setDates(id, e.target.value, it.due) })),
    el("div", { class: "row" }, el("label", { for: "dDue" }, "Due"),
      el("input", { id: "dDue", type: "date", value: it.due || "", onchange: e => setDates(id, it.start, e.target.value) })),
    el("div", { class: "depbox" },
      el("span", { class: "lab" }, "Waits on"),
      el("p", {}, "This task can't start until these are done. If one runs late, this task and everything after it move back automatically."),
      deps.length ? el("div", { class: "deplist" }, deps.map(p => el("span", { class: "dchip" },
        el("i", { style: `background:${groupOf(state.items[p]).color}` }), el("span", {}, taskName(p)),
        el("button", { "aria-label": "Remove", onclick: () => updateItem(id, { dependsOn: deps.filter(x => x !== p) }) }, "✕")))) : null,
      addSel,
      blocks.length ? el("p", {}, "Holding up: " + blocks.map(([, o]) => o.name).join(", ")) : null),
    el("div", { class: "depbox" },
      el("span", { class: "lab" }, "Subtasks" + (subProgress(it) ? " · " + subProgress(it) + " done" : "")),
      subs(it).map(x => el("div", { class: "subitem" },
        el("input", { type: "checkbox", checked: x.status === "done", "aria-label": "Done",
          onchange: e => updateSub(id, x.id, { status: e.target.checked ? "done" : "none" }) }),
        el("input", { class: "subname" + (x.status === "done" ? " done" : ""), value: x.name || "", "aria-label": "Subtask name",
          onchange: e => updateSub(id, x.id, { name: e.target.value.trim() || "Untitled subtask" }) }),
        el("input", { type: "date", value: x.due || "", "aria-label": "Subtask due date", onchange: e => updateSub(id, x.id, { due: e.target.value }) }),
        el("button", { class: "iconbtn", "aria-label": "Delete subtask", onclick: () => deleteSub(id, x.id) }, "✕"))),
      el("input", { id: "dAddSub", placeholder: "+ Add a subtask, then press Enter",
        onkeydown: e => { if (e.key === "Enter") addFromInput(e.target, v => addSub(id, v)); } })),
    el("label", { for: "dNotes" }, "Notes and updates"),
    el("textarea", { id: "dNotes", placeholder: "Add details, links, contacts or progress updates…", onchange: e => updateItem(id, { notes: e.target.value }) }, it.notes || ""),
    el("div", { class: "foot" },
      el("span", { class: "stamp" }, it.updatedAt ? "Updated " + new Date(it.updatedAt).toLocaleString() : ""),
      el("button", { class: "btn danger", onclick: e => {
        if (!armed) { armed = true; e.target.textContent = "Click again to delete"; return; }
        deleteItem(id); closeDrawer(); toast("Task deleted");
      } }, "Delete task"))].filter(x => x != null));
}

/* ---------- Toolbar ---------- */
for (const b of document.querySelectorAll("[data-view]")) b.onclick = () => setView(b.dataset.view);
$("search").oninput = e => { state.q = e.target.value.trim(); render(); };
$("addGroup").onclick = () => addGroup();
$("addTask").onclick = () => { const id = addItem(); openDrawer(id); };

/* ---------- Sign-in and team access ---------- */
const configured = !Object.values(firebaseConfig).some(v => String(v).includes("PASTE"));
let auth = null, me = null, unsubs = [];
state.members = {}; state.teamOpen = false;
// Who the owner is lives only in the Firebase access rules (not in this public code):
// only the owner is allowed to read settings/owner, so a successful read means "owner".
let ownerFlag = false, boardRun = 0;
const isOwner = () => ownerFlag;
async function checkOwner(run) {
  const key = "hoeschler.owner." + (me.email || "").toLowerCase();
  ownerFlag = load(key, false);
  try { await getDoc(doc(fs, "settings", "owner")); ownerFlag = true; }
  catch (e) { if (e.code === "permission-denied") ownerFlag = false; }
  if (run !== boardRun) return;
  save(key, ownerFlag);
  $("teamBtn").hidden = !ownerFlag;
  $("importBtn").hidden = !ownerFlag;
  if (ownerFlag) unsubs.push(onSnapshot(collection(fs, "members"), snap => {
    state.members = {};
    for (const d of snap.docs) state.members[d.id] = d.data();
    if (state.teamOpen) renderTeam();
  }, () => {}));
}
const siteUrl = () => location.origin + location.pathname.replace(/index\.html$/, "");

const AUTH_ERRORS = {
  "auth/invalid-credential": "That email and password don't match. Check them, or use Forgot password.",
  "auth/wrong-password": "That email and password don't match. Check them, or use Forgot password.",
  "auth/user-not-found": "There's no account with that email yet. Use Create an account.",
  "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/missing-password": "Enter your password.",
  "auth/network-request-failed": "You're offline. Connect to the internet to sign in for the first time on this device.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
};
const authMsg = e => AUTH_ERRORS[e && e.code] || "Something went wrong. Try again.";

function showApp(on) { $("app").hidden = !on; $("gate").hidden = on; }

function showGate(mode, info = {}) {
  showApp(false);
  const g = $("gateBody"); g.replaceChildren();
  const msg = el("p", { class: info.error ? "gerr" : "gok", hidden: !(info.error || info.ok) }, info.error || info.ok || "");

  if (mode === "setup") {
    g.append(el("h2", {}, "Almost ready"),
      el("p", {}, "This site still needs its Firebase settings and owner email in config.js. Ask whoever set up the site to finish that step."));
    return;
  }
  if (mode === "signin" || mode === "signup") {
    const up = mode === "signup";
    const email = el("input", { id: "gEmail", type: "email", autocomplete: "email", required: true, value: info.email || "" });
    const pass = el("input", { id: "gPass", type: "password", autocomplete: up ? "new-password" : "current-password", required: true, minlength: "6" });
    const btn = el("button", { class: "btn primary", type: "submit" }, up ? "Create account" : "Sign in");
    const form = el("form", { onsubmit: async e => {
      e.preventDefault(); btn.disabled = true; msg.hidden = true;
      try {
        if (up) {
          const cred = await createUserWithEmailAndPassword(auth, email.value.trim(), pass.value);
          await sendEmailVerification(cred.user, { url: siteUrl() });
        } else {
          await signInWithEmailAndPassword(auth, email.value.trim(), pass.value);
        }
      } catch (err) { msg.className = "gerr"; msg.textContent = authMsg(err); msg.hidden = false; btn.disabled = false; }
    } },
      el("label", { for: "gEmail" }, "Email"), email,
      el("label", { for: "gPass" }, up ? "Choose a password" : "Password"), pass,
      msg, btn);
    g.append(
      el("p", {}, up ? "Create your account with the email address the owner added to the team." : "Sign in to see the team's projects."),
      form,
      el("div", { class: "links" },
        el("button", { class: "linkbtn", type: "button", onclick: () => showGate(up ? "signin" : "signup", { email: email.value }) }, up ? "I already have an account" : "Create an account"),
        up ? null : el("button", { class: "linkbtn", type: "button", onclick: async () => {
          if (!email.value.trim()) { msg.className = "gerr"; msg.textContent = "Enter your email above first, then click Forgot password."; msg.hidden = false; return; }
          try { await sendPasswordResetEmail(auth, email.value.trim()); msg.className = "gok"; msg.textContent = `We emailed a password reset link to ${email.value.trim()}.`; }
          catch (err) { msg.className = "gerr"; msg.textContent = authMsg(err); }
          msg.hidden = false;
        } }, "Forgot password?")));
    setTimeout(() => (email.value ? pass : email).focus(), 0);
    return;
  }
  if (mode === "verify") {
    g.append(
      el("h2", {}, "Check your email"),
      el("p", {}, `We sent a confirmation link to ${me.email}. Click the link in that email, then come back here and press Continue. Check your spam folder if you don't see it.`),
      msg,
      el("button", { class: "btn primary", onclick: async () => {
        await me.reload();
        if (me.emailVerified) { await me.getIdToken(true); startBoard(); }
        else showGate("verify", { error: "Your email isn't confirmed yet. Click the link in the email first." });
      } }, "Continue"),
      el("div", { class: "links" },
        el("button", { class: "linkbtn", onclick: async () => {
          try { await sendEmailVerification(me, { url: siteUrl() }); showGate("verify", { ok: "Sent another link." }); }
          catch (err) { showGate("verify", { error: authMsg(err) }); }
        } }, "Send the email again"),
        el("button", { class: "linkbtn", onclick: () => signOut(auth) }, "Use a different account")));
    return;
  }
  if (mode === "noaccess") {
    g.append(
      el("h2", {}, "Waiting for access"),
      el("p", {}, `You're signed in as ${me.email}, but this email hasn't been added to the team yet. Ask the owner to add it under Team, then press Check again.`),
      el("button", { class: "btn primary", onclick: () => startBoard() }, "Check again"),
      el("div", { class: "links" }, el("button", { class: "linkbtn", onclick: () => signOut(auth) }, "Sign out")));
  }
}

function stopBoard() {
  for (const u of unsubs) u();
  unsubs = [];
  state.groups = {}; state.items = {}; state.members = {}; state.loaded = false;
  ownerFlag = false; boardRun++;
}

function startBoard() {
  stopBoard();
  showApp(true);
  $("signOutBtn").title = "Signed in as " + me.email;
  $("teamBtn").hidden = true;
  $("importBtn").hidden = true;
  checkOwner(++boardRun);
  render();
  const status = { groups: null, items: null };
  const showStatus = () => {
    const metas = Object.values(status).filter(Boolean);
    if (!metas.length) return;
    if (metas.some(m => m.hasPendingWrites)) $("syncState").textContent = navigator.onLine ? "Saving…" : "Offline · changes will sync when you reconnect";
    else if (!navigator.onLine || metas.some(m => m.fromCache)) $("syncState").textContent = "Offline · showing saved copy";
    else $("syncState").textContent = "Live · changes save automatically";
  };
  const listen = col => onSnapshot(collection(fs, col), { includeMetadataChanges: true }, snap => {
    const next = {};
    for (const d of snap.docs) next[d.id] = d.data();
    state[col] = next;
    status[col] = snap.metadata;
    if (col === "items") { state.loaded = true; scheduleSoon(); }
    showStatus();
    render();
  }, err => {
    if (err.code === "permission-denied") { stopBoard(); showGate("noaccess"); }
    else $("syncState").textContent = "Couldn't reach the board · retrying";
  });
  unsubs.push(listen("groups"), listen("items"));
  refreshStatus = showStatus;
}
let refreshStatus = () => {};
window.addEventListener("online", () => refreshStatus());
window.addEventListener("offline", () => refreshStatus());

/* ---------- Team (owner only) ---------- */
function openTeam() { state.openId = null; state.teamOpen = true; $("scrim").hidden = false; $("drawer").hidden = false; renderTeam(); }
function renderTeam() {
  const d = $("drawer");
  const input = el("input", { id: "tEmail", type: "email", placeholder: "teammate@example.com", autocomplete: "off" });
  const msg = el("p", { class: "gerr", hidden: true });
  const add = async e => {
    e.preventDefault();
    const em = input.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { msg.textContent = "Enter a full email address, like name@company.com."; msg.hidden = false; return; }
    try { await setDoc(doc(fs, "members", em), { addedAt: Date.now() }); toast(`Added ${em}`); }
    catch (err) { msg.textContent = "Couldn't add that person. Check that the access rules were published in Firebase."; msg.hidden = false; }
  };
  const link = el("input", { id: "tLink", readonly: true, value: siteUrl() });
  const emails = Object.keys(state.members).sort();
  d.replaceChildren(
    el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px" },
      el("h2", {}, "Team"), el("button", { class: "iconbtn", onclick: closeDrawer, "aria-label": "Close" }, "✕")),
    el("p", { style: "margin:0;color:var(--muted)" }, "Add the email address each teammate will sign in with. Then send them the link below. They choose Create an account, set their own password and confirm their email."),
    el("form", { class: "copyrow", onsubmit: add }, input, el("button", { class: "btn primary", type: "submit" }, "Add")),
    msg,
    el("span", { class: "lab" }, "Website link"),
    el("div", { class: "copyrow" }, link, el("button", { class: "btn", onclick: async () => {
      try { await navigator.clipboard.writeText(link.value); toast("Link copied"); } catch (e) { link.select(); }
    } }, "Copy")),
    el("span", { class: "lab" }, `People with access (${emails.length + 1})`),
    el("div", { class: "teamlist" },
      el("div", { class: "teamrow" }, el("span", {}, (me.email || "").toLowerCase()), el("span", { class: "who" }, "Owner (you)")),
      emails.filter(e => e !== (me.email || "").toLowerCase()).map(em => {
        let armed = false;
        return el("div", { class: "teamrow" }, el("span", {}, em), el("button", { class: "iconbtn", onclick: async ev => {
          if (!armed) { armed = true; ev.target.textContent = "Click again to remove"; ev.target.style.color = "var(--st-stuck)"; return; }
          try { await deleteDoc(doc(fs, "members", em)); toast(`Removed ${em}`); } catch (err) { toast("Couldn't remove that person. Try again."); }
        } }, "Remove"));
      })));
}

/* ---------- Backups ---------- */
function exportData() {
  const payload = { app: "Hoeschler Corp Projects", version: 1, exportedAt: new Date().toISOString(), groups: state.groups, items: state.items };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `hoeschler-projects-backup-${fromDay(todayN())}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("Backup saved to your Downloads folder");
}
async function restoreData(data) {
  const ops = [];
  for (const id of Object.keys(state.groups)) if (!data.groups[id]) ops.push(b => b.delete(doc(fs, "groups", id)));
  for (const id of Object.keys(state.items)) if (!data.items[id]) ops.push(b => b.delete(doc(fs, "items", id)));
  for (const [id, g] of Object.entries(data.groups)) ops.push(b => b.set(doc(fs, "groups", id), g));
  for (const [id, it] of Object.entries(data.items)) ops.push(b => b.set(doc(fs, "items", id), it));
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(fs);
    for (const op of ops.slice(i, i + 400)) op(b);
    await b.commit();
  }
}
function askRestore(data, fileName) {
  const n = $("notice"); n.hidden = false;
  const g = Object.keys(data.groups).length, i = Object.keys(data.items).length;
  n.replaceChildren(`Restore ${g} project${g === 1 ? "" : "s"} and ${i} task${i === 1 ? "" : "s"} from "${fileName}"? This replaces everything on the board for the whole team.`,
    el("button", { class: "btn primary", onclick: async e => {
      if (!navigator.onLine) { toast("Connect to the internet to restore a backup."); return; }
      e.target.disabled = true; e.target.textContent = "Restoring…";
      try { await restoreData(data); n.hidden = true; toast("Backup restored"); }
      catch (err) { e.target.disabled = false; e.target.textContent = "Replace with backup"; toast("Couldn't restore the backup. Try again."); }
    } }, "Replace with backup"),
    el("button", { class: "btn", onclick: () => n.hidden = true }, "Cancel"));
}

/* ---------- Toolbar wiring and startup ---------- */
$("teamBtn").onclick = openTeam;
$("exportBtn").onclick = exportData;
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || typeof data.groups !== "object" || typeof data.items !== "object") throw new Error();
    askRestore(data, f.name);
  } catch (err) { toast("That file isn't a Hoeschler Corp backup. Choose a file made with Back up."); }
};
$("signOutBtn").onclick = () => signOut(auth);
setInterval(() => { scheduleSoon(); render(); }, 60 * 60 * 1000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

if (!configured) showGate("setup");
else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  onAuthStateChanged(auth, user => {
    me = user;
    stopBoard();
    closeMenu();
    if (!user) showGate("signin");
    else if (!user.emailVerified) showGate("verify");
    else startBoard();
  });
}
