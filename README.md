# Hoeschler Corp Projects

The Hoeschler Corp team's project board: projects and tasks with owners, statuses,
priorities, start and due dates, and tasks that wait on other tasks. It has Table,
Timeline, Calendar and Kanban views. When a task runs past its due date, every task
that waits on it moves back automatically.

- **Website:** https://whoeschlercorp.github.io/Hoeschler-Corp/
- **Data and sign-in:** Google Firebase (Authentication + Cloud Firestore)
- **Works offline:** the site and the board are saved on each device and sync when the connection returns.

## Files

| File | What it is |
|---|---|
| `index.html` | The page and its styles |
| `app.js` | The board, sign-in and team management |
| `config.js` | Firebase settings and the owner's email |
| `firestore.rules` | Who can read and change data (pasted into Firebase) |
| `sw.js` | Keeps the site available offline |
| `manifest.webmanifest`, `icon*` | App name and icon when installed |

## One-time setup

1. **Firebase settings:** fill in `config.js` with the values from Firebase console →
   Project settings → Your apps, and set `OWNER_EMAIL`.
2. **Access rules:** in Firebase console → Firestore Database → Rules, paste the contents of
   `firestore.rules`, replace `OWNER_EMAIL_HERE` with the owner's email in lowercase, and click **Publish**.
3. **Sign-in domain:** in Firebase console → Authentication → Settings → Authorized domains,
   add `whoeschlercorp.github.io`.
4. **Hosting:** in GitHub → Settings → Pages, set Source to *Deploy from a branch* and pick
   the branch that holds these files, folder `/ (root)`.

## Adding a teammate

1. The owner signs in and clicks **Team**, then adds the teammate's email.
2. Send them the website link. They click **Create an account**, choose a password and
   click the confirmation link in their email.

## Installing on a Mac

- **Safari:** open the website, then File → Add to Dock.
- **Chrome:** open the website, then click the install icon in the address bar.
