import type { FieldDef, OperationDef, ResourceDef, SdkSpec } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { camelCase, pascalCase, snakeCase } from "../../utils/naming.js";
import { generateDummyValue } from "./value-generator.js";

/**
 * Emit a vitest contract test for the SDK's SSE streaming methods.
 *
 * Streaming ops can't go through the normal call-and-assert-response contract
 * test (the method is an async generator over `text/event-stream`, which Prism
 * can't mock), so they get this dedicated test instead. It drives the generated
 * `stream()` method through the SDK runtime's real `streamSSE` against a
 * channel-harness service: register an SSE scenario over the HTTP control API,
 * iterate the method, and assert the SDK yields the declared events in order
 * and actually put the request body on the wire.
 *
 * Expects the same env vars the channel contract tests use, set by globalSetup:
 *   ARCHASTRO_HARNESS_WS_URL       — ws://host:port/socket/websocket
 *   ARCHASTRO_HARNESS_CONTROL_URL  — http://host:port (also the SSE base URL)
 */

interface StreamSite {
  /** Top-level resource class, e.g. `ApiResource`. */
  topClass: string;
  /** Top-level resource name (for import path), e.g. `api`. */
  topName: string;
  /** Property chain from the top resource to the op's resource, e.g. `["v1","echo"]`. */
  accessor: string[];
  op: OperationDef;
}

function collectStreamSites(resources: ResourceDef[]): StreamSite[] {
  const out: StreamSite[] = [];
  for (const top of resources) {
    const topClass = `${pascalCase(top.name)}Resource`;
    const walk = (r: ResourceDef, accessor: string[]): void => {
      for (const op of r.operations) {
        if (op.streaming) out.push({ topClass, topName: top.name, accessor, op });
      }
      for (const child of r.children) {
        walk(child, [...accessor, camelCase(child.name)]);
      }
    };
    walk(top, []);
  }
  return out;
}

/** True when the spec declares any SSE streaming operation. */
export function specHasStreamingOps(spec: SdkSpec): boolean {
  return collectStreamSites(spec.resources).length > 0;
}

/**
 * @param spec               Parsed SDK spec.
 * @param resourceImportBase Import dir for generated resource files; each top
 *                           resource is imported from `${base}/${snake(name)}.js`.
 * @param runtimeImportPath  Import path to the runtime's HttpClient.
 */
export function emitStreamContractTestFile(
  spec: SdkSpec,
  resourceImportBase: string,
  runtimeImportPath: string
): string {
  const sites = collectStreamSites(spec.resources);
  const cb = new CodeBuilder();

  emitHeader(cb, sites, resourceImportBase, runtimeImportPath);
  for (const site of sites) emitStreamDescribe(cb, site);

  return cb.toString();
}

function emitHeader(
  cb: CodeBuilder,
  sites: StreamSite[],
  resourceImportBase: string,
  runtimeImportPath: string
): void {
  cb.line(generatedHeader());
  cb.line("// Contract tests for the SDK's SSE streaming methods. Drives each");
  cb.line("// generated stream() through the runtime's real streamSSE against the");
  cb.line("// channel-harness service — the same service the channel tests use.");
  cb.line();
  cb.line('import { describe, it, expect, beforeEach, afterEach } from "vitest";');
  cb.line('import { HarnessServiceClient } from "@archastro/channel-harness";');
  cb.line(`import { HttpClient } from "${runtimeImportPath}";`);

  // Import each distinct top-level resource class from its generated file.
  const seen = new Set<string>();
  for (const s of sites) {
    if (seen.has(s.topClass)) continue;
    seen.add(s.topClass);
    cb.line(
      `import { ${s.topClass} } from "${resourceImportBase}/${snakeCase(s.topName)}.js";`
    );
  }
  cb.line();

  cb.line("interface Rig {");
  cb.line("  client: HarnessServiceClient;");
  cb.line("  http: HttpClient;");
  cb.line("}");
  cb.line();
  cb.line("async function bootHarness(): Promise<Rig> {");
  cb.line("  const wsUrl = process.env.ARCHASTRO_HARNESS_WS_URL;");
  cb.line("  const controlUrl = process.env.ARCHASTRO_HARNESS_CONTROL_URL;");
  cb.line("  if (!wsUrl || !controlUrl) {");
  cb.line("    throw new Error(");
  cb.line('      "SSE contract tests require ARCHASTRO_HARNESS_WS_URL and " +');
  cb.line('        "ARCHASTRO_HARNESS_CONTROL_URL — set by global-setup.ts."');
  cb.line("    );");
  cb.line("  }");
  cb.line("  const client = new HarnessServiceClient({ wsUrl, controlUrl });");
  cb.line("  await client.reset();");
  cb.line("  // The harness serves SSE routes on the control listener, so the SDK");
  cb.line("  // base URL is the control URL.");
  cb.line("  const http = new HttpClient({ baseUrl: controlUrl });");
  cb.line("  return { client, http };");
  cb.line("}");
  cb.line();
}

