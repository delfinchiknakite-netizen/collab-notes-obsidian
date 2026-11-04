import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { AccountStore } from "../accounts.mjs";
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 4e3) {
  const start = Date.now();
  while (!await fn()) {
    if (Date.now() - start > timeout) throw new Error("Timed out");
    await delay(20);
  }
}
test("real HTTP/WS: scoped accounts, readers, revoked access, expiry and account restart", { timeout: 2e4 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collab-service-"));
  let proc;
  const providers = [];
  try {
    let client = function(docId, token) {
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(wsBase, docId, doc, { WebSocketPolyfill: WebSocket, disableBc: true, params: { token } });
      providers.push(provider);
      return { doc, provider, text: doc.getText("body") };
    };
    const mail = [], store = new AccountStore(dir, async (...args) => mail.push(args));
    await store.init();
    await store.register("test@example.com", "valid test password", "local");
    await store.consume("test@example.com", mail.at(-1)[2], "verify");
    await store.issue("test@example.com", "reset", "local");
    const reset = mail.at(-1)[2];
    const port = await freePort(), metrics = await freePort();
    const base = "http://127.0.0.1:" + port, wsBase = base.replace("http", "ws") + "/ws";
    const start = async () => {
      proc = spawn(process.execPath, ["prod-server.mjs"], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "ignore", "pipe"], env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        PORT: String(port),
        METRICS_PORT: String(metrics),
        LINK_SECRET: "local-test-secret-with-at-least-32-characters",
        ACCOUNT_DIR: dir,
        ACCESS_CHECK_MS: "100"
      } });
      await until(async () => {
        try {
          return (await fetch(base + "/healthz")).ok;
        } catch {
          return false;
        }
      });
    };
    const stop = async () => {
      const exited = once(proc, "exit");
      proc.kill("SIGTERM");
      await exited;
      proc = null;
    };
    const post = (url, body) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await start();
    const login = await post("/auth/login", { email: "test@example.com", password: "valid test password" });
    assert.equal(login.status, 200);
    const account = await login.json();
    const me = await fetch(base + "/auth/me", { headers: { Authorization: "Bearer " + account.token } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).vaultId, account.vaultId);
    const caps = await (await fetch(base + "/capabilities")).json();
    assert.equal(caps.protocol, 2);
    const session = await (await post("/sessions", {})).json();
    const writer = client(session.docId, session.editToken), reader = client(session.docId, session.viewToken);
    await until(() => writer.provider.synced && reader.provider.synced);
    writer.text.insert(0, "hello");
    await until(() => reader.text.toString() === "hello");
    reader.text.insert(reader.text.length, " attack");
    await delay(100);
    assert.equal(writer.text.toString(), "hello");
    const bad = new WebSocket(wsBase + "/" + session.docId + "?token=" + encodeURIComponent("viewer.guest.9999999999999." + "\u044B".repeat(43)));
    await new Promise((resolve, reject) => {
      bad.once("error", resolve);
      bad.once("open", () => reject(new Error("Bad token accepted")));
    });
    assert.equal((await fetch(base + "/healthz")).status, 200);
    const own = client(account.vaultId + ".manifest", account.vaultToken);
    await until(() => own.provider.synced);
    const foreign = new WebSocket(wsBase + "/foreign.manifest?token=" + encodeURIComponent(account.vaultToken));
    await new Promise((resolve, reject) => {
      foreign.once("error", resolve);
      foreign.once("open", () => reject(new Error("Foreign namespace accepted")));
    });
    assert.equal((await post("/auth/reset-password", { email: "test@example.com", code: reset, password: "new test password" })).status, 200);
    await until(() => !own.provider.wsconnected);
    assert.equal((await fetch(base + "/auth/me", { headers: { Authorization: "Bearer " + account.token } })).status, 401);
    providers.forEach((p) => {
      p.destroy();
      p.doc.destroy();
    });
    await stop();
    await start();
    const again = await post("/auth/login", { email: "test@example.com", password: "new test password" });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).vaultId, account.vaultId);
    await stop();
  } finally {
    providers.forEach((p) => {
      p.destroy();
      p.doc.destroy();
    });
    if (proc) {
      proc.kill("SIGKILL");
      await once(proc, "exit").catch(() => {
      });
    }
    await rm(dir, { recursive: true });
  }
});
test("initial sync waits for S3; a storage error never appears as an empty document", { timeout: 2e4 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collab-storage-"));
  let proc, failing = false;
  const clients = [];
  const saved = new Y.Doc();
  saved.getText("body").insert(0, "persisted content");
  const snapshot = Buffer.from(Y.encodeStateAsUpdate(saved));
  const storage = createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url.includes("snap/")) {
      await delay(150);
      if (failing) {
        res.writeHead(403, { "Content-Type": "application/xml" });
        res.end("<Error><Code>AccessDenied</Code></Error>");
      } else {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(snapshot);
      }
    } else if (req.method === "GET") {
      res.setHeader("Content-Type", "application/xml");
      res.end("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
    } else {
      req.resume();
      req.on("end", () => res.end());
    }
  });
  storage.listen(0, "127.0.0.1");
  await once(storage, "listening");
  try {
    const port = await freePort(), metrics = await freePort();
    const base = "http://127.0.0.1:" + port;
    proc = spawn(process.execPath, ["prod-server.mjs"], { cwd: new URL("../", import.meta.url), stdio: "ignore", env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      PORT: String(port),
      METRICS_PORT: String(metrics),
      LINK_SECRET: "local-test-secret-with-at-least-32-characters",
      ACCOUNT_DIR: dir,
      S3_BUCKET: "test",
      S3_ENDPOINT: "http://127.0.0.1:" + storage.address().port,
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test"
    } });
    await until(async () => {
      try {
        return (await fetch(base + "/healthz")).ok;
      } catch {
        return false;
      }
    });
    async function connect() {
      const session = await (await fetch(base + "/sessions", { method: "POST" })).json();
      const doc = new Y.Doc();
      const provider = new WebsocketProvider(
        base.replace("http", "ws") + "/ws",
        session.docId,
        doc,
        { params: { token: session.token }, disableBc: true, WebSocketPolyfill: WebSocket }
      );
      clients.push(provider);
      return { doc, provider };
    }
    const a = await connect();
    await until(() => a.provider.synced);
    assert.equal(a.doc.getText("body").toString(), "persisted content");
    failing = true;
    const b = await connect();
    await delay(400);
    assert.equal(b.provider.synced, false);
    assert.equal((await fetch(base + "/healthz")).status, 200);
  } finally {
    for (const provider of clients) {
      provider.destroy();
      provider.doc.destroy();
    }
    if (proc) {
      const exit = once(proc, "exit");
      proc.kill("SIGTERM");
      await exit;
    }
    storage.closeAllConnections();
    await new Promise((resolve) => storage.close(resolve));
    saved.destroy();
    await rm(dir, { recursive: true });
  }
});
