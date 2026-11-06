# Collab Notes

Self-hosted collaborative Markdown editing and vault synchronization for Obsidian desktop and mobile. Plugin version: **1.0.5**. No default server, analytics, billing or E2E encryption.

## Features

- Shared notes with participant names, cursors and selections, using Yjs and CodeMirror 6.
- Right-click a note or use its three-dot menu to share or manage it. Right-click a folder to import a link.
- Owner, editor and viewer capabilities with expiration. Reader links open read-only in the browser; importing one into Obsidian creates an independent local copy.
- Email/password accounts, email verification, password recovery and per-account vault namespaces.
- Explicit vault connection consent. Login does not start uploading files. A nonempty vault already bound to another account/server cannot be rebound; use a separate empty local vault.
- Markdown sync with a persistent local CRDT cache for offline/restart recovery.
- Binary attachments, Canvas, Bases and other nonhidden files. Concurrent binary edits preserve both branches as separate files, rather than guessing a merge.
- Optional configuration, theme and plugin-code sync. `.git`, trash, caches, workspace state, Collab Notes itself and plugin `data.json` files are excluded. Plugin data is excluded because it can contain credentials. Installing executable plugins from another device requires trusting that device.
- Recoverable deletions, folder/file renames, unique conflict copies and visible write errors.
- Server-side version snapshots and browser version history when S3 is configured.

## Server setup

The complete server and React browser client are in [server/](server/). The former minimal in-memory relay has been replaced; it did not implement accounts, durable storage or vault sync.

See [server/README.md](server/README.md) for local setup, Docker, email delivery, persistence, backups and the upgrade procedure. Use Node.js 20 or later. For a real deployment use HTTPS/WSS, persistent account and Redis volumes, and private S3 storage.

## Connect Obsidian

1. Configure **Service URL** with the API/WebSocket origin, not a static-only CDN address. For split hosting the browser build needs its own `VITE_API_BASE`.
2. Set your display name.
3. Register with a password of at least 12 characters. Enter the verification code from your email and confirm it. Then log in.
4. Back up your local vault. Enable sync separately and confirm the displayed account and number of local files.
5. On a second device, create a separate empty local vault, install the plugin, and log in with the same account. Enable sync explicitly.
6. Configuration/theme/plugin-code synchronization is opt-in and can only be changed while sync is disabled. Restart Obsidian after receiving configuration or executable plugin changes.

The key-based flow remains available for standalone vaults. Keys and edit links are bearer capabilities: anyone holding one has its permissions. Do not post them publicly.

## Offline and conflict behavior

For previously synchronized Markdown, local Yjs state is loaded before network connection. File changes are applied to that state before exchanging updates, so offline insertions are merged instead of blindly replacing the remote text.

On first import, unrelated local content at the same path is preserved in a uniquely named conflict copy. Concurrent binary branches and independent same-name creations also retain separate copies. Deletions go to the local trash. CRDT convergence does not guarantee that simultaneous edits make semantic sense.

The local cache is stored in the plugin directory under `.collab-sync/`, scoped by server and vault ID. Do not delete or Git-sync it between devices; it is local state, not a portable backup. Do not run another file-sync tool over the same vault during testing. The cache and server content are plaintext, not E2E encrypted.

## Network and storage disclosure

Only the configured service is contacted. Explicit sharing uploads the selected note. Enabling vault sync uploads included files; this is broader than sharing one note. Configuration/plugin-code sync uploads additional files only when enabled. Registration and recovery send the email address and password or recovery code to the configured service; passwords are stored as salted scrypt hashes. Email delivery uses the administrator's configured provider.

Notes, attachments, document history, account information and local CRDT caches consume storage. Expiring a link does not delete its content. There is no automatic content TTL. The server keeps up to 30 version snapshots per document; account backups need a separate retention policy.

## Installation

BRAT repository:

```text
https://github.com/delfinchiknakite-netizen/collab-notes-obsidian
```

Version **1.0.5** publishes the current vault-sync implementation under a new version so BRAT can detect the update from 1.0.4. A local build is not a published release.

Pushing tag `1.0.5` starts the release workflow. It can also be started manually with that tag. It runs the plugin and full server tests before publication.

For official installation, use Community Plugins once the submission has been approved.

## Build and test

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` to the plugin directory of a test vault. Restart or reload the plugin. Do not overwrite `data.json`.

The automated file-sync suite uses a simulated Yjs transport and filesystem. The server suite runs real local HTTP/WebSocket clients and filesystem persistence. Neither replaces desktop/mobile acceptance testing; see [test/ACCEPTANCE.md](test/ACCEPTANCE.md).

## Current boundaries

- Maximum individual synchronized file size is 20 MiB; larger files are skipped with an error notification.
- One connection per active document; large vaults need load testing before use.
- Hidden application data outside the Obsidian configuration directory is excluded. Empty folders are recreated only when needed by a file.
- Plugin credential/settings `data.json` files and Collab Notes itself are deliberately not synchronized.
- Foreign live-shared notes and legacy standalone shared sessions remain separate from personal vault sync. An owned note shared after vault sync is enabled uses its existing vault document, not a fork. Import older standalone links explicitly on another device.
- Email delivery must be configured; registration/recovery fail explicitly if it is absent.
- Account file storage assumes one server process/replica. Do not horizontally scale it against the same JSON file.
- Existing account users must confirm email and log in again after migration. Old account-bound vault keys are invalidated.
- No E2E encryption or billing.

## License

[MIT](LICENSE).
