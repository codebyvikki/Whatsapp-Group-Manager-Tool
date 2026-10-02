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
