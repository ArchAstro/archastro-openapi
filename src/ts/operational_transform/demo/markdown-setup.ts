/**
 * CodeMirror extensions that make a markdown buffer read like rich text:
 * headings render large, emphasis renders italic/bold, syntax markers fade
 * into the background — Google-Docs-adjacent while staying a plain markdown
 * document underneath.
 */

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { richBlocks } from "./rich-blocks.js";

const MONO = "'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace";

const richMarkdownHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.85em", fontWeight: "600", lineHeight: "1.3" },
  { tag: tags.heading2, fontSize: "1.45em", fontWeight: "600", lineHeight: "1.35" },
  { tag: tags.heading3, fontSize: "1.2em", fontWeight: "600" },
  { tag: tags.heading4, fontSize: "1.05em", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.monospace, fontFamily: MONO, fontSize: "0.9em", color: "#c7254e" },
  { tag: tags.link, color: "#1a73e8", textDecoration: "underline" },
  { tag: tags.url, color: "#1a73e8" },
  { tag: tags.quote, color: "#5f6368", fontStyle: "italic" },
  { tag: tags.contentSeparator, color: "#dadce0" },
  { tag: tags.list, color: "inherit" },
  // Markdown punctuation (#, *, _, `) fades so the text reads as rich text.
  { tag: tags.processingInstruction, color: "#b6bac2" },
  { tag: tags.meta, color: "#b6bac2" },
  // Tokens inside fenced code blocks (via codeLanguages).
  { tag: tags.keyword, color: "#7c4dbd" },
  { tag: tags.string, color: "#188038" },
  { tag: tags.number, color: "#b3261e" },
  { tag: tags.comment, color: "#9aa0a6", fontStyle: "italic" },
  { tag: tags.function(tags.variableName), color: "#1a73e8" },
  { tag: tags.typeName, color: "#00639b" },
  { tag: tags.propertyName, color: "#00639b" },
  { tag: tags.bool, color: "#b3261e" },
  { tag: tags.operator, color: "#5f6368" },
]);

const editorTheme = EditorView.theme({
  "&": {
    fontSize: "15px",
    backgroundColor: "transparent",
  },
  ".cm-content": {
    fontFamily: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    lineHeight: "1.7",
    padding: "56px 72px 120px",
    caretColor: "#1a73e8",
    maxWidth: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0" },
  ".cm-selectionBackground": { backgroundColor: "#c2dbff !important" },
  ".cm-cursor": { borderLeftColor: "#1a73e8", borderLeftWidth: "2px" },
  // Fenced code blocks render as a card.
  ".cm-md-codeblock": {
    backgroundColor: "#f6f8fa",
    fontFamily: MONO,
    fontSize: "13px",
    lineHeight: "1.6",
    padding: "0 14px",
    borderLeft: "1px solid #e4e7ec",
    borderRight: "1px solid #e4e7ec",
  },
  ".cm-md-codeblock-first": {
    borderTop: "1px solid #e4e7ec",
    borderRadius: "8px 8px 0 0",
    paddingTop: "6px",
  },
  ".cm-md-codeblock-last": {
    borderBottom: "1px solid #e4e7ec",
    borderRadius: "0 0 8px 8px",
    paddingBottom: "6px",
  },
  // Tables in monospace so the pipes align while editing.
  ".cm-md-table": {
    fontFamily: MONO,
    fontSize: "12.5px",
    backgroundColor: "#fbfcfe",
  },
});

export function editorExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(richMarkdownHighlight),
    richBlocks,
    editorTheme,
    EditorView.lineWrapping,
  ];
}
