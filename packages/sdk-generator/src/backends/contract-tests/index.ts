import type { SdkSpec } from "../../ast/types.js";
import { emitTypeScriptContractTests } from "./typescript-emitter.js";
import { emitPythonContractTests } from "./python-emitter.js";
import { emitSwiftContractTests } from "./swift-emitter.js";
import { emitGoContractTests } from "./go-emitter.js";

export type GeneratedFiles = Record<string, string>;

export interface ContractTestOptions {
  outDir: string;
  lang: "typescript" | "python" | "swift" | "go";
  /** Go only: import path of the generated SDK package. */
  goImportPath?: string;
  /** Go only: package alias the generated tests reference the SDK through. */
  goPackageAlias?: string;
}

/**
 * Generate contract test files from the SdkSpec AST.
 *
 * Tests run against a Prism mock server and validate:
 * - Happy path: SDK methods send valid requests, parse responses
 * - Error paths: SDK correctly throws ApiError for documented error codes
 */
export function generateContractTests(
  spec: SdkSpec,
  options: ContractTestOptions
): GeneratedFiles {
  if (options.lang === "typescript") {
    return emitTypeScriptContractTests(spec, options);
  } else if (options.lang === "swift") {
    return emitSwiftContractTests(spec, options);
  } else if (options.lang === "go") {
    return emitGoContractTests(spec, {
      outDir: options.outDir,
      importPath: options.goImportPath,
      packageAlias: options.goPackageAlias,
    });
  } else {
    return emitPythonContractTests(spec, options);
  }
}
