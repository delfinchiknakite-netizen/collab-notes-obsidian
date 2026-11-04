import {
  App, Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, MarkdownView, requestUrl, RequestUrlResponse,
  SettingDefinitionItem,
} from 'obsidian';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { VaultSync } from './vault-sync';
import { DocCache } from './doc-cache';
import { canBindVault } from './sync-core';
// @ts-ignore — без типов
import qrcode from 'qrcode-generator';

interface SharedInfo { docId: string; token: string; link: string; viewLink?: string; server?: string; }
interface VaultSyncSettings {
  syncConfig?: boolean;
  enabled: boolean;
  vaultId: string;
  vaultToken: string;
  index: Record<string, string>; // noteId -> path (локальное зеркало манифеста)
}
interface AccountSettings {
  email: string;
  token: string; // сессионный токен (не пароль)
}
interface CollabSettings {
  boundVault?: string;
  serviceUrl: string;
  userName: string;
  shared: Record<string, SharedInfo>; // path -> сессия (переживает перезапуск)
  vault: VaultSyncSettings;           // полный синк хранилища между устройствами
  account: AccountSettings;           // аккаунт: вход по email/паролю привязывает vault к юзеру
}
const DEFAULTS: CollabSettings = {
  serviceUrl: '', // сервер не задан по умолчанию — пользователь указывает свой (self-hosted)
  userName: '',
  shared: {},
  vault: { enabled: false, vaultId: '', vaultToken: '', index: {} },
  account: { email: '', token: '' },
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
  cache?: DocCache;
  writing?: boolean;
  diskQueue?: Promise<void>;
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
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile)) return;
      const session = this.sessions.get(file.path);
      if (!session || !session.synced || session.readOnly || session.writing) return;
      void this.app.vault.read(file).then((text) => applyTextToYText(session.ytext, text)).catch((error: Error) => new Notice(error.message));
    }));
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
      if (this.settings.vault.enabled) void this.refreshAuth().then(() => this.vaultSync.start()).catch((error: Error) => { new Notice('Синхронизация не запущена: ' + error.message, 15000); });
    });

    this.addSettingTab(new CollabSettingTab(this.app, this));
  }

  private restoreSessions() {
    let changed = false;
    for (const [path, info] of Object.entries(this.settings.shared || {})) {
      if (info.server && info.server !== this.settings.serviceUrl.replace(/\/$/, '')) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) this.connect(file, info.docId, info.token, null, info.link);
      else { delete this.settings.shared[path]; changed = true; }
    }
    if (changed) void this.saveSettings();
    this.refreshBinding();
  }

  onunload() {
    void this.vaultSync?.stop().catch((error: Error) => console.error('Collab Notes shutdown:', error.message));
    this.sessions.forEach((s) => { s.provider.destroy(); void s.cache?.close(); s.ydoc.destroy(); });
    this.sessions.clear();
  }

  // включить синк vault (создаёт vault-ключ, если его ещё нет)
  async enableVaultSync(): Promise<void> {
    if (!await this.requireAccountServer()) return;
    if (!this.settings.vault.vaultId) {
      const base = this.serviceBase(); if (!base) return;
      try {
        const res = await requestUrl({ url: base + '/vault', method: 'POST' });
        const v = res.json as { vaultId: string; vaultToken: string };
        this.settings.vault.vaultId = v.vaultId; this.settings.vault.vaultToken = v.vaultToken; this.settings.vault.index = {};
      } catch (e) { new Notice('Не удалось создать vault: ' + (e as Error).message); return; }
    }
    const target = this.settings.serviceUrl.replace(/\/$/, '') + ':' + this.settings.vault.vaultId;
    const nonempty = this.app.vault.getFiles().length > 0;
    if (!canBindVault(this.settings.boundVault, target, nonempty)) {
      new Notice('Это локальное хранилище уже привязано к другому аккаунту или серверу. Откройте отдельный пустой vault.', 15000);
      return;
    }
    const enable = async () => {
      this.settings.boundVault = target;
      this.settings.vault.enabled = true;
      await this.saveSettings();
      await this.vaultSync.start();
    };
    await new Promise<void>((resolve) => new SyncConsentModal(this.app, this.settings.account.email || this.settings.vault.vaultId, this.app.vault.getFiles().length, enable, resolve).open());
  }
  async disableVaultSync(): Promise<void> {
    this.settings.vault.enabled = false;
    await this.saveSettings();
    await this.vaultSync.stop();
  }
  async updateServiceUrl(value: string): Promise<void> {
    const next = value.trim().replace(/\/$/, '');
    const previous = this.settings.serviceUrl.replace(/\/$/, '');
    if (next === previous) return;
    await this.disableVaultSync();
    for (const [path, session] of this.sessions) {
      if (this.settings.shared[path]) this.settings.shared[path].server = previous;
      session.provider.destroy(); await session.cache?.close(); session.ydoc.destroy();
    }
    this.sessions.clear(); this.refreshBinding();
    this.settings.serviceUrl = next;
    this.settings.account = { email: '', token: '' };
    this.settings.vault = { enabled: false, vaultId: '', vaultToken: '', index: {} };
    await this.saveSettings();
  }
  vaultKeyString(): string {
    return this.settings.vault.vaultId ? `${this.settings.vault.vaultId}:${this.settings.vault.vaultToken}` : '';
  }

  // ---------- аккаунты ----------
  isLoggedIn(): boolean { return !!this.settings.account.token; }
  private async requireAccountServer(): Promise<boolean> {
    const base = this.serviceBase(); if (!base) return false;
    try {
      const url = new URL(base);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        new Notice('Для аккаунтов и синхронизации нужен HTTPS. HTTP разрешён только на localhost.', 15000);
        return false;
      }
      const res = await requestUrl({ url: base + '/capabilities', method: 'GET', throw: false });
      if (res.status !== 200 || (res.json as { protocol?: number }).protocol !== 2) {
        new Notice('Обновите сервер до версии 2.6.0 с протоколом 2 перед включением синхронизации.', 15000);
        return false;
      }
      return true;
    } catch { new Notice('Сервис недоступен или не поддерживает безопасный синк. Проверьте URL и версию сервера.', 15000); return false; }
  }

  // общий обработчик ответа /auth/{register,login}: сохранить сессию + привязать vault + включить синк
  private async applyAuth(data: { userId: string; token: string; email: string; vaultId: string; vaultToken: string }): Promise<void> {
    await this.suspendAccountSessions();
    this.settings.account = { email: data.email, token: data.token };
    // если vault сменился (другой аккаунт) — сбросить локальное зеркало манифеста
    const sameVault = this.settings.vault.vaultId === data.vaultId;
    await this.vaultSync.stop();
    this.settings.vault = { enabled: false, vaultId: data.vaultId, vaultToken: data.vaultToken, index: sameVault ? this.settings.vault.index : {}, syncConfig: this.settings.vault.syncConfig };
    await this.saveSettings();
    new Notice('Вход выполнен. Синхронизация выключена: включите её отдельно после проверки локального хранилища.', 15000);
  }
  async authRegister(email: string, password: string): Promise<void> {
    if (!await this.requireAccountServer()) return;
    const base = this.serviceBase(); if (!base) { new Notice('Сначала укажите адрес сервера'); return; }
    const res = await requestUrl({ url: base + '/auth/register', method: 'POST', contentType: 'application/json', body: JSON.stringify({ email, password }), throw: false });
    if (res.status >= 400) { new Notice('Регистрация: ' + ((res.json as { error?: string })?.error || res.status)); return; }
    new Notice('Аккаунт создан. Подтвердите email кодом из письма, затем войдите.', 15000);
  }
  async authLogin(email: string, password: string): Promise<void> {
    if (!await this.requireAccountServer()) return;
    const base = this.serviceBase(); if (!base) { new Notice('Сначала укажите адрес сервера'); return; }
    const res = await requestUrl({ url: base + '/auth/login', method: 'POST', contentType: 'application/json', body: JSON.stringify({ email, password }), throw: false });
    if (res.status >= 400) { new Notice('Вход: ' + ((res.json as { error?: string })?.error || res.status)); return; }
    await this.applyAuth(res.json as { userId: string; token: string; email: string; vaultId: string; vaultToken: string });
    new Notice('Вход выполнен');
  }
  async authLogout(): Promise<void> {
    await this.suspendAccountSessions();
    await this.vaultSync.stop();
    this.settings.account = { email: '', token: '' };
    this.settings.vault = { enabled: false, vaultId: '', vaultToken: '', index: {} };
    await this.saveSettings();
    new Notice('Вы вышли из аккаунта');
  }
  private async suspendAccountSessions(): Promise<void> {
    for (const [path, session] of this.sessions) {
      const info = this.settings.shared[path];
      if (!info?.token.startsWith('accountvault.')) continue;
      session.provider.destroy();
      await session.cache?.close();
      session.ydoc.destroy();
      this.sessions.delete(path);
      delete this.settings.shared[path];
    }
    this.refreshBinding();
  }
  async authAction(action: string, email: string, code = '', password = ''): Promise<void> {
    if (!await this.requireAccountServer()) return;
    const base = this.serviceBase(); if (!base) return;
    try {
      const res = await requestUrl({ url: base + '/auth/' + action, method: 'POST', contentType: 'application/json', body: JSON.stringify({ email, code, password }), throw: false });
      const data = res.json as { message?: string; error?: string };
      new Notice(data.error || data.message || 'Запрос выполнен', 15000);
    } catch { new Notice('Сервис недоступен. Повторите позже'); }
  }
  // при запуске обновить vault-токен по сессии (перевыпускается, не протухает пока жив аккаунт)
  async refreshAuth(): Promise<void> {
    if (!this.settings.account.token) return;
    const base = this.serviceBase(); if (!base) return;
    try {
      const res = await requestUrl({ url: base + '/auth/me', headers: { Authorization: 'Bearer ' + this.settings.account.token }, method: 'GET', throw: false });
      if (res.status === 401 || res.status === 403) {
        this.settings.vault.enabled = false;
        await this.saveSettings();
        new Notice('Сессия аккаунта истекла. Войдите заново', 15000);
        return;
      }
      if (res.status >= 400) throw new Error('Сервис аккаунтов недоступен');
      const d = res.json as { vaultId: string; vaultToken: string; email: string; token?: string };
      this.settings.vault.vaultId = d.vaultId; this.settings.vault.vaultToken = d.vaultToken;
      if (d.token) this.settings.account.token = d.token;
      for (const [path, info] of Object.entries(this.settings.shared)) {
        if (info.token.startsWith('accountvault.') && info.docId.startsWith(d.vaultId + '.')) {
          info.token = d.vaultToken;
          const session = this.sessions.get(path);
          if (session) {
            const url = new URL(session.provider.url); url.searchParams.set('token', d.vaultToken);
            session.provider.url = url.toString(); session.provider.disconnect(); session.provider.connect();
          }
        }
      }
      this.settings.account.email = d.email;
      await this.saveSettings();
    } catch { /* офлайн — используем сохранённый токен */ }
  }
  setVaultKey(key: string): boolean {
    const i = (key || '').indexOf(':');
    if (i <= 0) return false;
    const vaultId = key.slice(0, i), vaultToken = key.slice(i + 1);
    if (!vaultId || !vaultToken) return false;
    if (!/^[\w-]+$/.test(vaultId) || !/^(vault\.|accountvault\.)/.test(vaultToken)) return false;
    this.settings.vault = { enabled: false, vaultId, vaultToken, index: {} };
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
    const vaultDoc = this.vaultSync.documentId(file.path);
    if (vaultDoc) {
      try {
        const url = base + '/access/' + encodeURIComponent(vaultDoc) + '?token=' + encodeURIComponent(this.settings.vault.vaultToken);
        const create = async (role: string) => (await requestUrl({ url, method: 'POST', contentType: 'application/json', body: JSON.stringify({ role, days: 30 }) })).json as { link: string };
        const edit = await create('editor'), view = await create('viewer');
        this.settings.shared[file.path] = { docId: vaultDoc, token: this.settings.vault.vaultToken, link: edit.link, viewLink: view.link };
        await this.saveSettings();
        this.connect(file, vaultDoc, this.settings.vault.vaultToken, null, edit.link);
        new ResultModal(this.app, edit.link, undefined, view.link).open();
      } catch { new Notice('Не удалось выдать ссылку. Проверьте подключение и аккаунт'); }
      return;
    }
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
        try { content = await this.fetchDocContent(docId, token); }
        catch { new Notice('Не удалось загрузить заметку: проверьте ссылку и подключение. Пустая копия не создана.', 15000); return; }
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
    return new Promise((resolve, reject) => {
      const ydoc = new Y.Doc();
      const provider = new WebsocketProvider(this.wsBase(), docId, ydoc, { params: { token } });
      let done = false;
      let timeout: number;
      const finish = (ok: boolean) => {
        if (done) return; done = true;
        window.clearTimeout(timeout);
        const text = ydoc.getText('body').toString();
        provider.destroy(); ydoc.destroy();
        if (ok) resolve(text); else reject(new Error('Не удалось загрузить заметку'));
      };
      provider.on('sync', (isSynced: boolean) => { if (isSynced) finish(true); });
      timeout = window.setTimeout(() => finish(false), 15000);
      if (provider.synced) finish(true);
    });
  }

  private connect(file: TFile, docId: string, token: string, seed: string | null, link: string) {
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(this.wsBase(), docId, ydoc, { params: { token }, connect: false, disableBc: true });
    const ytext = ydoc.getText('body');

    const name = this.settings.userName || ('Гость-' + Math.floor(Math.random() * 900 + 100));
    const color = colorFor(name);
    provider.awareness.setLocalStateField('user', { name, color, colorLight: color + '55' });

    const session: Session = { file, docId, link, ydoc, provider, ytext, synced: false, readOnly: !canWriteToken(token) };
    this.sessions.set(file.path, session);
    let hadCache = false;
    ytext.observe(() => {
      if (!session.synced) return;
      session.diskQueue = (session.diskQueue || Promise.resolve()).then(async () => {
        if (this.sessions.get(session.file.path) !== session) return;
        const target = ytext.toString();
        if (await this.app.vault.read(session.file) === target) return;
        session.writing = true;
        try { await this.app.vault.modify(session.file, target); } finally { session.writing = false; }
      }).catch((error: Error) => { new Notice('Ошибка записи заметки: ' + error.message); });
    });

    // Привязываем yCollab ТОЛЬКО после первичной синхронизации, иначе входящий с сервера
    // текст добавится поверх уже загруженного из файла → дублирование.
    let initializing = false;
    const onSync = (isSynced: boolean) => {
      if (!isSynced || session.synced || initializing) return;
      initializing = true;
      if (seed != null && ytext.length === 0) ytext.insert(0, seed); // первый участник — засеять
      void (async () => {
        const local = await this.app.vault.read(session.file);
        if (local !== ytext.toString() && !hadCache && seed === null && local) {
          const copy = session.file.path.replace(/\.md$/i, '') + ' (конфликт ' + crypto.randomUUID() + ').md';
          await this.app.vault.create(copy, local);
        }
        session.writing = true;
        try { await this.app.vault.modify(session.file, ytext.toString()); } finally { session.writing = false; }
        session.synced = true;
        this.bindActive(session);
      })().catch((error: Error) => { initializing = false; new Notice('Ошибка совместной заметки: ' + error.message); });
    };
    provider.on('sync', onSync);
    if (provider.synced) onSync(true);

    provider.on('status', (e: { status: string }) => this.updateStatus(e.status === 'connected'));
    provider.awareness.on('change', () => this.updateStatus(provider.wsconnected));
    void (async () => {
      const opened = await DocCache.open(this.app.vault.adapter, this.app.vault.configDir + '/plugins/' + this.manifest.id + '/.collab-sync/shared', this.settings.serviceUrl + ':' + docId, ydoc,
        (error) => new Notice('Не сохранён офлайн-кэш: ' + error.message, 15000));
      if (this.sessions.get(file.path) !== session) { await opened.cache.close(); ydoc.destroy(); return; }
      if (opened.loaded && !session.readOnly) {
        hadCache = true;
        applyTextToYText(ytext, await this.app.vault.read(session.file));
        await opened.cache.flush();
        session.synced = true;
        this.bindActive(session);
      }
      session.cache = opened.cache;
      if (seed !== null && !opened.loaded) { applyTextToYText(ytext, seed); await opened.cache.flush(); }
      provider.connect();
    })().catch((error: Error) => new Notice('Не удалось открыть совместную заметку: ' + error.message, 15000));
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
    if (s) { s.provider.destroy(); void s.cache?.close(); s.ydoc.destroy(); this.sessions.delete(path); }
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
class SyncConsentModal extends Modal {
  constructor(app: App, private account: string, private count: number, private accept: () => Promise<void>, private done: () => void) { super(app); }
  onOpen() {
    this.setTitle('Подключить синхронизацию?');
    this.contentEl.createEl('p', { text: `Аккаунт/хранилище: ${this.account}. Локальных файлов: ${this.count}. Файлы этого vault будут отправлены на сервер, удалённые — загружены сюда. Для другого аккаунта используйте отдельный пустой vault. Сделайте резервную копию.` });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Отмена').onClick(() => this.close()))
      .addButton((b) => b.setButtonText('Подключить этот vault').setCta().onClick(() => {
        b.setDisabled(true);
        void this.accept().then(() => this.close()).catch((error: Error) => { new Notice(error.message); b.setDisabled(false); });
      }));
  }
  onClose() { this.contentEl.empty(); this.done(); }
}

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
    if (key === 'serviceUrl' && typeof v === 'string') { await this.plugin.updateServiceUrl(v); return; }
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

    let serviceInput = this.plugin.settings.serviceUrl;
    new Setting(containerEl).setName('URL сервиса')
      .setDesc('Адрес вашего collab-сервиса (https рекомендуется). Без него шаринг недоступен.')
      .addText((t) => t.setPlaceholder('https://collab.example.com').setValue(this.plugin.settings.serviceUrl)
        .onChange((v) => { serviceInput = v.trim(); }))
      .addButton((b) => b.setButtonText('Применить URL').onClick(() => {
        void this.plugin.updateServiceUrl(serviceInput).then(() => this.display()).catch((error: Error) => { new Notice(error.message); });
      }));
    new Setting(containerEl).setName('Ваше имя').setDesc('Отображается у вашего курсора для других участников')
      .addText((t) => t.setPlaceholder('Имя').setValue(this.plugin.settings.userName)
        .onChange(async (v) => {
          this.plugin.settings.userName = v.trim();
          await this.plugin.saveSettings();
          this.plugin.applyUserName();
        }));

    // ---- аккаунт ----
    new Setting(containerEl).setName('Аккаунт').setHeading();
    if (this.plugin.isLoggedIn()) {
      new Setting(containerEl).setName('Вы вошли')
        .setDesc(this.plugin.settings.account.email + ' — синхронизация включается отдельно ниже. Для разных аккаунтов используйте разные локальные vault.')
        .addButton((b) => b.setButtonText('Выйти').onClick(async () => { await this.plugin.authLogout(); this.display(); }));
    } else {
      const acctDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
      acctDesc.appendText('После регистрации подтвердите email кодом из письма. Вход не включает синхронизацию автоматически. На другом устройстве войдите тем же аккаунтом в отдельном пустом vault.');
      let em = '', pw = '', code = '';
      new Setting(containerEl).setName('Email')
        .addText((t) => { t.setPlaceholder('you@example.com').inputEl.type = 'email'; t.onChange((val) => { em = val.trim(); }); });
      new Setting(containerEl).setName('Пароль').setDesc('Для регистрации и сброса — минимум 12 символов.')
        .addText((t) => { t.inputEl.type = 'password'; t.setPlaceholder('••••••'); t.onChange((val) => { pw = val; }); });
      new Setting(containerEl)
        .addButton((b) => b.setButtonText('Войти').setCta().onClick(async () => { await this.plugin.authLogin(em, pw); this.display(); }))
        .addButton((b) => b.setButtonText('Регистрация').onClick(async () => { await this.plugin.authRegister(em, pw); this.display(); }));
      new Setting(containerEl).setName('Код из письма').addText((t) => t.onChange((value) => { code = value.trim(); }));
      new Setting(containerEl)
        .addButton((b) => b.setButtonText('Подтвердить email').onClick(() => void this.plugin.authAction('verify', em, code)))
        .addButton((b) => b.setButtonText('Повторить письмо').onClick(() => void this.plugin.authAction('resend-verification', em)))
        .addButton((b) => b.setButtonText('Восстановить пароль').onClick(() => void this.plugin.authAction('forgot-password', em)))
        .addButton((b) => b.setButtonText('Сменить пароль по коду').onClick(() => void this.plugin.authAction('reset-password', em, code, pw)));
    }

    // ---- синхронизация хранилища ----
    new Setting(containerEl).setName('Синхронизация хранилища (beta)').setHeading();
    const warn = containerEl.createEl('p', { cls: 'setting-item-description' });
    warn.appendText('Заметки, вложения, Canvas и Bases синхронизируются. Настройки, темы и код плагинов — по отдельному согласию. Конфликтующие вложения сохраняются отдельными копиями; удаления — в корзину. Файлы больше 20 MiB пропускаются с уведомлением. Сделайте резервную копию.');
    new Setting(containerEl).setName('Настройки, темы и плагины')
      .setDesc('Синхронизирует .obsidian, кроме workspace, кэша, данных плагинов и самого Collab Notes. Код плагинов может выполняться на другом устройстве. После получения настроек перезапустите Obsidian. Выключите синк перед изменением опции.')
      .addToggle((toggle) => toggle.setValue(!!this.plugin.settings.vault.syncConfig).setDisabled(this.plugin.settings.vault.enabled).onChange(async (value) => { this.plugin.settings.vault.syncConfig = value; await this.plugin.saveSettings(); }));

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
          await this.plugin.saveSettings(); await this.plugin.enableVaultSync(); this.display();
        }));
    } else {
      new Setting(containerEl).setName('Синхронизация включена').setDesc('Файлов в активном индексе: ' + this.plugin.vaultSync.fileCount())
        .addButton((b) => b.setButtonText('Выключить').onClick(async () => { await this.plugin.disableVaultSync(); this.display(); }));
      new Setting(containerEl).setName('Ключ хранилища')
        .setDesc('Скопируйте на другое устройство (Подключить к существующему), чтобы синхронизировать тот же vault. Держите ключ в секрете.')
        .addButton((b) => b.setButtonText('Скопировать ключ').onClick(async () => {
          try { await navigator.clipboard.writeText(this.plugin.vaultKeyString()); new Notice('Ключ хранилища скопирован'); } catch { /* mobile */ }
        }));
    }
  }
}
