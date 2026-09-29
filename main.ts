import {
  App, Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, MarkdownView, requestUrl,
} from 'obsidian';
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
// @ts-ignore — без типов
import qrcode from 'qrcode-generator';

interface SharedInfo { docId: string; token: string; link: string; }
interface CollabSettings {
  serviceUrl: string;
  userName: string;
  shared: Record<string, SharedInfo>; // path -> сессия (переживает перезапуск)
}
const DEFAULTS: CollabSettings = {
  serviceUrl: 'https://rt.av-tarasov.ru',
  userName: '',
  shared: {},
};

// один общий compartment на все редакторы: активной заметке с сессией — yCollab, остальным пусто
const collab = new Compartment();

interface Session {
  file: TFile;
  docId: string;
  link: string;
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  ytext: Y.Text;
  synced: boolean; // прошла первичная синхронизация с сервером
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

  async onload() {
    await this.loadSettings();
    this.registerEditorExtension([collab.of([])]);

    const collabTitle = (path: string) => (this.sessions.has(path) ? 'Совместное редактирование — управление' : 'Совместное редактирование');

    // ПКМ по заметке / по папке
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') {
        menu.addItem((i) => i.setTitle(collabTitle(file.path)).setIcon('users').onClick(() => this.startSession(file)));
      } else if (file instanceof TFolder) {
        // как «Новая доска Kanban / Canvas» — создать заметку из совместной ссылки прямо в папке
        menu.addItem((i) => i.setTitle('Создать совместную заметку из ссылки').setIcon('users').onClick(() => this.joinPrompt(file)));
      }
    }));

    // меню «•••» / три точки в открытой заметке
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      const file = (view as any)?.file as TFile | undefined;
      if (file && file.extension === 'md') {
        menu.addItem((i) => i.setTitle(collabTitle(file.path)).setIcon('users').onClick(() => this.startSession(file)));
      }
    }));

    this.addCommand({
      id: 'start', name: 'Совместное редактирование (активная заметка)',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (checking) return !!f && f.extension === 'md';
        if (f) this.startSession(f);
        return true;
      },
    });
    this.addCommand({ id: 'join', name: 'Добавить совместную заметку по ссылке', callback: () => this.joinPrompt() });
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
      if (this.settings.shared[oldPath]) {
        const info = this.settings.shared[oldPath];
        delete this.settings.shared[oldPath];
        this.settings.shared[(file as TFile).path] = info;
        const s = this.sessions.get(oldPath);
        if (s) { this.sessions.delete(oldPath); s.file = file as TFile; this.sessions.set((file as TFile).path, s); }
        this.saveSettings();
      }
    }));

    // восстановить сессии после перезапуска (переподключиться)
    this.app.workspace.onLayoutReady(() => this.restoreSessions());

    this.addSettingTab(new CollabSettingTab(this.app, this));
  }

  private restoreSessions() {
    let changed = false;
    for (const [path, info] of Object.entries(this.settings.shared || {})) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) this.connect(file, info.docId, info.token, null, info.link);
      else { delete this.settings.shared[path]; changed = true; }
    }
    if (changed) this.saveSettings();
    this.refreshBinding();
  }

  onunload() {
    this.sessions.forEach((s) => s.provider.destroy());
    this.sessions.clear();
  }

  private activeCM(): EditorView | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    // @ts-ignore — Obsidian отдаёт CM6 EditorView через editor.cm
    return (view && (view.editor as any)?.cm) || null;
  }

  private wsBase(): string {
    return this.settings.serviceUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/ws';
  }

  async startSession(file: TFile) {
    // уже в совместном режиме → форма управления (закрыть / скопировать ссылку)
    const existing = this.sessions.get(file.path);
    if (existing) { new ResultModal(this.app, existing.link, () => this.leave(file.path)).open(); return; }

    const base = this.settings.serviceUrl.replace(/\/$/, '');
    let res;
    try { res = await requestUrl({ url: base + '/sessions', method: 'POST' }); }
    catch (e) { new Notice('Не удалось создать сессию: ' + (e as Error).message); return; }
    const { docId, token, link } = res.json as { docId: string; token: string; link: string };

    await this.app.workspace.getLeaf(false).openFile(file);
    const content = await this.app.vault.read(file);
    this.connect(file, docId, token, content, link); // мы первые → засеиваем текущим содержимым

    this.settings.shared[file.path] = { docId, token, link };
    await this.saveSettings();

    try { await navigator.clipboard.writeText(link); } catch { /* mobile */ }
    new ResultModal(this.app, link).open();
  }

  async joinPrompt(folder?: TFolder) {
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

  private connect(file: TFile, docId: string, token: string, seed: string | null, link: string) {
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(this.wsBase(), docId, ydoc, { params: { token } });
    const ytext = ydoc.getText('body');

    const name = this.settings.userName || ('Гость-' + Math.floor(Math.random() * 900 + 100));
    const color = colorFor(name);
    provider.awareness.setLocalStateField('user', { name, color, colorLight: color + '55' });

    const session: Session = { file, docId, link, ydoc, provider, ytext, synced: false };
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

    provider.on('status', (e: any) => this.updateStatus(e.status === 'connected'));
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
    cm.dispatch({ effects: collab.reconfigure(yCollab(session.ytext, session.provider.awareness)) });
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
      cm.dispatch({ effects: collab.reconfigure(yCollab(s.ytext, s.provider.awareness)) });
    } else {
      cm.dispatch({ effects: collab.reconfigure([]) }); // нет сессии или ещё синхронизируется — свяжем в onSync
    }
    this.updateStatus(s ? s.provider.wsconnected : null);
  }

  private updateStatus(connected: boolean | null) {
    const active = this.app.workspace.getActiveFile();
    const s = active ? this.sessions.get(active.path) : undefined;
    if (!s) { this.statusEl.setText(''); return; }
    const peers = [...s.provider.awareness.getStates().values()].map((x: any) => x.user).filter(Boolean).length;
    this.statusEl.setText('👥 ' + (connected ? 'на связи' : '…') + ' · ' + peers);
  }

  leave(path: string) {
    const s = this.sessions.get(path);
    if (s) { s.provider.destroy(); this.sessions.delete(path); }
    delete this.settings.shared[path];
    this.saveSettings();
    this.refreshBinding();
    new Notice('Заметка отвязана от совместного редактирования (текст сохранён)');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    if (!this.settings.shared) this.settings.shared = {};
    // авто-миграция старых адресов: динамика (POST/WS) должна идти на rt.av-tarasov.ru,
    // а не на CDN collab.av-tarasov.ru (CDN не проксирует POST → 405) и не на старый sslip.
    const legacy = ['https://collab.av-tarasov.ru', 'http://collab.av-tarasov.ru', 'http://81-26-189-254.sslip.io', 'https://81-26-189-254.sslip.io'];
    if (legacy.includes((this.settings.serviceUrl || '').replace(/\/$/, ''))) {
      this.settings.serviceUrl = 'https://rt.av-tarasov.ru';
      await this.saveSettings();
    }
  }
  async saveSettings() { await this.saveData(this.settings); }
}

