import {
  App, Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, MarkdownView, requestUrl, RequestUrlResponse,
  SettingDefinitionItem, EventRef,
} from 'obsidian';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
// @ts-ignore — без типов
import qrcode from 'qrcode-generator';

interface SharedInfo { docId: string; token: string; link: string; viewLink?: string; }
interface VaultSyncSettings {
  enabled: boolean;
  vaultId: string;
  vaultToken: string;
  index: Record<string, string>; // noteId -> path (локальное зеркало манифеста)
}
interface CollabSettings {
  serviceUrl: string;
  userName: string;
  shared: Record<string, SharedInfo>; // path -> сессия (переживает перезапуск)
  vault: VaultSyncSettings;           // полный синк хранилища между устройствами
}
const DEFAULTS: CollabSettings = {
  serviceUrl: '', // сервер не задан по умолчанию — пользователь указывает свой (self-hosted)
  userName: '',
  shared: {},
  vault: { enabled: false, vaultId: '', vaultToken: '', index: {} },
};

// применить новый текст к Y.Text минимальным диффом (общий префикс/суффикс) — чтобы
// параллельные правки с разных устройств мержились по-символьно, а не затирались целиком.
function applyTextToYText(ytext: Y.Text, next: string): void {
  const cur = ytext.toString();
  if (cur === next) return;
  let start = 0;
  const min = Math.min(cur.length, next.length);
  while (start < min && cur[start] === next[start]) start++;
  let endCur = cur.length, endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) { endCur--; endNext--; }
  const doc = ytext.doc;
  const mutate = () => {
    if (endCur > start) ytext.delete(start, endCur - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  };
  if (doc) doc.transact(mutate); else mutate();
}

// один общий compartment на все редакторы: активной заметке с сессией — yCollab, остальным пусто
const collab = new Compartment();

interface Session {
  file: TFile;
  docId: string;
  link: string;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  ytext: Y.Text;
  synced: boolean;   // прошла первичная синхронизация с сервером
  readOnly: boolean; // роль без права записи (viewer) → редактор только для чтения
}

// роль из токена (role.class.exp.sig или старый perm.exp.sig): может ли писать
function canWriteToken(token: string): boolean {
  const r = (token || '').split('.')[0];
  return r !== 'viewer' && r !== 'view';
}

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return 'hsl(' + (h % 360) + ' 70% 45%)';
}

export default class CollabNotesPlugin extends Plugin {
  settings: CollabSettings;
  sessions = new Map<string, Session>();
  statusEl: HTMLElement;
  vaultSync!: VaultSync;

