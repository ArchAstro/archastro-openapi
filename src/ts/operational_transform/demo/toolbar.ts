/** Markdown formatting commands for the toolbar. */

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Wrap (or unwrap) the selection with an inline marker like `**` or `` ` ``. */
export function toggleWrap(view: EditorView, marker: string): void {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const before = state.sliceDoc(Math.max(0, range.from - marker.length), range.from);
    const after = state.sliceDoc(range.to, range.to + marker.length);

    if (before === marker && after === marker) {
      // Unwrap.
      return {
        changes: [
          { from: range.from - marker.length, to: range.from },
          { from: range.to, to: range.to + marker.length },
        ],
        range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
      };
    }
    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
    };
  });
  view.dispatch(changes, { userEvent: "input.format" });
  view.focus();
}

/** Toggle a line prefix (heading/quote/list) on every selected line. */
export function toggleLinePrefix(view: EditorView, prefix: string): void {
  const { state } = view;
  const changes: { from: number; to?: number; insert?: string }[] = [];
  const seen = new Set<number>();

  for (const range of state.selection.ranges) {
    const fromLine = state.doc.lineAt(range.from).number;
    const toLine = state.doc.lineAt(range.to).number;
    for (let n = fromLine; n <= toLine; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (line.text.startsWith(prefix)) {
        changes.push({ from: line.from, to: line.from + prefix.length });
      } else {
        // Strip any other heading prefix first so H1 -> H2 replaces cleanly.
        const existing = /^(#{1,6} |> |- )/.exec(line.text);
        if (existing && (prefix.match(/^#{1,6} $/) ? /^#{1,6} $/.test(existing[1]!) : false)) {
          changes.push({ from: line.from, to: line.from + existing[1]!.length, insert: prefix });
        } else {
          changes.push({ from: line.from, insert: prefix });
        }
      }
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input.format" });
  view.focus();
}
