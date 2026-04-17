import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SdkSpec, VersionedResourceSet } from "../../ast/types.js";
import { emitPydanticFile } from "./pydantic-emitter.js";
import { emitPythonResourceFile } from "./resource-emitter.js";
import { emitPythonClientFile } from "./client-emitter.js";
import { emitPythonChannelFile } from "./channel-emitter.js";
import { emitPythonAuthFile } from "./auth-emitter.js";
import { emitPythonNamespaceFile, pyVersionClassName } from "./namespace-emitter.js";
import { generatedHeaderPython, addContentHash, cleanStaleFiles } from "../../utils/codegen.js";
import { snakeCase } from "../../utils/naming.js";

export interface PythonBackendOptions {
  outDir: string;
}

/**
 * Generate a complete async Python SDK from the SDK AST.
 *
 * Creates:
 * - archastro_platform/types/*.py              — Pydantic models (shared)
 * - archastro_platform/{version}/resources/*.py — Async resource classes per version
 * - archastro_platform/{version}.py            — Version namespace class
 * - archastro_platform/channels/*.py           — Async channel classes (shared)
 * - archastro_platform/client.py               — PlatformClient class
 * - archastro_platform/__init__.py             — Package exports
 */
export function generatePython(
  spec: SdkSpec,
  options: PythonBackendOptions
): GeneratedFiles {
  const files: GeneratedFiles = {};
  const pkgDir = join(options.outDir, "src", "archastro", "platform");

  // 1. Use pre-grouped schemas from frontend (cycle-free, topo-sorted)
  const schemaGroups = spec.schemaGroups;

  // 2. Generate type files (shared across versions)
  // Pre-build schema name → import module + file name mappings
  const schemaImportMap: Record<string, string> = {};
  const schemaFileMap: Record<string, string> = {};
  for (const [groupName, schemas] of Object.entries(schemaGroups)) {
    const fileName = snakeCase(groupName);
    for (const schema of schemas) {
      schemaImportMap[schema.name] = `...types.${fileName}`;
      schemaFileMap[schema.name] = fileName;
    }
  }

  // Emit type files with cross-file import information
  for (const [groupName, schemas] of Object.entries(schemaGroups)) {
    const fileName = snakeCase(groupName);
    const filePath = join(pkgDir, "types", `${fileName}.py`);
    files[filePath] = emitPydanticFile(schemas, schemaFileMap);
  }

  // Types __init__.py
  files[join(pkgDir, "types", "__init__.py")] = generateTypesInit(
    Object.keys(schemaGroups)
  );

  // 3. Generate versioned resource files + namespace classes
  for (const versionSet of spec.versions) {
    const verDir = join(pkgDir, versionSet.version);

    // Resource files under {version}/resources/
    for (const resource of versionSet.resources) {
      const filePath = join(verDir, "resources", `${resource.name}.py`);
      files[filePath] = emitPythonResourceFile(resource, versionSet.apiPrefix, {
        runtimeImportPath: "...runtime.http_client",
        schemaImports: schemaImportMap,
      });
    }

    // Resources __init__.py
    files[join(verDir, "resources", "__init__.py")] =
      generateVersionedResourcesInit(versionSet);

    // Version package __init__.py — contains the namespace class (V1/V2)
    // We put the class here instead of a separate {version}.py because Python
    // treats the v1/ directory as a package, shadowing any v1.py file.
    files[join(verDir, "__init__.py")] =
      emitPythonNamespaceFile(versionSet, {
        resourceImportPrefix: ".resources",
        runtimeImportPrefix: "..runtime.http_client",
      });
  }

  // 4. Generate channel files
  for (const channel of spec.channels) {
    const fileName = snakeCase(channel.name);
    const filePath = join(pkgDir, "channels", `${fileName}.py`);
    files[filePath] = emitPythonChannelFile(channel);
  }

  if (spec.channels.length > 0) {
    files[join(pkgDir, "channels", "__init__.py")] = generateChannelsInit(spec);
  }

  // 5. Generate auth file (next to client.py)
  const authContent = emitPythonAuthFile(spec);
  if (authContent) {
    files[join(pkgDir, "auth.py")] = authContent;
  }

  // 6. Generate client
  files[join(pkgDir, "client.py")] = emitPythonClientFile(spec);

  // 7. Generate package __init__.py
  files[join(pkgDir, "__init__.py")] = generatePackageInit(spec);

  // Empty __init__ at the top `archastro/` level so the generated tree is a
  // regular package. Without it, Python falls back to namespace packages and
  // any parallel `archastro/` on `sys.path` (e.g. an installed SDK) merges
  // in, silently resolving imports to the other tree.
  const rootInitPath = join(options.outDir, "src", "archastro", "__init__.py");
  if (!(rootInitPath in files)) {
    files[rootInitPath] = "";
  }

  return files;
}

export function writePythonFiles(
  files: GeneratedFiles,
  cleanDirs: string[]
): void {
  cleanStaleFiles(files, cleanDirs, [".py"]);
  for (const [filePath, content] of Object.entries(files)) {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, addContentHash(content, "#"), "utf-8");
  }
}

export type GeneratedFiles = Record<string, string>;

// ─── Internal ────────────────────────────────────────────────────

function generateTypesInit(groupNames: string[]): string {
  const lines = [generatedHeaderPython().trim(), ""];
  for (const name of groupNames.sort()) {
    lines.push(`from .${snakeCase(name)} import *  # noqa: F401,F403`);
  }
  return lines.join("\n") + "\n";
}

function generateVersionedResourcesInit(
  versionSet: VersionedResourceSet
): string {
  const lines = [generatedHeaderPython().trim(), ""];
  for (const resource of versionSet.resources) {
    lines.push(
      `from .${resource.name} import ${resource.className}  # noqa: F401`
    );
  }
  return lines.join("\n") + "\n";
}

function generateChannelsInit(spec: SdkSpec): string {
  const lines = [generatedHeaderPython().trim(), ""];
  for (const channel of spec.channels) {
    const fileName = snakeCase(channel.name);
    lines.push(
      `from .${fileName} import ${channel.className}  # noqa: F401`
    );
  }
  return lines.join("\n") + "\n";
}

function generatePackageInit(spec: SdkSpec): string {
  const lines = [generatedHeaderPython().trim(), ""];
  lines.push("from importlib.metadata import version as _pkg_version");
  lines.push("");
  lines.push("from .client import PlatformClient  # noqa: F401");
  for (const versionSet of spec.versions) {
    const cls = pyVersionClassName(versionSet.version);
    lines.push(
      `from .${versionSet.version} import ${cls}  # noqa: F401`
    );
  }
  if ((spec.authOperations ?? []).length > 0) {
    lines.push("from .auth import AuthClient, AuthTokens  # noqa: F401");
  }
  lines.push("");
  // Use the configured package name so the importlib.metadata lookup
  // matches whatever distro the SDK is published under.
  lines.push(`__version__ = _pkg_version(${JSON.stringify(spec.name)})`);
  return lines.join("\n") + "\n";
}