  async onload() {
    await this.loadSettings();
    this.vaultSync = new VaultSync(this);
    this.registerEditorExtension([collab.of([])]);

    const collabTitle = (path: string) => (this.sessions.has(path) ? 'Совместное редактирование — управление' : 'Совместное редактирование');

    // ПКМ по заметке / по папке
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') {
        menu.addItem((i) => i.setTitle(collabTitle(file.path)).setIcon('users').onClick(() => void this.startSession(file)));
      } else if (file instanceof TFolder) {
        // как «Новая доска Kanban / Canvas» — создать заметку из совместной ссылки прямо в папке
        menu.addItem((i) => i.setTitle('Создать совместную заметку из ссылки').setIcon('users').onClick(() => void this.joinPrompt(file)));
      }
    }));

    // меню «•••» / три точки в открытой заметке
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
      const file = info.file;
      if (file && file.extension === 'md') {
        menu.addItem((i) => i.setTitle(collabTitle(file.path)).setIcon('users').onClick(() => void this.startSession(file)));
      }
    }));

    this.addCommand({
      id: 'start', name: 'Совместное редактирование (активная заметка)',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (checking) return !!f && f.extension === 'md';
        if (f) void this.startSession(f);
        return true;
      },
    });
    this.addCommand({ id: 'join', name: 'Добавить совместную заметку по ссылке', callback: () => void this.joinPrompt() });
    this.addCommand({
      id: 'leave', name: 'Отвязать заметку от совместного редактирования',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const has = !!f && this.sessions.has(f.path);
        if (checking) return has;
        if (f) this.leave(f.path);
        return true;
      },
    });

    this.addCommand({ id: 'list', name: 'Показать совместные заметки', callback: () => new SharedListModal(this.app, this).open() });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText('');
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshBinding()));

    // переименование заметки — обновить ключи
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      if (this.settings.shared[oldPath]) {
        const info = this.settings.shared[oldPath];
        delete this.settings.shared[oldPath];
        this.settings.shared[file.path] = info;
        const s = this.sessions.get(oldPath);
        if (s) { this.sessions.delete(oldPath); s.file = file; this.sessions.set(file.path, s); }
        void this.saveSettings();
      }
    }));

    // восстановить сессии после перезапуска (переподключиться) + запустить синк vault
    this.app.workspace.onLayoutReady(() => {
      this.restoreSessions();
      if (this.settings.vault.enabled) void this.vaultSync.start();
    });

    this.addSettingTab(new CollabSettingTab(this.app, this));
  }

  private restoreSessions() {
    let changed = false;
    for (const [path, info] of Object.entries(this.settings.shared || {})) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) this.connect(file, info.docId, info.token, null, info.link);
      else { delete this.settings.shared[path]; changed = true; }
    }
    if (changed) void this.saveSettings();
    this.refreshBinding();
  }

  onunload() {
    this.vaultSync?.stop();
    this.sessions.forEach((s) => s.provider.destroy());
    this.sessions.clear();
  }

  // включить синк vault (создаёт vault-ключ, если его ещё нет)
  async enableVaultSync(): Promise<void> {
    if (!this.settings.vault.vaultId) {
      const base = this.serviceBase(); if (!base) return;
      try {
        const res = await requestUrl({ url: base + '/vault', method: 'POST' });
        const v = res.json as { vaultId: string; vaultToken: string };
        this.settings.vault.vaultId = v.vaultId; this.settings.vault.vaultToken = v.vaultToken; this.settings.vault.index = {};
      } catch (e) { new Notice('Не удалось создать vault: ' + (e as Error).message); return; }
    }
    this.settings.vault.enabled = true;
    await this.saveSettings();
    await this.vaultSync.start();
  }
  async disableVaultSync(): Promise<void> {
    this.settings.vault.enabled = false;
    await this.saveSettings();
    this.vaultSync.stop();
  }
  vaultKeyString(): string {
    return this.settings.vault.vaultId ? `${this.settings.vault.vaultId}:${this.settings.vault.vaultToken}` : '';
  }
  setVaultKey(key: string): boolean {
    const i = (key || '').indexOf(':');
    if (i <= 0) return false;
    const vaultId = key.slice(0, i), vaultToken = key.slice(i + 1);
    if (!vaultId || !vaultToken) return false;
    this.settings.vault = { enabled: true, vaultId, vaultToken, index: {} };
    return true;
  }

  private activeCM(): EditorView | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;
    // Obsidian отдаёт CM6 EditorView через editor.cm (нет в публичных типах)
    return (view.editor as { cm?: EditorView }).cm ?? null;
  }

  private wsBase(): string {
    return this.settings.serviceUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/ws';
  }

  async startSession(file: TFile) {
    // уже в совместном режиме → форма управления (закрыть / скопировать ссылку)
    const existing = this.sessions.get(file.path);
    if (existing) { new ResultModal(this.app, existing.link, () => this.leave(file.path), this.settings.shared[file.path]?.viewLink).open(); return; }

    const base = this.serviceBase();
    if (!base) return;
    let res: RequestUrlResponse;
    try { res = await requestUrl({ url: base + '/sessions', method: 'POST' }); }
    catch (e) { new Notice('Не удалось создать сессию: ' + (e as Error).message); return; }
    const body = res.json as { docId: string; token: string; link: string; ownerToken?: string; editLink?: string; viewLink?: string };
    const docId = body.docId;
    const ownerToken = body.ownerToken || body.token; // владелец «своей» заметки (fallback на старый сервер)
    const writerLink = body.editLink || body.link;    // ссылка для соавторов (можно править)
    const viewLink = body.viewLink;                   // ссылка для читателей

    await this.app.workspace.getLeaf(false).openFile(file);
    const content = await this.app.vault.read(file);
    this.connect(file, docId, ownerToken, content, writerLink); // подключаемся как owner

    this.settings.shared[file.path] = { docId, token: ownerToken, link: writerLink, viewLink };
    await this.saveSettings();

    try { await navigator.clipboard.writeText(writerLink); } catch { /* mobile */ }
    new ResultModal(this.app, writerLink, undefined, viewLink).open();
  }

  async joinPrompt(folder?: TFolder) {
    if (!this.serviceBase()) return; // сервер не задан — подсказка показана
    const dir = folder ? folder.path.replace(/\/+$/, '') : '';
    const hint = folder ? (dir === '' ? 'в корне хранилища' : dir) : undefined;
    new JoinModal(this.app, hint, async (link, noteName) => {
      const m = link.match(/\/e\/([^/#?]+)#(.+)$/);
      if (!m) { new Notice('Ссылка должна быть вида .../e/<id>#<token>'); return; }
      const [, docId, token] = m;

      // уже добавляли эту заметку → просто открыть существующую
      const existing = Object.entries(this.settings.shared).find(([, i]) => i.docId === docId);
      if (existing) {
        const ef = this.app.vault.getAbstractFileByPath(existing[0]);
        if (ef instanceof TFile) { await this.app.workspace.getLeaf(false).openFile(ef); new Notice('Эта совместная заметка уже добавлена'); return; }
      }

      const clean = (noteName || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\.md$/i, '');
      const base = clean || ('Совместная-' + docId.slice(0, 6));
      const at = (n: string) => (dir ? dir + '/' : '') + n + '.md';
      let path = at(base);
      for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = at(base + ' ' + i);

      // read-only (viewer) ссылка → разовая КОПИЯ в vault, БЕЗ привязки к чужому vault
      if (!canWriteToken(token)) {
        let content = '';
        try { content = await this.fetchDocContent(docId, token); } catch { /* оставим пустой */ }
        let file: TFile;
        try { file = await this.app.vault.create(path, content); }
        catch (e) { new Notice('Не удалось создать заметку: ' + (e as Error).message); return; }
        await this.app.workspace.getLeaf(false).openFile(file);
        new Notice('Заметка скопирована в хранилище (только чтение — статичная копия, без синхронизации)');
        return;
      }

      // writable (editor/owner) → живая совместная сессия
      let file: TFile;
      try { file = await this.app.vault.create(path, ''); }
      catch (e) { new Notice('Не удалось создать заметку: ' + (e as Error).message); return; }
      await this.app.workspace.getLeaf(false).openFile(file);
      this.connect(file, docId, token, null, link); // содержимое придёт с сервера
      this.settings.shared[file.path] = { docId, token, link };
      await this.saveSettings();
      new Notice('Подключено к совместной заметке');
    }).open();
  }

  // разово получить текст заметки с сервера (для read-only копии), затем отключиться
  private fetchDocContent(docId: string, token: string): Promise<string> {
    return new Promise((resolve) => {
      const ydoc = new Y.Doc();
      const provider = new WebsocketProvider(this.wsBase(), docId, ydoc, { params: { token } });
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        const text = ydoc.getText('body').toString();
        provider.destroy(); ydoc.destroy();
        resolve(text);
      };
      provider.on('sync', (isSynced: boolean) => { if (isSynced) finish(); });
      if (provider.synced) finish();
      window.setTimeout(finish, 8000); // не ждём вечно
    });
  }

  private connect(file: TFile, docId: string, token: string, seed: string | null, link: string) {
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(this.wsBase(), docId, ydoc, { params: { token } });
    const ytext = ydoc.getText('body');

    const name = this.settings.userName || ('Гость-' + Math.floor(Math.random() * 900 + 100));
    const color = colorFor(name);
    provider.awareness.setLocalStateField('user', { name, color, colorLight: color + '55' });

    const session: Session = { file, docId, link, ydoc, provider, ytext, synced: false, readOnly: !canWriteToken(token) };
    this.sessions.set(file.path, session);

    // Привязываем yCollab ТОЛЬКО после первичной синхронизации, иначе входящий с сервера
    // текст добавится поверх уже загруженного из файла → дублирование.
    const onSync = (isSynced: boolean) => {
      if (!isSynced || session.synced) return;
      session.synced = true;
      if (seed != null && ytext.length === 0) ytext.insert(0, seed); // первый участник — засеять
      this.bindActive(session); // ytext теперь актуален → выравниваем редактор по нему и связываем
    };
    provider.on('sync', onSync);
    if (provider.synced) onSync(true);

    provider.on('status', (e: { status: string }) => this.updateStatus(e.status === 'connected'));
    provider.awareness.on('change', () => this.updateStatus(provider.wsconnected));
  }

  // применить имя из настроек ко всем активным сессиям «на лету»
  applyUserName() {
    const name = this.settings.userName || ('Гость-' + Math.floor(Math.random() * 900 + 100));
    const color = colorFor(name);
    for (const s of this.sessions.values())
      s.provider.awareness.setLocalStateField('user', { name, color, colorLight: color + '55' });
  }

  private bindActive(session: Session) {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.path !== session.file.path) return;
    const cm = this.activeCM();
    if (!cm) return;
    this.alignEditor(cm, session.ytext);
    cm.dispatch({ effects: collab.reconfigure(this.collabExt(session)) });
  }

  // yCollab + (для viewer) режим только чтения редактора
  private collabExt(s: Session) {
    const base = yCollab(s.ytext, s.provider.awareness);
    return s.readOnly ? [base, EditorState.readOnly.of(true), EditorView.editable.of(false)] : base;
  }

  // выровнять содержимое редактора по ytext ДО привязки yCollab (сервер — источник истины);
  // это же лечит уже задвоенный текст: редактор перезаписывается чистой серверной копией.
  private alignEditor(cm: EditorView, ytext: Y.Text) {
    const cur = cm.state.doc.toString();
    const target = ytext.toString();
    if (cur !== target) cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: target } });
  }

  private refreshBinding() {
    const active = this.app.workspace.getActiveFile();
    const cm = this.activeCM();
    if (!cm) { this.updateStatus(false); return; }
    const s = active ? this.sessions.get(active.path) : undefined;
    if (s && s.synced) {
      this.alignEditor(cm, s.ytext);
      cm.dispatch({ effects: collab.reconfigure(this.collabExt(s)) });
    } else {
      cm.dispatch({ effects: collab.reconfigure([]) }); // нет сессии или ещё синхронизируется — свяжем в onSync
    }
    this.updateStatus(s ? s.provider.wsconnected : null);
  }

  private updateStatus(connected: boolean | null) {
    const active = this.app.workspace.getActiveFile();
    const s = active ? this.sessions.get(active.path) : undefined;
    if (!s) { this.statusEl.setText(''); return; }
    const peers = [...s.provider.awareness.getStates().values()].map((x: { user?: unknown }) => x.user).filter(Boolean).length;
    this.statusEl.setText('👥 ' + (connected ? 'на связи' : '…') + ' · ' + peers);
  }

  leave(path: string) {
    const s = this.sessions.get(path);
    if (s) { s.provider.destroy(); this.sessions.delete(path); }
    delete this.settings.shared[path];
    void this.saveSettings();
    this.refreshBinding();
    new Notice('Заметка отвязана от совместного редактирования (текст сохранён)');
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<CollabSettings> | null;
    this.settings = Object.assign({}, DEFAULTS, data);
    if (!this.settings.shared) this.settings.shared = {};
  }
  async saveSettings() { await this.saveData(this.settings); }

  // базовый URL сервиса или null (с подсказкой) — сервер задаёт пользователь в настройках
  private serviceBase(): string | null {
    const url = (this.settings.serviceUrl || '').trim().replace(/\/$/, '');
    if (!url) {
      new Notice('Сначала укажите адрес collab-сервиса: Settings → Collab Notes → URL сервиса');
      return null;
    }
    return url;
  }
}

