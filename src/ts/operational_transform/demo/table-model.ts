/**
 * Pure model layer for spreadsheet-style editing of GFM markdown tables.
 *
 * A table stays plain markdown in the document — this module parses it into
 * cell spans (document offsets) and builds the text edits for spreadsheet
 * operations (set cell, insert/delete row/column, align, resize). Because
 * every operation is an ordinary text change, the OT layer needs no special
 * cases: concurrent edits to different cells touch disjoint spans and
 * transform cleanly; same-cell edits merge character-by-character thanks to
 * minimal diffs.
 *
 * Column widths are encoded in the delimiter row's dash count (markdown-
 * native, so widths replicate through OT like any other edit).
 *
 * All offsets are UTF-16 (CodeMirror coordinates); the OT adapter converts
 * to code points at the session boundary.
 */

export type ColAlign = "left" | "center" | "right" | null;

export interface CellSpan {
  /** Span of the cell's trimmed content in the document. */
  from: number;
  to: number;
  /** Raw (still pipe-escaped) content text. */
  raw: string;
}

export interface RowSpan {
  lineFrom: number;
  lineTo: number;
  cells: CellSpan[];
}

export interface DelimCol {
  from: number;
  to: number;
  dashes: number;
  align: ColAlign;
}

export interface TableModel {
  from: number;
  to: number;
  header: RowSpan;
  delimiter: { lineFrom: number; lineTo: number; cols: DelimCol[] };
  body: RowSpan[];
  colCount: number;
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** Convert DOM cell text to markdown-safe cell content. */
export function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Convert raw markdown cell content to display text. */
export function unescapeCell(raw: string): string {
  return raw.replace(/\\\|/g, "|").replace(/\\\\/g, "\\");
}

/** Pixel width encoded by a delimiter column's dash count. */
export function dashesToPx(dashes: number): number {
  return Math.min(Math.max(dashes * 9, 72), 640);
}

export function pxToDashes(px: number): number {
  return Math.min(Math.max(Math.round(px / 9), 3), 72);
}

interface ParsedLine {
  /** Content spans between pipes, in document offsets. */
  cells: { from: number; to: number; raw: string }[];
}

/** Split one table line into cell content spans (trimmed), honoring \| escapes. */
function parseLine(text: string, lineFrom: number): ParsedLine {
  const cells: ParsedLine["cells"] = [];
  let i = 0;
  if (text.startsWith("|")) i = 1;
  let cellStart = i;
  const flush = (end: number) => {
    // Trim the segment but keep offsets of the trimmed content.
    let from = cellStart;
    let to = end;
    while (from < to && (text[from] === " " || text[from] === "\t")) from++;
    while (to > from && (text[to - 1] === " " || text[to - 1] === "\t")) to--;
    cells.push({ from: lineFrom + from, to: lineFrom + to, raw: text.slice(from, to) });
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "|") {
      flush(i);
      i += 1;
      cellStart = i;
      continue;
    }
    i += 1;
  }
  // Trailing segment (only when the line doesn't end with a pipe).
  if (cellStart < text.length || cells.length === 0) {
    const rest = text.slice(cellStart);
    if (rest.trim() !== "" || cells.length === 0) flush(text.length);
  }
  return { cells };
}

const DELIM_CELL = /^:?-+:?$/;

function isDelimiterLine(text: string): boolean {
  const stripped = text.trim();
  if (!stripped.includes("-")) return false;
  const inner = stripped.replace(/^\|/, "").replace(/\|$/, "");
  const parts = inner.split("|").map((part) => part.trim());
  return parts.length > 0 && parts.every((part) => DELIM_CELL.test(part));
}

/**
 * Parses the markdown table occupying [from, to) in `docText` (the whole
 * document string). Returns null when the range is not a well-formed table
 * (header + delimiter at minimum).
 */
export function parseTable(docText: string, from: number, to: number): TableModel | null {
  const text = docText.slice(from, to);
  const lines: { text: string; from: number; to: number }[] = [];
  let offset = 0;
  for (const lineText of text.split("\n")) {
    lines.push({ text: lineText, from: from + offset, to: from + offset + lineText.length });
    offset += lineText.length + 1;
  }
  while (lines.length > 0 && lines[lines.length - 1]!.text.trim() === "") lines.pop();
  if (lines.length < 2) return null;
  if (!isDelimiterLine(lines[1]!.text)) return null;

  const toRow = (line: { text: string; from: number; to: number }): RowSpan => ({
    lineFrom: line.from,
    lineTo: line.to,
    cells: parseLine(line.text, line.from).cells,
  });

  const header = toRow(lines[0]!);

  const delimLine = lines[1]!;
  const delimCells = parseLine(delimLine.text, delimLine.from).cells;
  const cols: DelimCol[] = delimCells.map((cell) => {
    const raw = cell.raw;
    const align: ColAlign =
      raw.startsWith(":") && raw.endsWith(":")
        ? "center"
        : raw.endsWith(":")
          ? "right"
          : raw.startsWith(":")
            ? "left"
            : null;
    return {
      from: cell.from,
      to: cell.to,
      dashes: (raw.match(/-/g) ?? []).length,
      align,
    };
  });

  const body = lines.slice(2).map(toRow);
  const colCount = Math.max(
    header.cells.length,
    cols.length,
    ...body.map((row) => row.cells.length),
    1,
  );

  return {
    from,
    to: lines[lines.length - 1]!.to,
    header,
    delimiter: { lineFrom: delimLine.from, lineTo: delimLine.to, cols },
    body,
    colCount,
  };
}

