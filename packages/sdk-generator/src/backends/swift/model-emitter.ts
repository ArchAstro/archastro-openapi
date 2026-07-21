import type { FieldDef, SchemaDef, UnionTypeRef } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { camelCase } from "../../utils/naming.js";
import {
  SwiftNameRegistry,
  swiftString,
  uniqueSwiftMemberNames,
} from "./identifiers.js";
import { typeRefToSwift } from "./type-map.js";

export interface SwiftModelOptions {
  /** Emit a final class instead of a struct (for by-value ref cycles). */
  asClass?: boolean;
}

/**
 * Generate one Swift file of Codable models for a schema group.
 *
 * ```swift
 * public struct Team: Codable, Sendable {
 *     public var id: String
 *     public var createdAt: Date?
 *     public init(id: String, createdAt: Date? = nil) { ... }
 *     private enum CodingKeys: String, CodingKey { ... }
 * }
 * ```
 */
export function emitSwiftModelsFile(
  schemas: SchemaDef[],
  registry: SwiftNameRegistry,
  cycleSchemas: Set<string>
): string {
  const cb = new CodeBuilder("    ");
  for (const line of generatedHeader().trim().split("\n")) cb.line(line);
  cb.line();
  cb.line("import Foundation");
  cb.line();

  for (let i = 0; i < schemas.length; i++) {
    const schema = schemas[i]!;
    const name = registry.lookup(`schema:${schema.name}`);
    if (schema.unionType) {
      emitUnionSchema(cb, name, schema, registry);
    } else {
      emitSwiftStruct(cb, name, schema.fields, registry, {
        description: schema.description,
        asClass: cycleSchemas.has(schema.name),
      });
    }
    if (i < schemas.length - 1) cb.line();
  }

  return cb.toString();
}

/**
 * Emit a single Codable struct (or final class for recursive schemas).
 * Shared by the models file and the resource emitter's inline inputs and
 * responses.
 */
