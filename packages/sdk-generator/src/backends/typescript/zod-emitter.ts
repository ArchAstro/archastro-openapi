import type { SchemaDef, FieldDef, TypeRef } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { camelCase } from "../../utils/naming.js";

/**
 * Generate a TypeScript file containing Zod schemas and inferred types
 * for a group of SchemaDefs.
 *
 * Schemas are expected to arrive pre-sorted (dependencies before dependents)
 * by the frontend. The optional schemaFileMap enables cross-file imports for
 * schemas that reference types defined in sibling type files.
 *
 * ```ts
 * import { z } from "zod";
 *
 * export const teamSchema = z.object({ ... });
 * export type Team = z.infer<typeof teamSchema>;
 * ```
 */
export function emitZodSchemaFile(
  schemas: SchemaDef[],
  schemaFileMap?: Record<string, string>
): string {
  const cb = new CodeBuilder();

  cb.line(generatedHeader());
  cb.line(`import { z } from "zod";`);

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
      const imports = [...names]
        .sort()
        .map((n) => camelCase(n) + "Schema")
        .join(", ");
      cb.line(`import { ${imports} } from "./${file}.js";`);
    }
  }

  cb.line();

  for (let i = 0; i < schemas.length; i++) {
    const schema = schemas[i]!;
    emitSchema(cb, schema);
    if (i < schemas.length - 1) cb.line();
  }

  return cb.toString();
}

/**
 * Emit a single Zod schema + type alias.
 */
function emitSchema(cb: CodeBuilder, schema: SchemaDef): void {
  const schemaVar = camelCase(schema.name) + "Schema";
  const typeName = schema.name;

  if (schema.description) {
    cb.line(`/** ${schema.description} */`);
  }

  cb.line(`export const ${schemaVar} = z.object({`);
  cb.indent();

  for (const field of schema.fields) {
    emitField(cb, field);
  }

  cb.dedent();
  cb.line(`});`);
  cb.line(`export type ${typeName} = z.infer<typeof ${schemaVar}>;`);
}

/**
 * Emit a single field inside a z.object().
 */
function emitField(cb: CodeBuilder, field: FieldDef): void {
  const zodType = typeRefToZod(field.type);
  const comment = field.description ? ` // ${field.description}` : "";
  cb.line(`${field.name}: ${zodType},${comment}`);
}

/**
 * Convert a TypeRef to its Zod representation string.
 */
export function typeRefToZod(ref: TypeRef): string {
  switch (ref.kind) {
    case "primitive":
      return primitiveToZod(ref.type);

    case "array":
      return `z.array(${typeRefToZod(ref.items)})`;

    case "object": {
      if (ref.fields.length === 0) return "z.record(z.unknown())";
      const fields = ref.fields
        .map((f) => `${f.name}: ${typeRefToZod(f.type)}`)
        .join(", ");
      return `z.object({ ${fields} })`;
    }

    case "ref":
      return camelCase(ref.schema) + "Schema";

    case "enum":
      if (ref.values.length === 0) return "z.string()";
      if (ref.values.length === 1) return `z.literal("${ref.values[0]}")`;
      return `z.enum([${ref.values.map((v) => `"${v}"`).join(", ")}])`;

    case "union": {
      const variants = ref.variants.map(typeRefToZod);
      if (variants.length === 2) return `z.union([${variants.join(", ")}])`;
      return `z.union([${variants.join(", ")}])`;
    }

    case "optional":
      return `${typeRefToZod(ref.inner)}.optional()`;

    case "map":
      return `z.record(${typeRefToZod(ref.valueType)})`;

    case "unknown":
      return "z.unknown()";

    case "void":
      return "z.void()";
  }
}

function primitiveToZod(type: string): string {
  switch (type) {
    case "string":
      return "z.string()";
    case "integer":
      return "z.number().int()";
    case "float":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "datetime":
      return "z.string()";
    default:
      return "z.unknown()";
  }
}
