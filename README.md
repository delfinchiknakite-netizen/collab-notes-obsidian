# Collab Notes

Real-time collaborative markdown editing in Obsidian with **live participant cursors** — like Google Docs, but for your notes. Powered by a CRDT (Yjs) over a self-hosted service, so two or more people can edit the same note simultaneously and see each other's carets and selections.

Works on **desktop and mobile**.

> **This plugin has no default/bundled server.** You run your own collab server (a small Node service, included in [`server/`](server/)) and point the plugin at it. Nothing is sent anywhere until you configure a server URL.

---

## Features

- **Real-time editing + cursors** — see other participants' carets and selections with their names.
- **Right-click a note** (or the “•••” menu) → **Collaborative editing** → get a link + QR to send to a partner.
- **Right-click a folder** → **Create a collaborative note from a link** (like “New Kanban board”).
- Your partner adds the note to their own Obsidian with this plugin (or opens the link in a browser, if you also host the browser client).
- **Sessions survive restarts**: list of shared notes, auto-reconnect, detach a note.
- Access to a shared note is **only via the signed link**.

## Setup

### 1. Run the server
The plugin needs a collab server. A minimal one is in [`server/`](server/):

```bash
cd server
npm install
LINK_SECRET="<any-long-random-string>" \
PUBLIC_BASE="https://collab.example.com" \
PORT=3000 \
npm start
```

Or with Docker:
```bash
cd server
docker build -t collab-server .
docker run -p 3000:3000 \
  -e LINK_SECRET="<any-long-random-string>" \
  -e PUBLIC_BASE="https://collab.example.com" \
  collab-server
```

Environment variables:
- `LINK_SECRET` — **required**. Secret used to sign share links (any long random string). Keep it private.
- `PUBLIC_BASE` — public base URL that share links use (e.g. `https://collab.example.com`). Defaults to `http://localhost:PORT`.
- `PORT` — port to listen on (default `3000`).

Put the server behind HTTPS (a reverse proxy such as Caddy/nginx/Traefik) so links work in mobile and in-app browsers. The endpoints it exposes:
- `POST /sessions` → creates a session, returns `{ docId, token, link }`.
- `GET /ws/<docId>?token=…` → Yjs WebSocket relay (rejects invalid/expired tokens).
- `GET /healthz` → `ok`.

### 2. Point the plugin at your server
Settings → **Collab Notes** → **Service URL** = your server's public URL (e.g. `https://collab.example.com`). Set **Your name** too. Done — now you can share notes.

## Network use (disclosure)

This plugin only talks to **the server you configure** (there is no default). It uses the network for:
- **HTTPS** `POST /sessions` to create a session and get a shareable link.
- **WebSocket** to sync document edits and cursor presence in real time.

No analytics or telemetry. Only the note content you explicitly share is transmitted, and only to your configured server.

## How it works

- **[Yjs](https://github.com/yjs/yjs)** (CRDT) — edits merge without conflicts; the server is a thin relay.
- **CodeMirror 6** (the same editor Obsidian uses) + `y-codemirror.next` renders remote cursors out of the box.
- Access is a capability token embedded in the link (HMAC-SHA256), verified by the server on WebSocket upgrade.
- The plugin attaches `yCollab` to the active editor via a CM6 `Compartment`, only after the initial sync (to avoid duplicating text).

## Installation

### Community plugins
Once approved: Settings → Community plugins → Browse → search **Collab Notes** → Install → Enable → then do **Setup** above.

### Beta via BRAT
Install **BRAT**, then *Add a beta plugin* with:
```
https://github.com/delfinchiknakite-netizen/collab-notes-obsidian
```

## Usage

1. Open a note → **right-click** (or the “•••” menu) → **Collaborative editing**.
2. Copy the link / show the QR → send it to a partner.
3. Partner adds it to their Obsidian: command **Add a collaborative note by link**, or **right-click a folder → Create a collaborative note from a link**.
4. Manage: right-clicking an already-shared note shows a management form (copy link / detach). List everything with the command **Show collaborative notes**.

## Settings

- **Service URL** — address of your collab server (required; no default).
- **Your name** — shown at your cursor to other participants (applied live).

## Building from source

```bash
npm install
npm run build   # → main.js
```

## License

[MIT](LICENSE).

---

## По-русски

Совместное редактирование markdown-заметок в Obsidian в реальном времени с **живыми курсорами участников** — как в Google Docs. Работает на десктопе и телефоне.

**Дефолтного сервера нет** — вы разворачиваете свой (минимальный сервер лежит в [`server/`](server/)) и указываете его адрес в настройках. Настройка:
1. Запустите сервер: `cd server && npm install && LINK_SECRET="<секрет>" PUBLIC_BASE="https://collab.example.com" npm start` (или через Docker). Спрячьте за HTTPS.
2. Settings → Collab Notes → **URL сервиса** = адрес вашего сервера, задайте **имя**.
3. ПКМ по заметке → «Совместное редактирование» → отправьте ссылку. ПКМ по папке → «Создать совместную заметку из ссылки».

Переменные сервера: `LINK_SECRET` (обязательно), `PUBLIC_BASE`, `PORT`. Сетевой доступ — только к вашему серверу: `POST /sessions` (создать сессию) + WebSocket (синхронизация). Телеметрии нет.
