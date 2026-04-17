// SDK Generator AST — language-agnostic representation of an SDK.
//
// Frontend: OpenAPI spec → SdkSpec
// Backend:  SdkSpec → generated code (TypeScript, Python, etc.)

// ─── Top-Level Spec ──────────────────────────────────────────────

/** A versioned set of resources — one per API path version (v1, v2, …). */
export interface VersionedResourceSet {
  /** Version identifier, e.g., "v1" */
  version: string;
  /** Full API prefix for this version, e.g., "/api/v1" */
  apiPrefix: string;
  /** Resource tree for this version */
  resources: ResourceDef[];
}

export interface SdkSpec {
  name: string;
  version: string;
  description?: string;
  baseUrl: string;
  /** API base path without version, e.g., "/api" */
  apiBase: string;
  /** Default API version for convenience aliases, e.g., "v1" */
  defaultVersion: string;
  /** Per-version resource sets */
  versions: VersionedResourceSet[];
  auth: AuthConfig;
  types: TypeDef[];
  schemas: SchemaDef[];
  /**
   * Schemas grouped by related resource, with circular imports resolved.
   * Keys are group names (e.g., "agents", "threads", "common"), values are
   * topo-sorted schemas for that group. Populated by the frontend after parsing.
   */
  schemaGroups: Record<string, SchemaDef[]>;
  /** @deprecated Use versions[].resources instead — kept for backward compat */
  apiPrefix: string;
  /** @deprecated Use versions[].resources instead — default version's resources */
  resources: ResourceDef[];
  /** Auth-tagged operations — excluded from resources, handled by the auth emitter */
  authOperations: OperationDef[];
  channels: ChannelDef[];
}

// ─── Auth ────────────────────────────────────────────────────────

export interface AuthScheme {
  type: "apiKey" | "http";
  in?: string;
  name?: string;
  scheme?: string;
  prefix?: string;
  description?: string;
  "x-token-use"?: string;
}

export interface TokenFlow {
  endpoint?: string;
  authorize?: string;
  callback?: string;
  token?: string;
  method?: string;
  params?: (string | Record<string, string>)[];
  returns?: string[];
  requires?: string[];
  providers?: string[];
  description?: string;
}

export interface AuthConfig {
  schemes: Record<string, AuthScheme>;
  tokenFlows: Record<string, TokenFlow>;
  channelAuth: string[];
}

// ─── Type System ─────────────────────────────────────────────────

export type TypeRef =
  | PrimitiveTypeRef
  | ArrayTypeRef
  | ObjectTypeRef
  | RefTypeRef
  | EnumTypeRef
  | UnionTypeRef
  | OptionalTypeRef
  | MapTypeRef
  | UnknownTypeRef
  | VoidTypeRef;

export interface PrimitiveTypeRef {
  kind: "primitive";
  type: "string" | "integer" | "float" | "boolean" | "datetime";
}

export interface ArrayTypeRef {
  kind: "array";
  items: TypeRef;
}

export interface ObjectTypeRef {
  kind: "object";
  fields: FieldDef[];
}

export interface RefTypeRef {
  kind: "ref";
  schema: string;
}

export interface EnumTypeRef {
  kind: "enum";
  values: string[];
}

export interface UnionTypeRef {
  kind: "union";
  variants: TypeRef[];
}

export interface OptionalTypeRef {
  kind: "optional";
  inner: TypeRef;
}

export interface MapTypeRef {
  kind: "map";
  keyType: TypeRef;
  valueType: TypeRef;
}

export interface UnknownTypeRef {
  kind: "unknown";
}

export interface VoidTypeRef {
  kind: "void";
}

// ─── Fields ──────────────────────────────────────────────────────

export interface FieldDef {
  name: string;
  type: TypeRef;
  required: boolean;
  default?: unknown;
  description?: string;
  /** SDK role annotation (e.g., "access_token", "refresh_token", "token_expiry") */
  sdkRole?: string;
}

// ─── Custom Scalar Types ─────────────────────────────────────────

export interface TypeDef {
  name: string;
  baseType: "string" | "integer" | "float" | "boolean" | "datetime";
  description?: string;
  examples?: string[];
  pattern?: string;
}

// ─── Schemas (Object Models) ─────────────────────────────────────

export interface SchemaDef {
  name: string;
  description?: string;
  fields: FieldDef[];
  oneOfGroups?: string[][];
  /** Names of other schemas referenced by this schema's fields (populated by frontend). */
  refDeps?: string[];
}

// ─── Resources ───────────────────────────────────────────────────

export interface ResourceDef {
  name: string;
  className: string;
  description?: string;
  path: string;
  scopeParams: ParamDef[];
  operations: OperationDef[];
  children: ResourceDef[];
}

export interface OperationDef {
  name: string;
  operationId: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  pathParams: ParamDef[];
  queryParams: ParamDef[];
  body?: BodyDef;
  returnType: TypeRef;
  errors: ErrorDef[];
  pagination?: PaginationConfig;
  streaming?: StreamingConfig;
  rawResponse?: boolean;
  auth?: string[];
  /** Explicit SDK method name override from x-sdk-name */
  sdkName?: string;
  tags?: string[];
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ParamDef {
  name: string;
  type: TypeRef;
  required: boolean;
  default?: unknown;
  description?: string;
}

export interface BodyDef {
  schema: string;
  contentType: string;
  fields?: FieldDef[];
}

export interface PaginationConfig {
  style: "offset" | "cursor";
}

export interface StreamingConfig {
  style: "sse";
  events: StreamingEvent[];
}

export interface StreamingEvent {
  event: string;
  dataType: TypeRef;
}

export interface ErrorDef {
  status: number;
  code?: string;
  description: string;
}

// ─── Channels ────────────────────────────────────────────────────

export interface ChannelDef {
  name: string;
  className: string;
  description?: string;
  joins: ChannelJoinDef[];
  messages: ChannelMessageDef[];
  pushes: ChannelPushDef[];
  auth?: string[];
}

export interface ChannelJoinDef {
  topicPattern: string;
  name?: string;
  description?: string;
  params: ParamDef[];
  returnType: TypeRef;
}

export interface ChannelMessageDef {
  event: string;
  description?: string;
  params: ParamDef[];
  returnType: TypeRef;
}

export interface ChannelPushDef {
  event: string;
  description?: string;
  payloadType: TypeRef;
}
