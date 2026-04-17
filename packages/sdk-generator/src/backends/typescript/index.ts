import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SdkSpec, VersionedResourceSet } from "../../ast/types.js";
import { emitZodSchemaFile } from "./zod-emitter.js";
import { emitResourceFile } from "./resource-emitter.js";
import { emitClientFile } from "./client-emitter.js";
import { emitChannelFile } from "./channel-emitter.js";
import { emitAuthFile } from "./auth-emitter.js";
import { emitNamespaceFile, versionClassName } from "./namespace-emitter.js";
import { generatedHeader, addContentHash, cleanStaleFiles } from "../../utils/codegen.js";
import { snakeCase } from "../../utils/naming.js";

export interface TypeScriptBackendOptions {
  /** Output directory for generated SDK files */
  outDir: string;
}

/**
 * Generate a complete TypeScript SDK from the SDK AST.
 *
 * Creates:
 * - src/types/*.ts              — Zod schemas and inferred types (shared)
 * - src/{version}/resources/*.ts — Resource classes per API version
 * - src/{version}.ts            — Version namespace class (e.g., V1)
 * - src/channels/*.ts           — Channel classes (shared)
 * - src/client.ts               — PlatformClient with version namespaces + aliases
 * - src/index.ts                — Barrel exports
 */
export function generateTypeScript(
  spec: SdkSpec,
  options: TypeScriptBackendOptions
): GeneratedFiles {
  const files: GeneratedFiles = {};
  const srcDir = join(options.outDir, "src");

  // 1. Use pre-grouped schemas from frontend (cycle-free, topo-sorted)
  const schemaGroups = spec.schemaGroups;

  // 2. Generate type files (shared across versions)
  // Pre-build schema name → import path + file name mappings
  const schemaImportMap: Record<string, string> = {};
  const schemaFileMap: Record<string, string> = {};
  for (const [groupName, schemas] of Object.entries(schemaGroups)) {
    const fileName = snakeCase(groupName);
    for (const schema of schemas) {
      schemaImportMap[schema.name] = `../../types/${fileName}.js`;
      schemaFileMap[schema.name] = fileName;
    }
  }

  // Emit type files with cross-file import information
  for (const [groupName, schemas] of Object.entries(schemaGroups)) {
    const fileName = snakeCase(groupName);
    const filePath = join(srcDir, "types", `${fileName}.ts`);
    files[filePath] = emitZodSchemaFile(schemas, schemaFileMap);
  }

  // Generate types index
  const typesIndex = generateTypesIndex(Object.keys(schemaGroups));
  files[join(srcDir, "types", "index.ts")] = typesIndex;

  // 3. Generate versioned resource files + namespace classes
  for (const versionSet of spec.versions) {
    const verDir = join(srcDir, versionSet.version);

    // Resource files under {version}/resources/
    for (const resource of versionSet.resources) {
      const filePath = join(verDir, "resources", `${resource.name}.ts`);
      files[filePath] = emitResourceFile(resource, versionSet.apiPrefix, {
        runtimeImportPath: "../../runtime/http-client.js",
        schemaImports: schemaImportMap,
      });
    }

    // Resources index for this version
    files[join(verDir, "resources", "index.ts")] =
      generateVersionedResourcesIndex(versionSet);

    // Namespace class file at src/{version}.ts
    files[join(srcDir, `${versionSet.version}.ts`)] =
      emitNamespaceFile(versionSet);
  }

  // 4. Generate channel files (shared, not versioned)
  for (const channel of spec.channels) {
    const fileName = snakeCase(channel.name);
    const filePath = join(srcDir, "channels", `${fileName}.ts`);
    files[filePath] = emitChannelFile(channel);
  }

  // 5. Generate auth file (next to client.ts)
  const authContent = emitAuthFile(spec);
  if (authContent) {
    files[join(srcDir, "auth.ts")] = authContent;
  }

  // 6. Generate client file
  files[join(srcDir, "client.ts")] = emitClientFile(spec);

  // 7. Generate main index
  files[join(srcDir, "index.ts")] = generateMainIndex(spec);

  return files;
}

/**
 * Write all generated files to disk, cleaning stale files from previous runs.
 * @param cleanDirs - directories to scan for stale generated files to remove
 */
export function writeGeneratedFiles(
  files: GeneratedFiles,
  cleanDirs: string[]
): void {
  cleanStaleFiles(files, cleanDirs, [".ts"]);
  for (const [filePath, content] of Object.entries(files)) {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const commentPrefix = filePath.endsWith(".py") ? "#" : "//";
    writeFileSync(filePath, addContentHash(content, commentPrefix), "utf-8");
  }
}

export type GeneratedFiles = Record<string, string>;

// ─── Internal ────────────────────────────────────────────────────

function generateTypesIndex(groupNames: string[]): string {
  const lines = [generatedHeader()];
  for (const name of groupNames.sort()) {
    lines.push(`export * from "./${snakeCase(name)}.js";`);
  }
  return lines.join("\n") + "\n";
}

function generateVersionedResourcesIndex(
  versionSet: VersionedResourceSet
): string {
  const lines = [generatedHeader()];
  for (const resource of versionSet.resources) {
    lines.push(
      `export { ${resource.className} } from "./${resource.name}.js";`
    );
  }
  return lines.join("\n") + "\n";
}

function generateMainIndex(spec: SdkSpec): string {
  const lines = [generatedHeader()];
  lines.push(`export * from "./types/index.js";`);

  // Export version namespace classes
  for (const versionSet of spec.versions) {
    const cls = versionClassName(versionSet.version);
    lines.push(
      `export { ${cls} } from "./${versionSet.version}.js";`
    );
  }

  // Export resource classes from each version
  for (const versionSet of spec.versions) {
    lines.push(
      `export * from "./${versionSet.version}/resources/index.js";`
    );
  }

  lines.push(
    `export { PlatformClient, type PlatformClientConfig } from "./client.js";`
  );
  if ((spec.authOperations ?? []).length > 0) {
    lines.push(
      `export { AuthClient, type AuthTokens } from "./auth.js";`
    );
  }
  if (spec.channels.length > 0) {
    for (const channel of spec.channels) {
      const fileName = snakeCase(channel.name);
      lines.push(
        `export { ${channel.className} } from "./channels/${fileName}.js";`
      );
    }
  }
  return lines.join("\n") + "\n";
}
