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
