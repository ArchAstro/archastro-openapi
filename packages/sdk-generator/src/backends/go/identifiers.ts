/**
 * Go identifier rules for the generated SDK.
 *
 * Go has a single package-level namespace shared by types, functions, and
 * variables, so generated type names are handed out through one registry
 * (mirroring the Swift backend's single-module registry).
 */

/** Reserved words — never valid as an identifier. */
const GO_KEYWORDS = new Set([
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "map",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "type",
  "var",
]);

/**
 * Predeclared identifiers. Legal to shadow, but a local named `len` or
 * `string` inside a generated method body is a readability trap, so the
 * parameter namer avoids them.
 */
const GO_PREDECLARED = new Set([
  "any",
  "append",
  "bool",
  "byte",
  "cap",
  "clear",
  "close",
  "comparable",
  "complex",
  "complex64",
  "complex128",
  "copy",
  "delete",
  "error",
  "false",
  "float32",
  "float64",
  "imag",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "iota",
  "len",
  "make",
  "map",
  "max",
  "min",
  "new",
  "nil",
  "panic",
  "print",
  "println",
  "real",
  "recover",
  "rune",
  "string",
  "true",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
]);

/**
 * Canonical capitalization for common initialisms (the `golint` list, plus
 * the few the platform spec leans on). Applied per word, so `identity` is
 * untouched while `agent_id` becomes `AgentID`.
 */
const INITIALISMS: Record<string, string> = {
  acl: "ACL",
  api: "API",
  ascii: "ASCII",
  cpu: "CPU",
  css: "CSS",
  dns: "DNS",
  eof: "EOF",
  guid: "GUID",
  html: "HTML",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  ip: "IP",
  json: "JSON",
  lhs: "LHS",
  qps: "QPS",
  ram: "RAM",
  rhs: "RHS",
  rpc: "RPC",
  sla: "SLA",
  smtp: "SMTP",
  sql: "SQL",
  ssh: "SSH",
  sse: "SSE",
  tcp: "TCP",
  tls: "TLS",
  ttl: "TTL",
  udp: "UDP",
  ui: "UI",
  uid: "UID",
  uuid: "UUID",
  uri: "URI",
  url: "URL",
  utf8: "UTF8",
  vm: "VM",
  xml: "XML",
  xmpp: "XMPP",
  xsrf: "XSRF",
  xss: "XSS",
};

/**
 * Package-level names the hand-written runtime owns. A generated type with
 * one of these names would collide at compile time, so the registry never
 * hands them out.
 */
const RESERVED_TYPE_NAMES = new Set([
  // Runtime types
  "APIError",
  "Channel",
  "ChannelError",
  "ChannelReply",
  "ChannelState",
  "ClientConfig",
  "ClientOption",
  "HTTPClient",
  "JSONValue",
  "RawResponse",
  "SSEEvent",
  "SSEStream",
  "Socket",
  "SocketOption",
  "Time",
  // Generated top-level types the client emitter always produces
  "AuthClient",
  "Client",
  "NewClient",
  "NewClientWithCredentials",
  "NewClientWithSecretKey",
  "NewClientWithToken",
  // Runtime functions and sentinel errors
  "ErrLoginFailed",
  "ErrMissingAccessToken",
  "ErrRefreshFailed",
  "JSONOf",
  "MustParseTime",
  "NewSocket",
  "ParseTime",
  "Ptr",
  "WithAccessToken",
  "WithAccessTokenFunc",
  "WithBaseURL",
  "WithDefaultHeaders",
  "WithHTTPClient",
  "WithPathPrefix",
  "WithRefreshHandler",
  "WithSocketAutoReconnect",
  "WithSocketHeartbeat",
  "WithSocketParams",
  "WithSocketTimeout",
  // Predeclared name that would shadow the universe block
  "Error",
]);

/** Split a wire name into words on separators and camel-case humps. */
export function goWords(name: string): string[] {
  const words: string[] = [];
  for (const part of name.split(/[^A-Za-z0-9]+/).filter(Boolean)) {
    const matches = part.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g);
    if (matches) words.push(...matches);
    else words.push(part);
  }
  return words;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Exported Go identifier: `agent_id` → `AgentID`, `api_key` → `APIKey`. */
