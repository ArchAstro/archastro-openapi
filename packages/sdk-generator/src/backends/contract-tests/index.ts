import type { SdkSpec } from "../../ast/types.js";
import { emitTypeScriptContractTests } from "./typescript-emitter.js";
import { emitPythonContractTests } from "./python-emitter.js";

export type GeneratedFiles = Record<string, string>;

export interface ContractTestOptions {
  outDir: string;
  lang: "typescript" | "python";
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
  } else {
    return emitPythonContractTests(spec, options);
  }
}
