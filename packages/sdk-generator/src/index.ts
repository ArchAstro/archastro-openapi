#!/usr/bin/env node

/**
 * SDK Generator CLI
 *
 * Usage:
 *   npx @archastro/sdk-generator --spec openapi.json --lang typescript --out ./sdk
 *   sdk-generator --spec openapi.json --lang python --out ./sdk
 *   sdk-generator --spec openapi.json --ast-only --out ./sdk-ast.json
 *   sdk-generator --spec openapi.json --lang typescript --mode samples --out ./samples.json
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
import {
  generateSwift,
  writeSwiftFiles,
  SWIFT_GENERATED_DIR,
} from "./backends/swift/index.js";
import { SWIFT_TESTS_DIR } from "./backends/contract-tests/swift-emitter.js";
import { generateGo, writeGoFiles, GO_PACKAGE_NAME } from "./backends/go/index.js";
import { GO_TESTS_DIR } from "./backends/contract-tests/go-emitter.js";
import {
  generateElixir,
  writeElixirFiles,
  ELIXIR_GENERATED_DIR,
} from "./backends/elixir/index.js";
import { ELIXIR_TESTS_DIR } from "./backends/contract-tests/elixir-emitter.js";
import { generateContractTests } from "./backends/contract-tests/index.js";
import { generateTypeScriptSamples } from "./backends/typescript/sample-emitter.js";
import { generatePythonSamples } from "./backends/python/sample-emitter.js";
import {
  mergeSampleBundles,
  type SdkSampleAggregateOptions,
  type SdkSampleBundle,
} from "./backends/samples.js";

// Re-export everything for programmatic use
export { parseOpenApiSpec } from "./frontend/index.js";
export type { FrontendConfig } from "./frontend/config.js";
export type * from "./ast/types.js";
export { generateTypeScript, writeGeneratedFiles } from "./backends/typescript/index.js";
export { generatePython, writePythonFiles } from "./backends/python/index.js";
export { generateSwift, writeSwiftFiles, prepareSwiftSpec } from "./backends/swift/index.js";
export { generateGo, writeGoFiles, prepareGoSpec } from "./backends/go/index.js";
export { generateElixir, writeElixirFiles } from "./backends/elixir/index.js";
export { generateContractTests } from "./backends/contract-tests/index.js";
export { emitSwiftContractTests } from "./backends/contract-tests/swift-emitter.js";
export { emitGoContractTests } from "./backends/contract-tests/go-emitter.js";
export { generateTypeScriptSamples } from "./backends/typescript/sample-emitter.js";
export { generatePythonSamples } from "./backends/python/sample-emitter.js";
export type * from "./backends/samples.js";
export { emitChannelFile } from "./backends/typescript/channel-emitter.js";
export { emitResourceFile } from "./backends/typescript/resource-emitter.js";
export {
  channelTestFileStem,
  emitChannelContractTestFile,
} from "./backends/contract-tests/channel-emitter.js";
export {
  emitStreamContractTestFile,
  specHasStreamingOps,
} from "./backends/contract-tests/stream-emitter.js";
export { snakeCase, camelCase, pascalCase } from "./utils/naming.js";

export function generateSdkSamples(
  ast: ReturnType<typeof parseOpenApiSpec>,
  options: SdkSampleAggregateOptions = {}
): SdkSampleBundle {
  const languages = options.languages ?? ["typescript", "python"];
  const bundles: SdkSampleBundle[] = [];

  if (languages.includes("typescript")) {
    bundles.push(generateTypeScriptSamples(ast, options));
  }

  if (languages.includes("python")) {
    bundles.push(generatePythonSamples(ast, options));
  }

  return mergeSampleBundles(bundles);
}

function main() {
  const args = process.argv.slice(2);

  const specPath = getArg(args, "--spec");
  const lang = getArg(args, "--lang");
  const outDir = getArg(args, "--out");
  const configPath = getArg(args, "--config");
  const mode = getArg(args, "--mode") ?? "sdk";
  const astOnly = args.includes("--ast-only");

  if (!specPath) {
    console.error("Usage: sdk-generator --spec <openapi.json> [--lang typescript|python|swift|go|elixir|contract-tests-ts|contract-tests-py|contract-tests-swift|contract-tests-go|contract-tests-elixir] [--out <dir>] [--config <config.json>] [--mode sdk|samples] [--ast-only]");
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

  if (mode === "samples") {
    if (!lang) {
      console.error("--lang is required when using --mode samples");
      process.exit(1);
    }

    const samples = samplesForLanguage(ast, lang);
    const output = `${JSON.stringify(samples, null, 2)}\n`;
    if (outDir) {
      writeFileSync(resolve(outDir), output, "utf-8");
      console.log(`SDK samples written to ${outDir}`);
    } else {
      console.log(output);
    }
    return;
  }

  if (mode !== "sdk") {
    console.error(`Unknown mode: ${mode}. Supported: sdk, samples`);
    process.exit(1);
  }

  if (!lang || !outDir) {
    console.error("--lang and --out are required when not using --ast-only");
    process.exit(1);
  }

  const resolvedOut = resolve(outDir);

  switch (lang) {
    case "typescript": {
      const files = generateTypeScript(ast, {
        outDir: resolvedOut,
        clientExtensionModules: config.typescript?.clientExtensionModules,
      });
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
    case "swift": {
      const files = generateSwift(ast, { outDir: resolvedOut });
      const gen = resolve(resolvedOut, SWIFT_GENERATED_DIR);
      const cleanDirs = [
        gen,
        resolve(gen, "Types"),
        resolve(gen, "Channels"),
        ...ast.versions.map((v) => resolve(gen, v.version.toUpperCase())),
      ];
      writeSwiftFiles(files, cleanDirs);
      console.log(`Swift SDK generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    case "go": {
      const packageName = config.go?.packageName ?? GO_PACKAGE_NAME;
      const files = generateGo(ast, { outDir: resolvedOut, packageName });
      // Go compiles one package per directory, so the whole SDK lands flat
      // in a single directory alongside the hand-maintained runtime.
      writeGoFiles(files, [resolve(resolvedOut, packageName)]);
      console.log(`Go SDK generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    case "elixir": {
      const files = generateElixir(ast, { outDir: resolvedOut });
      const gen = resolve(resolvedOut, ELIXIR_GENERATED_DIR);
      // Walk the generated root so removed API-version directories are cleaned
      // as well as files belonging to versions still present in the AST.
      writeElixirFiles(files, [gen], true);
      console.log(`Elixir SDK generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    case "contract-tests-go": {
      const files = generateContractTests(ast, {
        outDir: resolvedOut,
        lang: "go",
        goImportPath: config.go?.importPath,
        goPackageAlias: config.go?.packageName ?? GO_PACKAGE_NAME,
      });
      writeGoFiles(files, [resolve(resolvedOut, GO_TESTS_DIR)]);
      console.log(`Go contract tests generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    case "contract-tests-elixir": {
      const files = generateContractTests(ast, { outDir: resolvedOut, lang: "elixir" });
      writeElixirFiles(files, [resolve(resolvedOut, ELIXIR_TESTS_DIR)], true);
      console.log(`Elixir contract tests generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    case "contract-tests-swift": {
      const files = generateContractTests(ast, { outDir: resolvedOut, lang: "swift" });
      const tests = resolve(resolvedOut, SWIFT_TESTS_DIR);
      writeSwiftFiles(files, [
        resolve(tests, "Channels"),
        resolve(tests, "Streams"),
        ...ast.versions.map((v) => resolve(tests, v.version.toUpperCase())),
      ]);
      console.log(`Swift contract tests generated at ${resolvedOut} (${Object.keys(files).length} files)`);
      break;
    }
    default:
      console.error(`Unknown language: ${lang}. Supported: typescript, python, swift, go, elixir, contract-tests-ts, contract-tests-py, contract-tests-swift, contract-tests-go, contract-tests-elixir`);
      process.exit(1);
  }
}

function samplesForLanguage(
  ast: ReturnType<typeof parseOpenApiSpec>,
  lang: string
): SdkSampleBundle {
  switch (lang) {
    case "typescript":
      return generateTypeScriptSamples(ast);
    case "python":
      return generatePythonSamples(ast);
    default:
      console.error(`Unknown sample language: ${lang}. Supported: typescript, python`);
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
