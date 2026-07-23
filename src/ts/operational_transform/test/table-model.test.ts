import { describe, expect, test } from "vitest";
import {
  deleteColEdits,
  deleteRowEdit,
  escapeCell,
  insertColEdits,
  insertRowEdit,
  minimalDiff,
  parseTable,
  setAlignEdit,
  setCellEdit,
  setColWidthEdit,
  tableTemplate,
  unescapeCell,
  type TextEdit,
} from "../demo/table-model.js";

const TABLE = ["| Name | Role |", "| ---- | ---- |", "| Ada  | Eng  |", "| Bob  | PM   |"].join("\n");

function docWith(table: string): { doc: string; from: number; to: number } {
  const prefix = "# Title\n\n";
  const suffix = "\n\nAfter.\n";
  return { doc: prefix + table + suffix, from: prefix.length, to: prefix.length + table.length };
}

function applyEdits(doc: string, edits: TextEdit[] | TextEdit): string {
  const list = Array.isArray(edits) ? [...edits] : [edits];
  list.sort((a, b) => b.from - a.from);
  let result = doc;
  for (const edit of list) {
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  }
  return result;
}

function parsed(doc: string, from: number, to: number) {
  const model = parseTable(doc, from, to);
  expect(model).not.toBeNull();
  return model!;
}

describe("parseTable", () => {
  test("maps cells to trimmed document spans", () => {
    const { doc, from, to } = docWith(TABLE);
    const model = parsed(doc, from, to);

    expect(model.colCount).toBe(2);
    expect(model.body).toHaveLength(2);
    expect(doc.slice(model.header.cells[0]!.from, model.header.cells[0]!.to)).toBe("Name");
    expect(doc.slice(model.body[0]!.cells[1]!.from, model.body[0]!.cells[1]!.to)).toBe("Eng");
    expect(model.delimiter.cols[0]!.dashes).toBe(4);
  });

  test("handles escaped pipes, alignment and ragged rows", () => {
    const table = "| A \\| B | C |\n| :--- | ---: |\n| only |";
    const { doc, from, to } = docWith(table);
    const model = parsed(doc, from, to);

    expect(unescapeCell(model.header.cells[0]!.raw)).toBe("A | B");
    expect(model.delimiter.cols[0]!.align).toBe("left");
    expect(model.delimiter.cols[1]!.align).toBe("right");
    expect(model.colCount).toBe(2);
    expect(model.body[0]!.cells).toHaveLength(1);
  });

  test("rejects non-tables", () => {
    const { doc, from, to } = docWith("just a line\nanother line");
    expect(parseTable(doc, from, to)).toBeNull();
  });
});

describe("cell editing", () => {
  test("setCellEdit produces a minimal in-span diff", () => {
    const { doc, from, to } = docWith(TABLE);
    const model = parsed(doc, from, to);

    const edit = setCellEdit(model, 0, 1, "Engineer")!;
    const result = applyEdits(doc, edit);
    expect(result).toContain("| Ada  | Engineer  |");
    // Minimal: the common prefix "Eng" is retained, only the tail is inserted.
    expect(edit.insert).toBe("ineer");
    expect(edit.from).toBe(edit.to);
  });

  test("escapes pipes and newlines on the way in", () => {
    expect(escapeCell("a|b\nc")).toBe("a\\|b c");
    expect(unescapeCell(escapeCell("a|b"))).toBe("a|b");
  });

  test("minimalDiff finds prefix/suffix", () => {
    expect(minimalDiff("hello", "hello")).toBeNull();
    expect(minimalDiff("abc", "aXc")).toEqual({ start: 1, end: 2, insert: "X" });
    expect(minimalDiff("abc", "abcd")).toEqual({ start: 3, end: 3, insert: "d" });
    expect(minimalDiff("abcd", "ad")).toEqual({ start: 1, end: 3, insert: "" });
  });
});

