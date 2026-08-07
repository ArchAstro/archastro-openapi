import { pascalCase, snakeCase } from "../../utils/naming.js";

const RESERVED = new Set([
  "after", "alias", "and", "case", "catch", "cond", "def", "defmodule", "do",
  "else", "end", "false", "fn", "for", "if", "import", "in", "nil", "not",
  "or", "quote", "raise", "receive", "require", "rescue", "super", "true",
  "try", "unless", "use", "when", "with", "xor",
  "__info__", "__struct__", "module_info",
]);

export function exFunctionName(value: string): string {
  const sanitized = snakeCase(value)
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^([0-9])/, (_match, digit: string) => `_${digit}`);
  const name = sanitized && !/^_+$/.test(sanitized) ? sanitized : "value";
  return RESERVED.has(name) ? `${name}_` : name;
}

export function exFieldName(value: string): string {
  return exFunctionName(value);
}

export function exModuleSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_]/g, "_");
  const module = pascalCase(cleaned);
  return /^[A-Z]/.test(module) ? module : `Value${module}`;
}

export function exString(value: string): string {
  // JSON escaping is otherwise compatible with Elixir double-quoted
  // binaries, but Elixir also interpolates `#{...}` at compile time.
  return JSON.stringify(value).replace(/#\{/g, "\\#{");
}

export function uniqueExFunctionNames(values: ReadonlyArray<string>, reserved: ReadonlyArray<string> = []): string[] {
  return uniqueNames(values.map(exFunctionName), reserved);
}

export function uniqueExFieldNames(values: ReadonlyArray<string>): string[] {
  return uniqueNames(values.map(exFieldName));
}

export function uniqueExModuleSegments(values: ReadonlyArray<string>): string[] {
  const used = new Set<string>();
  return values.map((value) => {
    const base = exModuleSegment(value);
    let candidate = base;
    let suffix = 2;
    while (used.has(exModuleSegment(candidate))) candidate = `${base}${suffix++}`;
    const normalized = exModuleSegment(candidate);
    used.add(normalized);
    return normalized;
  });
}

export function uniqueExFileStems(values: ReadonlyArray<string>): string[] {
  return uniqueNames(values.map(exFileStem));
}

export function exFileStem(value: string): string {
  const stem = snakeCase(value)
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  return stem || "value";
}

function uniqueNames(preferred: ReadonlyArray<string>, reserved: ReadonlyArray<string> = []): string[] {
  const used = new Set(reserved);
  return preferred.map((base) => {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate);
    return candidate;
  });
}
