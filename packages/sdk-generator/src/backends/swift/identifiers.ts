import { camelCase } from "../../utils/naming.js";

/**
 * Swift keywords that must be escaped with backticks when used as an
 * identifier (declaration or argument label). Keywords that are only
 * reserved in specific positions (e.g. `get`, `set`) are safe as member
 * names and deliberately excluded.
 */
const SWIFT_KEYWORDS = new Set([
  "associatedtype",
  "class",
  "deinit",
  "enum",
  "extension",
  "fileprivate",
  "func",
  "import",
  "init",
  "inout",
  "internal",
  "let",
  "open",
  "operator",
  "private",
  "precedencegroup",
  "protocol",
  "public",
  "rethrows",
  "static",
  "struct",
  "subscript",
  "typealias",
  "var",
  "break",
  "case",
  "catch",
  "continue",
  "default",
  "defer",
  "do",
  "else",
  "fallthrough",
  "for",
  "guard",
  "if",
  "in",
  "repeat",
  "return",
  "throw",
  "switch",
  "where",
  "while",
  "as",
  "false",
  "is",
  "nil",
  "self",
  "Self",
  "super",
  "throws",
  "true",
  "try",
  "Any",
  "Type",
  "Protocol",
]);

/**
 * Type names that clash with the runtime or common stdlib types the
 * generated code references unqualified. A schema with one of these names
 * would shadow the real type inside the module, so the registry renames it.
 */
const RESERVED_TYPE_NAMES = new Set([
  "HttpClient",
  "ApiError",
  "JSONValue",
  "RawResponse",
  "SSEEvent",
  "Socket",
  "Channel",
  "ChannelReply",
  "ChannelError",
  "PlatformClient",
  "AuthClient",
  "String",
  "Int",
  "Double",
  "Bool",
  "Date",
  "Data",
  "Array",
  "Dictionary",
  "Optional",
  "Error",
  "Result",
  "Task",
  "Void",
]);

export function isValidSwiftIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !SWIFT_KEYWORDS.has(name);
}

/** Sanitize an arbitrary string into a Swift identifier (no keyword escape). */
function sanitizeIdentifier(name: string): string {
  let identifier = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (identifier.length === 0) identifier = "_";
  if (/^[0-9]/.test(identifier)) identifier = `_${identifier}`;
  return identifier;
}

/**
 * Lower-camel Swift member/parameter name from a wire name. Keywords are
 * escaped with backticks (`default` → `` `default` ``).
 */
export function swiftMemberName(name: string): string {
  const identifier = sanitizeIdentifier(camelCase(name));
  return SWIFT_KEYWORDS.has(identifier) ? `\`${identifier}\`` : identifier;
}

/**
 * The bare (unescaped) member name — needed for CodingKeys raw-value
 * comparison and doc references.
 */
export function swiftMemberBaseName(name: string): string {
  return sanitizeIdentifier(camelCase(name));
}

/**
 * Assign unique Swift member names to an ordered list of wire names.
 * Collisions after camelCasing (`user_id` vs `userId`) get numeric
 * suffixes, mirroring the Python identifier strategy. `reserved` names
 * (local variables in the generated method body, e.g. the `query`
 * accumulator) are never handed out.
 */
export function uniqueSwiftMemberNames(
  names: ReadonlyArray<string>,
  reserved: ReadonlyArray<string> = []
): string[] {
  const used = new Set<string>(reserved);
  return names.map((name) => {
    const base = swiftMemberBaseName(name);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}${suffix}`;
      suffix++;
    }
    used.add(candidate);
    return SWIFT_KEYWORDS.has(candidate) ? `\`${candidate}\`` : candidate;
  });
}

/**
 * Global registry of generated type names. Swift compiles the whole SDK
 * into one module, so every generated type (schema struct, inline input,
 * inline response, channel payload, stream event) shares a namespace.
 * The registry hands out deterministic names: first-come keeps the
 * preferred name; later collisions get a numeric suffix. Reserved
 * runtime/stdlib names are never handed out bare.
 */
export class SwiftNameRegistry {
  private used = new Set<string>(RESERVED_TYPE_NAMES);
  private assigned = new Map<string, string>();

  /**
   * Claim a type name for `key` (a stable identity like "schema:Agent" or
   * "input:TeamCreateInput"). Returns the assigned name; repeated calls
   * with the same key return the same name.
   */
  claim(key: string, preferred: string): string {
    const existing = this.assigned.get(key);
    if (existing) return existing;

    let candidate = sanitizeTypeName(preferred);
    let suffix = 2;
    while (this.used.has(candidate)) {
      candidate = `${sanitizeTypeName(preferred)}${suffix}`;
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
      throw new Error(`[sdk-generator] swift: type name for "${key}" was never claimed`);
    }
    return name;
  }

  has(key: string): boolean {
    return this.assigned.has(key);
  }

  /** True if `name` is already handed out (or reserved). */
  nameTaken(name: string): boolean {
    return this.used.has(name);
  }
}

function sanitizeTypeName(name: string): string {
  let identifier = sanitizeIdentifier(name);
  if (/^[a-z]/.test(identifier)) {
    identifier = identifier.charAt(0).toUpperCase() + identifier.slice(1);
  }
  return identifier;
}

/** Swift string literal with proper escaping (including backslash-interpolation). */
export function swiftString(value: string): string {
  return JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
}
