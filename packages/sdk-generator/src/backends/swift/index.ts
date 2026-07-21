import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResourceDef, SdkSpec } from "../../ast/types.js";
import {
  addContentHash,
  cleanStaleFiles,
} from "../../utils/codegen.js";
import { pascalCase } from "../../utils/naming.js";
import { SwiftNameRegistry } from "./identifiers.js";
import { emitSwiftModelsFile } from "./model-emitter.js";
import {
  claimResourceTypeNames,
  emitSwiftResourceFile,
} from "./resource-emitter.js";
import { emitSwiftNamespaceFile, swiftVersionClassName } from "./namespace-emitter.js";
import { emitSwiftAuthFile } from "./auth-emitter.js";
import { emitSwiftClientFile } from "./client-emitter.js";
import {
  claimChannelTypeNames,
  emitSwiftChannelFile,
} from "./channel-emitter.js";
import { findValueCycleSchemas } from "./type-map.js";

export interface SwiftBackendOptions {
  outDir: string;
}

export type GeneratedFiles = Record<string, string>;

/** Directory (relative to the package root) that generated sources land in. */
export const SWIFT_GENERATED_DIR = "Sources/ArchAstroPlatform/Generated";

export interface PreparedSwiftSpec {
  spec: SdkSpec;
  registry: SwiftNameRegistry;
}

/**
 * Clone the spec and assign every generated Swift type name through one
 * global registry, in a canonical order (schemas → auth → resource classes
 * → inline inputs/responses → channels). Swift compiles the SDK as a
 * single module, so all type names share a namespace; claiming in a fixed
 * order makes names reproducible across separate generator runs (the SDK
 * pass and the contract-tests pass must agree).
 *
 * Resource and channel class names are rewritten in place on the clone so
 * emitters can use `.className` directly.
 */
export function prepareSwiftSpec(spec: SdkSpec): PreparedSwiftSpec {
  const cloned: SdkSpec = structuredClone(spec);
  const registry = new SwiftNameRegistry();

  // 1. Schemas keep their spec names whenever possible.
  for (const schema of cloned.schemas) {
    registry.claim(`schema:${schema.name}`, schema.name);
  }

  // 2. Auth tokens struct — sidesteps a schema literally named AuthTokens.
  if ((cloned.authOperations ?? []).length > 0) {
    registry.claim(
      "auth:AuthTokens",
      registry.nameTaken("AuthTokens") ? "ClientAuthTokens" : "AuthTokens"
    );
  }

  // 3. Resource class names (renamed in place on collision).
  for (const versionSet of cloned.versions) {
    renameResourceClasses(versionSet.resources, registry, versionSet.version);
  }

  // 4. Inline input/response struct names.
  for (const versionSet of cloned.versions) {
    claimResourceTypeNames(versionSet.resources, registry);
  }

  // 5. Channel class names + payload struct names.
  for (const channel of cloned.channels) {
    channel.className = registry.claim(
      `channel-class:${channel.name}`,
      channel.className
    );
    claimChannelTypeNames(channel, registry);
  }

  return { spec: cloned, registry };
}

function renameResourceClasses(
  resources: ResourceDef[],
  registry: SwiftNameRegistry,
  version: string
): void {
  for (const resource of resources) {
    // Keyed by version + path so identically-named resources in different
    // versions get distinct Swift class names.
    resource.className = registry.claim(
      `resource-class:${version}:${resource.path}:${resource.name}`,
      resource.className
    );
    renameResourceClasses(resource.children, registry, version);
  }
}

/**
 * Generate a complete Swift SDK from the SDK AST.
 *
 * Creates (under Sources/ArchAstroPlatform/Generated/):
 * - Types/{Group}.swift     — Codable models per schema group
 * - {V1}/{Resource}.swift   — resource classes per version
 * - {V1}/{V1}.swift         — version namespace class
 * - Channels/{Channel}.swift — channel classes
 * - Auth.swift              — AuthClient + AuthTokens
 * - Client.swift            — PlatformClient
 */
export function generateSwift(
  spec: SdkSpec,
  options: SwiftBackendOptions
): GeneratedFiles {
  const { spec: prepared, registry } = prepareSwiftSpec(spec);
  const files: GeneratedFiles = {};
  const genDir = join(options.outDir, SWIFT_GENERATED_DIR);

  const cycleSchemas = findValueCycleSchemas(prepared.schemas);

  // 1. Type files per schema group. The "Models" suffix keeps basenames
  // unique across the module — SwiftPM rejects same-named files in
  // different subdirectories of one target.
  for (const [groupName, schemas] of Object.entries(prepared.schemaGroups)) {
    const filePath = join(genDir, "Types", `${pascalCase(groupName)}Models.swift`);
    files[filePath] = emitSwiftModelsFile(schemas, registry, cycleSchemas);
  }

  // 2. Versioned resource files + namespace class.
  for (const versionSet of prepared.versions) {
    const verDir = join(genDir, swiftVersionClassName(versionSet.version));
    const seen = new Set<string>();
    for (const resource of versionSet.resources) {
      if (seen.has(resource.name)) continue;
      seen.add(resource.name);
      const filePath = join(verDir, `${pascalCase(resource.name)}.swift`);
      files[filePath] = emitSwiftResourceFile(resource, registry);
    }
    files[join(verDir, `${swiftVersionClassName(versionSet.version)}.swift`)] =
      emitSwiftNamespaceFile(versionSet);
  }

  // 3. Channels.
  for (const channel of prepared.channels) {
    const filePath = join(genDir, "Channels", `${channel.className}.swift`);
    files[filePath] = emitSwiftChannelFile(channel, registry);
  }

  // 4. Auth.
  const authContent = emitSwiftAuthFile(prepared, registry);
  if (authContent) {
    files[join(genDir, "Auth.swift")] = authContent;
  }

  // 5. Client.
  files[join(genDir, "Client.swift")] = emitSwiftClientFile(prepared);

  return files;
}

export function writeSwiftFiles(
  files: GeneratedFiles,
  cleanDirs: string[]
): void {
  cleanStaleFiles(files, cleanDirs, [".swift"]);
  for (const [filePath, content] of Object.entries(files)) {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, addContentHash(content, "//"), "utf-8");
  }
}
