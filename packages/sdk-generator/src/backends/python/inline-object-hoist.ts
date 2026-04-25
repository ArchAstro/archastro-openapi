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
  variant: HoistVariant
): HoistResult {
  const newFields: FieldDef[] = [];
  const hoisted: HoistedGroup[] = [];

  for (const field of fields) {
    const fieldRoot = `${parentName}${pascalCase(field.name)}`;
    const walked = walkType(field.type, fieldRoot, variant);
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
  variant: HoistVariant
): WalkResult {
  switch (t.kind) {
    case "object": {
      // Empty objects stay as `dict[str, object]` — there is nothing to
      // put on a hoisted type and consumers actually want a freeform bag
      // for things like `metadata`.
      if (t.fields.length === 0) return { type: t, hoisted: [] };

      const className = nameAtThisPoint;
      const inner = hoistInlineObjects(t.fields, className, variant);
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
      const inner = walkType(t.inner, nameAtThisPoint, variant);
      return {
        type: { kind: "optional", inner: inner.type },
        hoisted: inner.hoisted,
      };
    }
    case "array": {
      const items = walkType(t.items, `${nameAtThisPoint}Item`, variant);
      return {
        type: { kind: "array", items: items.type },
        hoisted: items.hoisted,
      };
    }
    case "map": {
      const value = walkType(
        t.valueType,
        `${nameAtThisPoint}Value`,
        variant
      );
      return {
        type: { kind: "map", keyType: t.keyType, valueType: value.type },
        hoisted: value.hoisted,
      };
    }
    case "union": {
      // Skip union hoisting — naming each variant is ambiguous and unions
      // of inline objects are rare in practice. They land as
      // `dict[str, object] | dict[str, object]` today, which is no worse
      // than the current state for non-hoisted unions.
      return { type: t, hoisted: [] };
    }
    default:
      return { type: t, hoisted: [] };
  }
}
