/**
 * Spreadsheet-mode rendering for markdown tables.
 *
 * The table's markdown text is replaced by a block widget rendering a real
 * <table> with contenteditable cells. Every interaction (typing, Enter for a
 * new row, the right-click menu, column resizing) turns into ordinary text
 * edits on the hidden markdown — which is exactly what makes collaboration
 * work: the OT layer sees plain text operations on disjoint spans.
 */

import { redo, undo } from "@codemirror/commands";
import { EditorView, WidgetType } from "@codemirror/view";
import {
  ColAlign,
  TableModel,
  cellAt,
  dashesToPx,
  deleteColEdits,
  deleteRowEdit,
  insertColEdits,
  insertRowEdit,
  setAlignEdit,
  setCellEdit,
  setColWidthEdit,
  unescapeCell,
} from "./table-model.js";

interface TableCtx {
  view: EditorView;
  model: TableModel;
}

interface TableRoot extends HTMLDivElement {
  __ctx?: TableCtx;
}

/** Where to restore focus after the widget rebuilds from a structural edit. */
let pendingFocus: { anchor: number; row: number; col: number; caret?: number } | null = null;

// --- context menu ------------------------------------------------------------

interface MenuItem {
  label?: string;
  action?: () => void;
  separator?: boolean;
  danger?: boolean;
}

let openMenu: HTMLElement | null = null;

function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

