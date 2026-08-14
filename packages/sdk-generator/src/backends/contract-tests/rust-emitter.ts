import { join } from "node:path";
import type { BodyDef, ChannelDef, ChannelJoinDef, FieldDef, OperationDef, ParamDef, ResourceDef, SchemaDef, SdkSpec, TypeRef } from "../../ast/types.js";
import { generatedHeader } from "../../utils/codegen.js";
import { rustIdent, rustString, rustTypeName } from "../rust/identifiers.js";

export const RUST_TESTS_DIR = "tests";
type GeneratedFiles = Record<string, string>;

interface TestCase {
  operation: OperationDef;
  chain: string;
  scopes: ParamDef[];
}

export function emitRustContractTests(spec: SdkSpec, outDir: string): GeneratedFiles {
  const cases: TestCase[] = [];
  for (const version of spec.versions) {
    const prefix = `client.${rustIdent(version.sdkName ?? version.version)}()`;
    const surface = versionSurface(version.resources, version.version, version.apiPrefix);
    for (const operation of surface.operations) cases.push({ operation, chain: prefix, scopes: [] });
    for (const resource of surface.resources) collect(resource, prefix, [], [], cases);
  }
  for (const operation of spec.authOperations) cases.push({ operation, chain: "client.auth()", scopes: [] });

  const rest = cases.filter((item) => !item.operation.streaming);
  const streams = cases.filter((item) => item.operation.streaming);
  return {
    [join(outDir, RUST_TESTS_DIR, "generated_rest_contract.rs")]: renderRest(rest, spec.schemas),
    [join(outDir, RUST_TESTS_DIR, "generated_stream_contract.rs")]: renderStreams(streams, spec.schemas),
    [join(outDir, RUST_TESTS_DIR, "generated_channel_contract.rs")]: renderChannels(spec.channels, spec.schemas),
  };
}

function collect(
  resource: ResourceDef,
  parentChain: string,
  ancestry: string[],
  parentScopes: ParamDef[],
  output: TestCase[]
): void {
  const introduced = resource.scopeParams.filter((param) => !parentScopes.some((parent) => parent.name === param.name));
  const args = introduced.map((param) => paramValue(param.type, param.name)).join(", ");
  const chain = `${parentChain}.${rustIdent(resource.name)}(${args})`;
  for (const operation of resource.operations) output.push({ operation, chain, scopes: resource.scopeParams });
  for (const child of resource.children) collect(child, chain, [...ancestry, resource.name], resource.scopeParams, output);
}

