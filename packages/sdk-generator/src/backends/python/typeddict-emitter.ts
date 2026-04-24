import type { FieldDef, ParamDef, TypeRef } from "../../ast/types.js";
import type { CodeBuilder } from "../../utils/codegen.js";
import { typeRefToPython } from "./pydantic-emitter.js";

/**
 * Emit a single TypedDict class for an inline JSON body / channel payload.
 *
 * Uses `total=False` plus `Required[T]` for required keys so that the runtime
 * shape stays a plain `dict` (zero overhead, accepts dict literals natively)
 * but type-checkers can still enforce the schema.
 *
 * ```python
 * class TeamCreateInput(TypedDict, total=False):
 *     name: Required[str]
 *     description: Optional[str]
 * ```
 */
export function emitTypedDictClass(
  cb: CodeBuilder,
  className: string,
  fields: ReadonlyArray<FieldDef | ParamDef>,
  description?: string
): void {
  if (description) {
    for (const line of description.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        cb.line(`# ${trimmed.replace(/[^\x20-\x7E]/g, " ")}`);
      }
    }
  }

  // total=False so unmentioned keys are allowed; required keys use Required[].
  // When every key is required, `total=True` (default) is cleaner — no
  // Required wrappers needed.
  const allRequired = fields.length > 0 && fields.every((f) => f.required);
  const header = allRequired
    ? `class ${className}(TypedDict)`
    : `class ${className}(TypedDict, total=False)`;

  cb.pyBlock(header, () => {
    if (fields.length === 0) {
      cb.line("pass");
      return;
    }
    for (const field of fields) {
      emitTypedDictField(cb, field, allRequired);
    }
  });
}

function emitTypedDictField(
  cb: CodeBuilder,
  field: FieldDef | ParamDef,
  classIsTotal: boolean
): void {
  const valueType = typeRefToPython(field.type);
  const annotation =
    !classIsTotal && field.required ? `Required[${valueType}]` : valueType;

  const comment = field.description
    ? `  # ${field.description.replace(/\n/g, " ").trim()}`
    : "";

  const line = `${field.name}: ${annotation}`;
  if (comment && (line + comment).length + 4 <= 100) {
    cb.line(line + comment);
  } else {
    cb.line(line);
  }
}

/**
 * Collect typing-module imports needed for a set of TypedDict classes.
 * Returns names suitable for a single `from typing import …` line.
 */
export function collectTypedDictImports(
  groups: ReadonlyArray<{ fields: ReadonlyArray<FieldDef | ParamDef> }>
): Set<string> {
  const imports = new Set<string>();
  let anyTypedDict = false;
  let anyRequired = false;

  for (const group of groups) {
    if (group.fields.length === 0) {
      anyTypedDict = true;
      continue;
    }
    anyTypedDict = true;
    const allRequired = group.fields.every((f) => f.required);
    for (const field of group.fields) {
      collectTypingFromTypeRef(field.type, imports);
      if (!allRequired && field.required) anyRequired = true;
    }
  }

  if (anyTypedDict) imports.add("TypedDict");
  if (anyRequired) imports.add("Required");
  return imports;
}

function collectTypingFromTypeRef(ref: TypeRef, imports: Set<string>): void {
  switch (ref.kind) {
    case "optional":
      imports.add("Optional");
      collectTypingFromTypeRef(ref.inner, imports);
      break;
    case "enum":
      if (ref.values.length > 0) imports.add("Literal");
      break;
    case "array":
      collectTypingFromTypeRef(ref.items, imports);
      break;
    case "union":
      for (const v of ref.variants) collectTypingFromTypeRef(v, imports);
      break;
    case "map":
      collectTypingFromTypeRef(ref.valueType, imports);
      break;
  }
}
