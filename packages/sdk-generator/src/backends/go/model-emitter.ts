import type { FieldDef, SchemaDef, UnionTypeRef } from "../../ast/types.js";
import { CodeBuilder } from "../../utils/codegen.js";
import {
  GoNameRegistry,
  goString,
  uniqueGoFieldNames,
} from "./identifiers.js";
import { goFieldType, goJSONTag, renderGoFile } from "./type-map.js";

/**
 * Generate one Go file of models for a schema group.
 *
 * ```go
 * // Team: A team.
 * type Team struct {
 *     ID        string `json:"id"`
 *     CreatedAt *Time  `json:"created_at,omitempty"`
 * }
 * ```
 */
export function emitGoModelsFile(
  packageName: string,
  schemas: SchemaDef[],
  registry: GoNameRegistry
): string {
  const cb = new CodeBuilder("\t");
  const imports = new Set<string>();

  for (let i = 0; i < schemas.length; i++) {
    const schema = schemas[i]!;
    const name = registry.lookup(`schema:${schema.name}`);
    if (schema.unionType) {
      emitUnionSchema(cb, name, schema, registry, imports);
    } else {
      emitGoStruct(cb, name, schema.fields, registry, {
        description: schema.description,
      });
    }
    if (i < schemas.length - 1) cb.line();
  }

  return renderGoFile(packageName, [...imports], cb.toString());
}

export interface GoStructOptions {
  description?: string;
}

/**
 * Emit a single Go struct with JSON tags. Shared by the models file and the
 * resource/channel emitters' hoisted inline inputs and responses.
 */
export function emitGoStruct(
  cb: CodeBuilder,
  name: string,
  fields: ReadonlyArray<FieldDef>,
  registry: GoNameRegistry,
  options: GoStructOptions = {}
): void {
  const resolveRef = makeRefResolver(registry);
  emitDocComment(cb, name, options.description);

  if (fields.length === 0) {
    cb.line(`type ${name} struct{}`);
    return;
  }

  const memberNames = uniqueGoFieldNames(fields.map((f) => f.name));
  cb.block(`type ${name} struct`, () => {
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      emitDocComment(cb, memberNames[i]!, field.description);
      cb.line(
        `${memberNames[i]} ${goFieldType(field, resolveRef)} ${goJSONTag(field)}`
      );
    }
  });
}

/** Resolve a spec schema name to its registered Go type name. */
export function makeRefResolver(
  registry: GoNameRegistry
): (schema: string) => string {
  return (schema: string): string =>
    registry.has(`schema:${schema}`) ? registry.lookup(`schema:${schema}`) : schema;
}

/**
 * Top-level oneOf schema → a Go struct with one pointer field per ref
 * variant plus the always-populated `Raw` payload. Go has no sum types; a
 * struct of optional variants is the shape every Go JSON library converges
 * on, and keeping `Raw` means an unrecognized variant is still readable.
 *
 * Discriminated unions decode by tag; plain unions try each variant in
 * declaration order.
 */
