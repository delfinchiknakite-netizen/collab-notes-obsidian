import { Notice, TFile, EventRef } from 'obsidian';
import { WebsocketProvider } from 'y-websocket';
import type CollabNotesPlugin from './main';
import { SyncDisk, SyncEngine, included } from './sync-core';

export class VaultSync {
  private engine: SyncEngine | null = null;
  private refs: EventRef[] = [];
  private timer: number | null = null;
  private pending: Promise<void> = Promise.resolve();
  private starting: Promise<void> | null = null;
  constructor(private plugin: CollabNotesPlugin) {}
  documentId(path: string): string | null { return this.engine?.documentId(path) || null; }
  fileCount(): number { return this.engine?.fileCount() || 0; }
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startInternal().finally(() => { this.starting = null; });
    return this.starting;
  }
  private async startInternal(): Promise<void> {
    await this.pending;
    if (this.engine || !this.plugin.settings.vault.enabled) return;
    const { app, settings } = this.plugin;
    const serviceUrl = settings.serviceUrl.replace(/\/$/, '');
    if (!settings.vault.vaultId || !settings.vault.vaultToken || !settings.serviceUrl) return;
    const adapter = app.vault.adapter;
    const config = app.vault.configDir;
    const scope = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(settings.serviceUrl.replace(/\/$/, '') + ':' + settings.vault.vaultId));
    const key = Array.from(new Uint8Array(scope), (v) => v.toString(16).padStart(2, '0')).join('');
    const root = `${config}/plugins/${this.plugin.manifest.id}/.collab-sync/${key}`;
    const folder = async (path: string) => {
      const dir = path.split('/').slice(0, -1).join('/');
      if (dir && !await adapter.exists(dir)) await adapter.mkdir(dir);
    };
    const list = async (dir: string): Promise<string[]> => {
      const entries = await adapter.list(dir);
      const files = [...entries.files];
      for (const sub of entries.folders) {
        if (sub === '.git' || sub === '.trash' || sub === `${config}/plugins/${this.plugin.manifest.id}`) continue;
        if (sub.startsWith(config) && !settings.vault.syncConfig) continue;
        files.push(...await list(sub));
      }
      return files;
    };
    const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
    const disk: SyncDisk = {
      list: () => list(''), exists: (path) => adapter.exists(path),
      read: async (path) => new Uint8Array(await adapter.readBinary(path)),
      write: async (path, bytes) => {
        await folder(path);
        const file = app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await app.vault.modifyBinary(file, buffer(bytes));
        else if (path.startsWith(config + '/')) await adapter.writeBinary(path, buffer(bytes));
        else if (!await adapter.exists(path)) await app.vault.createBinary(path, buffer(bytes));
        else await adapter.writeBinary(path, buffer(bytes));
      },
      move: async (from, to) => {
        await folder(to);
        const file = app.vault.getAbstractFileByPath(from);
        if (file instanceof TFile) await app.fileManager.renameFile(file, to);
        else await adapter.rename(from, to);
      },
      trash: async (path) => {
        const file = app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await app.vault.trash(file, false);
        else {
          const target = '.trash/collab-' + crypto.randomUUID() + '/' + path;
          await folder(target); await adapter.rename(path, target);
        }
      },
    };
    const cache: SyncDisk = {
      list: async () => [],
      exists: async (path) => await adapter.exists(root + '/' + path + '.next') || await adapter.exists(root + '/' + path),
      read: async (path) => new Uint8Array(await adapter.readBinary(root + '/' + path + (await adapter.exists(root + '/' + path + '.next') ? '.next' : ''))),
      write: async (path, bytes) => {
        const target = root + '/' + path;
        await folder(target);
        await adapter.writeBinary(target + '.next', buffer(bytes));
        await adapter.writeBinary(target, buffer(bytes));
        await adapter.remove(target + '.next');
      },
      move: async () => { throw new Error('Unsupported'); }, trash: async () => { throw new Error('Unsupported'); },
    };
    let lastError = 0;
    this.engine = new SyncEngine({
      disk, cache, namespace: settings.vault.vaultId, configDir: config,
      syncConfig: !!settings.vault.syncConfig,
      excluded: (path) => !!settings.shared[path],
      error: (error) => {
        console.error('Collab Notes sync:', error.message);
        if (Date.now() - lastError > 10000) { new Notice('Ошибка синхронизации: ' + error.message, 15000); lastError = Date.now(); }
      },
      connect: (id, doc, synced) => {
        const provider = new WebsocketProvider(serviceUrl.replace(/^http/, 'ws') + '/ws', id, doc, {
          connect: false, disableBc: true, params: { token: settings.vault.vaultToken },
        });
        provider.on('sync', (ready: boolean) => { if (ready) synced(); });
        return provider;
      },
    });
    try { await this.engine.start(); }
    catch (error) { await this.engine.stop(); this.engine = null; throw error; }
    const scan = () => { void this.engine?.scan().catch(() => {}); };
    this.refs.push(app.vault.on('modify', scan), app.vault.on('create', scan), app.vault.on('delete', scan));
    this.refs.push(app.vault.on('rename', (file, from) => { void this.engine?.renamed(from, file.path).then(scan).catch(() => {}); }));
    this.timer = window.setInterval(scan, 15000);
    new Notice('Синхронизация включена. Настройки и плагины: ' + (settings.vault.syncConfig ? 'да' : 'нет'));
  }
  stop(): Promise<void> {
    const starting = this.starting;
    this.pending = this.pending.then(async () => {
      if (starting) await starting.catch(() => {});
      for (const ref of this.refs) this.plugin.app.vault.offref(ref);
      this.refs = [];
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
      const engine = this.engine; this.engine = null;
      if (engine) await engine.stop();
    });
    return this.pending;
  }
}
