import { describe, it, expect } from "vitest";
import {
  renderLiteral,
  generateDummyValue,
  generateBodyLiteral,
} from "../../src/backends/contract-tests/value-generator.js";
import type { BodyDef, FieldDef } from "../../src/ast/types.js";

const str: FieldDef["type"] = { kind: "primitive", type: "string" };
const num: FieldDef["type"] = { kind: "primitive", type: "integer" };

describe("renderLiteral", () => {
  it("renders scalars per language", () => {
    expect(renderLiteral("hi", "typescript")).toBe('"hi"');
    expect(renderLiteral(3, "typescript")).toBe("3");
    expect(renderLiteral(true, "typescript")).toBe("true");
    expect(renderLiteral(true, "python")).toBe("True");
    expect(renderLiteral(null, "typescript")).toBe("null");
    expect(renderLiteral(null, "python")).toBe("None");
  });

  it("renders nested arrays and objects", () => {
    expect(renderLiteral(["a", "b"], "typescript")).toBe('["a", "b"]');
    expect(
      renderLiteral({ name: "Acme", tags: ["x"] }, "typescript")
    ).toBe('{ name: "Acme", tags: ["x"] }');
    expect(
      renderLiteral({ name: "Acme", tags: ["x"] }, "python")
    ).toBe('{"name": "Acme", "tags": ["x"]}');
  });

  it("quotes non-identifier object keys in typescript", () => {
    expect(renderLiteral({ "a-b": 1 }, "typescript")).toBe('{ "a-b": 1 }');
  });
});

describe("generateDummyValue", () => {
  it("renders the spec example when present", () => {
    expect(generateDummyValue(str, "email", "typescript", "user@example.com")).toBe(
      '"user@example.com"'
    );
  });

  it("falls back to the name/type heuristic without an example", () => {
    expect(generateDummyValue(str, "email", "typescript")).toBe('"test@example.com"');
    expect(generateDummyValue(num, "count", "typescript")).toBe("1");
  });

  it("escapes OpenAPI enum values in generated Elixir", () => {
    expect(
      generateDummyValue(
        { kind: "enum", values: ['unsafe#{raise "compiled"}'] },
        "state",
        "elixir"
      )
    ).toBe('"unsafe\\#{raise \\"compiled\\"}"');
  });

  it("generates typed DateTime values for Elixir contracts", () => {
    expect(
      generateDummyValue({ kind: "primitive", type: "datetime" }, "created_at", "elixir")
    ).toBe("~U[2024-01-01 00:00:00Z]");
  });
});

describe("generateBodyLiteral", () => {
  const schemas: never[] = [];
  const body: BodyDef = {
    schema: "inline",
    contentType: "application/json",
    fields: [
      { name: "name", type: str, required: true, example: "Acme" },
      { name: "note", type: str, required: false, example: "hello" },
    ],
  };

  it("includes only required fields with placeholders by default", () => {
    expect(generateBodyLiteral(body, schemas, "typescript")).toBe(
      '{ name: "test-name" }'
    );
  });

  it("includes all fields with example values when opted in", () => {
    expect(
      generateBodyLiteral(body, schemas, "typescript", {
        useExamples: true,
        includeOptional: true,
      })
    ).toBe('{ name: "Acme", note: "hello" }');
  });
});
