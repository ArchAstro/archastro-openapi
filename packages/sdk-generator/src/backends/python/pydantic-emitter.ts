import type { SchemaDef, FieldDef, TypeRef, UnionTypeRef } from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython, emitPythonImportLine } from "../../utils/codegen.js";
import { uniquePythonPydanticFieldNames } from "./identifiers.js";

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
  const allFieldTypes = schemas.flatMap((s) => {
    const types: TypeRef[] = s.fields.map((f) => f.type);
    if (s.unionType) types.push(s.unionType);
    return types;
  });
  if (typeRefsUseDatetime(allFieldTypes)) {
    cb.line("from datetime import datetime");
  }
  // A discriminated union needs `pydantic.Field(discriminator=...)`; plain
  // BaseModel-only files keep the smaller import to avoid lint noise.
  const hasAliasedFields = schemas.some((schema) => schemaHasAliasedFields(schema));
  const hasFieldDescriptions = schemas.some((schema) =>
    schema.fields.some((field) => field.description)
  );
  const needsField = schemas.some((s) => s.unionType?.discriminator) ||
    hasAliasedFields ||
    hasFieldDescriptions;
  const pydanticImports = ["BaseModel"];
  if (hasAliasedFields) pydanticImports.push("ConfigDict");
  if (needsField) pydanticImports.push("Field");
  cb.line(`from pydantic import ${pydanticImports.join(", ")}`);
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
  // Top-level unions become a typing alias (not a BaseModel subclass).
  // Discriminated unions get Pydantic's discriminator metadata for
  // tagged-union deserialization.
  if (schema.unionType) {
    emitPythonComment(cb, schema.description);
    cb.line(`${schema.name} = ${unionTypeToPython(schema.unionType)}`);
    return;
  }

  const fieldNames = pythonFieldNamesForSchema(schema);
  cb.pyBlock(`class ${schema.name}(BaseModel)`, () => {
    emitPythonDocstring(cb, schema.description);

    if (schema.fields.length === 0) {
      cb.line("pass");
      return;
    }

    if (schemaHasAliasedFields(schema, fieldNames)) {
      cb.line("model_config = ConfigDict(populate_by_name=True)");
      cb.line();
    }

    for (let i = 0; i < schema.fields.length; i++) {
      emitField(cb, schema.fields[i]!, fieldNames[i]!);
    }
  });
}

function unionTypeToPython(union: UnionTypeRef): string {
  const variants = union.variants.map(typeRefToPython).join(", ");
  if (union.discriminator) {
    return `Annotated[Union[${variants}], Field(discriminator="${union.discriminator.propertyName}")]`;
  }
  return `Union[${variants}]`;
}

function emitField(cb: CodeBuilder, field: FieldDef, fieldName: string): void {
  const pyType = typeRefToPython(field.type);
  const needsAlias = fieldName !== field.name;
  const needsFieldMetadata = needsAlias || Boolean(field.description);

  let line: string;
  if (needsFieldMetadata) {
    const fieldArgs: string[] = [];
    if (!field.required) {
      const defaultValue =
        field.default !== undefined ? pythonLiteral(field.default) : "None";
      fieldArgs.push(`default=${defaultValue}`);
    } else if (field.default !== undefined) {
      fieldArgs.push(`default=${pythonLiteral(field.default)}`);
    } else {
      fieldArgs.push("...");
    }

    if (needsAlias) {
      fieldArgs.push(`alias=${pythonLiteral(field.name)}`);
    }

    if (field.description) {
      fieldArgs.push(`description=${pythonLiteral(cleanDoc(field.description))}`);
    }

    line = `${fieldName}: ${pyType} = Field(${fieldArgs.join(", ")})`;
  } else if (!field.required) {
    const defaultVal =
      field.default !== undefined ? ` = ${pythonLiteral(field.default)}` : " = None";
    line = `${fieldName}: ${pyType}${defaultVal}`;
  } else if (field.default !== undefined) {
    line = `${fieldName}: ${pyType} = ${pythonLiteral(field.default)}`;
  } else {
    line = `${fieldName}: ${pyType}`;
  }

  cb.line(line);
}

function pythonFieldNamesForSchema(schema: SchemaDef): string[] {
  return uniquePythonPydanticFieldNames(schema.fields.map((field) => field.name));
}

function schemaHasAliasedFields(schema: SchemaDef, fieldNames = pythonFieldNamesForSchema(schema)): boolean {
  return !schema.unionType && schema.fields.some((field, index) => fieldNames[index] !== field.name);
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
      // Free-form objects map to Any, not the `object` builtin: a field
      // named `object` on the same model shadows the builtin when pydantic
      // resolves deferred annotations against the class namespace, silently
      // turning `dict[str, object]` into `dict[str, None]`.
      return "dict[str, Any]";

    case "ref":
      return ref.schema;

    case "enum":
      if (ref.values.length === 0) return "str";
      return `Literal[${ref.values.map((v) => `"${v}"`).join(", ")}]`;

    case "union":
      return ref.variants.map(typeRefToPython).join(" | ");

    case "optional":
      return `Optional[${typeRefToPython(ref.inner)}]`;

    case "nullable":
      return `Optional[${typeRefToPython(ref.inner)}]`;

    case "map":
      return `dict[str, ${typeRefToPython(ref.valueType)}]`;

    case "unknown":
      return "Any";

    case "void":
      return "None";
  }
}

/** True when a primitive TypeRef falls through to `Any` (needs the typing import). */
export function primitiveMapsToAny(type: string): boolean {
  return !["string", "datetime", "integer", "float", "boolean"].includes(type);
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
      return "Any";
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
    case "nullable":
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
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function cleanDoc(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

function emitPythonDocstring(cb: CodeBuilder, text: string | undefined): void {
  const lines = docLines(text);
  if (lines.length === 0) return;
  cb.line('"""');
  for (const line of lines) {
    cb.line(line);
  }
  cb.line('"""');
  cb.line();
}

function emitPythonComment(cb: CodeBuilder, text: string | undefined): void {
  for (const line of docLines(text)) {
    cb.line(`# ${line}`);
  }
}

function docLines(text: string | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map(cleanDoc)
    .filter(Boolean);
}

function collectTypingImports(schemas: SchemaDef[]): Set<string> {
  const imports = new Set<string>();

  for (const schema of schemas) {
    for (const field of schema.fields) {
      collectImportsFromType(field.type, imports);
    }
    if (schema.unionType) {
      // The union alias itself always needs `Union`; the tagged form adds
      // `Annotated` (the discriminator wrapper). Walk variants so anything
      // they expose (Literal, Optional, etc.) flows through too.
      imports.add("Union");
      if (schema.unionType.discriminator) imports.add("Annotated");
      for (const v of schema.unionType.variants) {
        collectImportsFromType(v, imports);
      }
    }
  }

  return imports;
}

function collectImportsFromType(ref: TypeRef, imports: Set<string>): void {
  switch (ref.kind) {
    case "nullable":
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
    case "map":
      collectImportsFromType(ref.valueType, imports);
      break;
    case "object":
    case "unknown":
      imports.add("Any");
      break;
    case "primitive":
      if (primitiveMapsToAny(ref.type)) imports.add("Any");
      break;
  }
}