function renderRest(cases: TestCase[], schemas: SchemaDef[]): string {
  const lines = [generatedHeader(), "//! Generated REST contract tests.", "mod support;", "use archastro::generated::*;", "", "#[test]", "fn generated_support_is_linked() { support::mark_all_used(); }", ""];
  for (const item of cases) {
    const name = rustIdent(item.operation.operationId);
    lines.push("#[tokio::test]", "#[ignore = \"requires Prism contract server\"]", `async fn ${name}_success() {`, "    let client = support::rest_client(None).await;", ...indentLines(callSetup(item, schemas), 4));
    lines.push(`    let result = ${operationCall(item)}.await;`, `    assert!(result.is_ok(), "{}: {:?}", ${rustString(`${item.operation.method} ${item.operation.path}`)}, result.err());`, "}", "");
    for (const status of [...new Set(item.operation.errors.map((error) => error.status))]) {
      lines.push("#[tokio::test]", "#[ignore = \"requires Prism contract server\"]", `async fn ${name}_error_${status}() {`, `    let client = support::rest_client(Some(${status})).await;`, ...indentLines(callSetup(item, schemas), 4));
      lines.push(`    let error = ${operationCall(item)}.await.expect_err("expected API error");`, `    support::assert_api_error(error, ${status});`, "}", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderStreams(cases: TestCase[], schemas: SchemaDef[]): string {
  const lines = [generatedHeader(), "//! Generated SSE contract tests.", "mod support;", "use archastro::generated::*;", "use futures_util::StreamExt;", "", "#[test]", "fn generated_support_is_linked() { support::mark_all_used(); }", ""];
  for (const item of cases) {
    const name = rustIdent(item.operation.operationId);
    const events = item.operation.streaming!.events.map((event) => rustString(event.event)).join(", ");
    lines.push("#[tokio::test]", "#[serial_test::serial]", "#[ignore = \"requires channel harness\"]", `async fn ${name}_events() {`, `    let harness = support::harness().await;`, `    harness.register_stream(${rustString(`${item.operation.method} ${item.operation.path}`)}, &[${events}]).await;`, "    let client = harness.client();", ...indentLines(callSetup(item, schemas), 4));
    lines.push(`    let mut stream = ${operationCall(item)}.await.expect("open stream");`, "    let mut count = 0usize;", `    while let Some(event) = stream.next().await { event.expect("decode event"); count += 1; if count == ${item.operation.streaming!.events.length} { break; } }`, `    assert_eq!(count, ${item.operation.streaming!.events.length});`, "}", "");
  }
  return `${lines.join("\n")}\n`;
}

function renderChannels(channels: ChannelDef[], schemas: SchemaDef[]): string {
  const lines = [generatedHeader(), "//! Generated Phoenix channel contract tests.", "mod support;", "use archastro::generated::*;", "use futures_util::StreamExt;", "", "#[test]", "fn generated_support_is_linked() { support::mark_all_used(); }", ""];
  for (const channel of channels) {
    const facade = rustTypeName(channel.sdkName ?? channel.className);
    channel.joins.forEach((joinDef, joinIndex) => {
      const testName = rustIdent(`${channel.name}_${joinDef.name ?? `join_${joinIndex + 1}`}`);
      const setup = channelJoinSetup(channel, joinDef, joinIndex, schemas);
      lines.push("#[tokio::test]", "#[serial_test::serial]", "#[ignore = \"requires channel harness\"]", `async fn ${testName}_join() {`, "    let harness = support::harness().await;", ...indentLines(setup.lines, 4), `    harness.register_channel(${setup.topicVar}, &[], &[]).await;`, "    let socket = harness.socket().await;", `    let channel = ${facade}::${setup.method}(&socket${setup.args.length ? `, ${setup.args.join(", ")}` : ""}).await.expect("join channel");`, "    channel.leave().await.expect(\"leave channel\");", "}", "");
    });

    const first = channel.joins[0];
    if (first && (channel.messages.length > 0 || channel.pushes.length > 0)) {
      const setup = channelJoinSetup(channel, first, 0, schemas);
      const testName = rustIdent(`${channel.name}_messages_and_pushes`);
      const messages = channel.messages.map((message) => rustString(message.event)).join(", ");
      const pushes = channel.pushes.map((push) => rustString(push.event)).join(", ");
      lines.push("#[tokio::test]", "#[serial_test::serial]", "#[ignore = \"requires channel harness\"]", `async fn ${testName}() {`, "    let harness = support::harness().await;", ...indentLines(setup.lines, 4), `    harness.register_channel(${setup.topicVar}, &[${messages}], &[${pushes}]).await;`, "    let socket = harness.socket().await;", `    let channel = ${facade}::${setup.method}(&socket${setup.args.length ? `, ${setup.args.join(", ")}` : ""}).await.expect("join channel");`);
      channel.messages.forEach((message, index) => {
        if (message.params.length > 0) {
          const type = `${facade}${rustTypeName(message.sdkTypeName ?? message.event)}Input`;
          const value = fieldsJson(message.params, schemas, new Set());
          lines.push(`    let message_${index}: ${type} = serde_json::from_str(${rawString(JSON.stringify(value))}).expect("valid message input");`);
        }
        lines.push(`    channel.${rustIdent(message.event)}(${message.params.length > 0 ? `&message_${index}` : ""}).await.expect("channel push");`);
      });
      channel.pushes.forEach((push, index) => {
        lines.push(`    let mut push_${index} = channel.subscribe_${rustIdent(push.event)}();`, `    push_${index}.next().await.expect("server push").expect("decode server push");`);
      });
      lines.push("    channel.leave().await.expect(\"leave channel\");", "}", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function channelJoinSetup(channel: ChannelDef, joinDef: ChannelJoinDef, joinIndex: number, schemas: SchemaDef[]): { lines: string[]; args: string[]; method: string; topicVar: string } {
  const facade = rustTypeName(channel.sdkName ?? channel.className);
  const placeholders = [...joinDef.topicPattern.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  const args = placeholders.map((placeholder) => rustString(stringValue(placeholder)));
  let topic = joinDef.topicPattern;
  placeholders.forEach((placeholder) => { topic = topic.replace(`{${placeholder}}`, stringValue(placeholder)); });
  const lines = [`let topic = ${rustString(topic)};`];
  const payload = joinDef.params.filter((param) => !placeholders.includes(param.wireName ?? param.name));
  if (payload.length > 0) {
    const type = `${facade}${rustTypeName(joinDef.sdkTypeName ?? joinDef.name ?? `Join${joinIndex + 1}`)}Params`;
    lines.push(`let join_params: ${type} = serde_json::from_str(${rawString(JSON.stringify(fieldsJson(payload, schemas, new Set())))}).expect("valid join params");`);
    args.push("&join_params");
  }
  return {
    lines,
    args,
    method: rustIdent(joinDef.name ?? (channel.joins.length > 1 ? `join_${joinIndex + 1}` : "join")),
    topicVar: "topic",
  };
}

function callSetup(item: TestCase, schemas: SchemaDef[]): string[] {
  const op = item.operation;
  const lines: string[] = [];
  if (op.body) {
    const type = op.body.fields ? `${rustTypeName(op.operationId)}Input` : rustTypeName(op.body.schema);
    const value = bodyJson(op.body, schemas);
    lines.push(`let body: ${type} = serde_json::from_str(${rawString(JSON.stringify(value))}).expect("valid generated body");`);
  }
  if (op.queryParams.length > 0) {
    const type = `${rustTypeName(op.operationId)}Params`;
    const value = fieldsJson(op.queryParams, schemas, new Set());
    lines.push(`let params: ${type} = serde_json::from_str(${rawString(JSON.stringify(value))}).expect("valid generated params");`);
  }
  return lines;
}

function operationCall(item: TestCase): string {
  const op = item.operation;
  const args = op.pathParams.filter((param) => !item.scopes.some((scope) => scope.name === param.name)).map((param) => paramValue(param.type, param.name));
  if (op.body) args.push("&body");
  if (op.queryParams.length > 0) args.push(op.queryParams.some((param) => param.required) ? "&params" : "Some(&params)");
  return `${item.chain}.${rustIdent(op.sdkName ?? op.name)}(${args.join(", ")})`;
}

function bodyJson(body: BodyDef, schemas: SchemaDef[]): unknown {
  if (body.fields) return fieldsJson(body.fields, schemas, new Set());
  const schema = schemas.find((candidate) => candidate.name === body.schema);
  return schema ? schemaJson(schema, schemas, new Set()) : {};
}

function schemaJson(schema: SchemaDef, schemas: SchemaDef[], seen: Set<string>): unknown {
  if (seen.has(schema.name)) return {};
  const next = new Set(seen).add(schema.name);
  if (schema.unionType) return typeJson(schema.unionType.variants[0]!, schema.name, schemas, next);
  return fieldsJson(schema.fields, schemas, next);
}

function fieldsJson(fields: readonly FieldDef[], schemas: SchemaDef[], seen: Set<string>): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => field.required).map((field) => [field.wireName ?? field.name, field.example ?? typeJson(field.type, field.name, schemas, seen)]));
}

function typeJson(type: TypeRef, fieldName: string, schemas: SchemaDef[], seen: Set<string>): unknown {
  switch (type.kind) {
    case "primitive":
      if (type.type === "integer") return 1;
      if (type.type === "float") return 1.0;
      if (type.type === "boolean") return true;
      if (type.type === "datetime") return "2024-01-01T00:00:00Z";
      return stringValue(fieldName);
    case "array": return [typeJson(type.items, "item", schemas, seen)];
    case "object": return fieldsJson(type.fields, schemas, seen);
    case "ref": {
      const schema = schemas.find((candidate) => candidate.name === type.schema);
      return schema ? schemaJson(schema, schemas, seen) : {};
    }
    case "enum": return type.values[0] ?? "unknown";
    case "union": return type.variants.length ? typeJson(type.variants[0]!, fieldName, schemas, seen) : null;
    case "optional": case "nullable": return typeJson(type.inner, fieldName, schemas, seen);
    case "map": case "unknown": return {};
    case "void": return null;
  }
}

function paramValue(type: TypeRef, name: string): string {
  if (type.kind === "primitive") {
    if (type.type === "string") return rustString(stringValue(name));
    if (type.type === "integer") return "1";
    if (type.type === "float") return "1.0";
    if (type.type === "boolean") return "true";
    if (type.type === "datetime") return "chrono::DateTime::parse_from_rfc3339(\"2024-01-01T00:00:00Z\").unwrap().with_timezone(&chrono::Utc)";
  }
  if (type.kind === "enum") return `${rustString(type.values[0] ?? "unknown")}.to_owned()`;
  return "Default::default()";
}

function stringValue(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("email")) return "test@example.com";
  if (lower.includes("password")) return "Password1234!";
  if (lower.includes("url") || lower.includes("uri")) return "https://example.com";
  if (lower.includes("key")) return "test-key";
  if (lower.includes("id") || lower === "agent" || lower === "team" || lower === "user") return "test-id";
  if (lower === "role") return "user";
  if (lower === "status") return "active";
  if (lower === "timezone") return "UTC";
  return "test-value";
}

function rawString(value: string): string { return `r#"${value}"#`; }

function versionSurface(resourcesInput: ResourceDef[], version: string, apiPrefix: string): { resources: ResourceDef[]; operations: OperationDef[] } {
  const resources: ResourceDef[] = [];
  const operations: OperationDef[] = [];
  for (const root of resourcesInput) {
    if (root.name === "api") {
      const versionRoot = root.children.find((child) => child.name === version || child.path === apiPrefix);
      if (versionRoot) {
        resources.push(...versionRoot.children);
        operations.push(...versionRoot.operations);
        continue;
      }
    }
    resources.push(root);
  }
  return { resources, operations };
}

function indentLines(lines: string[], spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => `${prefix}${line}`);
}
