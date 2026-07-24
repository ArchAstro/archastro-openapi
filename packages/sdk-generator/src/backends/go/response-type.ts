import type { OperationDef } from "../../ast/types.js";
import { pascalCase } from "../../utils/naming.js";
import {
  pythonResponseShape,
  type PythonResponseShape,
} from "../python/response-type.js";

/**
 * Response-shape classification for Go — identical semantics to the Python
 * and Swift classifiers (the logic inspects the AST return type, not
 * language syntax). Re-exported under a Go name so the resource emitter and
 * the contract-tests emitter share one source of truth.
 *
 * - "void"       → method returns only `error`
 * - "raw"        → `*RawResponse`
 * - "model"      → pointer to a named/hoisted struct
 * - "model_list" → `[]Model`
 * - "untyped"    → `JSONValue`
 */
export type GoResponseShape = PythonResponseShape;

export function goResponseShape(op: OperationDef): GoResponseShape {
  return pythonResponseShape(op);
}

/**
 * Preferred struct name for an operation's hoisted inline response —
 * `{ResourceShortName}{OpName}Response`, matching the Python/TS/Swift rule
 * so cross-language docs and tests line up.
 */
export function goInlineResponseName(
  resourceClassName: string,
  opName: string
): string {
  return `${resourceClassName.replace(/Resource$/, "")}${pascalCase(opName)}Response`;
}

/** Preferred struct name for an operation's inline request body. */
export function goInlineInputName(
  resourceClassName: string,
  opName: string
): string {
  return `${resourceClassName.replace(/Resource$/, "")}${pascalCase(opName)}Input`;
}

/**
 * Preferred struct name for an operation's query parameters. Go has no
 * default arguments, so every query-bearing operation takes a single
 * options struct instead of a long optional-argument tail.
 */
export function goParamsStructName(
  resourceClassName: string,
  opName: string
): string {
  return `${resourceClassName.replace(/Resource$/, "")}${pascalCase(opName)}Params`;
}
