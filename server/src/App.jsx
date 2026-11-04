import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, drawSelection, placeholder, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle, foldGutter } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { markdown } from "@codemirror/lang-markdown";
import { yCollab } from "y-codemirror.next";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import mark from "markdown-it-mark";
const NAMES = ["\u0410\u043D\u044F", "\u0411\u043E\u0440\u0438\u0441", "\u0412\u0435\u0440\u0430", "\u0413\u043B\u0435\u0431", "\u0414\u0430\u0448\u0430", "\u0415\u0433\u043E\u0440"];
const ACCENT = "#7c6cd9";
const API = import.meta.env.VITE_API_BASE || location.origin;
const WS_BASE = API.replace(/^http/, "ws") + "/ws";
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true }).use(taskLists, { enabled: true, label: true }).use(mark);
const TASK_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/gm;
function toggleTaskInText(ytext, ydoc, idx) {
  const text = ytext.toString();
  TASK_RE.lastIndex = 0;
  let m, n = 0;
  while ((m = TASK_RE.exec(text)) !== null) {
    if (n === idx) {
      const pos = m.index + m[1].length + 1;
      const next = text[pos] === " " ? "x" : " ";
      ydoc.transact(() => {
        ytext.delete(pos, 1);
        ytext.insert(pos, next);
      });
      return;
    }
    n++;
  }
}
const CALLOUT_ICON = {
  note: "\u2139\uFE0F",
  info: "\u2139\uFE0F",
  abstract: "\u{1F4C4}",
  summary: "\u{1F4C4}",
  tldr: "\u{1F4C4}",
  tip: "\u{1F4A1}",
  hint: "\u{1F4A1}",
  important: "\u{1F4A1}",
  success: "\u2705",
  check: "\u2705",
  done: "\u2705",
  question: "\u2753",
  help: "\u2753",
  faq: "\u2753",
  warning: "\u26A0\uFE0F",
  caution: "\u26A0\uFE0F",
  attention: "\u26A0\uFE0F",
  failure: "\u274C",
  fail: "\u274C",
  missing: "\u274C",
  danger: "\u{1F6D1}",
  error: "\u{1F6D1}",
  bug: "\u{1F41E}",
  example: "\u{1F4CB}",
  quote: "\u275D",
  cite: "\u275D",
  todo: "\u2611\uFE0F"
};
const CALLOUT_COLOR = {
  note: "#448aff",
  info: "#448aff",
  abstract: "#00b0ff",
  summary: "#00b0ff",
  tldr: "#00b0ff",
  tip: "#00bfa5",
  hint: "#00bfa5",
  important: "#00bfa5",
  success: "#2ec16b",
  check: "#2ec16b",
  done: "#2ec16b",
  question: "#e6b800",
  help: "#e6b800",
  faq: "#e6b800",
  warning: "#e08d00",
  caution: "#e08d00",
  attention: "#e08d00",
  failure: "#e5484d",
  fail: "#e5484d",
  missing: "#e5484d",
  danger: "#e5484d",
  error: "#e5484d",
  bug: "#e5484d",
  example: "#7c4dff",
  quote: "#9e9e9e",
  cite: "#9e9e9e",
  todo: "#448aff"
};
function renderMarkdown(text) {
  let html = md.render(text);
  html = html.replace(/<blockquote>\s*([\s\S]*?)<\/blockquote>/g, (whole, inner) => {
    const m = inner.match(/^\s*<p>\s*\[!([\w-]+)\][+-]?\s*([^\n<]*)/);
    if (!m) return whole;
    const type = m[1].toLowerCase();
    const title = m[2].trim();
    const icon = CALLOUT_ICON[type] || "\u2139\uFE0F";
    const color = CALLOUT_COLOR[type] || "#448aff";
    let body = inner.replace(/^\s*<p>\s*\[![\w-]+\][+-]?\s*[^\n<]*(<br>\s*\n?)?/, "<p>").replace(/<p>\s*<\/p>/g, "");
    return '<div class="ycp-callout" style="--cc:' + color + '"><div class="ycp-callout-title"><span class="ycp-callout-ic">' + icon + "</span>" + (title || type) + "</div>" + (body.trim() ? '<div class="ycp-callout-body">' + body + "</div>" : "") + "</div>";
  });
  return html;
}
const obsidianHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.8em", fontWeight: "700", lineHeight: "1.35" },
  { tag: t.heading2, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.35" },
  { tag: t.heading3, fontSize: "1.28em", fontWeight: "700" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "#999" },
  { tag: [t.link, t.url], color: ACCENT, textDecoration: "underline" },
  { tag: t.quote, color: "#8a8f98" },
  { tag: t.monospace, fontFamily: "ui-monospace, Menlo, monospace", color: "#c0341d" },
  { tag: t.processingInstruction, color: "#b9bcc4" },
  // markdown-разметка: #, **, -, >
  { tag: t.list, color: ACCENT }
]);
const editorTheme = EditorView.theme({
  "&": { fontSize: "17px", color: "#2e3338", backgroundColor: "#fff", height: "100%" },
  ".cm-scroller": { fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif', lineHeight: "1.7", overflow: "auto" },
  ".cm-content": { maxWidth: "740px", margin: "0 auto", padding: "28px 0 40vh", caretColor: ACCENT },
  ".cm-line": { padding: "0 12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: ACCENT, borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#e7e3f9" },
  ".cm-placeholder": { color: "#b0b4bb" }
});
const codeTheme = EditorView.theme({
  "&": { fontSize: "14px", color: "#24292e", backgroundColor: "#fff", height: "100%" },
  ".cm-scroller": { fontFamily: "ui-monospace, Menlo, Consolas, monospace", lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { padding: "8px 0", caretColor: ACCENT },
  ".cm-gutters": { backgroundColor: "#fafbfc", color: "#b0b4bb", border: "none" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: ACCENT },
  ".cm-activeLine": { backgroundColor: "#f6f8fa" },
  ".cm-activeLineGutter": { backgroundColor: "#eef1f4", color: "#8a8f98" },
  ".cm-placeholder": { color: "#b0b4bb" }
});
const obsidianAppearance = [EditorView.lineWrapping, syntaxHighlighting(obsidianHighlight), editorTheme];
const codeAppearance = [
  EditorView.lineWrapping,
  lineNumbers(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  foldGutter(),
  syntaxHighlighting(defaultHighlightStyle),
  codeTheme
];
const appearance = new Compartment();
function surround(view, before, after) {
  const s = view.state.selection.main;
  const sel = view.state.sliceDoc(s.from, s.to);
  view.dispatch({
    changes: { from: s.from, to: s.to, insert: before + sel + after },
    selection: { anchor: s.from + before.length, head: s.from + before.length + sel.length }
  });
  view.focus();
}
function prefixLines(view, prefix) {
  const { state } = view;
  const s = state.selection.main;
  const from = state.doc.lineAt(s.from).number;
  const to = state.doc.lineAt(s.to).number;
  const changes = [];
  for (let n = from; n <= to; n++) changes.push({ from: state.doc.line(n).from, insert: prefix });
  view.dispatch({ changes });
  view.focus();
}
const FMT = [
  { t: "\u0416", title: "\u0416\u0438\u0440\u043D\u044B\u0439  (Ctrl+B)", style: { fontWeight: 700 }, run: (v) => surround(v, "**", "**") },
  { t: "\u041A", title: "\u041A\u0443\u0440\u0441\u0438\u0432  (Ctrl+I)", style: { fontStyle: "italic" }, run: (v) => surround(v, "*", "*") },
  { t: "S", title: "\u0417\u0430\u0447\u0451\u0440\u043A\u043D\u0443\u0442\u044B\u0439", style: { textDecoration: "line-through" }, run: (v) => surround(v, "~~", "~~") },
  { t: "</>", title: "\u041C\u043E\u043D\u043E\u0448\u0438\u0440\u0438\u043D\u043D\u044B\u0439 \u043A\u043E\u0434", run: (v) => surround(v, "`", "`") },
  { sep: true },
  { t: "H", title: "\u0417\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A", run: (v) => prefixLines(v, "# ") },
  { t: "\u2022", title: "\u041C\u0430\u0440\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A", run: (v) => prefixLines(v, "- ") },
  { t: "\u2611", title: "\u0427\u0435\u043A-\u043B\u0438\u0441\u0442", run: (v) => prefixLines(v, "- [ ] ") },
  { t: "\u275D", title: "\u0426\u0438\u0442\u0430\u0442\u0430", run: (v) => prefixLines(v, "> ") },
  { t: "\u{1F517}", title: "\u0421\u0441\u044B\u043B\u043A\u0430", run: (v) => surround(v, "[", "](https://)") }
];
const MODES = [
  { id: "edit", icon: "\u270F\uFE0F", label: "\u041F\u0440\u0430\u0432\u043A\u0430" },
  { id: "split", icon: "\u25A4", label: "\u0421\u043F\u043B\u0438\u0442" },
  { id: "preview", icon: "\u{1F4D6}", label: "\u0427\u0442\u0435\u043D\u0438\u0435" }
];
function parseUrl() {
  const m = location.pathname.match(/^\/e\/([^/]+)/);
  return { docId: m ? decodeURIComponent(m[1]) : null, token: location.hash.slice(1) };
}
const ROLE_LABEL = { owner: "\u0432\u043B\u0430\u0434\u0435\u043B\u0435\u0446", editor: "\u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440", viewer: "\u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u0435\u043D\u0438\u0435" };
function roleFromToken(token) {
  const r = (token || "").split(".")[0];
  if (r === "view") return "viewer";
  if (r === "edit") return "editor";
  return ["owner", "editor", "viewer"].includes(r) ? r : "editor";
}
function expFromToken(token) {
  const p = (token || "").split(".");
  const exp = p.length === 4 ? p[2] : p.length === 3 ? p[1] : null;
  return /^\d+$/.test(exp || "") ? Number(exp) : null;
}
function Notice({ title, text }) {
  return <div className="landing"><h1>{title}</h1><p>{text}</p></div>;
}
export default function App() {
  const { docId, token } = parseUrl();
  if (!docId || !token) return <Landing />;
  const exp = expFromToken(token);
  if (exp && exp < Date.now()) {
    return <Notice title="⌛ Срок доступа истёк" text="Ссылка на эту заметку больше не действует. Попросите владельца прислать новую." />;
  }
  const role = roleFromToken(token);
  const readOnly = role === "viewer";
  return <Editor docId={docId} token={token} role={role} readOnly={readOnly} />;
}
function Landing() {
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const j = await (await fetch(API + "/sessions", { method: "POST" })).json();
      location.href = j.link && j.link.startsWith("http") ? j.link : `/e/${j.docId}#${j.token}`;
    } catch (e) {
      setBusy(false);
      alert("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0437\u0434\u0430\u0442\u044C: " + e.message);
    }
  };
  return <div className="landing"><h1>📝 Совместная заметка</h1><p>Создай заметку и отправь ссылку партнёру — редактируйте вместе, видно курсоры участников.
        Доступ только по подписанной ссылке.</p><button onClick={create} disabled={busy}>{busy ? "\u0421\u043E\u0437\u0434\u0430\u0451\u043C\u2026" : "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0441\u043E\u0432\u043C\u0435\u0441\u0442\u043D\u0443\u044E \u0437\u0430\u043C\u0435\u0442\u043A\u0443"}</button></div>;
}
function Editor({ docId, token, role, readOnly }) {
  const parentRef = useRef(null);
  const viewRef = useRef(null);
  const [peers, setPeers] = useState([]);
  const [status, setStatus] = useState("\u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435\u2026");
  const [copied, setCopied] = useState(false);
  const [viewCopied, setViewCopied] = useState(false);
  const [textCopied, setTextCopied] = useState(false);
  const [verUI, setVerUI] = useState(null);
  const [mode, setMode] = useState(() => readOnly ? "preview" : typeof window !== "undefined" && window.innerWidth <= 640 ? "edit" : "split");
  const [codeView, setCodeView] = useState(() => !!localStorage.getItem("collab-codeview"));
  const [html, setHtml] = useState("");
  const [name, setName] = useState(() => localStorage.getItem("collab-name") || NAMES[Math.floor(Math.random() * NAMES.length)] + "-" + Math.floor(Math.random() * 90 + 10));
  const awarenessRef = useRef(null);
  const ytextRef = useRef(null);
  const ydocRef = useRef(null);
  const colorRef = useRef("#" + (Math.random() * 16777215 | 0).toString(16).padStart(6, "0"));
  useEffect(() => {
    const ydoc = new Y.Doc();
    const idb = new IndexeddbPersistence("collab-" + API + ":" + docId, ydoc);
    const provider = new WebsocketProvider(WS_BASE, docId, ydoc, { params: { token } });
    const ytext = ydoc.getText("body");
    awarenessRef.current = provider.awareness;
    ytextRef.current = ytext;
    ydocRef.current = ydoc;
    const color = colorRef.current;
    provider.awareness.setLocalStateField("user", { name, color, colorLight: color + "33" });
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          history(),
          drawSelection(),
          keymap.of([
            { key: "Mod-b", run: (v) => (surround(v, "**", "**"), true) },
            { key: "Mod-i", run: (v) => (surround(v, "*", "*"), true) },
            ...defaultKeymap,
            ...historyKeymap
          ]),
          markdown(),
          appearance.of(codeView ? codeAppearance : obsidianAppearance),
          placeholder(readOnly ? "\u0422\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u0435\u043D\u0438\u0435" : "\u041F\u0438\u0448\u0438 \u0437\u0434\u0435\u0441\u044C\u2026 Markdown \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442: # \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A, **\u0436\u0438\u0440\u043D\u044B\u0439**, - [ ] \u0437\u0430\u0434\u0430\u0447\u0430"),
          ...readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
          yCollab(ytext, provider.awareness)
        ]
      }),
      parent: parentRef.current
    });
    viewRef.current = view;
    let timer;
    const render = () => setHtml(renderMarkdown(ytext.toString()));
    const onText = () => {
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    };
    ytext.observe(onText);
    render();
    const onStatus = (e) => setStatus(e.status === "connected" ? "\u043D\u0430 \u0441\u0432\u044F\u0437\u0438" : e.status);
    const onAwareness = () => setPeers([...provider.awareness.getStates().values()].map((s) => s.user).filter(Boolean));
    provider.on("status", onStatus);
    provider.awareness.on("change", onAwareness);
    return () => {
      clearTimeout(timer);
      ytext.unobserve(onText);
      provider.off("status", onStatus);
      provider.awareness.off("change", onAwareness);
      awarenessRef.current = null;
      viewRef.current = null;
      ytextRef.current = null;
      ydocRef.current = null;
      view.destroy();
      provider.destroy();
      idb.destroy();
      ydoc.destroy();
    };
  }, [docId, token]);
  useEffect(() => {
    const nm = name.trim() || "\u0410\u043D\u043E\u043D\u0438\u043C";
    localStorage.setItem("collab-name", nm);
    awarenessRef.current?.setLocalStateField("user", { name: nm, color: colorRef.current, colorLight: colorRef.current + "33" });
  }, [name]);
  useEffect(() => {
    localStorage.setItem("collab-codeview", codeView ? "1" : "");
    viewRef.current?.dispatch({ effects: appearance.reconfigure(codeView ? codeAppearance : obsidianAppearance) });
  }, [codeView]);
  const copy = () => {
    navigator.clipboard?.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const fmt = (run) => () => {
    if (viewRef.current) run(viewRef.current);
  };
  const copyText = async () => {
    const text = ytextRef.current ? ytextRef.current.toString() : "";
    try {
      await navigator.clipboard.writeText(text);
      setTextCopied(true);
      setTimeout(() => setTextCopied(false), 1500);
    } catch (e) {
      alert("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C: " + e.message);
    }
  };
  const shareView = async () => {
    try {
      const r = await (await fetch(`${API}/viewlink/${encodeURIComponent(docId)}?token=${encodeURIComponent(token)}`)).json();
      const link = r.viewLink && r.viewLink.startsWith("http") ? r.viewLink : `${location.origin}/e/${docId}#${r.viewToken}`;
      await navigator.clipboard?.writeText(link);
      setViewCopied(true);
      setTimeout(() => setViewCopied(false), 1500);
    } catch (e) {
      alert("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C view-\u0441\u0441\u044B\u043B\u043A\u0443: " + e.message);
    }
  };
  const openHistory = async () => {
    setVerUI({ versions: [], loading: true });
    try {
      const r = await (await fetch(`${API}/versions/${encodeURIComponent(docId)}?token=${encodeURIComponent(token)}`)).json();
      setVerUI({ versions: r.versions || [], loading: false });
    } catch (e) {
      setVerUI({ versions: [], loading: false, error: e.message });
    }
  };
  const previewVersion = async (ts) => {
    try {
      const buf = await (await fetch(`${API}/versions/${encodeURIComponent(docId)}/${ts}?token=${encodeURIComponent(token)}`)).arrayBuffer();
      const tmp = new Y.Doc();
      Y.applyUpdate(tmp, new Uint8Array(buf));
      const text = tmp.getText("body").toString();
      tmp.destroy();
      setVerUI((s) => ({ ...s, preview: { ts, text } }));
    } catch (e) {
      alert("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0432\u0435\u0440\u0441\u0438\u044E: " + e.message);
    }
  };
  const restoreVersion = () => {
    const p = verUI?.preview, yt = ytextRef.current, yd = ydocRef.current;
    if (!p || !yt || !yd || readOnly) return;
    yd.transact(() => {
      yt.delete(0, yt.length);
      yt.insert(0, p.text);
    });
    setVerUI(null);
  };
  const onPreviewClick = (e) => {
    if (readOnly) return;
    const cb = e.target;
    if (!(cb instanceof HTMLInputElement) || !cb.classList.contains("task-list-item-checkbox")) return;
    e.preventDefault();
    const boxes = [...e.currentTarget.querySelectorAll("input.task-list-item-checkbox")];
    const idx = boxes.indexOf(cb);
    if (idx >= 0 && ytextRef.current && ydocRef.current) toggleTaskInText(ytextRef.current, ydocRef.current, idx);
  };
  return <div className="app"><div className="bar"><b className="brand">📝 collab-notes</b><div className="modes">{MODES.map((m) => <button key={m.id} className={mode === m.id ? "on" : ""} onClick={() => setMode(m.id)} title={m.label}><span className="mi">{m.icon}</span>{m.label}</button>)}</div><span className="spacer" /><span className="peers">{peers.map((u, i) => <span key={i} className="peer" style={{ color: u.color }}>● {u.name}</span>)}</span><input
    className="name-input"
    value={name}
    onChange={(e) => setName(e.target.value)}
    maxLength={24}
    title="Ваше имя в совместном редактировании"
    placeholder="Ваше имя"
    style={{ borderLeft: `3px solid ${colorRef.current}` }}
  /><span className={"ro-badge role-" + role} title="Браузерный доступ — всегда гость; роль задаётся ссылкой">
          гость · {ROLE_LABEL[role] || role}</span><button className="hist" onClick={openHistory} title="История версий">🕘</button>{readOnly && <button className="hist" onClick={copyText} title="Скопировать текст заметки в буфер обмена">{textCopied ? "\u2713 \u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u043E" : "\u{1F4C4} \u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C"}</button>}<button className="share" onClick={copy}>{copied ? "\u2713" : "\u{1F517} \u0421\u0441\u044B\u043B\u043A\u0430"}</button>{!readOnly && <button className="share view" onClick={shareView} title="Скопировать ссылку «только чтение» для партнёра">{viewCopied ? "\u2713" : "\u{1F441} Read-only"}</button>}<span className="status">{status}</span></div>{mode !== "preview" && !readOnly && <div className="toolbar">{FMT.map((b, i) => b.sep ? <span key={i} className="tsep" /> : <button key={i} className="tbtn" style={b.style} title={b.title} onMouseDown={(e) => e.preventDefault()} onClick={fmt(b.run)}>{b.t}</button>)}<span className="spacer" /><div className="viewtoggle"><button className={!codeView ? "on" : ""} onClick={() => setCodeView(false)} title="Как в Obsidian: крупные заголовки, перенос строк">Обсидиан</button><button className={codeView ? "on" : ""} onClick={() => setCodeView(true)} title="Программистский вид: моноширинный шрифт, номера строк">Код</button></div></div>}<div className={"panes mode-" + mode}><div className="editor-pane"><div className="editor" ref={parentRef} /></div><div className="preview-pane markdown-body" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: html }} /></div>{verUI && <div className="modal-overlay" onClick={() => setVerUI(null)}><div className="modal" onClick={(e) => e.stopPropagation()}><div className="modal-head"><b>🕘 История версий</b><span className="spacer" /><button className="x" onClick={() => setVerUI(null)}>✕</button></div>{verUI.loading ? <p className="modal-msg">Загрузка…</p> : verUI.error ? <p className="modal-msg err">Ошибка: {verUI.error}</p> : verUI.preview ? <div className="ver-preview"><div className="ver-preview-head"><button onClick={() => setVerUI((s) => ({ ...s, preview: void 0 }))}>← к списку</button><span className="ver-when">{new Date(verUI.preview.ts).toLocaleString("ru")}</span><span className="spacer" />{!readOnly && <button className="restore" onClick={restoreVersion}>Восстановить эту версию</button>}</div><pre className="ver-text">{verUI.preview.text || "(\u043F\u0443\u0441\u0442\u043E)"}</pre></div> : verUI.versions.length === 0 ? <p className="modal-msg">Пока нет сохранённых версий (создаются при завершении сессии редактирования и периодически).</p> : <ul className="ver-list">{verUI.versions.map((v) => <li key={v.ts} onClick={() => previewVersion(v.ts)}><span>{new Date(v.ts).toLocaleString("ru")}</span><span className="ver-size">{(v.size / 1024).toFixed(1)} КБ</span></li>)}</ul>}</div></div>}</div>;
}
