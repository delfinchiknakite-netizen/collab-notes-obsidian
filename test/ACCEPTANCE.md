# Acceptance checklist

Use disposable vaults with a backup. Do not combine Git/Obsidian Sync/other replication with Collab Notes during these tests.

## Automated checks

At repository root run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
In `server/` run `npm install`, `npm test`, `npm run build`.

The root suite exercises path exclusions, real Yjs convergence, file/config/binary synchronization, offline restart, rename/delete, binary conflicts, same-name creation, write errors and corrupt cache rejection. The server suite exercises durable accounts, atomic registration, verification, code expiry/reuse, password reset, rate limits, actual HTTP/WebSocket roles, namespace isolation, malformed tokens and account persistence after process restart.

## Two-device test

1. Install the exact same built plugin on desktop and phone. Confirm manifest 1.0.4 and record the artifact hash; version alone is insufficient when release assets are replaced under the same version.
2. Register a test account, verify email, log in. Confirm no files upload before enabling sync and confirming the connection dialog.
3. Use a populated test vault on desktop and an empty vault on phone. Enable sync for the same account. Compare file bytes, folders and note content.
4. Add/edit/rename/delete a note, picture, PDF, Canvas and Base from each side. Confirm deletions are recoverable from trash. Test a folder rename and a same-name collision.
5. Edit the same note concurrently online. Check names, cursors, checklists and browser preview. Both clients must converge without duplicated initial content.
6. Go offline on both devices, edit different parts of a previously synchronized note, restart Obsidian while offline, then reconnect in either order. Both changes must survive and converge. Repeat edits at the same position and check the semantic result manually.
7. Change the same image on both devices offline. Reconnect. Confirm both byte variants survive, one as a uniquely named conflict file.
8. Modify a local note before the first import from the server. Confirm a unique conflict copy preserves the original. Repeat more than once on the same day.
9. Open a reader link in the browser: no edit, task toggle or version restore may alter the server document. Import it into Obsidian: it must be an independent file with no live foreign session.
10. Share a synchronized owned note, edit it in the browser, and check that another owner device sees the same document, not a separate fork.

## Accounts and operational checks

1. Log out. Log in as another account in the same nonempty vault. Enabling sync must be rejected; use a separate empty vault. No old account-bound sessions may remain active.
2. Test wrong password, duplicate registration, malformed/expired/reused email codes and login throttling. Verify email provider errors are visible and resending works.
3. Reset the password. Old account/vault tokens must be rejected and active account sockets closed within 30 seconds. Shared guest capabilities remain valid until their own expiry.
4. Disable configuration sync, create settings and plugin files, and verify they do not upload. Enable it with consent and restart the receiving app; allowed settings/themes/plugin code should appear, but workspace files, plugin `data.json`, credentials and Collab Notes must not.
5. Test storage-full and network failures; errors must be visible and original local files remain recoverable. A large file over 20 MiB must produce a skip notification, not silently disappear.
6. In a staging deployment, restart application and Redis pods and verify accounts, notes, offline changes and version history. Restore an account backup and document snapshot in isolation.
7. Check Prometheus/Grafana, failed backup jobs, disk usage and errors. Test actual mobile networks and browser types; passing localhost tests is not proof of production reachability.

Do not approve primary-vault use until these manual tests and the live deployment migration have passed.