describe("row operations", () => {
  test("insert row at end and re-parse", () => {
    const { doc, from, to } = docWith(TABLE);
    const model = parsed(doc, from, to);
    const result = applyEdits(doc, insertRowEdit(model, model.body.length));
    const reparsed = parseTable(result, from, from + result.length - doc.length + (to - from))!;
    expect(reparsed.body).toHaveLength(3);
    expect(reparsed.body[2]!.cells.map((c) => c.raw)).toEqual(["", ""]);
  });

  test("insert row in the middle", () => {
    const { doc, from, to } = docWith(TABLE);
    const model = parsed(doc, from, to);
    const result = applyEdits(doc, insertRowEdit(model, 1));
    expect(result).toContain("| Ada  | Eng  |\n|   |   |\n| Bob  | PM   |");
    void to;
  });

  test("delete row", () => {
    const { doc, from, to } = docWith(TABLE);
    const model = parsed(doc, from, to);
    const result = applyEdits(doc, deleteRowEdit(model, 0)!);
    expect(result).not.toContain("Ada");
    expect(result).toContain("| Bob  | PM   |");
  });
});

describe("column operations", () => {
  test("insert column at the end keeps a valid table", () => {
    const { doc, from, to } = docWith(TABLE);
    const model = parsed(doc, from, to);
    const result = applyEdits(doc, insertColEdits(model, model.colCount));
    const grown = result.length - doc.length;
    const reparsed = parseTable(result, from, to + grown)!;
    expect(reparsed.colCount).toBe(3);
    expect(reparsed.body[0]!.cells.map((c) => c.raw)).toEqual(["Ada", "Eng", ""]);
  });

  test("insert column at the start keeps a valid table", () => {
    const { doc, from, to } = docWith(TABLE);
    const model = parsed(doc, from, to);
    const result = applyEdits(doc, insertColEdits(model, 0));
    const grown = result.length - doc.length;
    const reparsed = parseTable(result, from, to + grown)!;
    expect(reparsed.colCount).toBe(3);
    expect(reparsed.header.cells.map((c) => c.raw)).toEqual(["", "Name", "Role"]);
  });

  test("delete first and last columns keep valid tables", () => {
    const { doc, from, to } = docWith(TABLE);
    const model = parsed(doc, from, to);

    const withoutFirst = applyEdits(doc, deleteColEdits(model, 0));
    const shrunk = doc.length - withoutFirst.length;
    const reparsedFirst = parseTable(withoutFirst, from, to - shrunk)!;
    expect(reparsedFirst.colCount).toBe(1);
    expect(reparsedFirst.body[0]!.cells[0]!.raw).toBe("Eng");

    const withoutLast = applyEdits(doc, deleteColEdits(model, 1));
    const shrunkLast = doc.length - withoutLast.length;
    const reparsedLast = parseTable(withoutLast, from, to - shrunkLast)!;
    expect(reparsedLast.colCount).toBe(1);
    expect(reparsedLast.body[0]!.cells[0]!.raw).toBe("Ada");
  });
});

describe("alignment and width", () => {
  test("setAlignEdit writes colons", () => {
    const { doc, from, to } = docWith(TABLE);
    const model = parsed(doc, from, to);
    const result = applyEdits(doc, setAlignEdit(model, 1, "center")!);
    expect(result).toContain("| ---- | :----: |");
  });

  test("setColWidthEdit encodes width as dashes and preserves alignment", () => {
    const table = "| A | B |\n| :--- | --- |\n| x | y |";
    const { doc, from, to } = docWith(table);
    const model = parsed(doc, from, to);
    const result = applyEdits(doc, setColWidthEdit(model, 0, 200)!);
    const match = /\| (:?-+:?) \|/.exec(result)!;
    expect(match[1]!.startsWith(":")).toBe(true);
    expect((match[1]!.match(/-/g) ?? []).length).toBeGreaterThan(10);
  });
});

describe("tableTemplate", () => {
  test("produces a parseable table of the requested size", () => {
    const template = tableTemplate(3, 4);
    const { doc, from } = docWith(template);
    const model = parseTable(doc, from, from + template.length)!;
    expect(model.colCount).toBe(4);
    expect(model.body).toHaveLength(3);
    expect(model.header.cells.map((c) => c.raw)).toEqual([
      "Column 1",
      "Column 2",
      "Column 3",
      "Column 4",
    ]);
  });
});
