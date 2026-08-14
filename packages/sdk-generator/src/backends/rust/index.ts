import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ChannelDef,
  FieldDef,
  OperationDef,
  ParamDef,
  ResourceDef,
  SchemaDef,
  SdkSpec,
  TypeRef,
  VersionedResourceSet,
} from "../../ast/types.js";
import { addContentHash, cleanStaleFiles, generatedHeader } from "../../utils/codegen.js";
import { hoistInlineObjects } from "../python/inline-object-hoist.js";
import { rustIdent, rustString, rustTypeName, uniqueRustNames } from "./identifiers.js";

export const RUST_GENERATED_DIR = "src/generated";
export type GeneratedFiles = Record<string, string>;

export interface RustBackendOptions { outDir: string }

export function generateRust(spec: SdkSpec, options: RustBackendOptions): GeneratedFiles {
  const files: GeneratedFiles = {};
  const root = join(options.outDir, RUST_GENERATED_DIR);
  files[join(root, "types.rs")] = emitTypes(spec);
  files[join(root, "auth.rs")] = emitAuth(spec);
  files[join(root, "channels.rs")] = emitChannels(spec);
  for (const version of spec.versions) {
    files[join(root, `${rustIdent(version.sdkName ?? version.version)}.rs`)] = emitVersion(version);
  }
  files[join(root, "mod.rs")] = emitMod(spec);
  return files;
}

export function writeRustFiles(files: GeneratedFiles, cleanDirs: string[]): void {
  cleanStaleFiles(files, cleanDirs, [".rs"], true);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(path.substring(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, addContentHash(content, "//"), "utf8");
  }
}

function header(): string { return generatedHeader(); }

function emitMod(spec: SdkSpec): string {
  const lines = [header(), "/// Generated authentication operations.", "pub mod auth;", "/// Generated Phoenix channel facades.", "pub mod channels;", "/// Generated API models.", "pub mod types;"];
  for (const version of spec.versions) lines.push(`/// Generated ${version.version} API resources.`, `pub mod ${rustIdent(version.sdkName ?? version.version)};`);
  lines.push("", "pub use auth::*;", "pub use channels::*;", "pub use types::*;");
  for (const version of spec.versions) lines.push(`pub use ${rustIdent(version.sdkName ?? version.version)}::*;`);
  return `${lines.join("\n")}\n`;
}

function emitTypes(spec: SdkSpec): string {
  const lines = [
    header(),
    "#![allow(clippy::large_enum_variant)]",
    "use serde::{Deserialize, Serialize};",
    "use serde_json::Value;",
    "",
  ];
  for (const scalar of spec.types) {
    lines.push(doc(scalar.description), `pub type ${rustTypeName(scalar.name)} = ${primitiveType(scalar.baseType)};`, "");
  }
  for (const schema of spec.schemas) {
    lines.push(emitSchema(schema, spec.schemas), "");
  }
  return `${lines.filter((line) => line !== undefined).join("\n")}\n`;
}

function emitSchema(schema: SchemaDef, schemas: readonly SchemaDef[]): string {
  const name = rustTypeName(schema.name);
  if (schema.unionType) {
    const definitions: string[] = [];
    const variantNames = uniqueRustTypeNames(schema.unionType.variants.map((variant, index) =>
      variant.kind === "ref" ? variant.schema : `Variant${index + 1}`));
    const variants = schema.unionType.variants.map((variant, index) => {
      const variantName = variantNames[index]!;
      const type = namedRustType(variant, `${name}${variantName}`, definitions, schema.name, schemas);
      return `    /// ${variantName} union variant.\n    ${variantName}(${type}),`;
    });
    return [...definitions,
      doc(schema.description),
      "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]",
      "#[serde(untagged)]",
      `pub enum ${name} {`,
      ...variants,
      "}",
    ].join("\n");
  }
  return emitStruct(name, schema.fields, schema.description, false, schema.name, schemas);
}

