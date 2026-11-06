# Full Collab Notes server

Node.js 20+, React, Yjs/y-websocket, Redis and S3. This directory includes the same functional server used by the application, not the old minimal relay.

## Local setup

```sh
npm ci
npm run build
npm test
PORT=8080 METRICS_PORT=9091 ACCOUNT_DIR=./data PUBLIC_BASE=http://localhost:8080 npm start
```

Local development can run without Redis/S3, but documents then live only in process memory. Accounts are stored in `ACCOUNT_DIR/accounts.json`. Registration requires email delivery configuration; tests inject a local mail sink and never send real email.

## Production configuration

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production` | Rejects a signing secret shorter than 32 characters |
| `LINK_SECRET` | Persistent random signing key; supply via secret management, never commit |
| `PUBLIC_BASE` | Public browser URL for generated links |
| `PORT`, `METRICS_PORT` | HTTP and internal Prometheus ports, defaults 80 and 9091 |
| `ACCOUNT_DIR` | Persistent private account directory; mount `/data/accounts` |
| `REDIS_URL` | Private Redis endpoint, configured with AOF and a persistent volume |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | Private snapshot/history/backup bucket |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | S3 service-account credentials, injected as secrets |
| `MAIL_API_URL` | HTTPS email endpoint accepting the Resend-compatible JSON envelope |
| `MAIL_API_TOKEN`, `MAIL_FROM` | Email API credential and verified sender |
| `TRUST_PROXY=1` | Only behind a trusted ingress which appends the actual client IP to X-Forwarded-For |
| `VITE_API_BASE` | Browser build-time API origin, only necessary when static hosting and API origins differ |

Email payload: `{from,to:[email],subject,text}` with `Authorization: Bearer ...`. Use a compatible provider or a controlled adapter. Codes are random, stored only as hashes and expire after one hour. Verification and reset codes are single-use. Password reset increments the account credential epoch, invalidating existing account and account-vault tokens; active sockets are rechecked within 30 seconds.

Limits apply to login IP and email, registration, sending codes and consuming codes. They are local to one process and reset on restart. Run one replica; an external ingress/WAF limiter is recommended as an additional layer. API errors never return passwords, codes or internal storage errors.

Use HTTPS/WSS. Do not expose Redis or the metrics port publicly. Disable token-bearing query strings in proxy/access logs. The account API uses Authorization headers; legacy share links and WebSocket clients still use bearer capabilities in URLs.

## Docker

```sh
docker build --build-arg VITE_API_BASE=https://api.example.com -t collab-server:2.6.0 .
```

If browser and API use one origin, omit the build argument. Supply runtime variables using your secret manager. Mount a persistent volume at `/data`, set `ACCOUNT_DIR=/data/accounts`, and put the container behind TLS. The image does not contain account data or local `.env` files; `.dockerignore` excludes them.

For the existing YC split deployment use browser origin `https://collab.av-tarasov.ru` and build-time API origin `https://rt.av-tarasov.ru`. Obsidian must use the latter.

## Persistence and backups

- Accounts: serialized transactions, temp-file write, fsync, atomic rename and directory fsync. Passwords are salted scrypt hashes. One process owns the account file.
- Redis: durable current CRDT checkpoints plus compatibility reads of old update logs. Configure AOF, `appendfsync always`, persistent storage and `noeviction`. Write failures are logged, not silently discarded.
- S3: current document snapshots on disconnect and version snapshots on disconnect/each 15 minutes if changed. Change detection hashes the complete Yjs update, including deletions. Up to 30 history entries per document.
- Account backup: `node backup.mjs` uploads an account snapshot to private S3 under `account-backups/`. Schedule every six hours. Never expose this prefix; it contains email addresses and password hashes.

Back up the signing key independently in your secret manager. Without the same key, previously issued capabilities stop working. Account backup alone does not back up notes. Protect Redis/PVC and S3 snapshots, and test restoration in isolation.

Restore accounts with the server stopped: copy a selected private account backup into `ACCOUNT_DIR/accounts.json`, restrict permissions, restart one server replica and test login. Restoring an older account backup can restore an older credential epoch; rotate `LINK_SECRET` if revocation must remain absolute after disaster recovery. Backup retention and bucket lifecycle must be configured by the operator.

## Safe upgrade from the Redis-only account implementation

Do not restart the old Redis before migration: it had no persistent volume.

1. Back up the existing Redis state, S3 objects and signing key using approved operator tooling. Keep the old Redis running.
2. Provision the account PVC. Deploy the new application with `ACCOUNT_DIR` on that volume and the existing `REDIS_URL`. Keep one replica and use Recreate rollout strategy for the file store.
3. At startup the server migrates every legacy `user:*` record into the durable account file before accepting traffic. The log reports only the migrated count, never account contents. Existing accounts are unverified until they confirm email. Configure mail before inviting users to log in.
4. Verify the migration count, account-file backup, email delivery, login and unchanged vault IDs. Old account-bound vault keys are rejected; users log in again to get epoch-bound credentials. Keep a rollback copy of the original Redis state.
5. Only then migrate Redis to its persistent AOF volume. Restore the old Redis state, including note updates, to the new instance before switching traffic. Do not blindly apply the new Redis deployment over the only live in-memory copy.
6. Enable the account backup job and test restoration in a separate environment. Apply the restrictive ingress policies only after verifying namespace labels and monitoring routes.

The Kubernetes templates in the application repository are prepared configuration, not evidence that this migration has run. Do not apply all templates in a single command against an old deployment.

Copies are included in [deploy/](deploy/). The current deployment uses `shared-storage.yaml` and an existing TGVault disk, not newly provisioned storage. `k8s.yaml` and `account-backup.yaml` mount only `collab-notes/redis` and `collab-notes/app` through the `collab-shared` claim. Historical TGVault files remain outside these directories. Both the original PV and the static alias must retain the disk (`Retain`); never delete the original TGVault disk or run the two applications against the same data directories. The alias is bound to this installation's disk ID and zone: replace those values for another installation. Do not mount this disk from another node concurrently.

`shared-storage-migrate.yaml` is a one-time, offline copy from the former SSD claims. Stop both application and Redis before running it. It refuses an existing destination, verifies copied file hashes and atomically installs the separate directory. Keep source claims until service and persistence checks pass. `storage.yaml` is only an optional provisioning alternative that creates paid SSDs; it is not part of the current deployment and its claim names do not match the shared-storage configuration.

Supply the image you actually built, verify ingress/monitoring namespace labels, and provision runtime secrets separately. The templates reference secret names, never secret values. New installations also need TLS ingress and DNS configured for their own domain. The account backup CronJob writes to the existing private S3 bucket; those objects and requests still have usage-based costs. Reusing a disk does not establish a monthly cloud bill guarantee.

## API

- `GET /healthz`, `GET /capabilities`
- `POST /auth/register`, `/auth/login`, `/auth/resend-verification`, `/auth/verify`
- `POST /auth/forgot-password`, `/auth/reset-password`
- `GET /auth/me` with `Authorization: Bearer <account-session>`
- `POST /sessions`, `POST /vault` for legacy standalone/key-based sharing
- `POST /access/<docId>` and `GET /viewlink/<docId>` with an authorized capability
- `GET /versions/<docId>[/<timestamp>]` with a capability
- WebSocket `/ws/<docId>?token=...`

The browser remains a guest link client. An account-vault token is scoped to that account's namespace; it cannot read a different namespace. Viewer clients are blocked from sending Yjs document writes server-side, even if they modify their UI.
