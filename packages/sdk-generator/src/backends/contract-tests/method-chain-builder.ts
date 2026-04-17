import type {
  SdkSpec,
  VersionedResourceSet,
  ResourceDef,
  OperationDef,
  HttpMethod,
} from "../../ast/types.js";
import { generateDummyValue, generateBodyLiteral } from "./value-generator.js";

export interface MethodArg {
  name: string;
  value: string;
  kind: "scope" | "path" | "body" | "query";
}

export interface MethodCallInfo {
  /** SDK accessor chain, e.g., "client.v1.agents" */
  accessorChain: string;
  /** SDK method name, e.g., "list" */
  methodName: string;
  /** Ordered arguments */
  args: MethodArg[];
  /** The underlying operation */
  operation: OperationDef;
  /** Resource this operation belongs to */
  resource: ResourceDef;
  /** Full HTTP path, e.g., "/api/v1/agents/{agent}" */
  httpPath: string;
  /** HTTP method */
  httpMethod: HttpMethod;
  /** Documented error status codes */
  errorCodes: number[];
  /** Nested resource label for grouping, e.g., "agents > schedules" */
  groupLabel: string;
}

/**
 * Determine whether an operation should be included in contract tests.
 */
function isTestableOperation(op: OperationDef): boolean {
  if (op.streaming) return false;
  return true;
}

/**
 * Walk the resource tree and yield MethodCallInfo for every testable operation.
 */
export function buildMethodCalls(
  spec: SdkSpec,
  versionSet: VersionedResourceSet,
  lang: "typescript" | "python"
): MethodCallInfo[] {
  const results: MethodCallInfo[] = [];
  const clientPrefix = `client.${versionSet.version}`;

  function walk(
    resources: ResourceDef[],
    parentChain: string,
    parentLabel: string
  ): void {
    for (const resource of resources) {
      const chain = `${parentChain}.${resource.name}`;
      const label = parentLabel
        ? `${parentLabel} > ${resource.name}`
        : resource.name;

      for (const op of resource.operations) {
        if (!isTestableOperation(op)) continue;

        const args: MethodArg[] = [];

        // 1. Scope params (parent path params baked into the resource)
        for (const sp of resource.scopeParams) {
          args.push({
            name: sp.name,
            value: generateDummyValue(sp.type, sp.name, lang),
            kind: "scope",
          });
        }

        // 2. Path params from the operation itself
        for (const pp of op.pathParams) {
          args.push({
            name: pp.name,
            value: generateDummyValue(pp.type, pp.name, lang),
            kind: "path",
          });
        }

        // 3. Request body (required fields only)
        if (op.body) {
          args.push({
            name: "input",
            value: generateBodyLiteral(op.body, spec.schemas, lang),
            kind: "body",
          });
        }

        // 4. Required query params (passed as params object)
        const requiredQuery = op.queryParams.filter((p) => p.required);
        if (requiredQuery.length > 0) {
          const entries = requiredQuery.map(
            (p) =>
              lang === "python"
                ? `"${p.name}": ${generateDummyValue(p.type, p.name, lang)}`
                : `${p.name}: ${generateDummyValue(p.type, p.name, lang)}`
          );
          const value =
            lang === "python"
              ? `{${entries.join(", ")}}`
              : `{ ${entries.join(", ")} }`;
          args.push({ name: "params", value, kind: "query" });
        }

        results.push({
          accessorChain: chain,
          methodName: op.name,
          args,
          operation: op,
          resource,
          httpPath: op.path,
          httpMethod: op.method,
          errorCodes: op.errors.map((e) => e.status),
          groupLabel: label,
        });
      }

      walk(resource.children, chain, label);
    }
  }

  walk(versionSet.resources, clientPrefix, "");
  return results;
}

/**
 * Group MethodCallInfo by top-level resource name for per-file generation.
 */
export function groupByTopLevelResource(
  calls: MethodCallInfo[]
): Map<string, MethodCallInfo[]> {
  const groups = new Map<string, MethodCallInfo[]>();

  for (const call of calls) {
    const topLevel = call.groupLabel.split(" > ")[0]!;
    const existing = groups.get(topLevel) ?? [];
    existing.push(call);
    groups.set(topLevel, existing);
  }

  return groups;
}