document.addEventListener("mousedown", (event) => {
  if (openMenu && !openMenu.contains(event.target as Node)) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

function showMenu(items: MenuItem[], x: number, y: number): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "mdtable-menu";
  for (const item of items) {
    if (item.separator) {
      menu.appendChild(document.createElement("hr"));
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label ?? "";
    if (item.danger) button.classList.add("danger");
    button.addEventListener("click", () => {
      closeMenu();
      item.action?.();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  openMenu = menu;
}

// --- widget ------------------------------------------------------------------

export class TableWidget extends WidgetType {
  constructor(
    readonly model: TableModel,
    readonly text: string,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.text === this.text && other.model.from === this.model.from;
  }

  override get estimatedHeight(): number {
    return (this.model.body.length + 2) * 34;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div") as TableRoot;
    root.className = "mdtable";
    root.__ctx = { view, model: this.model };
    buildTableDOM(root);
    attachHandlers(root);
    scheduleFocusRestore(root);
    return root;
  }

  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const root = dom as TableRoot;
    if (!root.__ctx) return false;
    const previous = root.__ctx.model;
    root.__ctx = { view, model: this.model };

    const structureChanged =
      previous.body.length !== this.model.body.length || previous.colCount !== this.model.colCount;

    if (structureChanged) {
      const remembered = captureFocus(root);
      buildTableDOM(root);
      if (remembered && !pendingFocus) {
        pendingFocus = {
          anchor: this.model.from,
          ...clampFocus(this.model, remembered),
          caret: remembered.caret,
        };
      }
    } else {
      patchCells(root);
      patchWidths(root);
    }
    // The DOM is attached here, so focus can be restored synchronously —
    // an async restore would drop keystrokes typed while a concurrent
    // structural change rebuilds the grid.
    restoreFocus(root);
    return true;
  }
}

function clampFocus(
  model: TableModel,
  focus: { row: number; col: number },
): { row: number; col: number } {
  return {
    row: Math.min(focus.row, model.body.length - 1),
    col: Math.max(0, Math.min(focus.col, model.colCount - 1)),
  };
}

function captureFocus(root: TableRoot): { row: number; col: number; caret: number } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  if (active.dataset.row === undefined) return null;
  let caret = Number.MAX_SAFE_INTEGER;
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0 && active.contains(selection.anchorNode)) {
    caret = selection.getRangeAt(0).startOffset;
  }
  return { row: Number(active.dataset.row), col: Number(active.dataset.col), caret };
}

function restoreFocus(root: TableRoot): void {
  if (!pendingFocus) return;
  const ctx = root.__ctx;
  if (!ctx || pendingFocus.anchor !== ctx.model.from) return;
  const { row, col, caret } = pendingFocus;
  pendingFocus = null;
  const cell = cellDOM(root, row, col);
  if (cell) focusCellDOM(cell, caret ?? Number.MAX_SAFE_INTEGER);
}

/** Async variant for freshly mounted widgets (not yet in the document). */
function scheduleFocusRestore(root: TableRoot): void {
  if (!pendingFocus) return;
  requestAnimationFrame(() => restoreFocus(root));
}

function cellDOM(root: TableRoot, row: number, col: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
}

/** Focus a cell and place the caret at `offset` (clamped; MAX = end). */
function focusCellDOM(cell: HTMLElement, offset: number = Number.MAX_SAFE_INTEGER): void {
  cell.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const textNode = [...cell.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
  if (textNode) {
    range.setStart(textNode, Math.min(offset, textNode.textContent?.length ?? 0));
  } else {
    range.selectNodeContents(cell);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

// --- DOM construction --------------------------------------------------------

function buildTableDOM(root: TableRoot): void {
  const ctx = root.__ctx!;
  const model = ctx.model;
  root.replaceChildren();

  const scroll = document.createElement("div");
  scroll.className = "mdtable-scroll";

  const table = document.createElement("table");
  table.className = "mdtable-grid";

  const colgroup = document.createElement("colgroup");
  for (let c = 0; c < model.colCount; c++) {
    const col = document.createElement("col");
    const delim = model.delimiter.cols[c];
    col.style.width = `${dashesToPx(delim?.dashes ?? 6)}px`;
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  thead.appendChild(buildRowDOM(model, -1));
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let r = 0; r < model.body.length; r++) tbody.appendChild(buildRowDOM(model, r));
  table.appendChild(tbody);

  scroll.appendChild(table);
  root.appendChild(scroll);

  const addRow = document.createElement("button");
  addRow.type = "button";
  addRow.className = "mdtable-add mdtable-add-row";
  addRow.title = "Add row";
  addRow.textContent = "+";
  addRow.dataset.tableAction = "add-row";
  root.appendChild(addRow);

  const addCol = document.createElement("button");
  addCol.type = "button";
  addCol.className = "mdtable-add mdtable-add-col";
  addCol.title = "Add column";
  addCol.textContent = "+";
  addCol.dataset.tableAction = "add-col";
  root.appendChild(addCol);
}

function buildRowDOM(model: TableModel, row: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (let c = 0; c < model.colCount; c++) {
    const isHeader = row === -1;
    const cell = document.createElement(isHeader ? "th" : "td");
    cell.dataset.row = String(row);
    cell.dataset.col = String(c);
    cell.contentEditable = "plaintext-only";
    cell.spellcheck = false;
    const span = cellAt(model, row, c);
    cell.textContent = span ? unescapeCell(span.raw) : "";
    const align = model.delimiter.cols[c]?.align;
    if (align) cell.style.textAlign = align;
    if (isHeader) {
      const handle = document.createElement("span");
      handle.className = "mdtable-resize";
      handle.dataset.col = String(c);
      cell.appendChild(handle);
    }
    tr.appendChild(cell);
  }
  return tr;
}

function patchCells(root: TableRoot): void {
  const model = root.__ctx!.model;
  const active = document.activeElement;
  for (const cell of root.querySelectorAll<HTMLElement>("[data-row]")) {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const span = cellAt(model, row, col);
    const expected = span ? unescapeCell(span.raw) : "";
    const current = cellText(cell);
    if (cell === active) {
      // Markdown trims cell content, so a trailing space being typed right
      // now is invisible to the model — leave the DOM alone unless the
      // trimmed texts genuinely diverge (i.e. a remote edit merged in). Then
      // adopt the merged text and park the caret at the end.
      if (current.trim() !== expected.trim()) {
        setCellText(cell, expected);
        focusCellDOM(cell);
      }
    } else if (current !== expected) {
      setCellText(cell, expected);
    }
    const align = model.delimiter.cols[col]?.align;
    cell.style.textAlign = align ?? "";
  }
}

function patchWidths(root: TableRoot): void {
  if (root.dataset.resizing === "true") return;
  const model = root.__ctx!.model;
  const cols = root.querySelectorAll<HTMLTableColElement>("col");
  cols.forEach((col, index) => {
    const delim = model.delimiter.cols[index];
    if (delim) col.style.width = `${dashesToPx(delim.dashes)}px`;
  });
}

/** Cell text ignoring the resize handle element; nbsp normalized to space. */
function cellText(cell: HTMLElement): string {
  let text = "";
  for (const node of cell.childNodes) {
    if (node instanceof HTMLElement && node.classList.contains("mdtable-resize")) continue;
    text += node.textContent ?? "";
  }
  return text.replace(/\u00A0/g, " ");
}

function setCellText(cell: HTMLElement, text: string): void {
  const handle = cell.querySelector(".mdtable-resize");
  cell.textContent = text;
  if (handle) cell.appendChild(handle);
}

// --- interaction -------------------------------------------------------------

function attachHandlers(root: TableRoot): void {
  root.addEventListener("input", (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (!cell || !root.__ctx) return;
    const { view, model } = root.__ctx;
    const edit = setCellEdit(model, Number(cell.dataset.row), Number(cell.dataset.col), cellText(cell));
    if (edit) view.dispatch({ changes: edit, userEvent: "input.table" });
  });

  root.addEventListener("keydown", (event) => onKeydown(root, event));

  root.addEventListener("contextmenu", (event) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (!cell || !root.__ctx) return;
    event.preventDefault();
    event.stopPropagation();
    openCellMenu(root, Number(cell.dataset.row), Number(cell.dataset.col), event.clientX, event.clientY);
  });

  root.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).dataset.tableAction;
    if (!action || !root.__ctx) return;
    const { view, model } = root.__ctx;
    if (action === "add-row") {
      pendingFocus = { anchor: model.from, row: model.body.length, col: 0 };
      view.dispatch({ changes: insertRowEdit(model, model.body.length), userEvent: "input.table" });
    } else if (action === "add-col") {
      view.dispatch({ changes: insertColEdits(model, model.colCount), userEvent: "input.table" });
    }
  });

  root.addEventListener("mousedown", (event) => {
    const handle = event.target as HTMLElement;
    if (!handle.classList.contains("mdtable-resize") || !root.__ctx) return;
    event.preventDefault();
    event.stopPropagation();
    startResize(root, Number(handle.dataset.col), event.clientX);
  });
}

function onKeydown(root: TableRoot, event: KeyboardEvent): void {
  const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
  if (!cell || !root.__ctx) return;
  const { view, model } = root.__ctx;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);

  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "z") {
    // Keep undo/redo at the document level; the cell's own stack would desync.
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) redo(view);
    else undo(view);
    return;
  }
  if (mod) return;

  switch (event.key) {
    case "Enter": {
      event.preventDefault();
      event.stopPropagation();
      if (row >= model.body.length - 1) {
        // Enter below the last row grows the table, spreadsheet-style.
        pendingFocus = { anchor: model.from, row: model.body.length, col };
        view.dispatch({ changes: insertRowEdit(model, model.body.length), userEvent: "input.table" });
      } else {
        const next = cellDOM(root, row + 1, col);
        if (next) focusCellDOM(next);
      }
      break;
    }
    case "Tab": {
      event.preventDefault();
      event.stopPropagation();
      const forward = !event.shiftKey;
      let nextRow = row;
      let nextCol = col + (forward ? 1 : -1);
      if (nextCol >= model.colCount) {
        nextCol = 0;
        nextRow = row + 1;
      } else if (nextCol < 0) {
        nextCol = model.colCount - 1;
        nextRow = row - 1;
      }
      if (nextRow >= model.body.length) {
        pendingFocus = { anchor: model.from, row: model.body.length, col: 0 };
        view.dispatch({ changes: insertRowEdit(model, model.body.length), userEvent: "input.table" });
        return;
      }
      if (nextRow < -1) return;
      const next = cellDOM(root, nextRow, nextCol);
      if (next) focusCellDOM(next);
      break;
    }
    case "ArrowDown":
    case "ArrowUp": {
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const target = cellDOM(root, row + delta, col);
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        focusCellDOM(target);
      }
      break;
    }
    case "Escape": {
      event.preventDefault();
      event.stopPropagation();
      cell.blur();
      const after = Math.min(model.to + 1, view.state.doc.length);
      view.focus();
      view.dispatch({ selection: { anchor: after } });
      break;
    }
  }
}

