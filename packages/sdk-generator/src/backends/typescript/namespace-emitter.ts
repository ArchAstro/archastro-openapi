import type { VersionedResourceSet } from "../../ast/types.js";
import { CodeBuilder, ImportTracker, generatedHeader } from "../../utils/codegen.js";

/**
 * Generate a TypeScript version namespace file (e.g., V1, V2).
 *
 * The namespace class holds all top-level resources for a given API version:
 *
 * ```ts
 * export class V1 {
 *   readonly agents: AgentResource;
 *   readonly teams: TeamResource;
 *   constructor(http: HttpClient) {
 *     this.agents = new AgentResource(http);
 *     this.teams = new TeamResource(http);
 *   }
 * }
 * ```
 */
export function emitNamespaceFile(
  versionSet: VersionedResourceSet,
  options?: { resourceImportPrefix?: string }
): string {
  const cb = new CodeBuilder();
  const imports = new ImportTracker();
  const resPrefix = options?.resourceImportPrefix ?? `./${versionSet.version}/resources`;

  imports.add("./runtime/http-client.js", "HttpClient");

  const seen = new Set<string>();
  const uniqueResources = versionSet.resources.filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });

  for (const resource of uniqueResources) {
    imports.add(`${resPrefix}/${resource.name}.js`, resource.className);
  }

  const className = versionSet.version.toUpperCase(); // "v1" → "V1"

  cb.line(generatedHeader());
  cb.line(imports.emit());

  cb.block(`export class ${className}`, () => {
    for (const resource of uniqueResources) {
      cb.line(`readonly ${resource.name}: ${resource.className};`);
    }

    cb.line();

    cb.block("constructor(http: HttpClient)", () => {
      for (const resource of uniqueResources) {
        cb.line(`this.${resource.name} = new ${resource.className}(http);`);
      }
    });
  });

  return cb.toString();
}

/** Get the class name for a version namespace (e.g., "v1" → "V1"). */
export function versionClassName(version: string): string {
  return version.toUpperCase();
}
