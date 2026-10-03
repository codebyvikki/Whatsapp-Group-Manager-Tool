# WhatsApp Group Manager — Multi-user

## Access model

- `PANEL_USER` / `PANEL_PASS` create the first admin automatically.
- Admin opens `/admin.html` and creates normal users.
- Normal users can only access their own saved lists and jobs.
- Normal users cannot disconnect the shared WhatsApp account.
- User passwords are stored as salted `scrypt` hashes.
- Login sessions use random HttpOnly cookies.
- Failed logins are rate limited.
- Each authenticated panel user gets their own WhatsApp socket/session, QR state and group cache.
- Adding a normal user does not reuse another user's WhatsApp account/session.
- Simultaneous invite-code requests are globally limited and duplicate requests for the same group are deduplicated.
- `MAX_WA_LINK_REQUESTS=5` controls the shared WhatsApp request concurrency.

## Local setup

```bash
npm install
```

Copy `.env.example` to `.env` and set a strong `PANEL_PASS`.

For production, set `MONGODB_URI` and keep `NODE_ENV=production`.

Then:

```bash
npm start
```

Admin:
`http://localhost:3000/admin.html`

Main app:
`http://localhost:3000/`

## Important

Do not commit `.env`, `auth/`, `users.json`, or production data.

MongoDB is strongly recommended for deployment. Local JSON fallback is intended for local development.

## Live Group Stats (`/stats.html`)

Four tabs, each with a per-group number, a search box, select boxes and downloads:

- Pending - join requests waiting for approval. Read straight from WhatsApp (exact, works from the first minute). Needs you to be admin of the group and "approve new members" to be on.
- Invite links - members who joined through an invite link (self-join, or a link request you approved).
- Total added - members added by other people. Shows who added how many, per group and across all groups.
- Total members - current size, split into: at start, +link, +added, +other, -left, -removed.

How it stays live:

- WhatsApp events (member joined/added/left/removed, join request created/rejected) are recorded as they happen and pushed to the open page (Server-Sent Events). Approve a request on your phone and the numbers move on screen.
- Pending lists are re-read from WhatsApp on connect, every 10 minutes and when you press "Refresh pending".
- If the server was offline, the difference is reconciled on the next connect (counted as "other", "left").

Honest limits:

- WhatsApp does not give history. Joins/adds from before the first start of this feature cannot be recovered; those members are counted as "At start" (baseline snapshot taken when a group is first seen).
- Keep the server running (or use MongoDB + an always-on host) so no events are missed.

Downloads (selected groups, or all if none selected): list as TXT/CSV, or "with numbers" (phone numbers, method, time, who added) as TXT/CSV.

Storage: MongoDB collection `gstats` when `MONGODB_URI` is set, otherwise `stats.json`.
Optional env: `STATS_TZ` (default `Asia/Kolkata`) for times in downloads.




======================================================
GROUP NAME MANAGER - FINAL UPDATE

Files in this update:
1. server.js
2. public/group-names.html
3. public/group-names.js

INSTALL
------
1. BACK UP your current project first.
2. Replace your current server.js with the server.js from this package.
3. Replace/add public/group-names.html.
4. Replace/add public/group-names.js.
5. Keep all other project files unchanged.
6. Start the project normally.
7. Open /group-names.html after logging in.

WORKFLOW
--------
Range:
- Enter EXISTING group prefix, e.g. My Group.
- Enter existing start/end, e.g. 1 to 10.
- Find matching groups.
- The matched groups are shown and can be individually deselected.
- Fill NEW prefix, starting number, step, separator and number format.
- Build Preview, then Rename Groups.

Select Groups:
- Search and manually select groups.
- Configure the new prefix/number settings.
- Preview and rename.

Name List:
- Select groups.
- Enter one exact new name per line.
- The number of names must exactly equal the number selected.

RELIABILITY
-----------
- Group-name updates reuse the existing WhatsApp connection.
- Rename mutations run one at a time to reduce rate-overlimit errors.
- Rate-limited renames are retried with increasing delays.
- Progress and per-group results are shown live.
- Existing target-name conflicts are rejected before the job starts.
- Existing Link Organizer, Stats and Permissions routes are retained.

OPTIONAL ENV SETTINGS
---------------------
GROUP_NAME_MAX=200
GROUP_NAME_DELAY_MS=500
GROUP_NAME_RETRIES=3

Do not delete stats.js or any other existing project file.



=============================================================
GROUP DP MANAGER
=================

Added:
- New Group DP Manager tool at /group-dp.html
- DP Add / Update and DP Remove sections
- Range Mode, Select Mode and List Mode
- Reuses the existing saved lists from Link Organizer
- JPG / PNG / WEBP upload with preview and 8 MB limit
- Bulk progress, success/failed results and retry for failed groups
- Conservative one-at-a-time WhatsApp updates with a short delay
- Dashboard card placed horizontally below Group Permissions / Group Creator and above Administration
- Same white + green dashboard/tool styling and Connected/Disconnected animated status

Backend:
- /api/group-dp/image
- /api/group-dp/apply
- /api/group-dp/remove
- /api/group-dp/job/:id
- /api/group-dp/job/:id/retry

The DP update uses the existing Baileys WhatsApp socket and requires the connected WhatsApp account to have permission to edit the selected groups.

Dependency:
- sharp is now a direct dependency in package.json. If moving this project to a new machine/server, run `npm install` before `npm start`.

=========================================
IMPORTANT - CLEAN INSTALL

This project archive intentionally does NOT include node_modules.
The previous archive contained an incomplete/corrupt MongoDB package inside node_modules, which caused:
Cannot find module './cmap/auth/mongo_credentials'

Do this after extracting:

1. Copy your existing .env file from your previous project folder into this folder.
2. Open PowerShell in this folder.
3. Run:
   npm install
4. Then run:
   npm start

OR double-click FIX-INSTALL-WINDOWS.bat. It removes any old node_modules, installs fresh dependencies, and starts the app.

Recommended Node.js: 22.x (matches package.json).
Do NOT copy the old node_modules folder into this project.




GROUP CREATOR MERGE
===================

The existing WhatsApp Group Manager project remains the base application.
The Group Creator functionality is integrated directly into server.js and
uses the currently authenticated user's existing WhatsApp socket.

Current structure:
- Group Creator backend logic/routes are already merged into server.js.
- public/group-creator.html is the Group Creator UI.
- The old standalone group-creator.js duplicate was removed because it was
  not imported or used by the running server.
- The old dashboard-group-creator-card.html snippet was removed because
  the Group Creator card is already present in public/dashboard.html.
- stats.js remains separate because Live Group Stats is an independent
  server module.
- group-names.js and permissions.js remain separate because they are the
  front-end logic modules for their respective tools.

UI update in this build:
- Group Creator Dashboard button now matches Link Organizer's Dashboard
  button styling.
- Group Creator WhatsApp status now uses the same Connected/Disconnected
  text-only status and green/red pulse-dot animation as Link Organizer.
- Connecting/QR is intentionally represented as Disconnected on this tool,
  while QR handling remains on Dashboard.

No Group Creator business logic or existing tool functionality was changed.
The clean source archive intentionally excludes .env, runtime data.json,
node_modules, and other local secrets/state. Keep your existing .env and
local runtime data separately when needed.
