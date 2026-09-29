# Collab Notes

Real-time collaborative markdown editing in Obsidian with **live participant cursors** — like Google Docs, but for your notes. Powered by a CRDT (Yjs) over a self-hosted service, so two or more people can edit the same note simultaneously and see each other's carets and selections.

Works on **desktop and mobile**.

---

## Features

- **Real-time editing + cursors** — see other participants' carets and selections with their names.
- **Right-click a note** (or the “•••” menu) → **Collaborative editing** → get a link + QR to send to a partner.
- **Right-click a folder** → **Create a collaborative note from a link** (like “New Kanban board”).
- Your partner opens the link in a browser **or** adds the note to their own Obsidian with this plugin.
- **Sessions survive restarts**: list of shared notes, auto-reconnect, detach a note.
- Access to a shared note is **only via the signed link**.

## Network use (disclosure)

This plugin is a client for a **collaborative-editing server** and therefore uses the network:

- **HTTPS** `POST /sessions` to create a session and get a shareable link.
- **WebSocket** to sync document edits and cursor presence in real time.

The server URL is configurable in settings (**Settings → Collab Notes → Service URL**). The default points to the author's public demo service. No analytics or telemetry is sent; only the note content you choose to share is transmitted, and only to the configured server. Point it at your own self-hosted instance if you prefer.

## How it works

- **[Yjs](https://github.com/yjs/yjs)** (CRDT) — edits merge without conflicts; the server is a thin relay.
- **CodeMirror 6** (the same editor Obsidian uses) + `y-codemirror.next` renders remote cursors out of the box.
- Access is a capability token embedded in the link (HMAC), verified by the server on WebSocket upgrade.
- The plugin attaches `yCollab` to the active editor via a CM6 `Compartment`, only after the initial sync (to avoid duplicating text).

## Installation

### Community plugins
Once approved: Settings → Community plugins → Browse → search **Collab Notes** → Install → Enable.

### Beta via BRAT
Install **BRAT**, then *Add a beta plugin* with:
```
https://github.com/delfinchiknakite-netizen/collab-notes-obsidian
```

## Usage

1. Open a note → **right-click** (or the “•••” menu) → **Collaborative editing**.
2. Copy the link / show the QR → send it to a partner.
3. Partner opens the link in a browser, or adds it to their Obsidian: command **Add a collaborative note by link**, or **right-click a folder → Create a collaborative note from a link**.
4. Manage: right-clicking an already-shared note shows a management form (copy link / detach). List everything with the command **Show collaborative notes**.

## Settings

- **Service URL** — address of the collab service (default: the author's demo).
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

Совместное редактирование markdown-заметок в Obsidian в реальном времени с **живыми курсорами участников** — как в Google Docs. Правый клик по заметке → «Совместное редактирование» → отправь ссылку партнёру. ПКМ по папке → «Создать совместную заметку из ссылки». Работает на десктопе и телефоне. Сетевой доступ: HTTPS `POST /sessions` + WebSocket для синхронизации; адрес сервиса настраивается (Settings → Collab Notes).