function openCellMenu(root: TableRoot, row: number, col: number, x: number, y: number): void {
  const ctx = root.__ctx!;
  const { view } = ctx;

  const dispatchEdits = (
    edits: { from: number; to: number; insert: string }[] | { from: number; to: number; insert: string } | null,
    focus?: { row: number; col: number },
  ) => {
    if (!edits) return;
    if (focus) pendingFocus = { anchor: ctx.model.from, ...focus };
    view.dispatch({ changes: edits, userEvent: "input.table" });
  };

  const model = ctx.model;
  const bodyRow = Math.max(row, 0);
  const align = (value: ColAlign) => () => dispatchEdits(setAlignEdit(model, col, value));
  const check = (value: ColAlign) => (model.delimiter.cols[col]?.align === value ? "✓ " : "   ");

  showMenu(
    [
      {
        label: "Insert row above",
        action: () => dispatchEdits(insertRowEdit(model, bodyRow), { row: bodyRow, col }),
      },
      {
        label: "Insert row below",
        action: () => dispatchEdits(insertRowEdit(model, bodyRow + 1), { row: bodyRow + 1, col }),
      },
      ...(row >= 0
        ? [
            {
              label: "Delete row",
              danger: true,
              action: () =>
                dispatchEdits(deleteRowEdit(model, row), {
                  row: Math.max(0, Math.min(row, model.body.length - 2)),
                  col,
                }),
            },
          ]
        : []),
      { separator: true },
      {
        label: "Insert column left",
        action: () => dispatchEdits(insertColEdits(model, col), { row, col }),
      },
      {
        label: "Insert column right",
        action: () => dispatchEdits(insertColEdits(model, col + 1), { row, col: col + 1 }),
      },
      ...(model.colCount > 1
        ? [
            {
              label: "Delete column",
              danger: true,
              action: () =>
                dispatchEdits(deleteColEdits(model, col), {
                  row,
                  col: Math.max(0, Math.min(col, model.colCount - 2)),
                }),
            },
          ]
        : []),
      { separator: true },
      { label: `${check("left")}Align left`, action: align("left") },
      { label: `${check("center")}Align center`, action: align("center") },
      { label: `${check("right")}Align right`, action: align("right") },
      { separator: true },
      {
        label: "Delete table",
        danger: true,
        action: () =>
          view.dispatch({
            changes: { from: model.from, to: Math.min(model.to + 1, view.state.doc.length), insert: "" },
            userEvent: "delete.table",
          }),
      },
    ],
    x,
    y,
  );
}

function startResize(root: TableRoot, colIndex: number, startX: number): void {
  const ctx = root.__ctx!;
  const colEl = root.querySelectorAll<HTMLTableColElement>("col")[colIndex];
  if (!colEl) return;
  const startWidth = colEl.getBoundingClientRect().width;
  root.dataset.resizing = "true";

  const onMove = (event: MouseEvent) => {
    const width = Math.min(Math.max(startWidth + (event.clientX - startX), 72), 640);
    colEl.style.width = `${width}px`;
  };
  const onUp = (event: MouseEvent) => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    delete root.dataset.resizing;
    const width = Math.min(Math.max(startWidth + (event.clientX - startX), 72), 640);
    const edit = setColWidthEdit(ctx.model, colIndex, width);
    if (edit) ctx.view.dispatch({ changes: edit, userEvent: "input.table" });
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