// ---------- Полный синк хранилища (vault) ----------
// Каждая .md-заметка = Y.Doc в неймспейсе <vaultId>.<noteId>; список файлов — манифест-док
// <vaultId>.manifest (Y.Map noteId -> {path, deleted}). Мост файл↔CRDT: правки файла уходят в
// Y.Text минимальным диффом, правки CRDT пишутся в файл. Петли гасятся набором writing.
// Данные не теряются: удаление → в корзину, конфликт при join → сохраняется копия.
interface NoteConn { doc: Y.Doc; provider: WebsocketProvider; ytext: Y.Text; obs: () => void; timer: number | null; }
class VaultSync {
  private manifest: { doc: Y.Doc; provider: WebsocketProvider; files: Y.Map<{ path: string; deleted?: boolean }> } | null = null;
  private notes = new Map<string, NoteConn>(); // noteId -> соединение
  private writing = new Set<string>();          // пути, которые сейчас пишет синк (гасим watcher)
  private refs: EventRef[] = [];
  private ready = false;

  constructor(private plugin: CollabNotesPlugin) {}
  private get app(): App { return this.plugin.app; }
  private get s(): VaultSyncSettings { return this.plugin.settings.vault; }
  private wsBase(): string { return this.plugin.settings.serviceUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/ws'; }
  private ns(noteId: string): string { return this.s.vaultId + '.' + noteId; }
  private newId(): string { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  private pathToId(path: string): string | undefined { return Object.keys(this.s.index).find((id) => this.s.index[id] === path); }

  async start(): Promise<void> {
    if (this.manifest || !this.s.vaultId || !this.s.vaultToken || !this.plugin.settings.serviceUrl) return;
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(this.wsBase(), this.s.vaultId + '.manifest', doc, { params: { token: this.s.vaultToken } });
    const files = doc.getMap('files') as Y.Map<{ path: string; deleted?: boolean }>;
    this.manifest = { doc, provider, files };
    const onSync = (isSynced: boolean) => { if (isSynced && !this.ready) { this.ready = true; void this.reconcile(); } };
    provider.on('sync', onSync);
    if (provider.synced) onSync(true);
    files.observe(() => void this.onManifestChange());
    this.refs.push(this.app.vault.on('modify', (f) => { if (f instanceof TFile && f.extension === 'md') void this.onFileChanged(f); }));
    this.refs.push(this.app.vault.on('create', (f) => { if (this.ready && f instanceof TFile && f.extension === 'md') void this.onFileChanged(f); }));
    this.refs.push(this.app.vault.on('delete', (f) => { if (f instanceof TFile && f.extension === 'md') void this.onFileDeleted(f.path); }));
    this.refs.push(this.app.vault.on('rename', (f, oldPath) => { if (f instanceof TFile && f.extension === 'md') void this.onFileRenamed(f, oldPath); }));
    new Notice('Синхронизация хранилища включена');
  }

  stop(): void {
    for (const r of this.refs) this.app.vault.offref(r);
    this.refs = [];
    for (const [, n] of this.notes) { if (n.timer) window.clearTimeout(n.timer); n.ytext.unobserve(n.obs); n.provider.destroy(); n.doc.destroy(); }
    this.notes.clear();
    if (this.manifest) { this.manifest.provider.destroy(); this.manifest.doc.destroy(); this.manifest = null; }
    this.ready = false;
  }

  // начальная сверка локальных файлов и манифеста
  private async reconcile(): Promise<void> {
    if (!this.manifest) return;
    const files = this.manifest.files;
    for (const [noteId, meta] of files) {
      const local = this.app.vault.getAbstractFileByPath(meta.path);
      if (meta.deleted) {
        if (local instanceof TFile && this.s.index[noteId]) await this.trash(local);
        delete this.s.index[noteId];
        continue;
      }
      this.connectNote(noteId, meta.path);
    }
    const known = new Set<string>();
    for (const [, m] of files) if (!m.deleted) known.add(m.path);
    for (const f of this.app.vault.getMarkdownFiles()) if (!known.has(f.path)) await this.addLocalFile(f);
    await this.plugin.saveSettings();
  }

  // добавить локальный файл в vault (создать noteId + запись в манифесте + доку)
  private async addLocalFile(file: TFile): Promise<void> {
    if (!this.manifest || this.pathToId(file.path)) return;
    const noteId = this.newId();
    this.s.index[noteId] = file.path;
    this.manifest.files.set(noteId, { path: file.path });
    const content = await this.app.vault.read(file);
    this.connectNote(noteId, file.path, content);
    await this.plugin.saveSettings();
  }

  // подключить док заметки и связать с файлом
  private connectNote(noteId: string, path: string, seed?: string): void {
    if (this.notes.has(noteId)) return;
    this.s.index[noteId] = path;
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(this.wsBase(), this.ns(noteId), doc, { params: { token: this.s.vaultToken } });
    const ytext = doc.getText('body');
    const conn: NoteConn = { doc, provider, ytext, obs: () => {}, timer: null };
    conn.obs = () => this.scheduleWriteFile(noteId);
    this.notes.set(noteId, conn);

    let synced = false;
    const onSync = (isSynced: boolean) => {
      if (!isSynced || synced) return; synced = true;
      void this.onNoteSynced(noteId, path, ytext, seed);
      ytext.observe(conn.obs);
    };
    provider.on('sync', onSync);
    if (provider.synced) onSync(true);
  }

  // первичная сверка содержимого дока и файла
  private async onNoteSynced(noteId: string, path: string, ytext: Y.Text, seed?: string): Promise<void> {
    const remote = ytext.toString();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (ytext.length === 0) {
      // новый док → засеять содержимым файла
      const text = seed ?? (file instanceof TFile ? await this.app.vault.read(file) : '');
      if (text) applyTextToYText(ytext, text);
      if (!(file instanceof TFile)) await this.writeFile(path, text); // создать локально, если нет
      return;
    }
    if (file instanceof TFile) {
      const local = await this.app.vault.read(file);
      if (local !== remote) {
        // конфликт: сохраняем локальную версию копией, файл приводим к vault
        await this.saveConflictCopy(path, local);
        await this.writeFile(path, remote);
      }
    } else {
      await this.writeFile(path, remote); // нет локально → вытянуть из vault
    }
  }

  // файл изменён/создан → в Y.Text (мин. диффом)
  private async onFileChanged(file: TFile): Promise<void> {
    if (!this.ready || this.writing.has(file.path)) return;
    let noteId = this.pathToId(file.path);
    if (!noteId) { await this.addLocalFile(file); return; }
    const conn = this.notes.get(noteId);
    if (!conn) { this.connectNote(noteId, file.path); return; }
    const text = await this.app.vault.read(file);
    applyTextToYText(conn.ytext, text);
  }

  private async onFileDeleted(path: string): Promise<void> {
    if (!this.ready || this.writing.has(path)) return;
    const noteId = this.pathToId(path);
    if (!noteId || !this.manifest) return;
    this.manifest.files.set(noteId, { path, deleted: true });
    const conn = this.notes.get(noteId);
    if (conn) { if (conn.timer) window.clearTimeout(conn.timer); conn.ytext.unobserve(conn.obs); conn.provider.destroy(); conn.doc.destroy(); this.notes.delete(noteId); }
    delete this.s.index[noteId];
    await this.plugin.saveSettings();
  }

  private async onFileRenamed(file: TFile, oldPath: string): Promise<void> {
    if (!this.ready) return;
    const noteId = this.pathToId(oldPath);
    if (!noteId || !this.manifest) { void this.onFileChanged(file); return; }
    this.s.index[noteId] = file.path;
    this.manifest.files.set(noteId, { path: file.path });
    await this.plugin.saveSettings();
  }

  // манифест изменился на другом устройстве → применить создания/переименования/удаления локально
  private async onManifestChange(): Promise<void> {
    if (!this.ready || !this.manifest) return;
    for (const [noteId, meta] of this.manifest.files) {
      const knownPath = this.s.index[noteId];
      if (meta.deleted) {
        const f = this.app.vault.getAbstractFileByPath(meta.path);
        if (f instanceof TFile) await this.trash(f);
        if (knownPath) { const c = this.notes.get(noteId); if (c) { c.provider.destroy(); c.doc.destroy(); this.notes.delete(noteId); } delete this.s.index[noteId]; }
        continue;
      }
      if (knownPath && knownPath !== meta.path) { // переименование с другого устройства
        const f = this.app.vault.getAbstractFileByPath(knownPath);
        if (f instanceof TFile) { this.writing.add(meta.path); try { await this.app.fileManager.renameFile(f, meta.path); } catch { /* конфликт имени */ } finally { window.setTimeout(() => this.writing.delete(meta.path), 500); } }
        this.s.index[noteId] = meta.path;
      } else if (!knownPath) { // новая заметка с другого устройства
        this.connectNote(noteId, meta.path);
      }
    }
    await this.plugin.saveSettings();
  }

  // записать Y.Text заметки в файл (дебаунс)
  private scheduleWriteFile(noteId: string): void {
    const conn = this.notes.get(noteId);
    if (!conn) return;
    if (conn.timer) window.clearTimeout(conn.timer);
    conn.timer = window.setTimeout(() => { void this.writeFile(this.s.index[noteId], conn.ytext.toString()); }, 250);
  }

  private async writeFile(path: string, text: string): Promise<void> {
    if (!path) return;
    this.writing.add(path);
    try {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) { if ((await this.app.vault.read(f)) !== text) await this.app.vault.modify(f, text); }
      else { await this.ensureFolder(path); await this.app.vault.create(path, text); }
    } catch (e) { /* ignore */ }
    finally { window.setTimeout(() => this.writing.delete(path), 500); }
  }

  private async ensureFolder(path: string): Promise<void> {
    const dir = path.split('/').slice(0, -1).join('/');
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) { try { await this.app.vault.createFolder(dir); } catch { /* уже есть */ } }
  }

