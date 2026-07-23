import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { DocSession } from "../src/index.js";
import {
  bindSession,
  refreshRemoteCursors,
  remoteTransaction,
} from "./cm-adapter.js";
import { editorExtensions } from "./markdown-setup.js";
import { toggleLinePrefix, toggleWrap } from "./toolbar.js";
import "./style.css";

const NAMES = ["Ada", "Grace", "Alan", "Edsger", "Barbara", "Donald", "Radia", "Leslie"];
const COLORS = ["#e8453c", "#12a765", "#f5a623", "#9334e6", "#0d9488", "#e0538e", "#3f51b5"];

// Document id from /d/<id>, else mint one and fix the URL.
function resolveDocId(): string {
  const match = /^\/d\/([\w-]{1,64})$/.exec(location.pathname);
  if (match) return match[1]!;
  const id = `doc-${Math.random().toString(36).slice(2, 10)}`;
  history.replaceState(null, "", `/d/${id}`);
  return id;
}

function resolveIdentity(): { name: string; color: string; actorId?: string } {
  const params = new URLSearchParams(location.search);
  const stored = localStorage.getItem("ot-demo-identity");
  const fallback = stored
    ? (JSON.parse(stored) as { name: string; color: string })
    : {
        name: NAMES[Math.floor(Math.random() * NAMES.length)]!,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      };
  const identity = {
    name: params.get("name") ?? fallback.name,
    color: params.get("color") ?? fallback.color,
    actorId: params.get("actor_id") ?? undefined,
  };
  localStorage.setItem(
    "ot-demo-identity",
    JSON.stringify({ name: identity.name, color: identity.color }),
  );
  return identity;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const docId = resolveDocId();
const identity = resolveIdentity();

const session = new DocSession({
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/socket`,
  docId,
  name: identity.name,
  color: identity.color,
  actorId: identity.actorId,
});

let view: EditorView | null = null;
let detach: (() => void) | null = null;

const statusPill = el<HTMLSpanElement>("status-pill");
const avatarRow = el<HTMLDivElement>("avatars");
const previewPane = el<HTMLElement>("preview");
const editorHost = el<HTMLElement>("editor");

el<HTMLSpanElement>("doc-chip").textContent = docId;
document.title = `${docId} — ArchAstro Docs`;

// --- status pill -------------------------------------------------------------

const STATUS_LABELS: Record<string, { text: string; className: string }> = {
  connecting: { text: "Connecting…", className: "status-muted" },
  synchronized: { text: "Saved", className: "status-ok" },
  pending: { text: "Saving…", className: "status-muted" },
  offline: { text: "Offline", className: "status-warn" },
  error: { text: "Error", className: "status-error" },
};

session.on("statusChange", (status) => {
  const label = STATUS_LABELS[status] ?? STATUS_LABELS.error!;
  statusPill.textContent = label.text;
  statusPill.className = `status-pill ${label.className}`;
});

session.on("error", (message) => console.warn("[ot-demo]", message));

// --- presence ----------------------------------------------------------------

function renderAvatars(): void {
  avatarRow.replaceChildren();
  const me = document.createElement("span");
  me.className = "avatar";
  me.style.backgroundColor = identity.color;
  me.textContent = initials(identity.name);
  me.title = `${identity.name} (you)`;
  avatarRow.appendChild(me);

  for (const actor of session.actors.values()) {
    const dot = document.createElement("span");
    dot.className = "avatar";
    dot.style.backgroundColor = actor.meta.color;
    dot.textContent = initials(actor.meta.name);
    dot.title = actor.meta.name;
    avatarRow.appendChild(dot);
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

session.on("actorJoined", renderAvatars);
session.on("actorLeft", renderAvatars);

// --- preview -----------------------------------------------------------------

let previewTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

function renderPreview(): void {
  const markdown = view ? view.state.doc.toString() : session.content;
  const html = DOMPurify.sanitize(marked.parse(markdown, { async: false }));
  previewPane.innerHTML = html;
}

el<HTMLButtonElement>("btn-preview").addEventListener("click", () => {
  document.body.classList.toggle("preview-open");
  renderPreview();
});

// --- editor ------------------------------------------------------------------

session.on("ready", ({ content }) => {
  if (!view) {
    view = new EditorView({
      state: EditorState.create({ doc: content, extensions: editorExtensions() }),
      parent: editorHost,
    });
    detach = bindSession(view, session);
    view.focus();
  } else {
    // Rejoin after reconnect: replace the whole doc with the fresh snapshot.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: remoteTransaction.of(true),
    });
  }
  renderAvatars();
  refreshRemoteCursors(view, session);
  renderPreview();
});

session.on("operation", schedulePreview);

// Local edits also refresh the preview.
document.addEventListener("keyup", schedulePreview);

// --- toolbar -----------------------------------------------------------------

const withView = (fn: (v: EditorView) => void) => () => {
  if (view) fn(view);
};

el("btn-bold").addEventListener("click", withView((v) => toggleWrap(v, "**")));
el("btn-italic").addEventListener("click", withView((v) => toggleWrap(v, "*")));
el("btn-strike").addEventListener("click", withView((v) => toggleWrap(v, "~~")));
el("btn-code").addEventListener("click", withView((v) => toggleWrap(v, "`")));
el("btn-h1").addEventListener("click", withView((v) => toggleLinePrefix(v, "# ")));
el("btn-h2").addEventListener("click", withView((v) => toggleLinePrefix(v, "## ")));
el("btn-h3").addEventListener("click", withView((v) => toggleLinePrefix(v, "### ")));
el("btn-quote").addEventListener("click", withView((v) => toggleLinePrefix(v, "> ")));
el("btn-list").addEventListener("click", withView((v) => toggleLinePrefix(v, "- ")));

el("btn-share").addEventListener("click", () => {
  void navigator.clipboard.writeText(location.href).then(() => {
    const button = el<HTMLButtonElement>("btn-share");
    const original = button.textContent;
    button.textContent = "Copied!";
    setTimeout(() => (button.textContent = original), 1200);
  });
});

// --- go ----------------------------------------------------------------------

session.connect();

// Hooks for the automated browser test (browser-test/concurrent-editors.mjs).
declare global {
  interface Window {
    __otDemo: {
      session: DocSession;
      content: () => string;
      status: () => string;
      revision: () => number;
      type: (text: string, position?: number) => void;
      remove: (from: number, length: number) => void;
    };
  }
}

window.__otDemo = {
  session,
  content: () => (view ? view.state.doc.toString() : session.content),
  status: () => `${session.status}/${session.client.stateName}`,
  revision: () => session.client.revision,
  type: (text: string, position?: number) => {
    if (!view) throw new Error("editor not ready");
    const at = position ?? view.state.doc.length;
    view.dispatch({
      changes: { from: at, insert: text },
      userEvent: "input.type",
    });
  },
  remove: (from: number, length: number) => {
    if (!view) throw new Error("editor not ready");
    view.dispatch({
      changes: { from, to: Math.min(from + length, view.state.doc.length) },
      userEvent: "delete.forward",
    });
  },
};
