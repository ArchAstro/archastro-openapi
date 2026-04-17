import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

// ajv-formats is published as CJS with a default export; under Node16 moduleResolution
// TS reads it as a namespace, so unwrap the runtime default and narrow the type.
type AddFormatsFn = (ajv: Ajv) => Ajv;
const mod = addFormatsModule as unknown as { default?: AddFormatsFn } & AddFormatsFn;
const addFormats: AddFormatsFn = mod.default ?? mod;
import type {
  ChannelContract,
  JsonSchema,
  LoadedSpec,
} from "./loader.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ChannelValidator {
  /** Validate client → server join params for a given join index. */
  validateJoinParams(
    channel: string,
    joinIndex: number,
    payload: unknown
  ): ValidationResult;
  /** Validate server → client join reply. */
  validateJoinReply(
    channel: string,
    joinIndex: number,
    payload: unknown
  ): ValidationResult;
  /** Validate client → server message params. */
  validateMessageParams(
    channel: string,
    event: string,
    payload: unknown
  ): ValidationResult;
  /** Validate server → client message reply. */
  validateMessageReply(
    channel: string,
    event: string,
    payload: unknown
  ): ValidationResult;
  /** Validate server → client push payload. */
  validatePushPayload(
    channel: string,
    event: string,
    payload: unknown
  ): ValidationResult;
}

interface CompiledChannel {
  joins: Array<{
    params: ValidateFunction | null;
    returns: ValidateFunction | null;
  }>;
  messages: Map<
    string,
    { params: ValidateFunction | null; returns: ValidateFunction | null }
  >;
  pushes: Map<string, { payload: ValidateFunction | null }>;
}

export function buildValidator(loaded: LoadedSpec): ChannelValidator {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    // Some real-world OpenAPI specs have component schemas with fields that
    // aren't strictly JSON Schema valid (e.g. a non-string `description`).
    // We only care whether inbound/outbound payloads validate against those
    // schemas — not whether the schemas themselves are pristine. Turning off
    // schema-of-schema checking keeps the harness forgiving about inputs it
    // didn't author.
    validateSchema: false,
  });
  addFormats(ajv);

  // Register every component schema under its canonical $ref so that
  // inline channel schemas using { "$ref": "#/components/schemas/X" } resolve.
  // Pass `_validateSchema: false` so Ajv accepts the raw OpenAPI schemas
  // verbatim — some real specs have quirks (e.g. `description: false`)
  // that aren't strictly JSON Schema valid but are harmless to our use.
  for (const [name, schema] of Object.entries(loaded.components)) {
    const id = `#/components/schemas/${name}`;
    if (!ajv.getSchema(id)) {
      ajv.addSchema({ ...schema, $id: id }, undefined, undefined, false);
    }
  }

  const compiled = new Map<string, CompiledChannel>();
  for (const [name, contract] of loaded.contracts) {
    compiled.set(name, compileChannel(ajv, contract));
  }

  return {
    validateJoinParams(channel, joinIndex, payload) {
      const fn = compiled.get(channel)?.joins[joinIndex]?.params;
      return runValidator(fn, payload);
    },
    validateJoinReply(channel, joinIndex, payload) {
      const fn = compiled.get(channel)?.joins[joinIndex]?.returns;
      return runValidator(fn, payload);
    },
    validateMessageParams(channel, event, payload) {
      const fn = compiled.get(channel)?.messages.get(event)?.params;
      return runValidator(fn, payload);
    },
    validateMessageReply(channel, event, payload) {
      const fn = compiled.get(channel)?.messages.get(event)?.returns;
      return runValidator(fn, payload);
    },
    validatePushPayload(channel, event, payload) {
      const fn = compiled.get(channel)?.pushes.get(event)?.payload;
      return runValidator(fn, payload);
    },
  };
}

function compileChannel(
  ajv: Ajv,
  contract: ChannelContract
): CompiledChannel {
  const joins = contract.joins.map((j) => ({
    // Topic variables are captured in the URL/topic string — the generated
    // SDKs pass them as positional args and deliberately keep them out of
    // the join payload. If the spec's `params` schema still requires those
    // fields, the SDK's join payload would fail server-side validation for
    // no real benefit. Strip topic vars from the schema before compiling so
    // validation matches the shape the SDK actually sends on the wire.
    params: compileIfPresent(ajv, stripTopicVarsFromSchema(j.paramsSchema, j.vars)),
    returns: compileIfPresent(ajv, j.returnsSchema),
  }));

  const messages = new Map<
    string,
    { params: ValidateFunction | null; returns: ValidateFunction | null }
  >();
  for (const [event, m] of contract.messages) {
    messages.set(event, {
      params: compileIfPresent(ajv, m.paramsSchema),
      returns: compileIfPresent(ajv, m.returnsSchema),
    });
  }

  const pushes = new Map<string, { payload: ValidateFunction | null }>();
  for (const [event, p] of contract.pushes) {
    pushes.set(event, { payload: compileIfPresent(ajv, p.payloadSchema) });
  }

  return { joins, messages, pushes };
}

function compileIfPresent(
  ajv: Ajv,
  schema: JsonSchema | null
): ValidateFunction | null {
  if (!schema) return null;
  return ajv.compile(schema);
}

/**
 * Produce a copy of `schema` with topic-variable fields removed from the
 * `properties` map and the `required` list. Non-object schemas (or schemas
 * without topic vars) pass through unchanged.
 */
function stripTopicVarsFromSchema(
  schema: JsonSchema | null,
  vars: string[]
): JsonSchema | null {
  if (!schema || vars.length === 0) return schema;
  const topicSet = new Set(vars);
  const copy: Record<string, unknown> = { ...schema };
  const properties = copy.properties;
  if (properties && typeof properties === "object") {
    const nextProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(properties as Record<string, unknown>)) {
      if (!topicSet.has(k)) nextProps[k] = v;
    }
    copy.properties = nextProps;
  }
  const required = copy.required;
  if (Array.isArray(required)) {
    copy.required = required.filter((r) => !topicSet.has(r));
  }
  return copy as JsonSchema;
}

function runValidator(
  fn: ValidateFunction | null | undefined,
  payload: unknown
): ValidationResult {
  if (!fn) return { valid: true, errors: [] };
  const valid = fn(payload);
  if (valid) return { valid: true, errors: [] };
  const errors = (fn.errors ?? []).map(
    (e) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}`
  );
  return { valid: false, errors };
}
