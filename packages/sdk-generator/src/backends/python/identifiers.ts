import { snakeCase } from "../../utils/naming.js";

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

const PYDANTIC_RESERVED_FIELDS = new Set(["model_config"]);

export function isValidPythonIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PYTHON_KEYWORDS.has(name);
}

export function pythonIdentifier(name: string): string {
  let identifier = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (identifier.length === 0) identifier = "_";
  if (/^[0-9]/.test(identifier)) identifier = `_${identifier}`;
  if (!isValidPythonIdentifier(identifier)) identifier = `${identifier}_`;
  return identifier;
}

export function pythonParameterName(name: string): string {
  return pythonIdentifier(snakeCase(name));
}

export function pythonPydanticFieldName(name: string): string {
  const identifier = pythonIdentifier(name);
  return PYDANTIC_RESERVED_FIELDS.has(identifier) ? `${identifier}_` : identifier;
}

export function needsPythonAlias(name: string): boolean {
  return pythonPydanticFieldName(name) !== name;
}

export function uniquePythonNames(
  names: ReadonlyArray<string>,
  sanitize: (name: string) => string
): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = sanitize(name);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = base.endsWith("_") ? `${base}${suffix}` : `${base}_${suffix}`;
      suffix++;
    }
    used.add(candidate);
    return candidate;
  });
}

export function uniquePythonParameterNames(names: ReadonlyArray<string>): string[] {
  return uniquePythonNames(names, pythonParameterName);
}

export function uniquePythonPydanticFieldNames(names: ReadonlyArray<string>): string[] {
  return uniquePythonNames(names, pythonPydanticFieldName);
}
