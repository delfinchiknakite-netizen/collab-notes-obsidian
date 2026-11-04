import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../accounts.mjs";
test("account durability, verification, reset, single-use codes and session epoch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collab-accounts-"));
  const mail = [];
  const send = async (...args) => mail.push(args);
  try {
    const store = new AccountStore(dir, send);
    await store.init();
    await store.register("TEST@example.com", "a strong password", "ip1");
    await assert.rejects(store.login("test@example.com", "a strong password", "ip1"), { status: 403 });
    const verify = mail[0][2];
    await store.consume("test@example.com", verify, "verify");
    await assert.rejects(store.consume("test@example.com", verify, "verify"), { status: 400 });
    const user = await store.login("test@example.com", "a strong password", "ip1");
    const restarted = new AccountStore(dir, send);
    await restarted.init();
    const again = await restarted.login("test@example.com", "a strong password", "ip1");
    assert.equal(again.vaultId, user.vaultId);
    await restarted.issue("test@example.com", "reset", "ip1");
    await restarted.consume("test@example.com", mail.at(-1)[2], "reset", "new strong password");
    await assert.rejects(restarted.login("test@example.com", "a strong password", "ip1"), { status: 401 });
    const changed = await restarted.login("test@example.com", "new strong password", "ip1");
    assert.equal(changed.epoch, user.epoch + 1);
    assert.equal(changed.vaultId, user.vaultId);
    const json = await readFile(path.join(dir, "accounts.json"), "utf8");
    assert.ok(!json.includes("a strong password"));
    assert.ok(!json.includes(verify));
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("concurrent registration is atomic, and invalid inputs and brute force are rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collab-accounts-"));
  try {
    const store = new AccountStore(dir, async () => {
    });
    await store.init();
    await assert.rejects(store.register("no-email", "valid long password", "i"), { status: 400 });
    await assert.rejects(store.register("x@example.com", "short", "i"), { status: 400 });
    const results = await Promise.allSettled([
      store.register("a@example.com", "valid long password", "a"),
      store.register("a@example.com", "valid long password", "b")
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
    for (let n = 0; n < 8; n++) await assert.rejects(store.login("absent@example.com", "wrong", "i"), { status: 401 });
    await assert.rejects(store.login("absent@example.com", "wrong", "i"), { status: 429 });
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("email failure is explicit, resending works, expired codes are rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collab-accounts-"));
  const mail = [];
  let time = 1e5;
  try {
    const store = new AccountStore(dir, null, () => time);
    await store.init();
    await assert.rejects(store.register("x@example.com", "valid long password", "a"), { status: 503 });
    store.sendMail = async (...args) => mail.push(args);
    await store.register("x@example.com", "valid long password", "a");
    time += 3600001;
    await assert.rejects(store.consume("x@example.com", mail[0][2], "verify"), { status: 400 });
    await store.issue("x@example.com", "verify", "a");
    await store.consume("x@example.com", mail.at(-1)[2], "verify");
    assert.equal((await store.login("x@example.com", "valid long password", "a")).email, "x@example.com");
  } finally {
    await rm(dir, { recursive: true });
  }
});
