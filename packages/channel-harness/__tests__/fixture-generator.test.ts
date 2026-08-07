import { describe, expect, it } from "vitest";
import type { SdkSpec } from "@archastro/sdk-generator";
import { FixtureGenerator } from "../src/fixtures/generator.js";
import { topicPatternToRegex } from "../src/spec/loader.js";

describe("harness edge-case fixtures", () => {
  it("routes topic placeholders containing non-word wire characters", () => {
    const { regex, vars } = topicPatternToRegex("room:{user-id}");
    expect(vars).toEqual(["user-id"]);
    expect("room:test-id").toMatch(regex);
  });

  it("generates a named union variant and terminates recursive arrays", () => {
    const schemas = [
      {
        name: "Leaf",
        fields: [{
          name: "id",
          required: true,
          type: { kind: "primitive" as const, type: "string" as const },
        }],
      },
      {
        name: "Choice",
        fields: [],
        unionType: {
          kind: "union" as const,
          variants: [{ kind: "ref" as const, schema: "Leaf" }],
        },
      },
      {
        name: "Node",
        fields: [{
          name: "children",
          required: true,
          type: { kind: "array" as const, items: { kind: "ref" as const, schema: "Edge" } },
        }],
      },
      {
        name: "Edge",
        fields: [{
          name: "node",
          required: true,
          type: { kind: "ref" as const, schema: "Node" },
        }],
      },
    ];
    const fixtures = new FixtureGenerator({ schemas } as SdkSpec);

    expect(fixtures.fromSchemaName("Choice")).toEqual({ id: "test-id" });
    expect(fixtures.fromSchemaName("Node")).toEqual({ children: [] });
  });
});