function emitUnionSchema(
  cb: CodeBuilder,
  name: string,
  schema: SchemaDef,
  registry: GoNameRegistry,
  imports: Set<string>
): void {
  const union = schema.unionType!;
  const resolveRef = makeRefResolver(registry);
  imports.add("encoding/json");

  const refVariants = union.variants.filter(
    (v): v is Extract<typeof v, { kind: "ref" }> => v.kind === "ref"
  );
  const variantNames = uniqueGoFieldNames(
    refVariants.map((v) => v.schema),
    ["Raw"]
  );

  emitDocComment(cb, name, schema.description);
  cb.line("//");
  cb.line("// Exactly one variant pointer is set when the payload matched a known");
  cb.line("// variant. Raw always carries the undecoded payload.");
  cb.block(`type ${name} struct`, () => {
    for (let i = 0; i < refVariants.length; i++) {
      cb.line(`${variantNames[i]} *${resolveRef(refVariants[i]!.schema)}`);
    }
    cb.line("Raw JSONValue");
  });
  cb.line();

  cb.line("// UnmarshalJSON decodes the union payload.");
  cb.block(
    `func (u *${name}) UnmarshalJSON(data []byte) error`,
    () => {
      cb.line("if err := json.Unmarshal(data, &u.Raw); err != nil {");
      cb.indent();
      cb.line("return err");
      cb.dedent();
      cb.line("}");
      if (union.discriminator?.mapping) {
        emitDiscriminatedUnmarshal(cb, name, union, variantNames, refVariants, resolveRef, imports);
      } else {
        emitUntaggedUnmarshal(cb, variantNames, refVariants, resolveRef);
      }
    }
  );
  cb.line();

  cb.line("// MarshalJSON re-encodes whichever variant is set.");
  cb.block(
    `func (u ${name}) MarshalJSON() ([]byte, error)`,
    () => {
      for (let i = 0; i < refVariants.length; i++) {
        cb.line(`if u.${variantNames[i]} != nil {`);
        cb.indent();
        cb.line(`return json.Marshal(u.${variantNames[i]})`);
        cb.dedent();
        cb.line("}");
      }
      cb.line("return json.Marshal(u.Raw)");
    }
  );
}

function emitDiscriminatedUnmarshal(
  cb: CodeBuilder,
  name: string,
  union: UnionTypeRef,
  variantNames: string[],
  refVariants: Array<{ schema: string }>,
  resolveRef: (schema: string) => string,
  imports: Set<string>
): void {
  imports.add("fmt");
  const disc = union.discriminator!;
  const indexByName = new Map(refVariants.map((v, i) => [v.schema, i]));
  cb.line(`tag := u.Raw.Get(${goString(disc.propertyName)}).StringValue()`);
  cb.block("switch tag", () => {
    for (const [tag, schemaName] of Object.entries(disc.mapping ?? {})) {
      const index = indexByName.get(schemaName);
      if (index === undefined) continue;
      cb.line(`case ${goString(tag)}:`);
      cb.indent();
      cb.line(`var v ${resolveRef(schemaName)}`);
      cb.line("if err := json.Unmarshal(data, &v); err != nil {");
      cb.indent();
      cb.line("return err");
      cb.dedent();
      cb.line("}");
      cb.line(`u.${variantNames[index]} = &v`);
      cb.line("return nil");
      cb.dedent();
    }
    cb.line("default:");
    cb.indent();
    cb.line(
      `return fmt.Errorf("${name}: unknown ${disc.propertyName} tag %q", tag)`
    );
    cb.dedent();
  });
}

function emitUntaggedUnmarshal(
  cb: CodeBuilder,
  variantNames: string[],
  refVariants: Array<{ schema: string }>,
  resolveRef: (schema: string) => string
): void {
  cb.line("// Untagged union: the first variant that decodes wins.");
  for (let i = 0; i < refVariants.length; i++) {
    cb.line(`var v${i} ${resolveRef(refVariants[i]!.schema)}`);
    cb.line(`if err := json.Unmarshal(data, &v${i}); err == nil {`);
    cb.indent();
    cb.line(`u.${variantNames[i]} = &v${i}`);
    cb.line("return nil");
    cb.dedent();
    cb.line("}");
  }
  cb.line("return nil");
}

/**
 * Go doc comment. The first line leads with the identifier (`// Team: …`)
 * so `go doc` output reads correctly; continuation lines follow verbatim.
 */
export function emitDocComment(
  cb: CodeBuilder,
  name: string,
  text: string | undefined
): void {
  const lines = docLines(text);
  if (lines.length === 0) return;
  cb.line(`// ${name}: ${lines[0]}`);
  for (const line of lines.slice(1)) cb.line(`// ${line}`);
}

/** Free-form doc lines with no identifier prefix. */
export function emitPlainDocComment(
  cb: CodeBuilder,
  text: string | undefined
): void {
  for (const line of docLines(text)) cb.line(`// ${line}`);
}

export function docLines(text: string | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((line) => line.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
