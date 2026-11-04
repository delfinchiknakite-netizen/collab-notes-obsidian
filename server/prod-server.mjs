import http from "http";
import crypto from "crypto";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { gzipSync, brotliCompressSync, constants as zconst } from "zlib";
import { WebSocketServer } from "ws";
import { createRequire } from "module";
import client from "prom-client";
import { AccountStore, AccountError, mailSender } from "./accounts.mjs";
const require = createRequire(import.meta.url);
const Y = require("yjs");
const { setupWSConnection, setPersistence, docs, getYDoc } = require("y-websocket/bin/utils");
const documentLoads = /* @__PURE__ */ new Map();
const DIST = path.resolve("./dist");
const PORT = Number(process.env.PORT || 80);
const METRICS_PORT = Number(process.env.METRICS_PORT || 9091);
const SECRET = process.env.LINK_SECRET || "dev-secret";
if (process.env.NODE_ENV === "production" && SECRET.length < 32) throw new Error("LINK_SECRET must contain at least 32 characters");
const PUBLIC_BASE = process.env.PUBLIC_BASE || "";
const accounts = new AccountStore(process.env.ACCOUNT_DIR || "./data", mailSender());
await accounts.init();
function signAccount(user, kind, exp) {
  const sig = crypto.createHmac("sha256", SECRET).update(`${kind}.${user.userId}.${user.epoch}.${exp}`).digest("base64url");
  return `${kind}.${user.userId}.${user.epoch}.${exp}.${sig}`;
}
function verifyAccount(token, kind) {
  const p = String(token || "").split(".");
  if (p.length !== 5 || p[0] !== kind || !/^\d+$/.test(p[3]) || Number(p[3]) <= Date.now()) return null;
  const user = accounts.byId(p[1]);
  if (!user || !user.verified || String(user.epoch || 0) !== p[2]) return null;
  return timingEq(token, signAccount(accounts.public(user), kind, p[3])) ? accounts.public(user) : null;
}
function accountResponse(user) {
  return { ...user, token: signAccount(user, "account", Date.now() + 30 * 864e5), vaultToken: signAccount(user, "accountvault", Date.now() + 365 * 864e5) };
}
const ROLES = /* @__PURE__ */ new Set(["owner", "editor", "viewer"]);
const CLASSES = /* @__PURE__ */ new Set(["guest", "user"]);
const canWrite = (role) => role === "owner" || role === "editor";
const canManage = (role) => role === "owner" || role === "editor";
function sign(docId, role, cls, exp) {
  const sig = crypto.createHmac("sha256", SECRET).update(`${docId}.${role}.${cls}.${exp}`).digest("base64url");
  return `${role}.${cls}.${exp}.${sig}`;
}
function signVault(vaultId, exp) {
  const sig = crypto.createHmac("sha256", SECRET).update(`vault.${vaultId}.${exp}`).digest("base64url");
  return `vault.${vaultId}.${exp}.${sig}`;
}
function timingEq(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function verify(docId, token) {
  if (!token) return null;
  if (token.startsWith("accountvault.")) {
    const user = verifyAccount(token, "accountvault");
    return user && docId.startsWith(user.vaultId + ".") ? { role: "owner", cls: "user", userId: user.userId } : null;
  }
  const p = token.split(".");
  if (p.length === 4 && p[0] === "vault") {
    const [, vaultId, exp, sig] = p;
    if (Object.values(accounts.users).some((user) => user.vaultId === vaultId)) return null;
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(`vault.${vaultId}.${exp}`).digest("base64url");
    if (!timingEq(sig, expected)) return null;
    return docId === vaultId || docId.startsWith(vaultId + ".") ? { role: "owner", cls: "user", vault: vaultId } : null;
  }
  if (p.length === 4) {
    const [role, cls, exp, sig] = p;
    if (!ROLES.has(role) || !CLASSES.has(cls) || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(`${docId}.${role}.${cls}.${exp}`).digest("base64url");
    return timingEq(sig, expected) ? { role, cls } : null;
  }
  if (p.length === 3) {
    const [perm, exp, sig] = p;
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(`${docId}.${perm}.${exp}`).digest("base64url");
    return timingEq(sig, expected) ? { role: perm === "view" ? "viewer" : "editor", cls: "guest" } : null;
  }
  return null;
}
const readBody = (req) => new Promise((resolve, reject) => {
  let b = "", size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 16384) {
      reject(new AccountError(413, "Request too large"));
      req.resume();
    } else b += c;
  });
  req.on("end", () => resolve(b));
  req.on("error", reject);
});
const mUpdates = new client.Counter({ name: "collab_updates_total", help: "Document updates (edits) applied" });
const gDocsTotal = new client.Gauge({ name: "collab_documents_total", help: "Total documents persisted (S3 snapshots)" });
let s3 = null;
let BUCKET = null;
let redis = null;
function hashPw(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("base64");
}
function signUser(userId, exp) {
  const sig = crypto.createHmac("sha256", SECRET).update(`user.${userId}.${exp}`).digest("base64url");
  return `user.${userId}.${exp}.${sig}`;
}
function verifyUser(token) {
  const p = (token || "").split(".");
  if (p.length !== 4 || p[0] !== "user") return null;
  const [, userId, exp, sig] = p;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(`user.${userId}.${exp}`).digest("base64url");
  return timingEq(sig, expected) ? { userId } : null;
}
const YEAR = 365 * 864e5;
const MAX_VERSIONS = 30;
const cleanId = (d) => String(d).replace(/^ws\//, "");
const verPrefix = (id) => `versions/${id}/`;
const verKey = (id, ts) => `versions/${id}/${ts}.ybin`;
const tsOf = (key) => Number((String(key).split("/").pop() || "").replace(".ybin", ""));
async function listVersions(id) {
  if (!s3) return [];
  const out = [];
  let tok;
  do {
    const r = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: verPrefix(id), ContinuationToken: tok }).promise();
    for (const o of r.Contents || []) {
      const ts = tsOf(o.Key);
      if (ts) out.push({ ts, size: o.Size });
    }
    tok = r.IsTruncated ? r.NextContinuationToken : null;
  } while (tok);
  out.sort((a, b) => b.ts - a.ts);
  return out;
}
async function getVersion(id, ts) {
  if (!s3) return null;
  const o = await s3.getObject({ Bucket: BUCKET, Key: verKey(id, ts) }).promise();
  return o.Body;
}
function isWriteMessage(data) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (buf.length < 1) return true;
  if (buf[0] !== 0) return false;
  if (buf.length < 2) return true;
  return buf[1] === 1 || buf[1] === 2;
}
if (process.env.REDIS_URL || process.env.S3_BUCKET) {
  const IORedis = (await import("ioredis")).default;
  const AWS = (await import("aws-sdk")).default;
  redis = process.env.REDIS_URL ? new IORedis(process.env.REDIS_URL) : null;
  if (redis) {
    let cursor = "0", migrated = 0;
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "user:*", "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        const record = await redis.get(key);
        if (record) {
          await accounts.migrate(JSON.parse(record));
          migrated++;
        }
      }
    } while (cursor !== "0");
    console.log("Legacy accounts migration completed:", migrated);
  }
  s3 = process.env.S3_BUCKET ? new AWS.S3({
    endpoint: process.env.S3_ENDPOINT || "https://storage.yandexcloud.net",
    region: process.env.S3_REGION || "ru-central1",
    s3ForcePathStyle: true,
    signatureVersion: "v4",
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY
  }) : null;
  BUCKET = process.env.S3_BUCKET;
  const logKey = (d) => `doc:${d}:log`;
  const snapKey = (d) => `snap/${d}.ybin`;
  const pendingWrites = /* @__PURE__ */ new Map();
  const lastVer = /* @__PURE__ */ new Map();
  const versionClock = /* @__PURE__ */ new Map();
  async function saveVersion(docName, ydoc) {
    if (!s3) return;
    try {
      const id = cleanId(docName);
      const state = Buffer.from(Y.encodeStateAsUpdate(ydoc));
      const timestamp = Math.max(Date.now(), (versionClock.get(docName) || 0) + 1);
      versionClock.set(docName, timestamp);
      await s3.putObject({ Bucket: BUCKET, Key: verKey(id, timestamp), Body: state, ContentType: "application/octet-stream" }).promise();
      lastVer.set(docName, crypto.createHash("sha256").update(state).digest("base64"));
      const r = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: verPrefix(id) }).promise();
      const objs = (r.Contents || []).sort((a, b) => tsOf(a.Key) - tsOf(b.Key));
      if (objs.length > MAX_VERSIONS) {
        await s3.deleteObjects({ Bucket: BUCKET, Delete: { Objects: objs.slice(0, objs.length - MAX_VERSIONS).map((o) => ({ Key: o.Key })) } }).promise();
      }
    } catch (e) {
      console.error("Version checkpoint failed");
    }
  }
  setPersistence({
    provider: "redis-s3",
    bindState: (docName, ydoc) => {
      const loaded = (async () => {
        if (pendingWrites.has(docName)) await pendingWrites.get(docName);
        if (s3) {
          try {
            const o = await s3.getObject({ Bucket: BUCKET, Key: snapKey(docName) }).promise();
            Y.applyUpdate(ydoc, new Uint8Array(o.Body));
          } catch (e) {
            if (e.code !== "NoSuchKey" && e.code !== "NotFound") throw e;
          }
        }
        if (redis) {
          const checkpoint = await redis.getBuffer(`doc:${docName}:state`);
          if (checkpoint) Y.applyUpdate(ydoc, new Uint8Array(checkpoint));
          const log = await redis.lrangeBuffer(logKey(docName), 0, -1);
          for (const u of log) Y.applyUpdate(ydoc, new Uint8Array(u));
          ydoc.on("update", () => {
            mUpdates.inc();
            const state = Buffer.from(Y.encodeStateAsUpdate(ydoc));
            const next = (pendingWrites.get(docName) || Promise.resolve()).catch(() => {
            }).then(() => redis.set(`doc:${docName}:state`, state));
            pendingWrites.set(docName, next);
            next.catch(() => console.error("Redis checkpoint failed"));
          });
        } else {
          ydoc.on("update", () => mUpdates.inc());
        }
      })();
      documentLoads.set(docName, loaded);
      loaded.catch(() => console.error("Document storage load failed"));
      return loaded;
    },
    writeState: async (docName, ydoc) => {
      if (pendingWrites.has(docName)) await pendingWrites.get(docName);
      if (s3) {
        const snap = Buffer.from(Y.encodeStateAsUpdate(ydoc));
        await s3.putObject({ Bucket: BUCKET, Key: snapKey(docName), Body: snap, ContentType: "application/octet-stream" }).promise();
        await saveVersion(docName, ydoc);
      }
    }
  });
  console.log("persistence: Redis=" + !!redis + " S3=" + !!s3);
  if (s3) {
    const countDocs = async () => {
      try {
        let count = 0, token;
        do {
          const r = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: "snap/", ContinuationToken: token }).promise();
          count += (r.Contents || []).length;
          token = r.IsTruncated ? r.NextContinuationToken : null;
        } while (token);
        gDocsTotal.set(count);
      } catch (e) {
      }
    };
    countDocs();
    setInterval(countDocs, 6e4);
    setInterval(() => {
      for (const [name, d] of docs) {
        try {
          const h = crypto.createHash("sha256").update(Buffer.from(Y.encodeStateAsUpdate(d))).digest("base64");
          if (lastVer.get(name) !== h) saveVersion(name, d);
        } catch (e) {
        }
      }
    }, 15 * 6e4);
  }
}
client.collectDefaultMetrics({ prefix: "collab_" });
const mConn = new client.Counter({ name: "collab_connections_total", help: "WS connections opened" });
const mMsg = new client.Counter({ name: "collab_messages_total", help: "WS messages received" });
const mRejected = new client.Counter({ name: "collab_rejected_total", help: "WS connections rejected (bad token)" });
const gConns = new client.Gauge({ name: "collab_active_connections", help: "Current WS connections" });
const gDocs = new client.Gauge({ name: "collab_active_documents", help: "Documents with >=1 connection" });
const mSessions = new client.Counter({ name: "collab_sessions_created_total", help: "Sessions created" });
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon", ".png": "image/png" };
const COMPRESSIBLE = /* @__PURE__ */ new Set([".html", ".js", ".css", ".svg", ".json"]);
const staticCache = /* @__PURE__ */ new Map();
async function getStaticEntry(file) {
  let entry = staticCache.get(file);
  if (entry) return entry;
  const raw = await readFile(file);
  const ext = path.extname(file);
  const compressible = COMPRESSIBLE.has(ext) && raw.length > 1024;
  entry = {
    type: MIME[ext] || "application/octet-stream",
    raw,
    gzip: compressible ? gzipSync(raw, { level: 9 }) : null,
    br: compressible ? brotliCompressSync(raw, { params: { [zconst.BROTLI_PARAM_QUALITY]: 5 } }) : null
  };
  staticCache.set(file, entry);
  return entry;
}
async function warmStatic() {
  try {
    const files = ["index.html"];
    for (const f of await readdir(path.join(DIST, "assets")).catch(() => [])) files.push(path.join("assets", f));
    for (const f of files) {
      const p = path.join(DIST, f);
      if (existsSync(p)) await getStaticEntry(p);
    }
    console.log("static cache warmed:", staticCache.size, "files");
  } catch (e) {
    console.log("warmStatic error:", e.message);
  }
}
const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (url === "/healthz") {
    res.end("ok");
    return;
  }
  if (url === "/capabilities") {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ protocol: 2, accounts: true, verification: !!accounts.sendMail, vaultSync: true, binaryMaxBytes: 20 * 1024 * 1024, versions: !!s3 }));
    return;
  }
  if (url.startsWith("/auth/")) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    try {
      let body = {};
      if (req.method === "POST") {
        try {
          body = JSON.parse(await readBody(req));
        } catch (error) {
          if (error instanceof AccountError) throw error;
          throw new AccountError(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 JSON");
        }
      }
      const ip = process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",").at(-1).trim() : req.socket.remoteAddress || "unknown";
      if (body.email && url !== "/auth/register" && redis) {
        const email = String(body.email).trim().toLowerCase();
        if (!accounts.users[email]) {
          const legacy = await redis.get("user:" + email);
          if (legacy) await accounts.migrate(JSON.parse(legacy));
        }
      }
      let result;
      if (req.method === "POST" && url === "/auth/register") result = await accounts.register(body.email, body.password, ip);
      else if (req.method === "POST" && url === "/auth/login") {
        const email = String(body.email || "").trim().toLowerCase();
        if (!accounts.users[email] && redis) {
          const legacy = await redis.get("user:" + email);
          if (legacy) await accounts.migrate(JSON.parse(legacy));
        }
        result = accountResponse(await accounts.login(body.email, body.password, ip));
      } else if (req.method === "POST" && url === "/auth/resend-verification") result = await accounts.issue(body.email, "verify", ip);
      else if (req.method === "POST" && url === "/auth/forgot-password") result = await accounts.issue(body.email, "reset", ip);
      else if (req.method === "POST" && (url === "/auth/verify" || url === "/auth/reset-password")) {
        accounts.limit("consume:" + ip, 30);
        result = await accounts.consume(body.email, body.code, url === "/auth/verify" ? "verify" : "reset", body.password);
      } else if (req.method === "GET" && url === "/auth/me") {
        const user = verifyAccount(String(req.headers.authorization || "").replace(/^Bearer /, ""), "account");
        if (!user) throw new AccountError(401, "\u0412\u043E\u0439\u0434\u0438\u0442\u0435 \u0437\u0430\u043D\u043E\u0432\u043E");
        result = accountResponse(user);
      } else throw new AccountError(404, "Not found");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = error instanceof AccountError ? error.status : 503;
      res.end(JSON.stringify({ error: error instanceof AccountError ? error.message : "\u0425\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435 \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u043E\u0432 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E" }));
    }
    return;
  }
  if (req.method === "POST" && url === "/sessions") {
    const docId = crypto.randomBytes(9).toString("base64url");
    const exp = Date.now() + 30 * 864e5;
    const ownerToken = sign(docId, "owner", "user", exp);
    const editToken = sign(docId, "editor", "guest", exp);
    const viewToken = sign(docId, "viewer", "guest", exp);
    mSessions.inc();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      docId,
      token: editToken,
      // обратная совместимость (браузер)
      link: `${PUBLIC_BASE}/e/${docId}#${editToken}`,
      role: "editor",
      class: "guest",
      ownerToken,
      ownerLink: `${PUBLIC_BASE}/e/${docId}#${ownerToken}`,
      editToken,
      editLink: `${PUBLIC_BASE}/e/${docId}#${editToken}`,
      viewToken,
      viewLink: `${PUBLIC_BASE}/e/${docId}#${viewToken}`,
      expiresAt: new Date(exp).toISOString()
    }));
    return;
  }
  if (req.method === "POST" && url === "/vault") {
    const vaultId = crypto.randomBytes(12).toString("base64url");
    const exp = Date.now() + 365 * 864e5;
    const vaultToken = signVault(vaultId, exp);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ vaultId, vaultToken, vaultKey: `${vaultId}:${vaultToken}`, expiresAt: new Date(exp).toISOString() }));
    return;
  }
  if (req.method === "POST" && url.startsWith("/access/")) {
    const docId = decodeURIComponent(url.slice("/access/".length));
    const q = new URL(req.url, "http://x").searchParams;
    const v = verify(docId, q.get("token"));
    if (!v || !canManage(v.role)) {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
    let o = {};
    try {
      o = JSON.parse(await readBody(req) || "{}");
    } catch {
    }
    const role = o.role === "editor" ? "editor" : "viewer";
    const days = Math.min(Math.max(Number(o.days) || 30, 1), 365);
    const exp = Date.now() + days * 864e5;
    const token = sign(docId, role, "guest", exp);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ role, class: "guest", token, link: `${PUBLIC_BASE}/e/${docId}#${token}`, expiresAt: new Date(exp).toISOString() }));
    return;
  }
  if (req.method === "GET" && url.startsWith("/viewlink/")) {
    const docId = decodeURIComponent(url.slice("/viewlink/".length));
    const q = new URL(req.url, "http://x").searchParams;
    const v = verify(docId, q.get("token"));
    if (!v || !canManage(v.role)) {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
    const exp = Date.now() + 30 * 864e5;
    const viewToken = sign(docId, "viewer", "guest", exp);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ viewToken, viewLink: `${PUBLIC_BASE}/e/${docId}#${viewToken}` }));
    return;
  }
  if (req.method === "GET" && url.startsWith("/versions/")) {
    const parts = url.split("/").filter(Boolean);
    const docId = decodeURIComponent(parts[1] || "");
    const q = new URL(req.url, "http://x").searchParams;
    if (!docId || !verify(docId, q.get("token"))) {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
    try {
      if (parts.length === 2) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ versions: await listVersions(docId) }));
      } else {
        const body = await getVersion(docId, Number(parts[2]));
        if (!body) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(body);
      }
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
    return;
  }
  let file = path.join(DIST, url === "/" ? "index.html" : url);
  if (!file.startsWith(DIST) || !existsSync(file)) file = path.join(DIST, "index.html");
  try {
    const entry = await getStaticEntry(file);
    res.setHeader("Content-Type", entry.type);
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Cache-Control", url.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    const ae = req.headers["accept-encoding"] || "";
    if (entry.br && ae.includes("br")) {
      res.setHeader("Content-Encoding", "br");
      res.setHeader("Content-Length", entry.br.length);
      res.end(entry.br);
    } else if (entry.gzip && ae.includes("gzip")) {
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Length", entry.gzip.length);
      res.end(entry.gzip);
    } else {
      res.setHeader("Content-Length", entry.raw.length);
      res.end(entry.raw);
    }
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
const roomConns = /* @__PURE__ */ new Map();
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", async (ws, req) => {
  ws.pause();
  const doc = (req.url || "").slice(1).split("?")[0];
  const ydoc = getYDoc(doc);
  try {
    await documentLoads.get(doc);
  } catch {
    ws.resume();
    ws.close(1011, "Storage unavailable");
    if (ydoc.conns.size === 0) {
      docs.delete(doc);
      documentLoads.delete(doc);
      ydoc.destroy();
    }
    return;
  }
  if (ws.readyState !== 1) return;
  if (!canWrite(ws._role)) {
    const realOn = ws.on.bind(ws);
    ws.on = function(event, handler) {
      if (event === "message") {
        return realOn("message", function(data, ...rest) {
          if (!isWriteMessage(data)) handler.call(this, data, ...rest);
        });
      }
      return realOn(event, handler);
    };
  }
  mConn.inc();
  gConns.inc();
  roomConns.set(doc, (roomConns.get(doc) || 0) + 1);
  gDocs.set(roomConns.size);
  ws.on("message", () => mMsg.inc());
  ws.on("close", () => {
    gConns.dec();
    const n = (roomConns.get(doc) || 1) - 1;
    if (n <= 0) roomConns.delete(doc);
    else roomConns.set(doc, n);
    gDocs.set(roomConns.size);
  });
  setupWSConnection(ws, req);
  ws.resume();
  const expiry = setInterval(() => {
    if (!verify(ws._docId, ws._token)) ws.close(1008, "Access expired");
  }, Math.max(100, Number(process.env.ACCESS_CHECK_MS) || 3e4));
  ws.once("close", () => clearInterval(expiry));
});
server.on("upgrade", (req, socket, head) => {
  let u;
  try {
    u = new URL(req.url, "http://x");
  } catch {
    socket.destroy();
    return;
  }
  if (!u.pathname.startsWith("/ws/")) {
    socket.destroy();
    return;
  }
  let docId;
  try {
    docId = decodeURIComponent(u.pathname.slice(4));
  } catch {
    socket.destroy();
    return;
  }
  if (!/^[\w.-]{1,200}$/.test(docId)) {
    socket.destroy();
    return;
  }
  const v = verify(docId, u.searchParams.get("token"));
  if (!v) {
    mRejected.inc();
    console.log("WS reject (bad/absent token) doc=" + docId);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._docId = docId;
    ws._token = u.searchParams.get("token");
    ws._role = v.role;
    ws._cls = v.cls;
    wss.emit("connection", ws, req);
  });
});
server.listen(PORT, () => {
  console.log("collab app on :" + PORT);
  warmStatic();
});
http.createServer(async (req, res) => {
  if ((req.url || "") === "/metrics") {
    res.setHeader("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  } else {
    res.statusCode = 404;
    res.end();
  }
}).listen(METRICS_PORT, () => console.log("metrics on :" + METRICS_PORT));