export function emitSwiftStruct(
  cb: CodeBuilder,
  name: string,
  fields: ReadonlyArray<FieldDef>,
  registry: SwiftNameRegistry,
  options: SwiftModelOptions & { description?: string } = {}
): void {
  const resolveRef = (schema: string): string =>
    registry.has(`schema:${schema}`) ? registry.lookup(`schema:${schema}`) : schema;

  emitDocComment(cb, options.description);

  const memberNames = uniqueSwiftMemberNames(fields.map((f) => f.name));
  const keyword = options.asClass ? "public final class" : "public struct";
  const conformance = options.asClass
    ? "Codable, @unchecked Sendable"
    : "Codable, Sendable";

  cb.block(`${keyword} ${name}: ${conformance}`, () => {
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      emitDocComment(cb, field.description);
      cb.line(`public var ${memberNames[i]}: ${fieldType(field, resolveRef)}`);
    }

    if (fields.length > 0) cb.line();
    const params = fields.map((field, i) => {
      const type = fieldType(field, resolveRef);
      const optional = !field.required || field.type.kind === "optional";
      return `${memberNames[i]}: ${type}${optional ? " = nil" : ""}`;
    });
    emitInit(cb, params, fields.map((_, i) => memberNames[i]!));

    if (fields.length > 0) {
      cb.line();
      cb.block("private enum CodingKeys: String, CodingKey", () => {
        for (let i = 0; i < fields.length; i++) {
          const field = fields[i]!;
          const member = memberNames[i]!;
          const bare = member.replace(/`/g, "");
          // A renamed member (camelCased, keyword-escaped, or suffixed on
          // collision) needs an explicit raw value for the wire name.
          if (bare === field.name) {
            cb.line(`case ${member}`);
          } else {
            cb.line(`case ${member} = ${swiftString(field.name)}`);
          }
        }
      });
    }
  });
}

function emitInit(cb: CodeBuilder, params: string[], memberNames: string[]): void {
  if (params.length === 0) {
    cb.line("public init() {}");
    return;
  }
  const oneLiner = `public init(${params.join(", ")}) {`;
  if (oneLiner.length <= 96) {
    cb.line(oneLiner);
  } else {
    cb.line("public init(");
    cb.indent();
    for (let i = 0; i < params.length; i++) {
      cb.line(`${params[i]}${i < params.length - 1 ? "," : ""}`);
    }
    cb.dedent();
    cb.line(") {");
  }
  cb.indent();
  for (const member of memberNames) {
    cb.line(`self.${member} = ${member}`);
  }
  cb.dedent();
  cb.line("}");
}

function fieldType(
  field: FieldDef,
  resolveRef: (schema: string) => string
): string {
  const base = typeRefToSwift(field.type, resolveRef);
  // Non-required fields become optional even when the schema type itself
  // isn't nullable — the wire may omit them.
  if (!field.required && field.type.kind !== "optional") {
    return `${base}?`;
  }
  return base;
}

/**
 * Top-level oneOf schema → a Swift enum with one case per ref variant.
 * Discriminated unions decode by tag; plain unions try each variant in
 * declaration order. Non-ref variants fall back to a `raw(JSONValue)` case.
 */
function emitUnionSchema(
  cb: CodeBuilder,
  name: string,
  schema: SchemaDef,
  registry: SwiftNameRegistry
): void {
  const union = schema.unionType!;
  const resolveRef = (s: string): string =>
    registry.has(`schema:${s}`) ? registry.lookup(`schema:${s}`) : s;

  emitDocComment(cb, schema.description);

  const refVariants = union.variants.filter(
    (v): v is Extract<typeof v, { kind: "ref" }> => v.kind === "ref"
  );
  const hasRaw = refVariants.length < union.variants.length;

  cb.block(`public enum ${name}: Codable, Sendable`, () => {
    for (const v of refVariants) {
      cb.line(`case ${camelCase(v.schema)}(${resolveRef(v.schema)})`);
    }
    if (hasRaw) cb.line("case raw(JSONValue)");
    cb.line();

    cb.block("public init(from decoder: any Decoder) throws", () => {
      if (union.discriminator && union.discriminator.mapping) {
        emitDiscriminatedInit(cb, union, resolveRef);
      } else {
        emitUntaggedInit(cb, refVariants.map((v) => v.schema), hasRaw, name, resolveRef);
      }
    });
    cb.line();

    cb.block("public func encode(to encoder: any Encoder) throws", () => {
      cb.block("switch self", () => {
        for (const v of refVariants) {
          cb.line(`case .${camelCase(v.schema)}(let value): try value.encode(to: encoder)`);
        }
        if (hasRaw) cb.line("case .raw(let value): try value.encode(to: encoder)");
      });
    });
  });
}

function emitDiscriminatedInit(
  cb: CodeBuilder,
  union: UnionTypeRef,
  resolveRef: (schema: string) => string
): void {
  const disc = union.discriminator!;
  cb.line("let raw = try JSONValue(from: decoder)");
  cb.line(`let tag = raw[${swiftString(disc.propertyName)}]?.stringValue`);
  cb.block("switch tag", () => {
    for (const [tag, schemaName] of Object.entries(disc.mapping ?? {})) {
      cb.line(
        `case ${swiftString(tag)}: self = .${camelCase(schemaName)}(try raw.decode(${resolveRef(schemaName)}.self))`
      );
    }
    cb.line("default:");
    cb.indent();
    cb.line(
      'throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, ' +
        `debugDescription: "Unknown ${disc.propertyName} tag: \\(tag ?? "nil")"))`
    );
    cb.dedent();
  });
}

function emitUntaggedInit(
  cb: CodeBuilder,
  refSchemas: string[],
  hasRaw: boolean,
  name: string,
  resolveRef: (schema: string) => string
): void {
  cb.line("let raw = try JSONValue(from: decoder)");
  for (const schemaName of refSchemas) {
    cb.block(
      `if let value = try? raw.decode(${resolveRef(schemaName)}.self)`,
      () => {
        cb.line(`self = .${camelCase(schemaName)}(value)`);
        cb.line("return");
      }
    );
  }
  if (hasRaw) {
    cb.line("self = .raw(raw)");
  } else {
    cb.line(
      `throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No ${name} variant matched"))`
    );
  }
}

export function emitDocComment(cb: CodeBuilder, text: string | undefined): void {
  for (const line of docLines(text)) {
    cb.line(`/// ${line}`);
  }
}

export function docLines(text: string | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((line) => line.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
