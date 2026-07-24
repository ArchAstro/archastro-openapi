import type { VersionedResourceSet } from "../../ast/types.js";
import { CodeBuilder } from "../../utils/codegen.js";
import { GoNameRegistry, uniqueGoFieldNames } from "./identifiers.js";
import { emitPlainDocComment } from "./model-emitter.js";
import { goResourceConstructor } from "./resource-emitter.js";
import { renderGoFile } from "./type-map.js";

/** Go struct name for a version namespace ("v1" → "V1"). */
export function goVersionStructName(version: string): string {
  return version.toUpperCase();
}

/** Resources of a version set, de-duplicated by name in declaration order. */
export function uniqueVersionResources(versionSet: VersionedResourceSet) {
  const seen = new Set<string>();
  return versionSet.resources.filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
}

/**
 * Generate a Go version namespace file.
 *
 * ```go
 * type V1 struct {
 *     Agents *AgentResource
 * }
 *
 * func newV1(h *HTTPClient) *V1 { … }
 * ```
 */
export function emitGoNamespaceFile(
  packageName: string,
  versionSet: VersionedResourceSet,
  _registry: GoNameRegistry
): string {
  const cb = new CodeBuilder("\t");
  const resources = uniqueVersionResources(versionSet);
  const fieldNames = uniqueGoFieldNames(resources.map((r) => r.name));
  const structName = goVersionStructName(versionSet.version);

  emitPlainDocComment(
    cb,
    `${structName}: resources served under ${versionSet.apiPrefix}.`
  );
  cb.block(`type ${structName} struct`, () => {
    for (let i = 0; i < resources.length; i++) {
      cb.line(`${fieldNames[i]} *${resources[i]!.className}`);
    }
    if (resources.length === 0) cb.line("_ struct{}");
  });
  cb.line();

  cb.block(`func new${structName}(h *HTTPClient) *${structName}`, () => {
    if (resources.length === 0) {
      cb.line("_ = h");
      cb.line(`return &${structName}{}`);
      return;
    }
    cb.line(`return &${structName}{`);
    cb.indent();
    for (let i = 0; i < resources.length; i++) {
      cb.line(
        `${fieldNames[i]}: ${goResourceConstructor(resources[i]!.className)}(h),`
      );
    }
    cb.dedent();
    cb.line("}");
  });

  return renderGoFile(packageName, [], cb.toString());
}