function emitStreamDescribe(cb: CodeBuilder, site: StreamSite): void {
  const { op } = site;
  const routeKey = `${op.method} ${op.path}`;
  const events = op.streaming?.events ?? [];
  const inputLiteral = buildObjectLiteral(op.body?.fields ?? []);
  const accessor = site.accessor.map((a) => `.${a}`).join("");
  const callExpr = (http: string): string =>
    `new ${site.topClass}(${http})${accessor}.${op.name}(${inputLiteral})`;

  const emitActions = events
    .map(
      (e) =>
        `{ type: "emit", event: ${JSON.stringify(e.event)}, data: ${generateDummyValue(
          e.dataType,
          e.event,
          "typescript"
        )} }`
    )
    .join(", ");
  const expectedNames = JSON.stringify(events.map((e) => e.event));

  cb.line(`describe(${JSON.stringify(`${site.topClass}${accessor}.${op.name} (${routeKey})`)}, () => {`);
  cb.indent();
  cb.line("let rig: Rig;");
  cb.line("beforeEach(async () => {");
  cb.line("  rig = await bootHarness();");
  cb.line("});");
  cb.line("afterEach(() => {");
  cb.line("  rig.client.closeAllSockets();");
  cb.line("});");
  cb.line();

  // Happy path: the SDK yields the declared events, in order, and sent the body.
  cb.line('it("yields the declared SSE events in order and sends the request body", async () => {');
  cb.indent();
  cb.line("await rig.client.registerStreamScenario({");
  cb.line(`  route: ${JSON.stringify(routeKey)},`);
  cb.line(`  actions: [${emitActions}],`);
  cb.line("});");
  cb.line();
  cb.line("const events: Array<{ event: string; data: unknown }> = [];");
  cb.line(`for await (const ev of ${callExpr("rig.http")}) {`);
  cb.line("  events.push(ev);");
  cb.line("}");
  cb.line(`expect(events.map((e) => e.event)).toEqual(${expectedNames});`);
  cb.line();
  cb.line(`const obs = await rig.client.observations(${JSON.stringify(routeKey)}, "request");`);
  cb.line("expect(obs).toHaveLength(1);");
  cb.line(`expect(obs[0]!.params).toEqual(${inputLiteral});`);
  cb.dedent();
  cb.line("});");
  cb.line();

  // Error path: a non-2xx status from the route surfaces as a thrown error.
  cb.line('it("rejects when the route returns a non-2xx status", async () => {');
  cb.indent();
  cb.line("await rig.client.registerStreamScenario({");
  cb.line(`  route: ${JSON.stringify(routeKey)},`);
  cb.line('  actions: [{ type: "status", code: 402, body: { error: { code: "plan_not_entitled" } } }],');
  cb.line("});");
  cb.line("const drain = async (): Promise<void> => {");
  cb.line(`  for await (const _ of ${callExpr("rig.http")}) {`);
  cb.line("    // drain");
  cb.line("  }");
  cb.line("};");
  cb.line("await expect(drain()).rejects.toBeTruthy();");
  cb.dedent();
  cb.line("});");

  cb.dedent();
  cb.line("});");
  cb.line();
}

function buildObjectLiteral(fields: FieldDef[]): string {
  if (fields.length === 0) return "{}";
  const parts = fields.map(
    (f) => `${f.name}: ${generateDummyValue(f.type, f.name, "typescript")}`
  );
  return `{ ${parts.join(", ")} }`;
}
