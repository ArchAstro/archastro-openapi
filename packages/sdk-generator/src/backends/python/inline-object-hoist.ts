import type { FieldDef, TypeRef } from "../../ast/types.js";
import { pascalCase } from "../../utils/naming.js";

export type HoistVariant = "typeddict" | "basemodel";

export interface HoistedGroup {
  name: string;
  fields: FieldDef[];
  description?: string;
  variant: HoistVariant;
}

export interface HoistResult {
  /** Top-level fields with nested inline objects replaced by ref types. */
  fields: FieldDef[];
  /**
   * Sibling groups to emit alongside the root, in dependency order
   * (deepest first). Empty when no nested inline objects were found.
   */
  hoisted: HoistedGroup[];
}

export interface HoistOptions {
  hoistUnions?: boolean;
}

/**
 * Walk an inline schema's fields and pull every nested inline object out as
 * a sibling type with a deterministic name (`{Parent}{FieldPascal}`,
 * `{Parent}{FieldPascal}Item` for array items, `{Parent}{FieldPascal}Value`
 * for map values). The transformed fields use `kind: ref` references to
 * those names; the original `kind: object` shape collapses to
 * `dict[str, object]` only when it has no fields (genuine freeform bag).
 *
 * Variant determines whether siblings are TypedDicts (input shapes) or
 * Pydantic BaseModels (response shapes). Depth-first recursion so each
 * hoisted entry only depends on entries that already appear before it.
 */
export function hoistInlineObjects(
  fields: ReadonlyArray<FieldDef>,
  parentName: string,
  variant: HoistVariant,
  options: HoistOptions = {}
): HoistResult {
  return hoistFields(fields, parentName, variant, new Set(), options);
}

function hoistFields(
  fields: ReadonlyArray<FieldDef>,
  parentName: string,
  variant: HoistVariant,
  usedNames: Set<string>,
  options: HoistOptions
): HoistResult {
  const newFields: FieldDef[] = [];
  const hoisted: HoistedGroup[] = [];

  for (const field of fields) {
    const fieldRoot = `${parentName}${pascalCase(field.name)}`;
    const walked = walkType(field.type, fieldRoot, variant, usedNames, options);
    newFields.push({ ...field, type: walked.type });
    hoisted.push(...walked.hoisted);
  }

  return { fields: newFields, hoisted };
}

interface WalkResult {
  type: TypeRef;
  hoisted: HoistedGroup[];
}

function walkType(
  t: TypeRef,
  nameAtThisPoint: string,
  variant: HoistVariant,
  usedNames: Set<string>,
  options: HoistOptions
): WalkResult {
  switch (t.kind) {
    case "object": {
      // Empty objects stay as `dict[str, object]` — there is nothing to
      // put on a hoisted type and consumers actually want a freeform bag
      // for things like `metadata`.
      if (t.fields.length === 0) return { type: t, hoisted: [] };

      const className = allocateName(nameAtThisPoint, usedNames);
      const inner = hoistFields(t.fields, className, variant, usedNames, options);
      return {
        type: { kind: "ref", schema: className },
        // Children are emitted before the parent so forward references
        // never appear in the generated file.
        hoisted: [
          ...inner.hoisted,
          { name: className, fields: inner.fields, variant },
        ],
      };
    }
    case "optional": {
      const inner = walkType(t.inner, nameAtThisPoint, variant, usedNames, options);
      return {
        type: { kind: "optional", inner: inner.type },
        hoisted: inner.hoisted,
      };
    }
    case "nullable": {
      const inner = walkType(t.inner, nameAtThisPoint, variant, usedNames, options);
      return {
        type: { kind: "nullable", inner: inner.type },
        hoisted: inner.hoisted,
      };
    }
    case "array": {
      const items = walkType(t.items, `${nameAtThisPoint}Item`, variant, usedNames, options);
      return {
        type: { kind: "array", items: items.type },
        hoisted: items.hoisted,
      };
    }
    case "map": {
      const value = walkType(
        t.valueType,
        `${nameAtThisPoint}Value`,
        variant,
        usedNames,
        options
      );
      return {
        type: { kind: "map", keyType: t.keyType, valueType: value.type },
        hoisted: value.hoisted,
      };
    }
    case "union": {
      if (!options.hoistUnions) return { type: t, hoisted: [] };
      const walked = t.variants.map((item, index) =>
        walkType(item, `${nameAtThisPoint}Variant${index + 1}`, variant, usedNames, options)
      );
      return {
        type: { ...t, variants: walked.map((item) => item.type) },
        hoisted: walked.flatMap((item) => item.hoisted),
      };
    }
    default:
      return { type: t, hoisted: [] };
  }
}

function allocateName(preferred: string, usedNames: Set<string>): string {
  let candidate = preferred;
  let suffix = 2;
  while (usedNames.has(candidate)) candidate = `${preferred}${suffix++}`;
  usedNames.add(candidate);
  return candidate;
}
