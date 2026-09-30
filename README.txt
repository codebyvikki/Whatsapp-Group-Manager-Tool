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
