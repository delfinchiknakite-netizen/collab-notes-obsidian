import { DataAdapter } from 'obsidian';
import * as Y from 'yjs';

export class DocCache {
  private tail: Promise<void> = Promise.resolve();
  private constructor(private adapter: DataAdapter, private path: string, private doc: Y.Doc, private error: (error: Error) => void) {}
  static async open(adapter: DataAdapter, directory: string, scope: string, doc: Y.Doc, error: (error: Error) => void): Promise<{ cache: DocCache; loaded: boolean }> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope));
    const id = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
    const path = directory + '/' + id + '.ybin';
    if (!await adapter.exists(directory)) await adapter.mkdir(directory);
    const cache = new DocCache(adapter, path, doc, error);
    const next = await adapter.exists(path + '.next');
    const loaded = next || await adapter.exists(path);
    if (loaded) Y.applyUpdate(doc, new Uint8Array(await adapter.readBinary(path + (next ? '.next' : ''))));
    doc.on('update', cache.update);
    return { cache, loaded };
  }
  private update = (): void => {
    const state = Y.encodeStateAsUpdate(this.doc).slice().buffer as ArrayBuffer;
    this.tail = this.tail.then(async () => {
      await this.adapter.writeBinary(this.path + '.next', state);
      await this.adapter.writeBinary(this.path, state);
      await this.adapter.remove(this.path + '.next');
    }).catch(this.error);
  };
  async flush(): Promise<void> { this.update(); await this.tail; }
  close(): Promise<void> { this.doc.off('update', this.update); return this.flush(); }
}
