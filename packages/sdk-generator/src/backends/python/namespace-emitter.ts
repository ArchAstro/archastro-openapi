import type { VersionedResourceSet } from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython } from "../../utils/codegen.js";

/**
 * Generate a Python version namespace file (e.g., V1, V2).
 *
 * ```python
 * class V1:
 *     def __init__(self, http: HttpClient):
 *         self.agents = AgentResource(http)
 *         self.teams = TeamResource(http)
 * ```
 */
export function emitPythonNamespaceFile(
  versionSet: VersionedResourceSet,
  options?: { resourceImportPrefix?: string; runtimeImportPrefix?: string }
): string {
  const cb = new CodeBuilder("    ");
  const resPrefix = options?.resourceImportPrefix ?? `.${versionSet.version}.resources`;
  const runtimeImport = options?.runtimeImportPrefix ?? ".runtime.http_client";

  for (const line of generatedHeaderPython().trim().split("\n")) {
    cb.line(line);
  }
  cb.line();

  cb.line(`from ${runtimeImport} import HttpClient`);

  const seen = new Set<string>();
  const uniqueResources = versionSet.resources.filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });

  for (const resource of uniqueResources) {
    cb.line(
      `from ${resPrefix}.${resource.name} import ${resource.className}`
    );
  }
  cb.line();

  const className = pyVersionClassName(versionSet.version);

  cb.pyBlock(`class ${className}`, () => {
    cb.pyBlock("def __init__(self, http: HttpClient)", () => {
      if (uniqueResources.length === 0) {
        // Empty namespace (e.g. a channels-only spec). Python rejects a
        // function body of zero statements, so emit `pass` to keep the
        // generated file importable.
        cb.line("pass");
      } else {
        for (const resource of uniqueResources) {
          cb.line(`self.${resource.name} = ${resource.className}(http)`);
        }
      }
    });
  });

  return cb.toString();
}

/** Get the Python class name for a version namespace (e.g., "v1" → "V1"). */
export function pyVersionClassName(version: string): string {
  return version.toUpperCase();
}
