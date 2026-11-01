import type { OperationDef } from "../../ast/types.js";
import { pascalCase } from "../../utils/naming.js";
import {
  pythonResponseShape,
  type PythonResponseShape,
} from "../python/response-type.js";

/**
 * Response-shape classification for Swift — identical semantics to the
 * Python classifier (the logic is language-neutral: it inspects the AST
 * return type, not language syntax). Re-exported under a Swift name so
 * resource emitter and contract-tests emitter share one source of truth.
 *
 * - "void"       → method returns nothing (`requestVoid`)
 * - "raw"        → `RawResponse` via `requestRaw`
 * - "model"      → named/hoisted Decodable struct
 * - "model_list" → `[Model]`
 * - "untyped"    → `JSONValue`
 */
export type SwiftResponseShape = Exclude<PythonResponseShape, "model_union">;

export function swiftResponseShape(op: OperationDef): SwiftResponseShape {
  const shape = pythonResponseShape(op);
  // Unions of models decode as untyped JSON here.
  return shape === "model_union" ? "untyped" : shape;
}

/**
 * Preferred struct name for an operation's hoisted inline response —
 * `{ResourceShortName}{OpName}Response`, matching the Python/TS rule so
 * cross-language docs and tests line up.
 */
export function swiftInlineResponseName(
  resourceClassName: string,
  opName: string
): string {
  return `${resourceClassName.replace(/Resource$/, "")}${pascalCase(opName)}Response`;
}

/** Preferred struct name for an operation's inline request body. */
export function swiftInlineInputName(
  resourceClassName: string,
  opName: string
): string {
  return `${resourceClassName.replace(/Resource$/, "")}${pascalCase(opName)}Input`;
}
