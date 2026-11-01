import type { OperationDef, TypeRef } from "../../ast/types.js";
import { pascalCase } from "../../utils/naming.js";

/**
 * How the Python runtime should treat an operation's response body.
 *
 * - "void"        — no content (204); runtime returns None
 * - "raw"         — bytes via request_raw; stays a {content, mime_type} dict
 * - "model"       — single Pydantic model (named $ref or hoisted inline object)
 * - "model_list"  — list of Pydantic models
 * - "model_union" — union of $ref models and plain objects (e.g. a
 *                   `representation` switch); validated against the union
 * - "untyped"     — anything else (scalars, bare dicts); stays raw JSON
 *
 * This classifier is shared by the resource emitter (which decides whether to
 * pass response_type= to the runtime) and the contract-tests emitter (which
 * decides what shape to assert). Keeping both on one function guarantees the
 * generated assertions always match the generated deserialization behavior.
 */
export type PythonResponseShape =
  | "void"
  | "raw"
  | "model"
  | "model_list"
  | "model_union"
  | "untyped";

/** Peel a single outer `nullable` / `optional` wrapper. */
export function unwrapNullability(ref: TypeRef): TypeRef {
  let current = ref;
  while (current.kind === "nullable" || current.kind === "optional") {
    current = current.inner;
  }
  return current;
}

/** True when the operation may legally return JSON null. */
export function responseAllowsNull(ref: TypeRef): boolean {
  return ref.kind === "nullable" || ref.kind === "optional";
}

export function pythonResponseShape(op: OperationDef): PythonResponseShape {
  if (op.rawResponse) return "raw";
  const ret = unwrapNullability(op.returnType);
  switch (ret.kind) {
    case "void":
      return "void";
    case "ref":
      return "model";
    case "object":
      // Inline objects with fields are hoisted into generated BaseModels;
      // empty objects have nothing to validate and stay dicts.
      return ret.fields.length > 0 ? "model" : "untyped";
    case "array":
      return ret.items.kind === "ref" ? "model_list" : "untyped";
    case "union":
      return isModelUnion(ret) ? "model_union" : unionRefError(op, ret);
    default:
      // A model buried in a shape we don't deserialize (union, optional,
      // nested array) would mean the return annotation promises a model the
      // runtime never constructs — the exact bug response_type fixes. Fail
      // generation so spec evolution cannot reintroduce it silently.
      if (containsRef(ret)) return unionRefError(op, ret);
      return "untyped";
  }
}

/**
 * A union of $ref models and plain objects (at least one of each), such as a
 * list endpoint that returns summaries or full entities depending on a query
 * parameter. Pure $ref unions are still rejected below.
 */
function isModelUnion(ref: TypeRef & { kind: "union" }): boolean {
  return (
    ref.variants.some((v) => v.kind === "ref") &&
    ref.variants.some((v) => v.kind === "object") &&
    ref.variants.every((v) => v.kind === "ref" || v.kind === "object")
  );
}

function unionRefError(op: OperationDef, ret: TypeRef): "untyped" {
  if (!containsRef(ret)) return "untyped";
  throw new Error(
    `[sdk-generator] ${op.operationId}: response shape "${ret.kind}" ` +
      `contains a schema ref but is not deserialized (no response_type ` +
      `emitted); the Python return annotation would not match runtime ` +
      `behavior. Extend pythonResponseShape to cover this shape.`
  );
}

/**
 * Class name for the BaseModel hoisted from an operation's inline object
 * response. Single source of truth for the naming rule — the resource
 * emitter (which emits the class) and the contract-tests emitter (which
 * asserts against it) must agree.
 */
export function pythonInlineResponseName(
  resourceClassName: string,
  opName: string
): string {
  return `${resourceClassName.replace(/Resource$/, "")}${pascalCase(opName)}Response`;
}

function containsRef(ref: TypeRef): boolean {
  switch (ref.kind) {
    case "ref":
      return true;
    case "array":
      return containsRef(ref.items);
    case "nullable":
    case "optional":
      return containsRef(ref.inner);
    case "union":
      return ref.variants.some(containsRef);
    case "map":
      return containsRef(ref.valueType);
    default:
      return false;
  }
}

/**
 * Python expression for the runtime's response_type kwarg, or undefined when
 * the response should pass through as raw JSON. `inlineResponseName` is the
 * hoisted BaseModel name for ops with inline object responses.
 */
export function pythonResponseTypeExpr(
  op: OperationDef,
  inlineResponseName: string | undefined
): string | undefined {
  switch (pythonResponseShape(op)) {
    case "model": {
      const inner = unwrapNullability(op.returnType);
      const name =
        inner.kind === "ref"
          ? inner.schema
          : inlineResponseName;
      if (!name) {
        throw new Error(
          `[sdk-generator] ${op.operationId}: classified as "model" (inline ` +
            `object response) but no hoisted BaseModel name was provided; ` +
            `the inline-response collection predicate has drifted from ` +
            `pythonResponseShape.`
        );
      }
      // TypeAdapter(Model) rejects JSON null; the union is what the runtime
      // actually deserializes for OAS nullable $ref responses.
      return responseAllowsNull(op.returnType) ? `${name} | None` : name;
    }
    case "model_list": {
      const inner = unwrapNullability(op.returnType);
      if (inner.kind === "array" && inner.items.kind === "ref") {
        const listType = `list[${inner.items.schema}]`;
        return responseAllowsNull(op.returnType) ? `${listType} | None` : listType;
      }
      return undefined;
    }
    case "model_union": {
      const inner = unwrapNullability(op.returnType);
      if (inner.kind !== "union") return undefined;
      // $ref variants first so the model wins ties; plain objects stay dicts.
      const refs = inner.variants.filter((v) => v.kind === "ref");
      const objects = inner.variants.some((v) => v.kind === "object")
        ? ["dict[str, Any]"]
        : [];
      const names = [...new Set([...refs.map((v) => (v as { schema: string }).schema), ...objects])];
      if (responseAllowsNull(op.returnType)) names.push("None");
      return names.join(" | ");
    }
    default:
      return undefined;
  }
}
