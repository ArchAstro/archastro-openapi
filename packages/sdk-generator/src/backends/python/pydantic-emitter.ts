import type { SchemaDef, FieldDef, TypeRef } from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython, emitPythonImportLine } from "../../utils/codegen.js";

/**
 * Generate a Python file containing Pydantic models.
 *
 * Schemas are expected to arrive pre-sorted (dependencies before dependents)
 * by the frontend. The optional schemaFileMap enables cross-file imports for
 * schemas that reference types defined in sibling type files.
 *
 * ```python
 * from pydantic import BaseModel
 * from typing import Optional, Literal
 *
 * class Team(BaseModel):
 *     id: str
 *     name: str
 *     description: Optional[str] = None
 * ```
 */
export function emitPydanticFile(
  schemas: SchemaDef[],
  schemaFileMap?: Record<string, string>
): string {
  const cb = new CodeBuilder("    ");
  const typingImports = collectTypingImports(schemas);

  for (const line of generatedHeaderPython().trim().split("\n")) { cb.line(line); };
  cb.line();
  const allFieldTypes = schemas.flatMap((s) => s.fields.map((f) => f.type));
  if (typeRefsUseDatetime(allFieldTypes)) {
    cb.line("from datetime import datetime");
  }
  cb.line("from pydantic import BaseModel");
  if (typingImports.size > 0) {
    cb.line(`from typing import ${[...typingImports].sort().join(", ")}`);
  }

  // Generate imports for schemas referenced from other type files
  if (schemaFileMap) {
    const localNames = new Set(schemas.map((s) => s.name));
    const externalByFile = new Map<string, Set<string>>();
    for (const schema of schemas) {
      for (const dep of schema.refDeps ?? []) {
        if (!localNames.has(dep) && schemaFileMap[dep]) {
          const file = schemaFileMap[dep];
          if (!externalByFile.has(file)) externalByFile.set(file, new Set());
          externalByFile.get(file)!.add(dep);
        }
      }
    }
    for (const [file, names] of [...externalByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      emitPythonImportLine(cb, `.${file}`, [...names].sort());
    }
  }

  cb.line();
  cb.line();

  for (let i = 0; i < schemas.length; i++) {
    emitModel(cb, schemas[i]!);
    if (i < schemas.length - 1) { cb.line(); cb.line(); }
  }

  return cb.toString();
}

export function emitPydanticModel(cb: CodeBuilder, schema: SchemaDef): void {
  emitModel(cb, schema);
}

function emitModel(cb: CodeBuilder, schema: SchemaDef): void {
  if (schema.description) {
    for (const line of schema.description.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        cb.line(`# ${trimmed.replace(/[^\x20-\x7E]/g, " ")}`);
      }
    }
  }

  cb.pyBlock(`class ${schema.name}(BaseModel)`, () => {
    if (schema.fields.length === 0) {
      cb.line("pass");
      return;
    }

    for (const field of schema.fields) {
      emitField(cb, field);
    }
  });
}

function emitField(cb: CodeBuilder, field: FieldDef): void {
  const pyType = typeRefToPython(field.type);
  const comment = field.description ? `  # ${field.description.replace(/\n/g, " ").trim()}` : "";

  let line: string;
  if (!field.required) {
    const defaultVal =
      field.default !== undefined ? ` = ${pythonLiteral(field.default)}` : " = None";
    line = `${field.name}: ${pyType}${defaultVal}`;
  } else if (field.default !== undefined) {
    line = `${field.name}: ${pyType} = ${pythonLiteral(field.default)}`;
  } else {
    line = `${field.name}: ${pyType}`;
  }

  // 4 = one indent level (class body), 100 = ruff line-length
  if (comment && (line + comment).length + 4 <= 100) {
    cb.line(line + comment);
  } else {
    cb.line(line);
  }
}

/**
 * Convert TypeRef to Python type annotation string.
 */
export function typeRefToPython(ref: TypeRef): string {
  switch (ref.kind) {
    case "primitive":
      return primitiveToPython(ref.type);

    case "array":
      return `list[${typeRefToPython(ref.items)}]`;

    case "object":
      if (ref.fields.length === 0) return "dict[str, object]";
      return "dict[str, object]";

    case "ref":
      return ref.schema;

    case "enum":
      if (ref.values.length === 0) return "str";
      return `Literal[${ref.values.map((v) => `"${v}"`).join(", ")}]`;

    case "union":
      return ref.variants.map(typeRefToPython).join(" | ");

    case "optional":
      return `Optional[${typeRefToPython(ref.inner)}]`;

    case "map":
      return `dict[str, ${typeRefToPython(ref.valueType)}]`;

    case "unknown":
      return "object";

    case "void":
      return "None";
  }
}

function primitiveToPython(type: string): string {
  switch (type) {
    case "string":
      return "str";
    case "datetime":
      // Pydantic v2 auto-parses ISO-8601 strings into `datetime`. Emitting the
      // typed annotation propagates the format up to the static type system.
      return "datetime";
    case "integer":
      return "int";
    case "float":
      return "float";
    case "boolean":
      return "bool";
    default:
      return "object";
  }
}

/** True if any TypeRef in `types` (recursively) is a datetime primitive. */
export function typeRefsUseDatetime(types: ReadonlyArray<TypeRef>): boolean {
  for (const t of types) if (typeRefUsesDatetime(t)) return true;
  return false;
}

function typeRefUsesDatetime(ref: TypeRef): boolean {
  switch (ref.kind) {
    case "primitive":
      return ref.type === "datetime";
    case "array":
      return typeRefUsesDatetime(ref.items);
    case "object":
      return ref.fields.some((f) => typeRefUsesDatetime(f.type));
    case "optional":
      return typeRefUsesDatetime(ref.inner);
    case "union":
      return ref.variants.some(typeRefUsesDatetime);
    case "map":
      return typeRefUsesDatetime(ref.valueType);
    default:
      return false;
  }
}

function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

function collectTypingImports(schemas: SchemaDef[]): Set<string> {
  const imports = new Set<string>();

  for (const schema of schemas) {
    for (const field of schema.fields) {
      collectImportsFromType(field.type, imports);
    }
  }

  return imports;
}

function collectImportsFromType(ref: TypeRef, imports: Set<string>): void {
  switch (ref.kind) {
    case "optional":
      imports.add("Optional");
      collectImportsFromType(ref.inner, imports);
      break;
    case "enum":
      if (ref.values.length > 0) imports.add("Literal");
      break;
    case "array":
      collectImportsFromType(ref.items, imports);
      break;
    case "union":
      for (const v of ref.variants) collectImportsFromType(v, imports);
      break;
  }
}