  private async saveConflictCopy(path: string, content: string): Promise<void> {
    const base = path.replace(/\.md$/i, '');
    const cp = `${base} (конфликт ${new Date().toISOString().slice(0, 10)}).md`;
    this.writing.add(cp);
    try { if (!this.app.vault.getAbstractFileByPath(cp)) await this.app.vault.create(cp, content); } catch { /* ignore */ }
    finally { window.setTimeout(() => this.writing.delete(cp), 500); }
  }

  private async trash(file: TFile): Promise<void> {
    this.writing.add(file.path);
    try { await this.app.vault.trash(file, false); } catch { /* ignore */ }
    finally { window.setTimeout(() => this.writing.delete(file.path), 500); }
  }
}

// Форма-результат (как в yc-pages): ссылка + копирование + QR + открыть/закрыть
class ResultModal extends Modal {
  constructor(app: App, private link: string, private onLeave?: () => void, private viewLink?: string) { super(app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle('Совместное редактирование');
    contentEl.createEl('p', {
      text: this.onLeave
        ? 'Заметка уже в совместном режиме. Можно скопировать ссылку ещё раз или закрыть совместное редактирование.'
        : 'Отправьте ссылку партнёру — он откроет её в браузере или добавит заметку в Obsidian.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl).setName('Ссылка')
      .addText((t) => {
        t.setValue(this.link);
        t.inputEl.readOnly = true;
        t.inputEl.addClass('collab-link-input');
        t.inputEl.onclick = () => t.inputEl.select();
      })
      .addExtraButton((b) => b.setIcon('copy').setTooltip('Скопировать ссылку (можно редактировать)').onClick(async () => {
        try { await navigator.clipboard.writeText(this.link); new Notice('Ссылка скопирована'); } catch { /* mobile */ }
      }));

    if (this.viewLink) {
      const vl = this.viewLink;
      new Setting(contentEl).setName('Ссылка «только чтение»')
        .setDesc('Партнёр сможет только читать, без правок.')
        .addExtraButton((b) => b.setIcon('copy').setTooltip('Скопировать read-only ссылку').onClick(async () => {
          try { await navigator.clipboard.writeText(vl); new Notice('Read-only ссылка скопирована'); } catch { /* mobile */ }
        }));
    }

    try {
      const qr = qrcode(0, 'M');
      qr.addData(this.link);
      qr.make();
      contentEl.createEl('img', { attr: { src: qr.createDataURL(5, 4), alt: 'QR' }, cls: 'collab-qr' });
    } catch { /* QR недоступен */ }

    const actions = new Setting(contentEl);
    actions.addButton((b) => b.setButtonText('Открыть в браузере').onClick(() => window.open(this.link)));
    if (this.onLeave) {
      const onLeave = this.onLeave;
      actions.addButton((b) => b.setButtonText('Отвязать заметку').onClick(() => { this.close(); onLeave(); }));
    }
    actions.addButton((b) => b.setButtonText('Закрыть').setCta().onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}

class JoinModal extends Modal {
  constructor(app: App, private folderHint: string | undefined, private onSubmit: (link: string, noteName: string) => void | Promise<void>) { super(app); }
  onOpen() {
    const { contentEl } = this;
    this.setTitle('Совместная заметка из ссылки');
    if (this.folderHint !== undefined) {
      contentEl.createEl('p', { text: 'Заметка будет создана ' + this.folderHint, cls: 'setting-item-description' });
    }

    contentEl.createEl('label', { text: 'Ссылка', cls: 'setting-item-description' });
    const link = contentEl.createEl('input', { attr: { placeholder: 'https://…/e/<id>#<token>' }, cls: 'collab-modal-input' });

    contentEl.createEl('label', { text: 'Имя заметки (необязательно)', cls: 'setting-item-description' });
    const name = contentEl.createEl('input', { attr: { placeholder: 'Совместная заметка' }, cls: 'collab-modal-input' });

    link.focus();
    const submit = () => { this.close(); void this.onSubmit(link.value.trim(), name.value); };
    new Setting(contentEl).addButton((b) => b.setButtonText('Создать и подключиться').setCta().onClick(submit));
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  onClose() { this.contentEl.empty(); }
}

// Список всех совместно редактируемых заметок
class SharedListModal extends Modal {
  constructor(app: App, private plugin: CollabNotesPlugin) { super(app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle('Совместные заметки');
    const entries = Object.entries(this.plugin.settings.shared);
    if (!entries.length) {
      contentEl.createEl('p', { text: 'Пока нет совместных заметок. ПКМ по заметке → «Совместное редактирование».', cls: 'setting-item-description' });
      return;
    }
    for (const [path, info] of entries) {
      const online = this.plugin.sessions.has(path);
      new Setting(contentEl)
        .setName((path.endsWith('.md') ? path.slice(0, -3) : path))
        .setDesc(online ? 'на связи' : 'не подключено')
        .addExtraButton((b) => b.setIcon('link').setTooltip('Открыть заметку').onClick(async () => {
          const f = this.app.vault.getAbstractFileByPath(path);
          if (f instanceof TFile) { await this.app.workspace.getLeaf(false).openFile(f); this.close(); }
          else new Notice('Заметка не найдена');
        }))
        .addExtraButton((b) => b.setIcon('copy').setTooltip('Скопировать ссылку').onClick(async () => {
          try { await navigator.clipboard.writeText(info.link); new Notice('Ссылка скопирована'); } catch { /* mobile */ }
        }))
        .addExtraButton((b) => b.setIcon('globe').setTooltip('Открыть в браузере').onClick(() => window.open(info.link)))
        .addExtraButton((b) => b.setIcon('unlink').setTooltip('Отвязать заметку').onClick(() => { this.plugin.leave(path); this.onOpen(); }));
    }
  }
  onClose() { this.contentEl.empty(); }
}

class CollabSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CollabNotesPlugin) { super(app, plugin); }

  // Декларативные настройки (Obsidian 1.13+) — попадают в поиск по настройкам.
  // display() ниже остаётся fallback'ом для более старых версий.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: 'URL сервиса',
        desc: 'Адрес вашего collab-сервиса (self-hosted, https рекомендуется). Без него шаринг недоступен. Инструкция — в README репозитория.',
        control: { key: 'serviceUrl', type: 'text', placeholder: 'https://collab.example.com' },
      },
      {
        name: 'Ваше имя',
        desc: 'Отображается у вашего курсора для других участников.',
        control: { key: 'userName', type: 'text', placeholder: 'Имя' },
      },
    ];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const v = typeof value === 'string' ? value.trim() : value;
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = v;
    await this.plugin.saveSettings();
    if (key === 'userName') this.plugin.applyUserName();
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const intro = containerEl.createEl('p', { cls: 'setting-item-description' });
    intro.appendText('Плагину нужен свой collab-сервер (self-hosted). Разверните его и укажите адрес ниже. Инструкция: ');
    intro.createEl('a', { text: 'README', attr: { href: 'https://github.com/delfinchiknakite-netizen/collab-notes-obsidian#self-hosting-the-server' } });
    intro.appendText('.');

    new Setting(containerEl).setName('URL сервиса')
      .setDesc('Адрес вашего collab-сервиса (https рекомендуется). Без него шаринг недоступен.')
      .addText((t) => t.setPlaceholder('https://collab.example.com').setValue(this.plugin.settings.serviceUrl)
        .onChange(async (v) => { this.plugin.settings.serviceUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Ваше имя').setDesc('Отображается у вашего курсора для других участников')
      .addText((t) => t.setPlaceholder('Имя').setValue(this.plugin.settings.userName)
        .onChange(async (v) => {
          this.plugin.settings.userName = v.trim();
          await this.plugin.saveSettings();
          this.plugin.applyUserName();
        }));

    // ---- синхронизация хранилища ----
    new Setting(containerEl).setName('Синхронизация хранилища (beta)').setHeading();
    const warn = containerEl.createEl('p', { cls: 'setting-item-description' });
    warn.appendText('Синхронизирует все .md-заметки между устройствами через ваш сервер. ⚠️ Бета — сделайте резервную копию хранилища. Вложения (картинки и т.п.) пока не синхронизируются. Данные не удаляются безвозвратно (в корзину), конфликты сохраняются копией.');

    const v = this.plugin.settings.vault;
    if (!v.enabled) {
      new Setting(containerEl).setName('Включить синхронизацию')
        .setDesc('Создаст «ключ хранилища» на вашем сервере и начнёт синк текущего vault.')
        .addButton((b) => b.setButtonText('Включить').setCta().onClick(async () => { await this.plugin.enableVaultSync(); this.display(); }));
      let keyInput = '';
      new Setting(containerEl).setName('…или подключить к существующему')
        .setDesc('Вставьте «ключ хранилища» с другого устройства, чтобы синхронизировать тот же vault.')
        .addText((t) => { t.setPlaceholder('vaultId:token'); t.onChange((val) => { keyInput = val.trim(); }); })
        .addButton((b) => b.setButtonText('Подключить').onClick(async () => {
          if (!this.plugin.setVaultKey(keyInput)) { new Notice('Неверный ключ (формат vaultId:token)'); return; }
          await this.plugin.saveSettings(); await this.plugin.vaultSync.start(); this.display();
        }));
    } else {
      new Setting(containerEl).setName('Синхронизация включена').setDesc('Заметок в индексе: ' + Object.keys(v.index).length)
        .addButton((b) => b.setButtonText('Выключить').onClick(async () => { await this.plugin.disableVaultSync(); this.display(); }));
      new Setting(containerEl).setName('Ключ хранилища')
        .setDesc('Скопируйте на другое устройство (Подключить к существующему), чтобы синхронизировать тот же vault. Держите ключ в секрете.')
        .addButton((b) => b.setButtonText('Скопировать ключ').onClick(async () => {
          try { await navigator.clipboard.writeText(this.plugin.vaultKeyString()); new Notice('Ключ хранилища скопирован'); } catch { /* mobile */ }
        }));
    }
  }
}
