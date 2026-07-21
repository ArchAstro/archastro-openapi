import type { VersionedResourceSet } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { uniqueSwiftMemberNames } from "./identifiers.js";

/** Swift class name for a version namespace ("v1" → "V1"). */
export function swiftVersionClassName(version: string): string {
  return version.toUpperCase();
}

/**
 * Generate a Swift version namespace file.
 *
 * ```swift
 * public final class V1: Sendable {
 *     public let agents: AgentResource
 *     public init(http: HttpClient) { ... }
 * }
 * ```
 */
export function emitSwiftNamespaceFile(versionSet: VersionedResourceSet): string {
  const cb = new CodeBuilder("    ");
  for (const line of generatedHeader().trim().split("\n")) cb.line(line);
  cb.line();
  cb.line("import Foundation");
  cb.line();

  const seen = new Set<string>();
  const uniqueResources = versionSet.resources.filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });

  const accessorNames = uniqueSwiftMemberNames(uniqueResources.map((r) => r.name));
  const className = swiftVersionClassName(versionSet.version);

  cb.block(`public final class ${className}: Sendable`, () => {
    for (let i = 0; i < uniqueResources.length; i++) {
      cb.line(`public let ${accessorNames[i]}: ${uniqueResources[i]!.className}`);
    }
    cb.line();
    cb.block("public init(http: HttpClient)", () => {
      for (let i = 0; i < uniqueResources.length; i++) {
        cb.line(
          `self.${accessorNames[i]} = ${uniqueResources[i]!.className}(http: http)`
        );
      }
      if (uniqueResources.length === 0) {
        cb.line("_ = http");
      }
    });
  });

  return cb.toString();
}
