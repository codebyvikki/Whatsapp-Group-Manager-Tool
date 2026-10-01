# Group Link Organizer — Multi-user

## Access model

- `PANEL_USER` / `PANEL_PASS` create the first admin automatically.
- Admin opens `/admin.html` and creates normal users.
- Normal users can only access their own saved lists and jobs.
- Normal users cannot disconnect the shared WhatsApp account.
- User passwords are stored as salted `scrypt` hashes.
- Login sessions use random HttpOnly cookies.
- Failed logins are rate limited.
- The WhatsApp socket remains shared, so adding users does not create extra WhatsApp connections.
- Invite-code cache and group cache remain shared for performance.
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