// Форма-результат (как в yc-pages): ссылка + копирование + QR + открыть/закрыть
class ResultModal extends Modal {
  constructor(app: App, private link: string, private onLeave?: () => void) { super(app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Совместное редактирование' });
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
      .addExtraButton((b) => b.setIcon('copy').setTooltip('Скопировать ссылку').onClick(async () => {
        try { await navigator.clipboard.writeText(this.link); new Notice('Ссылка скопирована'); } catch { /* mobile */ }
      }));

    try {
      const qr = qrcode(0, 'M');
      qr.addData(this.link);
      qr.make();
      contentEl.createEl('img', { attr: { src: qr.createDataURL(5, 4), alt: 'QR' }, cls: 'collab-qr' });
    } catch (e) { /* QR недоступен */ }

    const actions = new Setting(contentEl);
    actions.addButton((b) => b.setButtonText('Открыть в браузере').onClick(() => window.open(this.link)));
    if (this.onLeave) {
      actions.addButton((b) => b.setButtonText('Отвязать заметку').setWarning().onClick(() => { this.close(); this.onLeave!(); }));
    }
    actions.addButton((b) => b.setButtonText('Закрыть').setCta().onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}

class JoinModal extends Modal {
  constructor(app: App, private folderHint: string | undefined, private onSubmit: (link: string, noteName: string) => void) { super(app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Совместная заметка из ссылки' });
    if (this.folderHint !== undefined) {
      contentEl.createEl('p', { text: 'Заметка будет создана ' + this.folderHint, cls: 'setting-item-description' });
    }

    contentEl.createEl('label', { text: 'Ссылка', cls: 'setting-item-description' });
    const link = contentEl.createEl('input', { attr: { placeholder: 'https://…/e/<id>#<token>' }, cls: 'collab-modal-input' });

    contentEl.createEl('label', { text: 'Имя заметки (необязательно)', cls: 'setting-item-description' });
    const name = contentEl.createEl('input', { attr: { placeholder: 'Совместная заметка' }, cls: 'collab-modal-input' });

    link.focus();
    const submit = () => { this.close(); this.onSubmit(link.value.trim(), name.value); };
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
    contentEl.createEl('h3', { text: 'Совместные заметки' });
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
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Collab Notes' });
    new Setting(containerEl).setName('URL сервиса').setDesc('Адрес collab-сервиса (http/https)')
      .addText((t) => t.setPlaceholder('http://…sslip.io').setValue(this.plugin.settings.serviceUrl)
        .onChange(async (v) => { this.plugin.settings.serviceUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Ваше имя').setDesc('Отображается у вашего курсора для других участников')
      .addText((t) => t.setPlaceholder('Имя').setValue(this.plugin.settings.userName)
        .onChange(async (v) => {
          this.plugin.settings.userName = v.trim();
          await this.plugin.saveSettings();
          this.plugin.applyUserName();
        }));
  }
}
