/**
 * Bundles the demo into the example Phoenix server's priv/static so the
 * Elixir app serves it directly:
 *
 *   priv/static/index.html
 *   priv/static/assets/app.js
 *   priv/static/assets/app.css
 *
 * Usage: node scripts/build-demo.mjs [--watch]
 */

import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const staticDir = resolve(
  pkgRoot,
  "../../elixir/operational_transform/examples/ot_example/priv/static",
);

const watch = process.argv.includes("--watch");

mkdirSync(resolve(staticDir, "assets"), { recursive: true });
cpSync(resolve(pkgRoot, "demo/index.html"), resolve(staticDir, "index.html"));
cpSync(resolve(pkgRoot, "demo/assets"), resolve(staticDir, "assets"), { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [{ in: resolve(pkgRoot, "demo/main.ts"), out: "app" }],
  bundle: true,
  format: "esm",
  target: "es2022",
  // language-data loads fence highlighters via dynamic import; splitting
  // keeps them out of the main bundle and loads them on demand.
  splitting: true,
  sourcemap: true,
  minify: !watch,
  outdir: resolve(staticDir, "assets"),
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`[build-demo] watching; output -> ${staticDir}`);
} else {
  await esbuild.build(options);
  console.log(`[build-demo] built -> ${staticDir}`);
}
