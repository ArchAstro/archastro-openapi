import { pascalCase, snakeCase } from "../../utils/naming.js";

const KEYWORDS = new Set([
  "as", "break", "const", "continue", "crate", "else", "enum", "extern",
  "false", "fn", "for", "if", "impl", "in", "let", "loop", "match",
  "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static",
  "struct", "super", "trait", "true", "type", "unsafe", "use", "where",
  "while", "async", "await", "dyn", "abstract", "become", "box", "do",
  "final", "macro", "override", "priv", "typeof", "unsized", "virtual",
  "yield", "try", "gen",
]);

export function rustIdent(value: string): string {
  let result = snakeCase(value).replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!result) result = "value";
  if (/^[0-9]/.test(result)) result = `_${result}`;
  return KEYWORDS.has(result) ? `${result}_` : result;
}

export function rustTypeName(value: string): string {
  let result = pascalCase(value.replace(/[^a-zA-Z0-9_]/g, "_"));
  if (!result) result = "Value";
  if (/^[0-9]/.test(result)) result = `Value${result}`;
  return KEYWORDS.has(result) ? `${result}Type` : result;
}

export function rustString(value: string): string {
  return JSON.stringify(value);
}

export function uniqueRustNames(values: string[], reserved: string[] = []): string[] {
  const used = new Set(reserved);
  return values.map((value) => {
    const base = rustIdent(value);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate);
    return candidate;
  });
}
