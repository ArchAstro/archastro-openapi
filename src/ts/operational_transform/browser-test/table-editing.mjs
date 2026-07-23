#!/usr/bin/env node
/**
 * End-to-end test of spreadsheet-mode table editing, driven through real
 * browsers with agent-browser.
 *
 * Covers:
 *   - the table widget rendering for markdown tables,
 *   - inserting a table from the toolbar grid picker,
 *   - typing in cells (spaces included) syncing to the markdown,
 *   - Enter in the last row adding a row; Tab moving between cells,
 *   - the right-click context menu inserting a column,
 *   - drag-resizing a column persisting into the delimiter row,
 *   - two browsers editing the same table concurrently (different cells,
 *     plus a row-insert racing header typing) and converging with the server.
 *
 * Usage: `npm run test:browser:tables` (env: OT_E2E_PORT).
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  ab,
  abEval,
  assert,
  assertEqual,
  drag,
  fetchServerDoc,
  log,
  makeArtifactsDir,
  openEditor,
  pkgRoot,
  rightClick,
  startServer,
  waitFor,
} from "./harness.mjs";

const PORT = Number(process.env.OT_E2E_PORT ?? 4398);
const RUN_ID = Date.now().toString(36);
const DOC_ID = `table-e2e-${RUN_ID}`;
const A = `ot-table-alice-${RUN_ID}`;
const B = `ot-table-bob-${RUN_ID}`;
const artifactsDir = makeArtifactsDir("ot-table-e2e-");

let server = null;

const content = (session) => abEval(session, "window.__otDemo.content()");
const tableLines = (session) =>
  abEval(session, 'window.__otDemo.content().split("\\n").filter(l => l.trim().startsWith("|")).length');

async function bothSynchronized() {
  const [a, b] = await Promise.all([
    abEval(A, "window.__otDemo.status()"),
    abEval(B, "window.__otDemo.status()"),
  ]);
  return a === "synchronized/synchronized" && b === "synchronized/synchronized";
}

async function main() {
  execFileSync("node", [join(pkgRoot, "scripts/build-demo.mjs")], { stdio: "inherit" });
  server = await startServer(PORT);

  await ab(A, ["set", "viewport", "1440", "900"]);
  await ab(B, ["set", "viewport", "1440", "900"]);
  await openEditor(A, server.base, DOC_ID, "Alice", "#e8453c", `alice-${RUN_ID}`, ".mdtable");
  await openEditor(B, server.base, DOC_ID, "Bob", "#12a765", `bob-${RUN_ID}`, ".mdtable");

  // --- widget renders for the welcome doc's table --------------------------
  assert("table widget rendered", (await abEval(A, 'document.querySelectorAll(".mdtable").length')) >= 1);

  // --- cell typing (with spaces) -------------------------------------------
  log("typing into a cell");
  await ab(A, ["click", '[data-row="0"][data-col="1"]']);
  await ab(A, ["keyboard", "type", " plus live grids"]);
  await waitFor("cell edit to reach the markdown", async () =>
    (await content(A)).includes("plus live grids"),
  );

  // --- Enter adds a row; Tab moves; typing lands ---------------------------
  log("Enter in the last row adds a row");
  const linesBefore = await tableLines(A);
  const lastRow = (await abEval(A, 'document.querySelectorAll(".mdtable-grid tbody tr").length')) - 1;
  await ab(A, ["click", `[data-row="${lastRow}"][data-col="0"]`]);
  await ab(A, ["press", "Enter"]);
  await waitFor("new table line", async () => (await tableLines(A)) === linesBefore + 1);
  await ab(A, ["keyboard", "type", "rowviaenter"]);
  await ab(A, ["press", "Tab"]);
  await ab(A, ["keyboard", "type", "tabbedcell"]);
  await waitFor("typed text in the new row", async () => {
    const doc = await content(A);
    return doc.includes("rowviaenter") && doc.includes("tabbedcell");
  });

  // --- right-click menu: insert column -------------------------------------
  log("context menu inserts a column");
  const colsBefore = await abEval(A, 'document.querySelectorAll(".mdtable-grid thead th").length');
  await rightClick(A, '[data-row="0"][data-col="0"]');
  await waitFor("context menu", () => abEval(A, '!!document.querySelector(".mdtable-menu")'));
  await ab(A, ["find", "text", "Insert column right", "click"]);
  await waitFor(
    "extra column",
    async () =>
      (await abEval(A, 'document.querySelectorAll(".mdtable-grid thead th").length')) === colsBefore + 1,
  );

  // --- drag-resize persists into the delimiter row -------------------------
  log("drag-resizing the first column");
  const dashesBefore = await abEval(
    A,
    'window.__otDemo.content().split("\\n").find(l => l.includes("---")).split("|")[1].trim().length',
  );
  await drag(A, '.mdtable-resize[data-col="0"]', 90, 0);
  await waitFor("wider delimiter", async () => {
    const dashes = await abEval(
      A,
      'window.__otDemo.content().split("\\n").find(l => l.includes("---")).split("|")[1].trim().length',
    );
    return dashes > dashesBefore;
  });

  // --- concurrent edits: different cells + row insert vs typing ------------
  // Both target cells in the freshly inserted (empty) column: clicking a
  // non-empty cell parks the caret mid-text, which would split earlier
  // markers and make contiguous-substring assertions flaky.
  log("concurrent cell edits from two browsers");
  await ab(A, ["click", '[data-row="0"][data-col="1"]']);
  await ab(B, ["click", '[data-row="1"][data-col="1"]']);
  await Promise.all([
    ab(A, ["keyboard", "type", " ALICECELL"]),
    ab(B, ["keyboard", "type", " BOBCELL"]),
  ]);

  log("row insert racing header typing");
  const bodyRows = await abEval(B, 'document.querySelectorAll(".mdtable-grid tbody tr").length');
  await ab(A, ["click", '[data-row="-1"][data-col="0"]']);
  await ab(B, ["click", `[data-row="${bodyRows - 1}"][data-col="0"]`]);
  await Promise.all([
    ab(A, ["keyboard", "type", " HEADER"]),
    (async () => {
      await ab(B, ["press", "Enter"]);
      await ab(B, ["keyboard", "type", "RACEROW"]);
    })(),
  ]);

  log("waiting for quiescence…");
  await waitFor("both clients synchronized", bothSynchronized, 30_000);
  // Let any final broadcast land before comparing.
  await new Promise((r) => setTimeout(r, 500));

  const [contentA, contentB, serverDoc] = await Promise.all([
    content(A),
    content(B),
    fetchServerDoc(server.base, DOC_ID),
  ]);
  assertEqual("editor A == editor B", contentA, contentB);
  assertEqual("editor A == server", contentA, serverDoc.content);

  for (const marker of ["plus live grids", "rowviaenter", "tabbedcell", "ALICECELL", "BOBCELL", "HEADER", "RACEROW"]) {
    assert(`marker "${marker}" present`, contentA.includes(marker));
  }

  // The table must still parse as a table everywhere (grid mode intact).
  assert("grid still rendered in A", (await abEval(A, 'document.querySelectorAll(".mdtable").length')) >= 1);
  assert("grid still rendered in B", (await abEval(B, 'document.querySelectorAll(".mdtable").length')) >= 1);

  // --- toolbar picker -------------------------------------------------------
  log("toolbar grid picker inserts a table");
  await ab(A, ["click", "#btn-table"]);
  await ab(A, ["click", '.table-picker-cell[data-rows="2"][data-cols="3"]']);
  await waitFor("second table widget", async () =>
    (await abEval(A, 'document.querySelectorAll(".mdtable").length')) >= 2,
  );
  await waitFor("template markdown synced", async () => (await content(A)).includes("Column 3"));

  await Promise.allSettled([
    ab(A, ["screenshot", join(artifactsDir, "alice-final.png")]),
    ab(B, ["screenshot", join(artifactsDir, "bob-final.png")]),
  ]);
  log(`screenshots saved under ${artifactsDir}`);
  log("PASS ✅  spreadsheet-mode table editing works and converges across browsers");
}

main()
  .catch(async (error) => {
    console.error(`[e2e] FAIL ❌ ${error.message}`);
    await Promise.allSettled([
      ab(A, ["screenshot", join(artifactsDir, "alice-failure.png")]),
      ab(B, ["screenshot", join(artifactsDir, "bob-failure.png")]),
    ]);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([ab(A, ["close"]), ab(B, ["close"])]);
    server?.stop();
  });
