import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResourceDef, SdkSpec } from "../../ast/types.js";
import { addContentHash, cleanStaleFiles } from "../../utils/codegen.js";
import { GoNameRegistry, goFileStem } from "./identifiers.js";
import { emitGoModelsFile } from "./model-emitter.js";
import { claimResourceTypeNames, emitGoResourceFile } from "./resource-emitter.js";
import { emitGoNamespaceFile, goVersionStructName } from "./namespace-emitter.js";
import { emitGoAuthFile } from "./auth-emitter.js";
import { emitGoClientFile } from "./client-emitter.js";
import { claimChannelTypeNames, emitGoChannelFile } from "./channel-emitter.js";

export interface GoBackendOptions {
  outDir: string;
  /** Go package name for the generated SDK (default: "platform"). */
  packageName?: string;
  /** Directory (relative to outDir) the package lives in (default: same as packageName). */
  packageDir?: string;
}

export type GeneratedFiles = Record<string, string>;

/** Default Go package name and directory for the generated SDK. */
export const GO_PACKAGE_NAME = "platform";

export interface PreparedGoSpec {
  spec: SdkSpec;
  registry: GoNameRegistry;
}

/**
 * Clone the spec and assign every generated Go identifier through one
 * registry, in a canonical order (versions → schemas → auth → resource
 * structs → inline inputs/responses/params → channels). Go resolves types
 * *and* functions from a single package-level namespace, so the join
 * constructors and topic builders claim through the same registry as the
 * structs.
 *
 * Claiming in a fixed order makes names reproducible across separate
 * generator runs — the SDK pass and the contract-tests pass must agree.
 */
export function prepareGoSpec(spec: SdkSpec): PreparedGoSpec {
  const cloned: SdkSpec = structuredClone(spec);
  const registry = new GoNameRegistry();

  // 1. Version namespaces are structural — they claim before schemas so a
  // schema literally named "V1" is the one that gets renamed.
  for (const versionSet of cloned.versions) {
    registry.claim(
      `version:${versionSet.version}`,
      goVersionStructName(versionSet.version)
    );
  }

  // 2. Schemas keep their spec names whenever possible.
  for (const schema of cloned.schemas) {
    registry.claim(`schema:${schema.name}`, schema.name);
  }

  // 3. Auth tokens struct — sidesteps a schema literally named AuthTokens.
  if ((cloned.authOperations ?? []).length > 0) {
    registry.claim(
      "auth:AuthTokens",
      registry.nameTaken("AuthTokens") ? "ClientAuthTokens" : "AuthTokens"
    );
  }

  // 4. Resource struct names (renamed in place on collision).
  for (const versionSet of cloned.versions) {
    renameResourceClasses(versionSet.resources, registry, versionSet.version);
  }

  // 5. Inline input/response/params struct names.
  for (const versionSet of cloned.versions) {
    claimResourceTypeNames(versionSet.resources, registry);
  }

  // 6. Channel struct names, payload structs, and join/topic functions.
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
  registry: GoNameRegistry,
  version: string
): void {
  for (const resource of resources) {
    // Keyed by version + path so identically-named resources in different
    // versions get distinct Go struct names.
    resource.className = registry.claim(
      `resource-class:${version}:${resource.path}:${resource.name}`,
      resource.className
    );
    renameResourceClasses(resource.children, registry, version);
  }
}

/**
 * Generate a complete Go SDK from the SDK AST.
 *
 * Go compiles one package per directory, so every generated file lands flat
 * in the package directory with a role prefix:
 *
 * - types_{group}.go      — models per schema group
 * - {version}_{resource}.go — resource structs per version
 * - {version}.go          — version namespace struct
 * - channels_{channel}.go — channel structs + join helpers
 * - auth.go               — AuthClient + AuthTokens
 * - client.go             — Client
 */
export function generateGo(
  spec: SdkSpec,
  options: GoBackendOptions
): GeneratedFiles {
  const { spec: prepared, registry } = prepareGoSpec(spec);
  const packageName = options.packageName ?? GO_PACKAGE_NAME;
  const packageDir = options.packageDir ?? packageName;
  const files: GeneratedFiles = {};
  const genDir = join(options.outDir, packageDir);

  // 1. Models per schema group.
  for (const [groupName, schemas] of Object.entries(prepared.schemaGroups)) {
    const filePath = join(genDir, `types_${goFileStem(groupName)}.go`);
    files[filePath] = emitGoModelsFile(packageName, schemas, registry);
  }

  // 2. Versioned resource files + namespace struct.
  for (const versionSet of prepared.versions) {
    const prefix = goFileStem(versionSet.version);
    const seen = new Set<string>();
    for (const resource of versionSet.resources) {
      if (seen.has(resource.name)) continue;
      seen.add(resource.name);
      const filePath = join(genDir, `${prefix}_${goFileStem(resource.name)}.go`);
      files[filePath] = emitGoResourceFile(packageName, resource, registry);
    }
    files[join(genDir, `${prefix}.go`)] = emitGoNamespaceFile(
      packageName,
      versionSet,
      registry
    );
  }

  // 3. Channels.
  for (const channel of prepared.channels) {
    const filePath = join(genDir, `channels_${goFileStem(channel.className)}.go`);
    files[filePath] = emitGoChannelFile(packageName, channel, registry);
  }

  // 4. Auth.
  const authContent = emitGoAuthFile(packageName, prepared, registry);
  if (authContent) {
    files[join(genDir, "auth.go")] = authContent;
  }

  // 5. Client.
  files[join(genDir, "client.go")] = emitGoClientFile(packageName, prepared);

  return files;
}

export function writeGoFiles(files: GeneratedFiles, cleanDirs: string[]): void {
  cleanStaleFiles(files, cleanDirs, [".go"]);
  for (const [filePath, content] of Object.entries(files)) {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, addContentHash(content, "//"), "utf-8");
  }
}
