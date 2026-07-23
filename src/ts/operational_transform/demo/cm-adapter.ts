/**
 * Bridges a CodeMirror 6 editor and a DocSession.
 *
 * CodeMirror addresses text by UTF-16 offsets; the OT protocol uses Unicode
 * code points. All conversion happens here and only here.
 */

import { Annotation, ChangeSet, ChangeSpec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import {
  CursorPosition,
  DocSession,
  TextOperation,
  cpLength,
  cpToUtf16Offset,
  isInsert,
  isRetain,
  utf16OffsetToCp,
} from "../src/index.js";

/** Marks transactions that came from the server, so we don't echo them back. */
export const remoteTransaction = Annotation.define<boolean>();

/** Convert a CodeMirror ChangeSet into a TextOperation (code points). */
export function opFromChanges(changes: ChangeSet, oldDoc: string): TextOperation {
  const op = new TextOperation();
  let lastCp = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const fromCp = utf16OffsetToCp(oldDoc, fromA);
    const toCp = utf16OffsetToCp(oldDoc, toA);
    op.retain(fromCp - lastCp);
    if (toCp > fromCp) op.delete(toCp - fromCp);
    const text = inserted.toString();
    if (text) op.insert(text);
    lastCp = toCp;
  });
  op.retain(cpLength(oldDoc) - lastCp);
  return op;
}

/** Convert a TextOperation into CodeMirror change specs (UTF-16). */
export function changesFromOp(op: TextOperation, doc: string): ChangeSpec[] {
  const specs: ChangeSpec[] = [];
  let cp = 0;
  for (const c of op.ops) {
    if (isRetain(c)) {
      cp += c;
    } else if (isInsert(c)) {
      specs.push({ from: cpToUtf16Offset(doc, cp), insert: c });
    } else {
      specs.push({ from: cpToUtf16Offset(doc, cp), to: cpToUtf16Offset(doc, cp - c) });
      cp += -c;
    }
  }
  return specs;
}

// Remote cursors -------------------------------------------------------------

export interface RemoteCursor {
  actorId: string;
  name: string;
  color: string;
  /** UTF-16 offsets into the current editor doc. */
  anchor: number;
  head: number;
}

export const setRemoteCursors = StateEffect.define<RemoteCursor[]>();

class CaretWidget extends WidgetType {
  constructor(
    private color: string,
    private name: string,
  ) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    return other.color === this.color && other.name === this.name;
  }

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "remote-caret";
    caret.style.borderLeftColor = this.color;
    const label = document.createElement("span");
    label.className = "remote-caret-label";
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    caret.appendChild(label);
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export const remoteCursorField = StateField.define<{
  cursors: RemoteCursor[];
  decorations: DecorationSet;
}>({
  create: () => ({ cursors: [], decorations: Decoration.none }),
  update(value, tr) {
    let cursors = value.cursors;
    let changed = false;

    if (tr.docChanged) {
      cursors = cursors.map((c) => ({
        ...c,
        anchor: tr.changes.mapPos(c.anchor),
        head: tr.changes.mapPos(c.head),
      }));
      changed = true;
    }
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCursors)) {
        cursors = effect.value;
        changed = true;
      }
    }
    if (!changed) return value;
    return { cursors, decorations: buildDecorations(cursors, tr.newDoc.length) };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

function buildDecorations(cursors: RemoteCursor[], docLength: number): DecorationSet {
  const ranges = [];
  for (const cursor of cursors) {
    const from = Math.min(Math.min(cursor.anchor, cursor.head), docLength);
    const to = Math.min(Math.max(cursor.anchor, cursor.head), docLength);
    if (from < to) {
      ranges.push(
        Decoration.mark({
          class: "remote-selection",
          attributes: { style: `background-color: ${cursor.color}33` },
        }).range(from, to),
      );
    }
    const caretPos = Math.min(cursor.head, docLength);
    ranges.push(
      Decoration.widget({
        widget: new CaretWidget(cursor.color, cursor.name),
        side: 1,
      }).range(caretPos),
    );
  }
  ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  return Decoration.set(ranges, true);
}

// Binding ---------------------------------------------------------------------

export interface EditorBinding {
  view: EditorView;
  detach: () => void;
}

/**
 * Wires the session and the view together:
 *  - local transactions -> session.applyLocal
 *  - session "operation" -> remote transaction
 *  - selection changes -> session.sendCursor (debounced)
 *  - session cursor/actor events -> remote cursor decorations
 */
export function bindSession(view: EditorView, session: DocSession): () => void {
  let applyingRemote = false;
  const unsubscribers: (() => void)[] = [];

  unsubscribers.push(
    session.on("operation", ({ op }) => {
      const docBefore = view.state.doc.toString();
      applyingRemote = true;
      try {
        view.dispatch({
          changes: changesFromOp(op, docBefore),
          annotations: remoteTransaction.of(true),
        });
      } finally {
        applyingRemote = false;
      }
      refreshRemoteCursors(view, session);
    }),
  );

  const refresh = () => refreshRemoteCursors(view, session);
  unsubscribers.push(session.on("cursor", refresh));
  unsubscribers.push(session.on("actorJoined", refresh));
  unsubscribers.push(session.on("actorLeft", refresh));

  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  const listener = EditorView.updateListener.of((update) => {
    if (applyingRemote) return;
    const isRemote = update.transactions.some((tr) => tr.annotation(remoteTransaction));
    if (isRemote) return;

    if (update.docChanged) {
      const oldDoc = update.startState.doc.toString();
      const op = opFromChanges(update.changes, oldDoc);
      if (!op.isNoop()) {
        session.applyLocal(op, selectionAsCursor(update.view, session));
      }
    }
    if (update.selectionSet || update.docChanged) {
      if (cursorTimer) clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => {
        session.sendCursor(selectionAsCursor(view, session));
      }, 80);
    }
  });

  // The listener extension must be added by the caller (it's returned via
  // appendConfig at creation time in main.ts); here we only manage teardown.
  view.dispatch({ effects: StateEffect.appendConfig.of([listener, remoteCursorField]) });

  return () => {
    if (cursorTimer) clearTimeout(cursorTimer);
    for (const unsub of unsubscribers) unsub();
  };
}

function selectionAsCursor(view: EditorView, _session: DocSession): CursorPosition {
  const doc = view.state.doc.toString();
  const { anchor, head } = view.state.selection.main;
  return {
    position: utf16OffsetToCp(doc, anchor),
    selection_end: utf16OffsetToCp(doc, head),
  };
}

export function refreshRemoteCursors(view: EditorView, session: DocSession): void {
  const doc = view.state.doc.toString();
  const cursors: RemoteCursor[] = [];
  for (const actor of session.actors.values()) {
    if (!actor.cursor) continue;
    cursors.push({
      actorId: actor.actorId,
      name: actor.meta.name,
      color: actor.meta.color,
      anchor: cpToUtf16Offset(doc, actor.cursor.position),
      head: cpToUtf16Offset(doc, actor.cursor.selection_end),
    });
  }
  view.dispatch({ effects: setRemoteCursors.of(cursors) });
}
