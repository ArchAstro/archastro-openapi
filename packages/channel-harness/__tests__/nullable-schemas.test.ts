import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildValidator, loadSpec } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// OpenAPI 3.0 marks nullability with `nullable: true`, and on schema-ref or
// union properties that flag legitimately appears without a sibling `type`
// (`allOf: [$ref] + nullable` / `oneOf: [...] + nullable`). Ajv refuses to
// compile `nullable` without `type`, so the harness must normalize these
// shapes before compilation — these tests pin that behavior down.

/** Minimal spec carrying every nullable shape the platform spec uses. */
const syntheticSpec = {
  openapi: "3.0.0",
  info: { title: "Nullable shapes", version: "1.0.0" },
  paths: {},
  components: {
    schemas: {
      Acl: {
        type: "object",
        properties: { grants: { type: "array", items: { type: "string" } } },
      },
      // Component whose property is a type-less nullable ref — exercises the
      // ajv.addSchema registration path (compiled lazily via $ref).
      Wrapper: {
        type: "object",
        properties: {
          acl: { allOf: [{ $ref: "#/components/schemas/Acl" }], nullable: true },
        },
      },
    },
  },
  "x-channels": [
    {
      name: "Chat",
      description: "Nullable-shape fixture channel",
      joins: [
        {
          pattern: "api:chat:{room_id}",
          name: "join_room",
          params: {
            type: "object",
            required: ["room_id"],
            properties: { room_id: { type: "string" } },
          },
          returns: { type: "object" },
        },
      ],
      messages: [
        {
          event: "send",
          description: "All three nullable shapes, plus one nested in items",
          params: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              // shape 1: typed nullable
              note: { type: "string", nullable: true },
              // shape 2: allOf + $ref + nullable (the Message.acl idiom)
              acl: {
                allOf: [{ $ref: "#/components/schemas/Acl" }],
                nullable: true,
              },
              // shape 3: oneOf + nullable (the Message.user idiom)
              user: {
                nullable: true,
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" } },
                  },
                ],
              },
              // nullable nested inside items
              tags: {
                type: "array",
                items: { nullable: true, oneOf: [{ type: "string" }] },
              },
            },
          },
          returns: { type: "object" },
        },
      ],
      pushes: [
        {
          event: "wrapped",
          description: "Payload referencing a component with a nullable ref",
          payload: { $ref: "#/components/schemas/Wrapper" },
        },
      ],
    },
  ],
};

describe("nullable schema normalization", () => {
  it("compiles a spec whose schemas use nullable without type", () => {
    expect(() => buildValidator(loadSpec(syntheticSpec))).not.toThrow();
  });

  it("accepts null in every declared-nullable shape", () => {
    const validator = buildValidator(loadSpec(syntheticSpec));
    const result = validator.validateMessageParams("Chat", "send", {
      id: "msg_1",
      note: null,
      acl: null,
      user: null,
      tags: [null, "a"],
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("still validates the non-null branch of a nullable union", () => {
    const validator = buildValidator(loadSpec(syntheticSpec));
    expect(
      validator.validateMessageParams("Chat", "send", {
        id: "msg_1",
        user: { id: "usr_1" },
        acl: { grants: ["read"] },
      }).valid
    ).toBe(true);
    // A value matching neither the union branches nor null must still fail.
    expect(
      validator.validateMessageParams("Chat", "send", { id: "msg_1", user: 42 })
        .valid
    ).toBe(false);
    expect(
      validator.validateMessageParams("Chat", "send", {
        id: "msg_1",
        acl: { grants: "not-an-array" },
      }).valid
    ).toBe(false);
  });

  it("rejects null in a non-nullable field", () => {
    const validator = buildValidator(loadSpec(syntheticSpec));
    const result = validator.validateMessageParams("Chat", "send", { id: null });
    expect(result.valid).toBe(false);
  });

  it("normalizes nullable inside registered component schemas", () => {
    const validator = buildValidator(loadSpec(syntheticSpec));
    expect(validator.validatePushPayload("Chat", "wrapped", { acl: null }).valid).toBe(
      true
    );
    expect(validator.validatePushPayload("Chat", "wrapped", { acl: 5 }).valid).toBe(
      false
    );
  });
});

describe("canonical platform spec", () => {
  const platformSpec = JSON.parse(
    readFileSync(resolve(__dirname, "../../../specs/platform-openapi.json"), "utf-8")
  ) as Record<string, unknown>;

  // Regression test for the boot crash: ajv threw '"nullable" cannot be used
  // without "type"' while compiling the refreshed spec's channel contracts,
  // killing the harness process before it could serve a single test.
  it("builds a validator from specs/platform-openapi.json", () => {
    expect(() => buildValidator(loadSpec(platformSpec))).not.toThrow();
  });

  it("accepts a chat message with null acl and null user", () => {
    const validator = buildValidator(loadSpec(platformSpec));
    const result = validator.validatePushPayload("ApiChatChannel", "message_added", {
      thread_id: "thr_1",
      message: { id: "msg_1", acl: null, user: null },
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects null in a non-nullable field of the same payload", () => {
    const validator = buildValidator(loadSpec(platformSpec));
    const result = validator.validatePushPayload("ApiChatChannel", "message_added", {
      thread_id: "thr_1",
      message: { id: null },
    });
    expect(result.valid).toBe(false);
  });
});