function emitStruct(name: string, fields: readonly FieldDef[], description?: string, boxRefs = false, schemaName?: string, schemas: readonly SchemaDef[] = []): string {
  const names = uniqueRustNames(fields.map((field) => field.name));
  const definitions: string[] = [];
  const types = fields.map((field) => namedRustType(
    field.type,
    `${name}${rustTypeName(field.name)}`,
    definitions,
    schemaName,
    schemas,
    boxRefs,
  ));
  const lines = [
    doc(description),
    "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]",
    `pub struct ${name} {`,
  ];
  fields.forEach((field, index) => {
    const ident = names[index]!;
    const wire = field.wireName ?? field.name;
    const optional = !field.required || field.type.kind === "optional";
    if (ident !== wire) lines.push(`    #[serde(rename = ${rustString(wire)})]`);
    if (optional) lines.push("    #[serde(default, skip_serializing_if = \"Option::is_none\")]" );
    lines.push(indentDoc(field.description, 4));
    const type = optionalRustType(types[index]!, optional);
    lines.push(`    pub ${ident}: ${type},`);
  });
  lines.push("}");
  return [...definitions, lines.filter(Boolean).join("\n")].join("\n\n");
}

function namedRustType(
  ref: TypeRef,
  name: string,
  definitions: string[],
  schemaName?: string,
  schemas: readonly SchemaDef[] = [],
  boxRefs = false,
  inlineStorage = true,
): string {
  switch (ref.kind) {
    case "enum": {
      const variants = uniqueRustTypeNames(ref.values);
      definitions.push([
        `/// Contract-defined values for ${name}.`,
        "#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]",
        `pub enum ${name} {`,
        ...ref.values.flatMap((value, index) => [
          `    /// The ${value.replace(/[\r\n]/g, " ")} wire value.`,
          `    #[serde(rename = ${rustString(value)})]`,
          `    ${variants[index]},`,
        ]),
        "}",
      ].join("\n"));
      return name;
    }
    case "union": {
      const variants = uniqueRustTypeNames(ref.variants.map((variant, index) =>
        variant.kind === "ref" ? variant.schema : `Variant${index + 1}`));
      const types = ref.variants.map((variant, index) =>
        namedRustType(variant, `${name}${variants[index]}`, definitions, schemaName, schemas, boxRefs, inlineStorage));
      definitions.push([
        `/// Contract-defined alternatives for ${name}.`,
        "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]",
        "#[serde(untagged)]",
        `pub enum ${name} {`,
        ...types.flatMap((type, index) => [
          `    /// ${variants[index]} union variant.`,
          `    ${variants[index]}(${type}),`,
        ]),
        "}",
      ].join("\n"));
      return name;
    }
    case "optional": return `Option<${namedRustType(ref.inner, name, definitions, schemaName, schemas, boxRefs, inlineStorage)}>`;
    case "nullable": return `Option<${namedRustType(ref.inner, name, definitions, schemaName, schemas, boxRefs, inlineStorage)}>`;
    case "array": return `Vec<${namedRustType(ref.items, `${name}Item`, definitions, schemaName, schemas, boxRefs, false)}>`;
    case "map": return `std::collections::BTreeMap<String, ${namedRustType(ref.valueType, `${name}Value`, definitions, schemaName, schemas, boxRefs, false)}>`;
    case "ref": {
      const shouldBox = boxRefs || Boolean(schemaName && inlineStorage && reachesInline(ref.schema, schemaName, schemas, new Set()));
      return shouldBox ? `Box<${rustTypeName(ref.schema)}>` : rustTypeName(ref.schema);
    }
    default: return rustType(ref, boxRefs);
  }
}

