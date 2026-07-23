import { describe, expect, test } from "vitest";
import {
  TextOperation,
  cpLength,
  utf16OffsetToCp,
  cpToUtf16Offset,
} from "../src/text-operation.js";

function op(): TextOperation {
  return new TextOperation();
}

describe("building and lengths", () => {
  test("tracks base and target lengths", () => {
    const o = op().retain(3).insert("abc").delete(2);
    expect(o.baseLength).toBe(5);
    expect(o.targetLength).toBe(6);
  });

  test("merges consecutive components of the same kind", () => {
    const o = op().retain(2).retain(3).insert("a").insert("b");
    expect(o.toJSON()).toEqual([5, "ab"]);
  });

  test("normalizes adjacent insert/delete to insert-first", () => {
    const a = op().retain(1).delete(2).insert("xy");
    const b = op().retain(1).insert("xy").delete(2);
    expect(a.toJSON()).toEqual([1, "xy", -2]);
    expect(a.toJSON()).toEqual(b.toJSON());
    expect(a.apply("abc")).toBe("axy");
  });

  test("ignores empty components", () => {
    const o = op().retain(0).insert("").delete(0);
    expect(o.toJSON()).toEqual([]);
    expect(o.isNoop()).toBe(true);
  });

  test("measures in code points, not UTF-16 units", () => {
    // "👍" is 1 code point but 2 UTF-16 units; "é" (é decomposed) is 2
    // code points but 1 grapheme.
    const o = op().retain(1).delete(2);
    expect(o.apply("\u{1F44D}e\u0301")).toBe("\u{1F44D}");
  });
});

describe("wire format", () => {
  test("round-trips", () => {
    const o = op().retain(2).insert("hi 🚀").delete(3).retain(1);
    expect(TextOperation.fromJSON(o.toJSON()).equals(o)).toBe(true);
  });

  test("matches the Elixir library's format", () => {
    const o = op().retain(6).insert("world").delete(5);
    expect(o.toJSON()).toEqual([6, "world", -5]);
    expect(o.apply("hello there")).toBe("hello world");
  });

  test("rejects garbage", () => {
    expect(() => TextOperation.fromJSON([1, null])).toThrow();
    expect(() => TextOperation.fromJSON([0])).toThrow();
    expect(() => TextOperation.fromJSON([1.5])).toThrow();
    expect(() => TextOperation.fromJSON("nope")).toThrow();
  });
});

describe("apply", () => {
  test("errors on length mismatch", () => {
    expect(() => op().retain(3).apply("ab")).toThrow(/length/);
  });
});

describe("invert", () => {
  test("undoes the operation", () => {
    const doc = "hello *world*";
    const o = op().retain(6).delete(7).insert("there");
    const applied = o.apply(doc);
    expect(o.invert(doc).apply(applied)).toBe(doc);
  });
});

describe("compose", () => {
  test("composition equals sequential application", () => {
    const doc = "abcdef";
    const a = op().retain(3).insert("X").retain(3);
    const b = op().delete(2).retain(5);
    expect(a.compose(b).apply(doc)).toBe(b.apply(a.apply(doc)));
  });

  test("rejects incompatible lengths", () => {
    expect(() => op().retain(3).compose(op().retain(4))).toThrow(/compose/);
  });
});

describe("transform", () => {
  test("TP1: both orders converge (Elixir fixture)", () => {
    const doc = "she is a girl";
    const a = op().retain(9).insert("good ").retain(4);
    const b = op().delete(3).insert("he").retain(10);

    const [a1, b1] = TextOperation.transform(a, b);
    expect(b1.apply(a.apply(doc))).toBe(a1.apply(b.apply(doc)));
    expect(b1.apply(a.apply(doc))).toBe("he is a good girl");
  });

  test("insert tie-break: left operand's insert comes first (Elixir fixture)", () => {
    const doc = "ab";
    const a = op().retain(1).insert("X").retain(1);
    const b = op().retain(1).insert("Y").retain(1);

    const [a1, b1] = TextOperation.transform(a, b);
    expect(b1.apply(a.apply(doc))).toBe("aXYb");
    expect(a1.apply(b.apply(doc))).toBe("aXYb");
  });

  test("overlapping deletes converge (Elixir fixture)", () => {
    const doc = "abcdef";
    const a = op().retain(1).delete(3).retain(2);
    const b = op().retain(2).delete(3).retain(1);

    const [a1, b1] = TextOperation.transform(a, b);
    expect(b1.apply(a.apply(doc))).toBe(a1.apply(b.apply(doc)));
    expect(b1.apply(a.apply(doc))).toBe("af");
  });

  test("rejects different base lengths", () => {
    expect(() => TextOperation.transform(op().retain(3), op().retain(4))).toThrow(/transform/);
  });
});

describe("transformIndex", () => {
  test("inserts before the index shift it right", () => {
    expect(TextOperation.transformIndex(3, op().insert("ab").retain(5))).toBe(5);
  });

  test("inserts after the index leave it alone", () => {
    expect(TextOperation.transformIndex(3, op().retain(4).insert("ab").retain(1))).toBe(3);
  });

  test("deletes spanning the index clamp it", () => {
    expect(TextOperation.transformIndex(3, op().retain(1).delete(4))).toBe(1);
  });

  test("deletes before the index shift it left", () => {
    expect(TextOperation.transformIndex(4, op().delete(2).retain(3))).toBe(2);
  });
});

describe("code point helpers", () => {
  test("cpLength counts code points", () => {
    expect(cpLength("a👍b")).toBe(3);
    expect("a👍b".length).toBe(4);
  });

  test("utf16 <-> code point conversions round-trip", () => {
    const doc = "a👍é🚀b"; // mixed BMP / astral / combining
    for (let cp = 0; cp <= cpLength(doc); cp++) {
      const u16 = cpToUtf16Offset(doc, cp);
      expect(utf16OffsetToCp(doc, u16)).toBe(cp);
    }
  });
});
