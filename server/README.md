# Collab Notes — server

Minimal signed-link relay for the [Collab Notes](../) Obsidian plugin.

```bash
npm install
LINK_SECRET="<any-long-random-string>" PUBLIC_BASE="https://collab.example.com" PORT=3000 npm start
```

Docker:
```bash
docker build -t collab-server .
docker run -p 3000:3000 -e LINK_SECRET="<secret>" -e PUBLIC_BASE="https://collab.example.com" collab-server
```

Env: `LINK_SECRET` (required), `PUBLIC_BASE` (public URL for links), `PORT` (default 3000).
Put it behind HTTPS. Endpoints: `POST /sessions`, `GET /ws/<docId>?token=…`, `GET /healthz`.