function uniqueRustTypeNames(values: readonly string[]): string[] {
  const used = new Set<string>();
  return values.map((value) => {
    const base = rustTypeName(value);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}${suffix++}`;
    used.add(candidate);
    return candidate;
  });
}

function primitiveType(type: string): string {
  switch (type) {
    case "string": return "String";
    case "integer": return "i64";
    case "float": return "f64";
    case "boolean": return "bool";
    case "datetime": return "chrono::DateTime<chrono::Utc>";
    default: return "Value";
  }
}

export function rustType(ref: TypeRef, boxRefs = false): string {
  switch (ref.kind) {
    case "primitive": return primitiveType(ref.type);
    case "array": return `Vec<${rustType(ref.items, boxRefs)}>`;
    case "object": return "Value";
    case "ref": return boxRefs ? `Box<${rustTypeName(ref.schema)}>` : rustTypeName(ref.schema);
    case "enum": return "String";
    case "union": return "Value";
    case "optional": return `Option<${rustType(ref.inner, boxRefs)}>`;
    case "nullable": return `Option<${rustType(ref.inner, boxRefs)}>`;
    case "map": return `std::collections::BTreeMap<String, ${rustType(ref.valueType, boxRefs)}>`;
    case "unknown": return "Value";
    case "void": return "()";
  }
}

function optionalRustType(input: string, optional: boolean): string {
  let type = input;
  if (optional && !type.startsWith("Option<")) type = `Option<${type}>`;
  return type;
}

function reachesInline(from: string, target: string, schemas: readonly SchemaDef[], seen: Set<string>): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const schema = schemas.find((candidate) => candidate.name === from);
  if (!schema) return false;
  const refs = schema.unionType
    ? inlineRefs(schema.unionType)
    : schema.fields.flatMap((field) => inlineRefs(field.type));
  return refs.some((next) => reachesInline(next, target, schemas, seen));
}

function inlineRefs(ref: TypeRef): string[] {
  switch (ref.kind) {
    case "ref": return [ref.schema];
    case "optional": case "nullable": return inlineRefs(ref.inner);
    case "union": return ref.variants.flatMap(inlineRefs);
    default: return [];
  }
}

function emitVersion(version: VersionedResourceSet): string {
  const lines = [
    header(),
    "use reqwest::Method;",
    "use serde::{Deserialize, Serialize};",
    "use serde_json::Value;",
    "use crate::{Client, Result};",
    "use crate::generated::types::*;",
    "use crate::sse::{SseDecode, SseStream};",
    "",
  ];
  const surface = versionSurface(version);
  const top = surface.resources;
  const versionType = rustTypeName(version.sdkName ?? version.version);
  const allOperations = [
    ...surface.operations,
    ...top.flatMap((resource) => collectResourceOperations(resource)),
  ];
  for (const op of allOperations) {
    const definitions = emitOperation(op, []).definitions;
    if (definitions) lines.push(definitions, "");
  }
  lines.push(`/// ${version.version} API namespace.`, "#[derive(Clone)]", `pub struct ${versionType} { pub(crate) client: Client }`, "");
  lines.push(`impl ${versionType} {`);
  for (const resource of top) {
    const info = resourceInfo(resource, []);
    lines.push(`    /// Access the ${resource.name} resource.`, `    pub fn ${rustIdent(resource.name)}(&self) -> ${info.typeName} { ${info.typeName} { client: self.client.clone()${scopeInitializers(resource.scopeParams)} } }`);
  }
  for (const op of surface.operations) lines.push(indent(emitOperation(op, []).method, 4));
  lines.push("}", "");
  for (const resource of top) emitResource(lines, resource, []);
  return `${lines.join("\n")}\n`;
}

interface ResourceInfo { typeName: string; ancestry: string[] }

function resourceInfo(resource: ResourceDef, ancestry: string[]): ResourceInfo {
  const chain = [...ancestry, resource.name];
  return { typeName: `${chain.map(rustTypeName).join("")}Resource`, ancestry: chain };
}

function emitResource(lines: string[], resource: ResourceDef, ancestry: string[]): void {
  const info = resourceInfo(resource, ancestry);
  lines.push(doc(resource.description ?? `${resource.name} API resource.`), "#[derive(Clone)]", `pub struct ${info.typeName} {`, "    client: Client,");
  for (const param of resource.scopeParams) lines.push(`    /// Bound ${param.name} scope.`, `    ${rustIdent(param.name)}: ${ownedParamType(param.type)},`);
  lines.push("}", "", `impl ${info.typeName} {`);
  for (const child of resource.children) {
    const childInfo = resourceInfo(child, info.ancestry);
    const inherited = new Map(resource.scopeParams.map((p) => [p.name, p]));
    const introduced = child.scopeParams.filter((p) => !inherited.has(p.name));
    const args = introduced.map((p) => `${rustIdent(p.name)}: ${paramType(p.type)}`).join(", ");
    const initializers = child.scopeParams.map((p) => {
      const id = rustIdent(p.name);
      return inherited.has(p.name) ? `${id}: self.${id}.clone()` : `${id}: ${ownedExpr(p.type, id)}`;
    });
    lines.push(`    /// Access the nested ${child.name} resource.`, `    pub fn ${rustIdent(child.name)}(&self${args ? `, ${args}` : ""}) -> ${childInfo.typeName} {`);
    lines.push(`        ${childInfo.typeName} { client: self.client.clone()${initializers.length ? `, ${initializers.join(", ")}` : ""} }`);
    lines.push("    }");
  }
  for (const op of resource.operations) lines.push(indent(emitOperation(op, resource.scopeParams).method, 4));
  lines.push("}", "");
  for (const child of resource.children) emitResource(lines, child, info.ancestry);
}

interface EmittedOperation { definitions: string; method: string }

function emitOperation(op: OperationDef, scopes: ParamDef[]): EmittedOperation {
  const method = rustIdent(op.sdkName ?? op.name);
  const pathParams = op.pathParams.filter((p) => !scopes.some((s) => s.name === p.name));
  const args: string[] = pathParams.map((p) => `${rustIdent(p.name)}: ${paramType(p.type)}`);
  const definitions: string[] = [];
  let bodyArg: string | undefined;
  if (op.body) {
    const typeName = op.body.fields ? `${rustTypeName(op.operationId)}Input` : rustTypeName(op.body.schema);
    if (op.body.fields) definitions.push(emitInlineTypes(typeName, op.body.fields, op.description));
    args.push(`body: &${typeName}`);
    bodyArg = "body";
  }
  let queryArg: string | undefined;
  let queryRequired = false;
  if (op.queryParams.length > 0) {
    const typeName = `${rustTypeName(op.operationId)}Params`;
    definitions.push(emitStruct(typeName, op.queryParams, `Query parameters for ${op.operationId}.`));
    queryRequired = op.queryParams.some((param) => param.required);
    args.push(queryRequired ? `params: &${typeName}` : `params: Option<&${typeName}>`);
    queryArg = "params";
  }
  let returnType = operationReturnType(op);
  if (op.returnType.kind === "object" && op.returnType.fields.length > 0 && !op.streaming) {
    const typeName = `${rustTypeName(op.operationId)}Response`;
    definitions.push(emitInlineTypes(typeName, op.returnType.fields, op.returnDescription));
    returnType = typeName;
  }
  if (op.streaming) {
    const enumName = `${rustTypeName(op.operationId)}Event`;
    definitions.push(emitStreamEnum(enumName, op));
    returnType = `SseStream<${enumName}>`;
  }
  const lines: string[] = [];
  lines.push(doc(op.summary ?? op.description));
  if (op.deprecated) lines.push("#[deprecated]");
  lines.push(`pub async fn ${method}(&self${args.length ? `, ${args.join(", ")}` : ""}) -> Result<${returnType}> {`);
  const hasPathReplacements = scopes.length > 0 || pathParams.length > 0;
  lines.push(`    let ${hasPathReplacements ? "mut " : ""}path = ${rustString(op.path)}.to_owned();`);
  for (const scope of scopes) lines.push(`    path = path.replace(${rustString(`{${scope.wireName ?? scope.name}}`)}, &crate::encode_path(${pathValueExpr(scope.type, `self.${rustIdent(scope.name)}`, true)}));`);
  for (const param of pathParams) lines.push(`    path = path.replace(${rustString(`{${param.wireName ?? param.name}}`)}, &crate::encode_path(${pathValueExpr(param.type, rustIdent(param.name), false)}));`);
  lines.push(`    let request = self.client.request(Method::${op.method}, &path);`);
  if (queryArg) lines.push(queryRequired ? `    let request = request.query(${queryArg})?;` : `    let request = match ${queryArg} { Some(value) => request.query(value)?, None => request };`);
  if (bodyArg) lines.push(`    let request = request.json(${bodyArg})?;`);
  if (op.streaming) lines.push("    request.stream().await");
  else if (op.rawResponse) lines.push("    request.send_raw().await");
  else if (op.returnType.kind === "void") lines.push("    request.send_empty().await");
  else lines.push("    request.send().await");
  lines.push("}");
  if (!op.streaming) {
    lines.push(`/// Blocking variant of [Self::${method}].`, "#[cfg(feature = \"blocking\")]", `pub fn ${method}_blocking(&self${args.length ? `, ${args.join(", ")}` : ""}) -> Result<${returnType}> {`);
    lines.push(`    crate::blocking::block_on(self.${method}(${callArgs(pathParams, bodyArg, queryArg)}))`);
    lines.push("}");
  }
  return {
    definitions: definitions.filter(Boolean).join("\n\n"),
    method: lines.filter(Boolean).join("\n"),
  };
}

function callArgs(pathParams: ParamDef[], body?: string, query?: string): string {
  const args = pathParams.map((p) => rustIdent(p.name));
  if (body) args.push(body);
  if (query) args.push(query);
  return args.join(", ");
}

function emitInlineTypes(name: string, fields: readonly FieldDef[], description?: string): string {
  const hoist = hoistInlineObjects([...fields], name, "typeddict");
  const parts = hoist.hoisted.map((item) => emitStruct(rustTypeName(item.name), item.fields, item.description));
  parts.push(emitStruct(name, hoist.fields, description));
  return parts.join("\n\n");
}

function emitStreamEnum(name: string, op: OperationDef): string {
  const variants = op.streaming!.events.map((event) => `    ${rustTypeName(event.sdkTypeName ?? event.event)}(${rustType(event.dataType)}),`);
  const arms = op.streaming!.events.map((event) => `            ${rustString(event.event)} => Ok(Self::${rustTypeName(event.sdkTypeName ?? event.event)}(serde_json::from_str(data)?)),`);
  return [
    `/// Typed events emitted by ${op.operationId}.`, "#[derive(Debug, Clone, PartialEq)]", `pub enum ${name} {`, ...variants.flatMap((variant) => [`    /// Contract-defined stream event.`, variant]), "}",
    `impl SseDecode for ${name} {`,
    "    fn decode(event: &str, data: &str) -> Result<Self> {", "        match event {", ...arms,
    "            other => Err(crate::Error::UnknownSseEvent(other.to_owned())),", "        }", "    }", "}",
  ].join("\n");
}

function operationReturnType(op: OperationDef): string {
  if (op.rawResponse) return "crate::RawResponse";
  return rustType(op.returnType);
}

function emitAuth(spec: SdkSpec): string {
  const lines = [header(), "use reqwest::Method;", "use serde::{Deserialize, Serialize};", "use crate::{Client, Result};", "use crate::generated::types::*;", ""];
  for (const op of spec.authOperations) {
    const definitions = emitOperation(op, []).definitions;
    if (definitions) lines.push(definitions, "");
  }
  lines.push("/// Authentication API resource.", "#[derive(Clone)]", "pub struct Auth { pub(crate) client: Client }", "", "impl Auth {");
  for (const op of spec.authOperations) lines.push(indent(emitOperation(op, []).method, 4));
  lines.push("}");
  const login = spec.authOperations.find((op) => op.path.endsWith("/auth/login") && op.method === "POST");
  const refresh = spec.authOperations.find((op) => op.path.endsWith("/auth/refresh") && op.method === "POST");
  if (login?.body?.fields && refresh) {
    const loginType = `${rustTypeName(login.operationId)}Input`;
    const loginMethod = rustIdent(login.sdkName ?? login.name);
    lines.push("", "impl Client {", "    /// Authenticate with email/password and enable generation-fenced automatic refresh.");
    lines.push("    pub async fn with_credentials(api_key: impl Into<String>, email: impl Into<String>, password: impl Into<String>) -> Result<Self> {");
    lines.push("        let client = Self::builder().publishable_key(api_key).build()?;");
    lines.push(`        let tokens = client.auth().${loginMethod}(&${loginType} { email: email.into(), password: password.into() }).await?;`);
    const tokenSchemaName = login.returnType.kind === "ref" ? login.returnType.schema : "AuthTokens";
    const tokenSchema = spec.schemas.find((schema) => schema.name === tokenSchemaName);
    const accessField = tokenSchema?.fields.find((field) => field.sdkRole === "access_token" || field.name === "access_token" || field.name === "token");
    const refreshField = tokenSchema?.fields.find((field) => field.sdkRole === "refresh_token" || field.name === "refresh_token");
    const accessExpr = `tokens.${rustIdent(accessField?.name ?? "access_token")}.clone()`;
    const refreshBase = `tokens.${rustIdent(refreshField?.name ?? "refresh_token")}.clone()`;
    const refreshExpr = refreshField && (refreshField.required && refreshField.type.kind !== "optional" && refreshField.type.kind !== "nullable") ? `Some(${refreshBase})` : refreshBase;
    lines.push(`        client.install_session(${accessExpr}, ${refreshExpr}, ${rustString(refresh.path)}).await;`);
    lines.push("        Ok(client)", "    }", "}");
  }
  return `${lines.join("\n")}\n`;
}

function emitChannels(spec: SdkSpec): string {
  const lines = [header(), "use serde::{Deserialize, Serialize};", "use serde_json::Value;", "use crate::{Channel, ChannelEventStream, Result, Socket};", ""];
  for (const channel of spec.channels) lines.push(emitChannel(channel), "");
  return `${lines.join("\n")}\n`;
}

function emitChannel(channel: ChannelDef): string {
  const name = rustTypeName(channel.sdkName ?? channel.className);
  const definitions: string[] = [];
  for (const message of channel.messages) {
    if (message.params.length > 0) definitions.push(emitInlineTypes(`${name}${rustTypeName(message.sdkTypeName ?? message.event)}Input`, message.params, message.description), "");
  }
  for (const push of channel.pushes) {
    if (push.payloadType.kind === "object" && push.payloadType.fields.length > 0) definitions.push(emitInlineTypes(`${name}${rustTypeName(push.sdkTypeName ?? push.event)}Payload`, push.payloadType.fields, push.description), "");
  }
  for (const [index, join] of channel.joins.entries()) {
    const segment = rustTypeName(join.sdkTypeName ?? join.name ?? `Join${index + 1}`);
    const payload = join.params.filter((p) => ![...join.topicPattern.matchAll(/\{([^}]+)\}/g)].some((match) => match[1] === (p.wireName ?? p.name)));
    if (payload.length > 0) definitions.push(emitInlineTypes(`${name}${segment}Params`, payload, join.description), "");
    if (join.returnType.kind === "object" && join.returnType.fields.length > 0) definitions.push(emitInlineTypes(`${name}${segment}Response`, join.returnType.fields, join.description), "");
  }
  const lines: string[] = [...definitions];
  lines.push(doc(channel.description), "#[derive(Clone)]", `pub struct ${name}<R = Value> {`, "    /// Underlying joined Phoenix channel.", "    pub channel: Channel,", "    /// Typed payload returned by the join.", "    pub join_response: R,", "}", `impl ${name}<Value> {`);
  channel.joins.forEach((join, index) => {
    const method = rustIdent(join.name ?? (channel.joins.length > 1 ? `join_${index + 1}` : "join"));
    const segment = rustTypeName(join.sdkTypeName ?? join.name ?? `Join${index + 1}`);
    const placeholders = [...join.topicPattern.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    const params = uniqueRustNames(placeholders);
    const payload = join.params.filter((p) => !placeholders.includes(p.wireName ?? p.name));
    const args = params.map((p) => `${p}: &str`);
    if (payload.length > 0) {
      const inputName = `${name}${segment}Params`;
      args.push(`params: &${inputName}`);
    }
    const responseType = join.returnType.kind === "object" && join.returnType.fields.length > 0
      ? `${name}${segment}Response`
      : rustType(join.returnType);
    let topic = rustString(join.topicPattern);
    placeholders.forEach((placeholder, i) => { topic = `${topic}.replace(${rustString(`{${placeholder}}`)}, ${params[i]})`; });
    lines.push(`    /// ${join.description ?? `Join ${join.topicPattern}.`}`, `    pub async fn ${method}(socket: &Socket${args.length ? `, ${args.join(", ")}` : ""}) -> Result<${name}<${responseType}>> {`);
    lines.push(`        let topic = ${topic};`);
    lines.push(`        let channel = socket.channel(topic);`);
    lines.push(`        let value = channel.join(${payload.length > 0 ? "serde_json::to_value(params)?" : "serde_json::json!({})"}).await?;`);
    lines.push(responseType === "Value" ? "        let join_response = value;" : `        let join_response = serde_json::from_value(value)?;`);
    lines.push(`        Ok(${name} { channel, join_response })`, "    }");
  });
  lines.push("}", `impl<R> ${name}<R> {`);
  lines.push("    /// Leave the underlying Phoenix channel.", "    pub async fn leave(&self) -> Result<()> { self.channel.leave().await }");
  for (const message of channel.messages) {
    const method = rustIdent(message.event);
    const inputName = `${name}${rustTypeName(message.sdkTypeName ?? message.event)}Input`;
    const args = message.params.length > 0 ? `, input: &${inputName}` : "";
    const payload = message.params.length > 0 ? "serde_json::to_value(input)?" : "serde_json::json!({})";
    lines.push(`    /// ${message.description ?? `Push the ${message.event} event.`}`, `    pub async fn ${method}(&self${args}) -> Result<${rustType(message.returnType)}> {`);
    lines.push(`        let value = self.channel.push(${rustString(message.event)}, ${payload}).await?;`);
    if (message.returnType.kind === "void") lines.push("        Ok(())");
    else lines.push("        Ok(serde_json::from_value(value)?)");
    lines.push("    }");
  }
  for (const push of channel.pushes) {
    const type = push.payloadType.kind === "object" && push.payloadType.fields.length > 0
      ? `${name}${rustTypeName(push.sdkTypeName ?? push.event)}Payload`
      : rustType(push.payloadType);
    lines.push(`    /// ${push.description ?? `Subscribe to ${push.event} pushes.`}`, `    pub fn subscribe_${rustIdent(push.event)}(&self) -> ChannelEventStream<${type}> { self.channel.subscribe(${rustString(push.event)}) }`);
  }
  lines.push("}");
  return lines.filter(Boolean).join("\n");
}

function versionSurface(version: VersionedResourceSet): { resources: ResourceDef[]; operations: OperationDef[] } {
  const resources: ResourceDef[] = [];
  const operations: OperationDef[] = [];
  for (const root of version.resources) {
    if (root.name === "api") {
      const versionRoot = root.children.find((child) => child.name === version.version || child.path === version.apiPrefix);
      if (versionRoot) {
        operations.push(...versionRoot.operations);
        resources.push(...versionRoot.children);
        continue;
      }
    }
    resources.push(root);
  }
  return { resources, operations };
}

function collectResourceOperations(resource: ResourceDef): OperationDef[] {
  return [...resource.operations, ...resource.children.flatMap((child) => collectResourceOperations(child))];
}

function ownedParamType(ref: TypeRef): string {
  if (ref.kind === "primitive" && ref.type === "string") return "String";
  return rustType(ref);
}

function paramType(ref: TypeRef): string {
  if (ref.kind === "primitive" && ref.type === "string") return "&str";
  return rustType(ref);
}

function ownedExpr(ref: TypeRef, ident: string): string {
  return ref.kind === "primitive" && ref.type === "string" ? `${ident}.to_owned()` : ident;
}

function pathValueExpr(ref: TypeRef, ident: string, owned: boolean): string {
  if (ref.kind === "primitive" && ref.type === "string") {
    return owned ? `${ident}.as_str()` : ident;
  }
  return `&${ident}.to_string()`;
}

function scopeInitializers(params: ParamDef[]): string {
  return params.length ? `, ${params.map((p) => `${rustIdent(p.name)}: Default::default()`).join(", ")}` : "";
}

function doc(value?: string): string {
  if (!value) return "/// Generated from the ArchAstro OpenAPI contract.";
  return value.split("\n").map((line) => `/// ${line.replace(/\r/g, "")}`).join("\n");
}

function indentDoc(value: string | undefined, spaces: number): string {
  if (!value) return indent("/// API field.", spaces);
  return indent(doc(value), spaces);
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => line ? `${prefix}${line}` : line).join("\n");
}
