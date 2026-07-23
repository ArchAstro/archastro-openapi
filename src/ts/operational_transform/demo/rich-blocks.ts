/**
 * Block-level rich rendering for the markdown editor:
 *
 *  - fenced code blocks get a card-like background (line decorations),
 *  - GFM tables render in monospace so the pipes line up,
 *  - images render inline: the `![alt](src)` syntax stays editable and the
 *    actual image appears as a block widget right below it.
 *
 * Block widgets must come from state, not a view plugin, so this is a
 * StateField recomputed per document change (demo documents are small).
 */

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, Range, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";

const codeLine = Decoration.line({ class: "cm-md-codeblock" });
const codeLineFirst = Decoration.line({ class: "cm-md-codeblock cm-md-codeblock-first" });
const codeLineLast = Decoration.line({ class: "cm-md-codeblock cm-md-codeblock-last" });
const tableLine = Decoration.line({ class: "cm-md-table" });

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-image";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.title = this.alt;
    img.draggable = false;
    // Reflow once the real dimensions are known.
    img.onload = () => wrap.classList.add("cm-md-image-loaded");
    img.onerror = () => wrap.classList.add("cm-md-image-broken");
    wrap.appendChild(img);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // Parse the whole (small) document so decorations don't pop in lazily.
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? null;
  if (!tree) return Decoration.none;

  tree.iterate({
    enter: (node) => {
      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          const line = state.doc.line(n);
          const deco = n === first ? codeLineFirst : n === last ? codeLineLast : codeLine;
          ranges.push(deco.range(line.from));
        }
      } else if (node.name === "Table") {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          ranges.push(tableLine.range(state.doc.line(n).from));
        }
      } else if (node.name === "Image") {
        const text = state.sliceDoc(node.from, node.to);
        const match = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(text);
        if (match) {
          const src = match[2]!;
          if (/^(https?:\/\/|\/|\.\/|data:image\/)/.test(src)) {
            ranges.push(
              Decoration.widget({
                widget: new ImageWidget(src, match[1] ?? ""),
                side: 1,
                block: true,
              }).range(state.doc.lineAt(node.to).to),
            );
          }
        }
      }
    },
  });

  return Decoration.set(ranges, true);
}

export const richBlocks = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    if (!tr.docChanged) return value.map(tr.changes);
    return buildDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});
