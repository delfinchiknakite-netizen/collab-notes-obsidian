import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { SyncEngine, included, safePath, applyText, binaryHeads, canBindVault } from './generated/sync-core.mjs';
import { DocCache } from './generated/doc-cache.mjs';

const enc = new TextEncoder(), dec = new TextDecoder();
class Disk {
  files = new Map();
  deleted = [];
  async list() { return [...this.files.keys()]; }
  async exists(p) { return this.files.has(p); }
  async read(p) { if (!this.files.has(p)) throw new Error('Missing ' + p); return this.files.get(p).slice(); }
  async write(p, b) { this.files.set(p, b.slice()); }
  async move(a, b) { if (this.files.has(b)) throw new Error('Destination exists'); this.files.set(b, await this.read(a)); this.files.delete(a); }
  async trash(p) { this.deleted.push([p, await this.read(p)]); this.files.delete(p); }
  async text(p, value) { await this.write(p, enc.encode(value)); }
  async value(p) { return dec.decode(await this.read(p)); }
}
class Hub {
  docs = new Map();
  connections = [];
  online = true;
  connect(id, doc, synced) {
    if (!this.docs.has(id)) this.docs.set(id, new Y.Doc());
    const server = this.docs.get(id);
    const c = { active: false, connect: () => {
      c.active = true;
      if (!this.online) return;
      Y.applyUpdate(server, Y.encodeStateAsUpdate(doc), c);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), c);
      synced();
    }, destroy: () => { c.active = false; doc.off('update', push); server.off('update', pull); } };
    const push = (u, origin) => { if (this.online && c.active && origin !== c) Y.applyUpdate(server, u, c); };
    const pull = (u, origin) => { if (this.online && c.active && origin !== c) Y.applyUpdate(doc, u, c); };
    doc.on('update', push); server.on('update', pull);
    this.connections.push(c); return c;
  }
  reconnect() { this.online = true; for (const c of this.connections) if (c.active) c.connect(); }
}
function client(hub, disk = new Disk(), cache = new Disk(), extra = {}) {
  const errors = [];
  const engine = new SyncEngine({ disk, cache, namespace: 'vault', configDir: '.obsidian', syncConfig: false,
    excluded: () => false, connect: (...a) => hub.connect(...a), error: (e) => errors.push(e), ...extra });
  return { engine, disk, cache, errors };
}
async function settle(...clients) {
  for (let i = 0; i < 15; i++) {
    await Promise.all(clients.map((c) => c.engine.idle()));
    await new Promise((r) => setTimeout(r, 2));
  }
  for (const c of clients) assert.deepEqual(c.errors, []);
}
test('paths and configuration exclude credentials, caches and traversal', () => {
  for (const p of ['../x', '/x', 'a\\b', 'a/./x', 'a//b', 'a\u0000x']) assert.equal(safePath(p), false);
  assert.equal(included('folder/pic.png', '.obsidian', false), true);
  assert.equal(included('.obsidian/app.json', '.obsidian', false), false);
  assert.equal(included('.obsidian/app.json', '.obsidian', true), true);
  for (const p of ['.git/config', '.trash/a.md', '.obsidian/workspace-mobile.json', '.obsidian/plugins/collab-notes/main.js', '.obsidian/plugins/obsidian-git/data.json']) assert.equal(included(p, '.obsidian', true), false);
});
test('nonempty account/server-bound vault cannot silently move to another principal', () => {
  assert.equal(canBindVault('server:a', 'server:a', true), true);
  assert.equal(canBindVault('server:a', 'server:b', true), false);
  assert.equal(canBindVault('server:a', 'other-server:a', true), false);
  assert.equal(canBindVault('server:a', 'server:b', false), true);
  assert.equal(canBindVault(undefined, 'server:a', true), true);
});
test('concurrent text edits converge preserving both insertions', () => {
  const a = new Y.Doc(), b = new Y.Doc();
  applyText(a.getText('body'), 'base'); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  applyText(a.getText('body'), 'A base'); applyText(b.getText('body'), 'base B');
  const ua = Y.encodeStateAsUpdate(a), ub = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, ub); Y.applyUpdate(b, ua);
  assert.equal(a.getText('body').toString(), 'A base B');
  assert.equal(a.getText('body').toString(), b.getText('body').toString());
});
test('files, binary, configuration and rename sync; deletion uses trash', async () => {
  const hub = new Hub(), a = client(hub, undefined, undefined, { syncConfig: true }), b = client(hub, undefined, undefined, { syncConfig: true });
  await a.disk.text('folder/note.md', 'hello'); await a.disk.write('photo.png', new Uint8Array([0, 255, 4]));
  await a.disk.text('.obsidian/app.json', '{"x":1}');
  await a.engine.start(); await settle(a); await b.engine.start(); await settle(a, b);
  assert.equal(await b.disk.value('folder/note.md'), 'hello');
  assert.deepEqual(await b.disk.read('photo.png'), new Uint8Array([0, 255, 4]));
  assert.equal(await b.disk.value('.obsidian/app.json'), '{"x":1}');
  await a.disk.move('folder/note.md', 'other/note.md'); await a.engine.renamed('folder', 'other'); await settle(a, b);
  assert.equal(await b.disk.value('other/note.md'), 'hello');
  a.disk.files.delete('other/note.md'); await a.engine.scan(); await settle(a, b);
  assert.equal(await b.disk.exists('other/note.md'), false); assert.equal(b.disk.deleted.length, 1);
  await a.engine.stop(); await b.engine.stop();
});
test('offline edits survive process restart and merge against persisted CRDT', async () => {
  const hub = new Hub(), a = client(hub), b = client(hub);
  await a.disk.text('n.md', 'base'); await a.engine.start(); await settle(a); await b.engine.start(); await settle(a, b);
  hub.online = false;
  await a.disk.text('n.md', 'A base'); await a.engine.scan(); await settle(a);
  await b.disk.text('n.md', 'base B'); await b.engine.scan(); await settle(b);
  await b.engine.stop();
  const c = client(hub, b.disk, b.cache);
  await c.engine.start(); await settle(c); hub.reconnect(); await settle(a, c);
  assert.equal(await a.disk.value('n.md'), 'A base B'); assert.equal(await c.disk.value('n.md'), 'A base B');
  await a.engine.stop(); await c.engine.stop();
});
test('concurrent binaries preserve losing branch in a unique conflict file', async () => {
  const hub = new Hub(), a = client(hub), b = client(hub);
  await a.disk.write('p.png', new Uint8Array([1])); await a.engine.start(); await settle(a); await b.engine.start(); await settle(a, b);
  hub.online = false;
  await a.disk.write('p.png', new Uint8Array([2])); await a.engine.scan();
  await b.disk.write('p.png', new Uint8Array([3])); await b.engine.scan();
  hub.reconnect(); await settle(a, b);
  assert.deepEqual(await a.disk.read('p.png'), await b.disk.read('p.png'));
  const values = [...a.disk.files].filter(([p]) => p.endsWith('.png')).map(([, bytes]) => bytes[0]);
  assert.ok(values.includes(2)); assert.ok(values.includes(3));
  await a.engine.stop(); await b.engine.stop();
});
test('initial different content is preserved as a conflict copy', async () => {
  const hub = new Hub(), a = client(hub), b = client(hub);
  await a.disk.text('n.md', 'server'); await a.engine.start(); await settle(a);
  await b.disk.text('n.md', 'local'); await b.engine.start(); await settle(a, b);
  assert.equal(await b.disk.value('n.md'), 'server');
  const copies = [...b.disk.files].filter(([p]) => p.includes('(конфликт'));
  assert.ok(copies.length >= 1); assert.equal(dec.decode(copies[0][1]), 'local');
  await a.engine.stop(); await b.engine.stop();
});
test('binary revision graph detects concurrent heads', () => {
  const map = new Y.Doc().getMap('r');
  map.set('a', { parents: [], bytes: new Uint8Array([1]) });
  map.set('b', { parents: ['a'], bytes: new Uint8Array([2]) });
  map.set('c', { parents: ['a'], bytes: new Uint8Array([3]) });
  assert.deepEqual(binaryHeads(map), ['b', 'c']);
});
test('two offline creations with the same path retain both documents', async () => {
  const hub = new Hub(), a = client(hub), b = client(hub);
  await a.engine.start(); await b.engine.start(); await settle(a, b);
  hub.online = false;
  await a.disk.text('same.md', 'first'); await a.engine.scan();
  await b.disk.text('same.md', 'second'); await b.engine.scan();
  hub.reconnect(); await settle(a, b);
  const values = await Promise.all([...a.disk.files.keys()].filter((p) => p.endsWith('.md')).map((p) => a.disk.value(p)));
  assert.ok(values.includes('first')); assert.ok(values.includes('second'));
  await a.engine.stop(); await b.engine.stop();
});
test('sync errors are surfaced, not silently ignored', async () => {
  const hub = new Hub(), a = client(hub), disk = new Disk();
  disk.write = async () => { throw new Error('disk full'); };
  const b = client(hub, disk);
  await a.disk.text('a.md', 'important'); await a.engine.start(); await settle(a); await b.engine.start();
  await new Promise((resolve) => setTimeout(resolve, 30)); await b.engine.idle();
  assert.ok(b.errors.some((e) => e.message === 'disk full'));
  assert.equal(await a.disk.value('a.md'), 'important');
  await a.engine.stop(); await b.engine.stop();
});
test('corrupted local state fails closed without overwriting local files', async () => {
  const c = client(new Hub()); await c.disk.text('safe.md', 'important'); await c.cache.text('manifest.ybin', 'corrupt');
  await assert.rejects(c.engine.start()); assert.equal(await c.disk.value('safe.md'), 'important');
});
test('shared-note cache survives restart and recovers the complete staged checkpoint', async () => {
  const files = new Map(), errors = [];
  const adapter = {
    exists: async (path) => files.has(path), mkdir: async () => {},
    readBinary: async (path) => files.get(path).slice(0),
    writeBinary: async (path, bytes) => { files.set(path, bytes.slice(0)); },
    remove: async (path) => { files.delete(path); },
  };
  const doc = new Y.Doc();
  const { cache } = await DocCache.open(adapter, 'cache', 'server:doc', doc, (e) => errors.push(e));
  doc.getText('body').insert(0, 'offline'); await cache.close();
  const main = [...files.keys()][0];
  doc.getText('body').insert(7, ' staged');
  files.set(main + '.next', Y.encodeStateAsUpdate(doc).slice().buffer);
  const restored = new Y.Doc();
  const second = await DocCache.open(adapter, 'cache', 'server:doc', restored, (e) => errors.push(e));
  assert.equal(second.loaded, true); assert.equal(restored.getText('body').toString(), 'offline staged');
  const foreign = await DocCache.open(adapter, 'cache', 'other-server:doc', new Y.Doc(), (e) => errors.push(e));
  assert.equal(foreign.loaded, false); assert.deepEqual(errors, []);
  await second.cache.close(); await foreign.cache.close(); doc.destroy(); restored.destroy();
});
test('remote deletion preserves concurrent offline content in trash', async () => {
  const hub = new Hub(), a = client(hub), b = client(hub);
  await a.disk.text('n.md', 'base'); await a.engine.start(); await settle(a); await b.engine.start(); await settle(a, b);
  hub.online = false;
  await b.disk.text('n.md', 'offline work'); await b.engine.scan();
  a.disk.files.delete('n.md'); await a.engine.scan();
  hub.reconnect(); await settle(a, b);
  assert.ok(b.disk.deleted.some(([path, bytes]) => path === 'n.md' && dec.decode(bytes) === 'offline work'));
  await a.engine.stop(); await b.engine.stop();
});
test('a legacy document cleared to empty is not re-seeded with stale local text', async () => {
  const hub = new Hub();
  const manifest = new Y.Doc(); manifest.getMap('files').set('legacy', { path: 'empty.md' });
  const doc = new Y.Doc(); doc.getText('body').insert(0, 'old'); doc.getText('body').delete(0, 3);
  hub.docs.set('vault.manifest', manifest); hub.docs.set('vault.legacy', doc);
  const c = client(hub); await c.disk.text('empty.md', 'stale'); await c.engine.start(); await settle(c);
  assert.equal(await c.disk.value('empty.md'), '');
  assert.ok([...c.disk.files].some(([path, bytes]) => path.includes('(конфликт') && dec.decode(bytes) === 'stale'));
  await c.engine.stop();
});
test('remote rename preserves an unrelated local destination before moving', async () => {
  const hub = new Hub(), a = client(hub), b = client(hub);
  await a.disk.text('n.md', 'shared'); await a.engine.start(); await settle(a); await b.engine.start(); await settle(a, b);
  await b.disk.text('target.md', 'unrelated');
  await a.disk.move('n.md', 'target.md'); await a.engine.renamed('n.md', 'target.md'); await settle(a, b);
  assert.equal(await b.disk.value('target.md'), 'shared');
  assert.ok([...b.disk.files].some(([path, bytes]) => path.includes('(конфликт') && dec.decode(bytes) === 'unrelated'));
  await a.engine.stop(); await b.engine.stop();
});
