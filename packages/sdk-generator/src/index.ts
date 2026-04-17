#!/usr/bin/env node

/**
 * SDK Generator CLI
 *
 * Usage:
 *   npx @archastro/sdk-generator --spec openapi.json --lang typescript --out ./sdk
 *   sdk-generator --spec openapi.json --lang python --out ./sdk
 *   sdk-generator --spec openapi.json --ast-only --out ./sdk-ast.json
 *
 * Installable as a global bin (`npm install -g @archastro/sdk-generator`) — the
 * bin is named `sdk-generator` so `npx @archastro/sdk-generator` resolves
 * without an explicit --package flag.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseOpenApiSpec } from "./frontend/index.js";
import type { FrontendConfig } from "./frontend/config.js";
import { generateTypeScript, writeGeneratedFiles } from "./backends/typescript/index.js";
import { generatePython, writePythonFiles } from "./backends/python/index.js";
import { generateContractTests } from "./backends/contract-tests/index.js";

// Re-export everything for programmatic use
export { parseOpenApiSpec } from "./frontend/index.js";
export type { FrontendConfig } from "./frontend/config.js";
export type * from "./ast/types.js";
export { generateTypeScript, writeGeneratedFiles } from "./backends/typescript/index.js";
export { generatePython, writePythonFiles } from "./backends/python/index.js";
export { generateContractTests } from "./backends/contract-tests/index.js";
export { emitChannelFile } from "./backends/typescript/channel-emitter.js";
export {
  channelTestFileStem,
  emitChannelContractTestFile,
} from "./backends/contract-tests/channel-emitter.js";
export { snakeCase, camelCase, pascalCase } from "./utils/naming.js";

function main() {
  const args = process.argv.slice(2);

  const specPath = getArg(args, "--spec");
  const lang = getArg(args, "--lang");
  const outDir = getArg(args, "--out");
  const configPath = getArg(args, "--config");
  const astOnly = args.includes("--ast-only");

  if (!specPath) {
    console.error("Usage: sdk-generator --spec <openapi.json> [--lang typescript|python|contract-tests-ts|contract-tests-py] [--out <dir>] [--config <config.json>] [--ast-only]");
    process.exit(1);
  }

  // Load OpenAPI spec
  const specJson = readFileSync(resolve(specPath), "utf-8");
  const spec = JSON.parse(specJson);

  // Load config if provided
  let config: Partial<FrontendConfig> = {};
  if (configPath) {
    const configJson = readFileSync(resolve(configPath), "utf-8");
    config = JSON.parse(configJson);
  }

  // Parse spec into AST
  const ast = parseOpenApiSpec(spec, config);

  if (astOnly) {
    const output = JSON.stringify(ast, null, 2);
    if (outDir) {
      writeFileSync(resolve(outDir), output, "utf-8");
      console.log(`AST written to ${outDir}`);
    } else {
      console.log(output);
    }
    return;
  }

  if (!lang || !outDir) {
    console.error("--lang and --out are required when not using --ast-only");
    process.exit(1);
  }

  const resolvedOut = resolve(outDir);

  switch (lang) {
    case "typescript": {
      const files = generateTypeScript(ast, { outDir: resolvedOut });
      const src = resolve(resolvedOut, "src");
      writeGeneratedFiles(files, [
        resolve(src, "types"),
        resolve(src, "v1/resources"),
        resolve(src, "channels"),
      ]);
      console.log(`TypeScript SDK generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    case "python": {
      const files = generatePython(ast, { outDir: resolvedOut });
      const pkg = resolve(resolvedOut, "src/archastro/platform");
      writePythonFiles(files, [
        resolve(pkg, "types"),
        resolve(pkg, "v1/resources"),
        resolve(pkg, "channels"),
      ]);
      console.log(`Python SDK generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    case "contract-tests-ts": {
      const files = generateContractTests(ast, { outDir: resolvedOut, lang: "typescript" });
      writeGeneratedFiles(files, [
        resolve(resolvedOut, "__tests__/contract"),
        resolve(resolvedOut, "__tests__/contract/v1"),
      ]);
      console.log(`TypeScript contract tests generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    case "contract-tests-py": {
      const files = generateContractTests(ast, { outDir: resolvedOut, lang: "python" });
      writePythonFiles(files, [
        resolve(resolvedOut, "tests/contract"),
        resolve(resolvedOut, "tests/contract/v1"),
      ]);
      console.log(`Python contract tests generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    default:
      console.error(`Unknown language: ${lang}. Supported: typescript, python, contract-tests-ts, contract-tests-py`);
      process.exit(1);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// Only run main when executed directly
const isMain = process.argv[1]?.endsWith("sdk-generator") ||
               process.argv[1]?.endsWith("index.js");
if (isMain) {
  main();
}
