import * as Y from 'yjs';

export interface SyncDisk {
  list(): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  move(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
}
export interface SyncConnection { connect(): void; destroy(): void; }
export interface SyncOptions {
  disk: SyncDisk;
  cache: SyncDisk;
  namespace: string;
  configDir: string;
  syncConfig: boolean;
  connect: (id: string, doc: Y.Doc, synced: () => void) => SyncConnection;
  error: (error: Error) => void;
  excluded: (path: string) => boolean;
}
type Meta = { path: string; deleted?: boolean; kind?: 'text' | 'binary' };
type Revision = { parents: string[]; bytes: Uint8Array };
type State = { path: string; fingerprint?: string; missing?: boolean; };
type Note = { doc: Y.Doc; connection: SyncConnection; state: State; ready: boolean; };
const utf8 = new TextEncoder();
const decoder = new TextDecoder();
export function canBindVault(bound: string | undefined, target: string, nonempty: boolean): boolean {
  return !nonempty || !bound || bound === target;
}
export function safePath(path: string): boolean {
  return !!path && path.length < 1000 && !/[\\:\x00-\x1f]/.test(path) && !path.startsWith('/') && path.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}
export function included(path: string, configDir: string, config: boolean): boolean {
  if (!safePath(path)) return false;
  const parts = path.split('/');
  if (parts.includes('.git') || parts.includes('.trash') || parts.includes('node_modules') || parts.includes('.collab-sync')) return false;
  if (parts[0] === configDir) {
    if (!config || parts[1] === 'plugins' && parts[2] === 'collab-notes') return false;
    if (/^(workspace.*\.json|cache|sync|\.collab-sync)$/.test(parts[1] || '')) return false;
    if (parts[1] === 'plugins' && parts.at(-1) === 'data.json') return false;
    return true;
  }
  return !parts.some((part) => part.startsWith('.'));
}
export function applyText(text: Y.Text, next: string): void {
  const before = text.toString();
  if (before === next) return;
  let start = 0, end = before.length, nextEnd = next.length;
  while (start < end && start < nextEnd && before[start] === next[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  text.doc!.transact(() => { if (end > start) text.delete(start, end - start); if (nextEnd > start) text.insert(start, next.slice(start, nextEnd)); });
}
export function binaryHeads(revisions: Y.Map<Revision>): string[] {
  const parents = new Set<string>();
  for (const value of revisions.values()) for (const parent of value.parents) parents.add(parent);
  return [...revisions.keys()].filter((id) => !parents.has(id)).sort();
}
async function fingerprint(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
}
export class SyncEngine {
  private manifest = new Y.Doc();
  private files = this.manifest.getMap<Meta>('files');
  private notes = new Map<string, Note>();
  private index: Record<string, State> = {};
  private tail: Promise<void> = Promise.resolve();
  private remote: SyncConnection | null = null;
  private stopped = false;
  private manifestReady = false;
  constructor(private options: SyncOptions) {}
  private accept(path: string): boolean { return included(path, this.options.configDir, this.options.syncConfig) && !this.options.excluded(path); }
  private queue(task: () => Promise<void>): Promise<void> {
    const result = this.tail.then(async () => { if (!this.stopped) await task(); });
    this.tail = result.catch((error: Error) => this.options.error(error));
    return result;
  }
  async idle(): Promise<void> { await this.tail; }
  documentId(path: string): string | null {
    for (const [id, meta] of this.files) if (!meta.deleted && meta.path === path) return this.options.namespace + '.' + id;
    return null;
  }
  fileCount(): number { return [...this.files.values()].filter((meta) => !meta.deleted && this.accept(meta.path)).length; }
  private async checkpoint(id: string, doc: Y.Doc): Promise<void> {
    await this.options.cache.write(id + '.ybin', Y.encodeStateAsUpdate(doc));
    await this.options.cache.write('index.json', utf8.encode(JSON.stringify(this.index)));
  }
  private async load(id: string, doc: Y.Doc): Promise<boolean> {
    if (!await this.options.cache.exists(id + '.ybin')) return false;
    Y.applyUpdate(doc, await this.options.cache.read(id + '.ybin'));
    return true;
  }
  async start(): Promise<void> {
    if (await this.options.cache.exists('index.json')) this.index = JSON.parse(decoder.decode(await this.options.cache.read('index.json')));
    await this.load('manifest', this.manifest);
    this.manifest.on('update', () => { void this.queue(async () => { await this.checkpoint('manifest', this.manifest); if (this.manifestReady) await this.reconcile(); }); });
    for (const [id, meta] of this.files) {
      if (!meta.deleted && this.accept(meta.path)) await this.open(id, meta, false);
    }
    for (const [id, note] of this.notes) {
      if (note.ready) await this.ingest(id, note);
    }
    this.remote = this.options.connect(this.options.namespace + '.manifest', this.manifest, () => {
      void this.queue(async () => { this.manifestReady = true; await this.reconcile(); });
    });
    this.remote.connect();
    for (const note of this.notes.values()) note.connection.connect();
  }
  private async open(id: string, meta: Meta, connect = true): Promise<void> {
    if (this.notes.has(id) || !this.accept(meta.path) || meta.deleted) return;
    const doc = new Y.Doc();
    const cached = await this.load(id, doc);
    const state = this.index[id] || { path: meta.path };
    this.index[id] = state;
    const note: Note = { doc, state, ready: cached && !!state.fingerprint, connection: null! };
    note.connection = this.options.connect(this.options.namespace + '.' + id, doc, () => {
      void this.queue(async () => {
        if (!note.ready) {
          if (await this.options.disk.exists(meta.path)) {
            const bytes = await this.options.disk.read(meta.path);
            const hash = await fingerprint(bytes);
            if (state.fingerprint && hash !== state.fingerprint) {
              await this.conflict(meta.path, bytes);
            } else if (!state.fingerprint && this.hasContent(note, meta)) {
              const remote = this.bytes(note, meta);
              if (hash !== await fingerprint(remote)) await this.conflict(meta.path, bytes);
            } else if (!this.hasContent(note, meta)) await this.setBytes(note, meta, bytes);
            state.fingerprint = hash;
          }
          note.ready = true;
        }
        await this.apply(id, note);
      });
    });
    this.notes.set(id, note);
    doc.on('update', () => { void this.queue(async () => { await this.checkpoint(id, doc); if (note.ready) await this.apply(id, note); }); });
    if (connect) note.connection.connect();
  }
  private hasContent(note: Note, meta: Meta): boolean {
    return meta.kind === 'binary' ? note.doc.getMap('revisions').size > 0 : note.doc.getMap('meta').get('initialized') === true || note.doc.getText('body').length > 0 || Y.encodeStateVector(note.doc).length > 1;
  }
  private bytes(note: Note, meta: Meta): Uint8Array {
    if (meta.kind !== 'binary') return utf8.encode(note.doc.getText('body').toString());
    const revisions = note.doc.getMap<Revision>('revisions');
    const heads = binaryHeads(revisions);
    return heads.length ? revisions.get(heads[heads.length - 1])!.bytes : new Uint8Array();
  }
  private async setBytes(note: Note, meta: Meta, bytes: Uint8Array): Promise<void> {
    if (meta.kind === 'binary') {
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Файл больше 20 MiB: ' + meta.path);
      const revisions = note.doc.getMap<Revision>('revisions');
      const hash = await fingerprint(bytes);
      const heads = binaryHeads(revisions);
      if (heads.length === 1 && await fingerprint(revisions.get(heads[0])!.bytes) === hash) return;
      revisions.set(crypto.randomUUID(), { parents: heads, bytes });
      this.pruneRevisions(revisions);
    } else {
      applyText(note.doc.getText('body'), decoder.decode(bytes));
      note.doc.getMap('meta').set('initialized', true);
    }
  }
  private pruneRevisions(revisions: Y.Map<Revision>): void {
    const heads = new Set(binaryHeads(revisions));
    for (const [id, revision] of revisions) {
      if (!heads.has(id) && revision.bytes.length) revisions.set(id, { parents: revision.parents, bytes: new Uint8Array() });
    }
  }
  private async ingest(id: string, note: Note): Promise<void> {
    const meta = this.files.get(id);
    if (!meta || meta.deleted || !this.accept(meta.path)) return;
    const path = note.state.path;
    if (!await this.options.disk.exists(path)) {
      if (note.state.fingerprint) { this.files.set(id, { ...meta, deleted: true }); note.state.missing = true; }
      return;
    }
    const bytes = await this.options.disk.read(path);
    const hash = await fingerprint(bytes);
    if (hash !== note.state.fingerprint) {
      await this.setBytes(note, meta, bytes);
      note.state.fingerprint = hash;
      await this.checkpoint(id, note.doc);
    }
  }
  async scan(): Promise<void> {
    return this.queue(async () => {
      for (const [id, note] of this.notes) if (note.ready) await this.ingest(id, note);
      if (this.manifestReady) await this.reconcile();
    });
  }
  private async reconcile(): Promise<void> {
    const known = new Set<string>();
    const owners = new Map<string, string>();
    for (const [id, meta] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (meta.deleted || !this.accept(meta.path)) continue;
      const normalized = meta.path.normalize('NFC').toLowerCase();
      if (!owners.has(normalized)) { owners.set(normalized, id); continue; }
      const dot = meta.path.lastIndexOf('.'), slash = meta.path.lastIndexOf('/');
      const path = dot > slash ? meta.path.slice(0, dot) + ' (конфликт имени ' + id + ')' + meta.path.slice(dot) : meta.path + ' (конфликт имени ' + id + ')';
      this.files.set(id, { ...meta, path });
    }
    for (const [id, meta] of this.files) {
      if (!this.accept(meta.path)) continue;
      const prior = this.index[id];
      if (meta.deleted) {
        if (prior && !prior.missing && await this.options.disk.exists(prior.path)) {
          const bytes = await this.options.disk.read(prior.path);
          if (await fingerprint(bytes) !== prior.fingerprint) await this.conflict(prior.path, bytes);
          await this.options.disk.trash(prior.path);
        }
        if (prior) prior.missing = true;
        const note = this.notes.get(id);
        if (note) { await this.checkpoint(id, note.doc); note.connection.destroy(); note.doc.destroy(); this.notes.delete(id); }
        continue;
      }
      known.add(meta.path);
      if (prior && prior.path !== meta.path) {
        if (await this.options.disk.exists(prior.path)) {
          if (await this.options.disk.exists(meta.path)) {
            await this.conflict(meta.path, await this.options.disk.read(meta.path));
            await this.options.disk.trash(meta.path);
          }
          await this.options.disk.move(prior.path, meta.path);
        }
        prior.path = meta.path;
      }
      await this.open(id, meta);
    }
    for (const path of await this.options.disk.list()) {
      if (!this.accept(path) || known.has(path)) continue;
      const id = crypto.randomUUID();
      const meta: Meta = { path, kind: /\.md$/i.test(path) ? 'text' : 'binary' };
      const bytes = await this.options.disk.read(path);
      if (bytes.length > 20 * 1024 * 1024) { this.options.error(new Error('Пропущен файл больше 20 MiB: ' + path)); continue; }
      this.index[id] = { path, fingerprint: await fingerprint(bytes) };
      this.files.set(id, meta);
      const doc = new Y.Doc();
      const seed: Note = { doc, state: this.index[id], ready: true, connection: null! };
      await this.setBytes(seed, meta, bytes);
      await this.checkpoint(id, doc);
      doc.destroy();
      await this.open(id, meta);
      known.add(path);
    }
    await this.checkpoint('manifest', this.manifest);
  }
  private async conflict(path: string, bytes: Uint8Array, suffix: string = crypto.randomUUID()): Promise<void> {
    const dot = path.lastIndexOf('.'), slash = path.lastIndexOf('/');
    const base = dot > slash ? path.slice(0, dot) : path;
    const ext = dot > slash ? path.slice(dot) : '';
    const copy = `${base} (конфликт ${suffix})${ext}`;
    if (!await this.options.disk.exists(copy)) await this.options.disk.write(copy, bytes);
  }
  private async apply(id: string, note: Note): Promise<void> {
    const meta = this.files.get(id);
    if (!meta || meta.deleted || !this.accept(meta.path) || !this.hasContent(note, meta)) return;
    const bytes = this.bytes(note, meta);
    if (await this.options.disk.exists(meta.path)) {
      const local = await this.options.disk.read(meta.path);
      const hash = await fingerprint(local);
      if (hash !== note.state.fingerprint && hash !== await fingerprint(bytes)) {
        await this.setBytes(note, meta, local);
        note.state.fingerprint = hash;
        await this.checkpoint(id, note.doc);
        return;
      }
    }
    if (meta.kind === 'binary') {
      const revisions = note.doc.getMap<Revision>('revisions');
      const heads = binaryHeads(revisions);
      for (const other of heads.slice(0, -1)) await this.conflict(meta.path, revisions.get(other)!.bytes, other);
      this.pruneRevisions(revisions);
    }
    const hash = await fingerprint(bytes);
    if (!await this.options.disk.exists(meta.path) || hash !== await fingerprint(await this.options.disk.read(meta.path))) await this.options.disk.write(meta.path, bytes);
    note.state.path = meta.path;
    note.state.fingerprint = hash;
    note.state.missing = false;
    await this.checkpoint(id, note.doc);
  }
  async renamed(from: string, to: string): Promise<void> {
    return this.queue(async () => {
      for (const [id, meta] of this.files) {
        if (meta.deleted || (meta.path !== from && !meta.path.startsWith(from + '/'))) continue;
        const path = to + meta.path.slice(from.length);
        if (!this.accept(path)) throw new Error('Путь исключён из синхронизации: ' + path);
        const state = this.index[id];
        if (state) state.path = path;
        this.files.set(id, { ...meta, path });
      }
      await this.checkpoint('manifest', this.manifest);
    });
  }
  async stop(): Promise<void> {
    this.remote?.destroy();
    for (const note of this.notes.values()) note.connection.destroy();
    await this.idle();
    await this.checkpoint('manifest', this.manifest);
    for (const [id, note] of this.notes) { await this.checkpoint(id, note.doc); note.doc.destroy(); }
    this.stopped = true;
    this.notes.clear(); this.manifest.destroy();
  }
}