/** Minimal single-span diff between two strings (common prefix/suffix). */
export function minimalDiff(
  oldText: string,
  newText: string,
): { start: number; end: number; insert: string } | null {
  if (oldText === newText) return null;
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > prefix && newEnd > prefix && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { start: prefix, end: oldEnd, insert: newText.slice(prefix, newEnd) };
}

/** Edit that replaces cell (row, col) content with `text` (display text). */
export function setCellEdit(model: TableModel, row: number, col: number, text: string): TextEdit | null {
  const cell = cellAt(model, row, col);
  if (!cell) return null;
  const escaped = escapeCell(text);
  const diff = minimalDiff(cell.raw, escaped);
  if (!diff) return null;
  return { from: cell.from + diff.start, to: cell.from + diff.end, insert: diff.insert };
}

/** row: -1 = header, 0.. = body rows. */
export function cellAt(model: TableModel, row: number, col: number): CellSpan | null {
  const rowSpan = row === -1 ? model.header : model.body[row];
  if (!rowSpan) return null;
  return rowSpan.cells[col] ?? null;
}

function blankRowText(colCount: number): string {
  return `|${"   |".repeat(colCount)}`;
}

/** Insert a blank body row. `index` is the body position to insert at (0..body.length). */
export function insertRowEdit(model: TableModel, index: number): TextEdit {
  const line = blankRowText(model.colCount);
  if (index >= model.body.length) {
    const anchor = model.body.length > 0 ? model.body[model.body.length - 1]!.lineTo : model.delimiter.lineTo;
    return { from: anchor, to: anchor, insert: `\n${line}` };
  }
  const anchor = model.body[index]!.lineFrom;
  return { from: anchor, to: anchor, insert: `${line}\n` };
}

export function deleteRowEdit(model: TableModel, index: number): TextEdit | null {
  const row = model.body[index];
  if (!row) return null;
  // Remove the line plus one adjacent newline.
  if (row.lineTo < model.to) return { from: row.lineFrom, to: row.lineTo + 1, insert: "" };
  return { from: row.lineFrom - 1, to: row.lineTo, insert: "" };
}

/**
 * Insert a column at `index` (0..colCount). Returns one edit per table line;
 * all positions reference the current document (dispatch together).
 */
export function insertColEdits(model: TableModel, index: number): TextEdit[] {
  const edits: TextEdit[] = [];
  const rows: RowSpan[] = [model.header, ...model.body];
  for (const row of rows) {
    edits.push(rowColInsert(row, index, "   |"));
  }
  edits.push(delimColInsert(model, index));
  return edits;
}

function rowColInsert(row: RowSpan, index: number, cellText: string): TextEdit {
  if (index >= row.cells.length) {
    // Append at end of line (ensure the line ends with a pipe first).
    return { from: row.lineTo, to: row.lineTo, insert: ` ${cellText.trimEnd()}` };
  }
  // Insert before the target cell's content, right after the preceding pipe.
  const anchor = row.cells[index]!.from;
  return { from: anchor, to: anchor, insert: `${cellText} ` };
}

function delimColInsert(model: TableModel, index: number): TextEdit {
  const { cols, lineTo } = model.delimiter;
  if (index >= cols.length) return { from: lineTo, to: lineTo, insert: " --- |" };
  const anchor = cols[index]!.from;
  return { from: anchor, to: anchor, insert: "--- | " };
}

export function deleteColEdits(model: TableModel, index: number): TextEdit[] {
  const edits: TextEdit[] = [];
  const rows: (RowSpan | { lineFrom: number; lineTo: number; cells: { from: number; to: number }[] })[] = [
    model.header,
    { lineFrom: model.delimiter.lineFrom, lineTo: model.delimiter.lineTo, cells: model.delimiter.cols },
    ...model.body,
  ];
  for (const row of rows) {
    const cell = row.cells[index];
    if (!cell) continue;
    const nextCell = row.cells[index + 1];
    if (nextCell) {
      // Delete from this cell's content through the next cell's start (the pipe between).
      edits.push({ from: cell.from, to: nextCell.from, insert: "" });
    } else {
      // Last column: delete from the previous pipe to end of line.
      const prevCell = row.cells[index - 1];
      const from = prevCell ? prevCell.to : row.lineFrom;
      edits.push({ from, to: row.lineTo, insert: prevCell ? " |" : "" });
    }
  }
  return edits;
}

export function setAlignEdit(model: TableModel, col: number, align: ColAlign): TextEdit | null {
  const delimCol = model.delimiter.cols[col];
  if (!delimCol) return null;
  const dashes = "-".repeat(Math.max(delimCol.dashes, 3));
  const text =
    align === "center" ? `:${dashes}:` : align === "right" ? `${dashes}:` : align === "left" ? `:${dashes}` : dashes;
  return { from: delimCol.from, to: delimCol.to, insert: text };
}

export function setColWidthEdit(model: TableModel, col: number, px: number): TextEdit | null {
  const delimCol = model.delimiter.cols[col];
  if (!delimCol) return null;
  const dashes = "-".repeat(pxToDashes(px));
  const prefix = delimCol.align === "center" || delimCol.align === "left" ? ":" : "";
  const suffix = delimCol.align === "center" || delimCol.align === "right" ? ":" : "";
  return { from: delimCol.from, to: delimCol.to, insert: `${prefix}${dashes}${suffix}` };
}

/** Markdown for a fresh rows x cols table. */
export function tableTemplate(rows: number, cols: number): string {
  const headerCells = Array.from({ length: cols }, (_, i) => ` Column ${i + 1} `).join("|");
  const delim = Array.from({ length: cols }, () => " ------ ").join("|");
  const body = Array.from({ length: rows }, () => `|${"   |".repeat(cols)}`).join("\n");
  return `|${headerCells}|\n|${delim}|\n${body}`;
}