export function goExportedName(name: string): string {
  const parts = goWords(name).map(
    (word) => INITIALISMS[word.toLowerCase()] ?? capitalize(word)
  );
  const joined = parts.join("");
  if (joined.length === 0) return "X";
  // Exported identifiers must start with an upper-case letter.
  if (!/^[A-Z]/.test(joined)) return `X${joined}`;
  return joined;
}

/** Unexported Go identifier: `agent_id` → `agentID`, `type` → `typeVal`. */
export function goUnexportedName(name: string): string {
  const words = goWords(name);
  if (words.length === 0) return "x";
  const head = words[0]!.toLowerCase();
  const tail = words
    .slice(1)
    .map((word) => INITIALISMS[word.toLowerCase()] ?? capitalize(word));
  let joined = head + tail.join("");
  if (/^[0-9]/.test(joined)) joined = `x${joined}`;
  if (GO_KEYWORDS.has(joined) || GO_PREDECLARED.has(joined)) {
    joined = `${joined}Val`;
  }
  return joined;
}

/**
 * Unique exported names for an ordered list of wire names. Collisions after
 * casing (`user_id` vs `userId`) take a numeric suffix, keeping generated
 * struct fields stable across runs.
 */
export function uniqueGoFieldNames(
  names: ReadonlyArray<string>,
  reserved: ReadonlyArray<string> = []
): string[] {
  return uniquify(names, reserved, goExportedName);
}

/**
 * Unique unexported names for method parameters and locals. `reserved`
 * carries the locals the generated body already uses (`ctx`, `q`, `err`, …).
 */
export function uniqueGoParamNames(
  names: ReadonlyArray<string>,
  reserved: ReadonlyArray<string> = []
): string[] {
  return uniquify(names, reserved, goUnexportedName);
}

function uniquify(
  names: ReadonlyArray<string>,
  reserved: ReadonlyArray<string>,
  transform: (name: string) => string
): string[] {
  const used = new Set<string>(reserved);
  return names.map((name) => {
    const base = transform(name);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}${suffix}`;
      suffix++;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * Registry of exported package-level names. Go resolves types, functions,
 * and vars from one namespace per package, and the SDK compiles as a single
 * package, so schemas, resource structs, channel structs, constructors, and
 * join helpers all claim through here. First-come keeps the preferred name;
 * later collisions take a numeric suffix.
 */
export class GoNameRegistry {
  private used = new Set<string>(RESERVED_TYPE_NAMES);
  private assigned = new Map<string, string>();

  /**
   * Claim a name for `key` (a stable identity like `schema:Agent`).
   * Repeated calls with the same key return the same name.
   */
  claim(key: string, preferred: string): string {
    const existing = this.assigned.get(key);
    if (existing) return existing;

    const base = goExportedName(preferred);
    let candidate = base;
    let suffix = 2;
    while (this.used.has(candidate)) {
      candidate = `${base}${suffix}`;
      suffix++;
    }
    this.used.add(candidate);
    this.assigned.set(key, candidate);
    return candidate;
  }

  /** Look up a previously claimed name; throws if the key was never claimed. */
  lookup(key: string): string {
    const name = this.assigned.get(key);
    if (!name) {
      throw new Error(`[sdk-generator] go: type name for "${key}" was never claimed`);
    }
    return name;
  }

  has(key: string): boolean {
    return this.assigned.has(key);
  }

  /** True if `name` is already handed out (or reserved by the runtime). */
  nameTaken(name: string): boolean {
    return this.used.has(name);
  }
}

/** Go string literal (double-quoted, JSON escaping is compatible). */
export function goString(value: string): string {
  return JSON.stringify(value);
}

/**
 * snake_case file stem for a generated Go file. Word-splitting (rather than
 * a regex on case transitions) keeps acronyms readable: `APIChatChannel`
 * becomes `api_chat_channel`, not `apichat_channel`.
 */
export function goFileStem(name: string): string {
  const words = goWords(name).map((word) => word.toLowerCase());
  return words.length > 0 ? words.join("_") : "x";
}
