// Минимальный collab-relay для плагина Collab Notes:
//  • POST /sessions — выдаёт docId и подписанную ссылку (HMAC),
//  • WS /ws/<docId>?token=... — Yjs-релей, пускает только по валидному токену.
// Переменные окружения:
//  PORT         — порт (по умолчанию 3000)
//  LINK_SECRET  — секрет для подписи ссылок (ОБЯЗАТЕЛЬНО, любая длинная строка)
//  PUBLIC_BASE  — публичный базовый URL для ссылок (например https://collab.example.com)
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setupWSConnection } = require('y-websocket/bin/utils');

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.LINK_SECRET || '';
const PUBLIC_BASE = (process.env.PUBLIC_BASE || `http://localhost:${PORT}`).replace(/\/$/, '');
if (!SECRET) { console.error('Set LINK_SECRET env var'); process.exit(1); }

const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
const sign = (docId, perm, exp) => `${perm}.${exp}.${hmac(`${docId}.${perm}.${exp}`)}`;
const verify = (docId, token) => {
  const [perm, exp, sig] = (token || '').split('.');
  if (!perm || !exp || !sig || Date.now() > Number(exp)) return false;
  const expect = hmac(`${docId}.${perm}.${exp}`);
  return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (url === '/healthz') { res.end('ok'); return; }
  if (req.method === 'POST' && url === '/sessions') {
    const docId = crypto.randomBytes(9).toString('base64url');
    const exp = Date.now() + 30 * 86400000; // 30 дней
    const token = sign(docId, 'edit', exp);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ docId, token, link: `${PUBLIC_BASE}/e/${docId}#${token}`, expiresAt: new Date(exp).toISOString() }));
    return;
  }
  res.statusCode = 404; res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/ws\/([^/]+)/);
  const docId = m ? decodeURIComponent(m[1]) : null;
  const token = u.searchParams.get('token');
  if (!docId || !verify(docId, token)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => setupWSConnection(ws, req, { docName: docId }));
});

server.listen(PORT, () => console.log(`collab relay on :${PORT} (public base ${PUBLIC_BASE})`));
