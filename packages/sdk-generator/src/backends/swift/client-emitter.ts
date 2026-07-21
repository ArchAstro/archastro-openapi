import type { OperationDef, SdkSpec } from "../../ast/types.js";
import { CodeBuilder, generatedHeader } from "../../utils/codegen.js";
import { swiftString, uniqueSwiftMemberNames } from "./identifiers.js";
import {
  extractSwiftAuthInputParams,
  swiftAuthMethodName,
} from "./auth-emitter.js";
import { swiftVersionClassName } from "./namespace-emitter.js";

/**
 * Generate the Swift PlatformClient: constructor, version namespaces,
 * default-version aliases, auth factory constructors, and socket helpers.
 */
export function emitSwiftClientFile(spec: SdkSpec): string {
  const cb = new CodeBuilder("    ");

  const authOps = spec.authOperations ?? [];
  const hasAuth = authOps.length > 0;
  const hasChannels = spec.channels.length > 0;
  const schemes = spec.auth?.schemes ?? {};
  const flows = spec.auth?.tokenFlows ?? {};
  const socketApiKeyHeader =
    schemes.publishable_key?.name ?? schemes.secret_key?.name ?? "x-archastro-api-key";

  const defaultVersionSet =
    spec.versions.find((v) => v.version === spec.defaultVersion) ?? spec.versions[0];
  const seen = new Set<string>();
  const aliasResources = (defaultVersionSet?.resources ?? []).filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
  const aliasNames = uniqueSwiftMemberNames(aliasResources.map((r) => r.name));

  for (const line of generatedHeader().trim().split("\n")) cb.line(line);
  cb.line();
  cb.line("import Foundation");
  cb.line();

  cb.line("/// Client for the platform API. Configure with an API key and/or");
  cb.line("/// access token, then access resources via `client.v1.…` or the");
  cb.line("/// default-version aliases (`client.agents`, …).");
  cb.block("public final class PlatformClient: Sendable", () => {
    cb.line("public let http: HttpClient");
    if (hasAuth) cb.line("public let auth: AuthClient");
    for (const versionSet of spec.versions) {
      cb.line(
        `public let ${versionSet.version}: ${swiftVersionClassName(versionSet.version)}`
      );
    }
    cb.line("private let baseUrl: String");
    cb.line("private let defaultHeaders: [String: String]");
    cb.line("private let state = Locked(ClientState())");
    cb.line();
    cb.block("private struct ClientState", () => {
      cb.line("var refreshToken: String?");
      cb.line("var sockets: [Socket] = []");
    });
    cb.line();

    // Constructor
    cb.line("public init(");
    cb.indent();
    cb.line(`baseUrl: String = ${swiftString(spec.baseUrl)},`);
    cb.line("accessToken: String? = nil,");
    cb.line("getAccessToken: (@Sendable () -> String?)? = nil,");
    cb.line("onRefreshToken: (@Sendable () async throws -> String)? = nil,");
    cb.line("pathPrefix: String? = nil,");
    cb.line("defaultHeaders: [String: String] = [:]");
    cb.dedent();
    cb.line(") {");
    cb.indent();
    cb.line("self.baseUrl = baseUrl");
    cb.line("self.defaultHeaders = defaultHeaders");
    cb.line("self.http = HttpClient(");
    cb.indent();
    cb.line("baseUrl: baseUrl,");
    cb.line("accessToken: accessToken,");
    cb.line("getAccessToken: getAccessToken,");
    cb.line("onRefreshToken: onRefreshToken,");
    cb.line("pathPrefix: pathPrefix,");
    cb.line("defaultHeaders: defaultHeaders");
    cb.dedent();
    cb.line(")");
    if (hasAuth) cb.line("self.auth = AuthClient(http: http)");
    for (const versionSet of spec.versions) {
      cb.line(
        `self.${versionSet.version} = ${swiftVersionClassName(versionSet.version)}(http: http)`
      );
    }
    cb.dedent();
    cb.line("}");

    // Default-version aliases
    if (defaultVersionSet && aliasResources.length > 0) {
      cb.line();
      cb.line("// ─── Default-version aliases ───");
      for (let i = 0; i < aliasResources.length; i++) {
        cb.line(
          `public var ${aliasNames[i]}: ${aliasResources[i]!.className} { ${spec.defaultVersion}.${aliasNames[i]!.replace(/`/g, "")} }`
        );
      }
    }

    // Token management
    cb.line();
    cb.line("/// The refresh token captured by `withCredentials`, if any.");
    cb.block("public var refreshToken: String?", () => {
      cb.line("state.withLock { $0.refreshToken }");
    });
    cb.line();
    cb.block("public func setAccessToken(_ token: String)", () => {
      cb.line("http.setAccessToken(token)");
    });
    cb.line();
    cb.block("public func setRefreshToken(_ token: String)", () => {
      cb.line("state.withLock { $0.refreshToken = token }");
    });
    cb.line();
    cb.block("public func close() async", () => {
      cb.line("let sockets = state.withLock { state in");
      cb.indent();
      cb.line("let sockets = state.sockets");
      cb.line("state.sockets = []");
      cb.line("return sockets");
      cb.dedent();
      cb.line("}");
      cb.block("for socket in sockets", () => {
        cb.line("await socket.disconnect()");
      });
    });

    if (hasChannels) {
      emitSocketHelpers(cb, socketApiKeyHeader);
    }

    if (Object.keys(schemes).length > 0) {
      cb.line();
      cb.line("// ─── Factory constructors (generated from auth schemes) ───");

      if (schemes.secret_key) {
        const header = schemes.secret_key.name ?? "x-archastro-api-key";
        cb.line();
        cb.line(
          `/// ${schemes.secret_key.description ?? "Create a client with a secret API key."}`
        );
        cb.block(
          "public static func withSecretKey(_ key: String, baseUrl: String? = nil) -> PlatformClient",
          () => {
            cb.line("return PlatformClient(");
            cb.indent();
            cb.line(`baseUrl: baseUrl ?? ${swiftString(spec.baseUrl)},`);
            cb.line(`defaultHeaders: [${swiftString(header)}: key]`);
            cb.dedent();
            cb.line(")");
          }
        );
      }

      if (schemes.publishable_key) {
        const header = schemes.publishable_key.name ?? "x-archastro-api-key";
        cb.line();
        cb.line("/// Create a client with a publishable key and pre-existing access token.");
        cb.block(
          "public static func withToken(apiKey: String, accessToken: String, baseUrl: String? = nil) -> PlatformClient",
          () => {
            cb.line("return PlatformClient(");
            cb.indent();
            cb.line(`baseUrl: baseUrl ?? ${swiftString(spec.baseUrl)},`);
            cb.line("accessToken: accessToken,");
            cb.line(`defaultHeaders: [${swiftString(header)}: apiKey]`);
            cb.dedent();
            cb.line(")");
          }
        );
      }

      if (hasAuth && schemes.publishable_key) {
        const loginOp = findLoginOperation(authOps, flows);
        if (loginOp) {
          emitWithCredentials(cb, spec, loginOp, authOps);
        }
      }
    }
  });

  return cb.toString();
}

function emitSocketHelpers(cb: CodeBuilder, apiKeyHeader: string): void {
  cb.line();
  cb.line("// ─── Realtime sockets ───");
  cb.line();
  cb.block("private func apiKey() -> String?", () => {
    cb.block("for (key, value) in defaultHeaders", () => {
      cb.block(
        `if key.lowercased() == ${swiftString(apiKeyHeader)}.lowercased()`,
        () => {
          cb.line("return value");
        }
      );
    });
    cb.line("return nil");
  });
  cb.line();
  cb.block("private func defaultWebSocketURL() -> String", () => {
    cb.line("guard var components = URLComponents(string: baseUrl) else { return baseUrl }");
    cb.block("switch components.scheme", () => {
      cb.line('case "https": components.scheme = "wss"');
      cb.line('case "http": components.scheme = "ws"');
      cb.line("default: break");
    });
    cb.line("var path = components.path");
    cb.line('while path.hasSuffix("/") { path.removeLast() }');
    cb.line('components.path = path + "/socket/api/websocket"');
    cb.line("components.query = nil");
    cb.line("components.fragment = nil");
    cb.line("return components.string ?? baseUrl");
  });
  cb.line();
  cb.line("/// Open a Phoenix socket to the platform, injecting the client's");
  cb.line("/// API key and current access token as connect params.");
  cb.line("public func openSocket(");
  cb.indent();
  cb.line("url: String? = nil,");
  cb.line("params: [String: String] = [:],");
  cb.line("connect: Bool = true,");
  cb.line("heartbeatInterval: TimeInterval = 30,");
  cb.line("timeout: TimeInterval = 10,");
  cb.line("autoReconnect: Bool = true");
  cb.dedent();
  cb.line(") async throws -> Socket {");
  cb.indent();
  cb.line("var socketParams: [String: String] = [:]");
  cb.line("if let apiKey = apiKey() { socketParams[\"api_key\"] = apiKey }");
  cb.line("if let token = http.currentAccessToken() { socketParams[\"token\"] = token }");
  cb.line("for (key, value) in params { socketParams[key] = value }");
  cb.block("if connect && socketParams[\"token\"] == nil", () => {
    cb.line(
      'throw PlatformClientError.missingAccessToken("PlatformClient.openSocket requires an access token")'
    );
  });
  cb.line("let socket = Socket(");
  cb.indent();
  cb.line("url: url ?? defaultWebSocketURL(),");
  cb.line("params: socketParams,");
  cb.line("heartbeatInterval: heartbeatInterval,");
  cb.line("timeout: timeout,");
  cb.line("autoReconnect: autoReconnect");
  cb.dedent();
  cb.line(")");
  cb.block("if connect", () => {
    cb.line("try await socket.connect()");
  });
  cb.line("state.withLock { $0.sockets.append(socket) }");
  cb.line("return socket");
  cb.dedent();
  cb.line("}");
}

function emitWithCredentials(
  cb: CodeBuilder,
  spec: SdkSpec,
  loginOp: OperationDef,
  authOps: OperationDef[]
): void {
  const schemes = spec.auth?.schemes ?? {};
  const header = schemes.publishable_key?.name ?? "x-archastro-api-key";
  const requiredParams = extractSwiftAuthInputParams(loginOp).filter((p) => p.required);
  const sig = requiredParams.map((p) => `${p.name}: String`).join(", ");
  const loginMethod = swiftAuthMethodName(loginOp);
  const loginArgs = requiredParams
    .map((p) => `${p.name}: ${p.name.replace(/`/g, "")}`)
    .join(", ");

  const refreshOp = findRefreshOperation(authOps);
  const refreshMethod = refreshOp ? swiftAuthMethodName(refreshOp) : undefined;
  const refreshParam = refreshOp
    ? extractSwiftAuthInputParams(refreshOp).filter((p) => p.required)[0]
    : undefined;

  cb.line();
  cb.line("/// Create a client by logging in with credentials. Wires automatic");
  cb.line("/// 401 token refresh when the login flow returns a refresh token.");
  cb.block(
    `public static func withCredentials(apiKey: String, ${sig}, baseUrl: String? = nil) async throws -> PlatformClient`,
    () => {
      cb.line("let client = PlatformClient(");
      cb.indent();
      cb.line(`baseUrl: baseUrl ?? ${swiftString(spec.baseUrl)},`);
      cb.line(`defaultHeaders: [${swiftString(header)}: apiKey]`);
      cb.dedent();
      cb.line(")");
      cb.line(`let tokens = try await client.auth.${loginMethod}(${loginArgs})`);
      cb.block("guard let accessToken = tokens.accessToken else", () => {
        cb.line(
          'throw PlatformClientError.loginFailed("Login did not return an access token")'
        );
      });
      cb.line("client.setAccessToken(accessToken)");

      if (refreshMethod && refreshParam) {
        cb.block("if let refreshToken = tokens.refreshToken", () => {
          cb.line("client.setRefreshToken(refreshToken)");
        });
        cb.line("// Refresh runs on a separate refresh-only HTTP client so it");
        cb.line("// can never re-enter the main client's 401 retry.");
        cb.line("let refreshHttp = HttpClient(");
        cb.indent();
        cb.line(`baseUrl: baseUrl ?? ${swiftString(spec.baseUrl)},`);
        cb.line(`defaultHeaders: [${swiftString(header)}: apiKey],`);
        cb.line("refreshOnly: true");
        cb.dedent();
        cb.line(")");
        cb.line("let refreshAuth = AuthClient(http: refreshHttp)");
        cb.line("client.http.setRefreshHandler { [weak client] in");
        cb.indent();
        cb.block("guard let client, let refreshToken = client.refreshToken else", () => {
          cb.line(
            'throw PlatformClientError.refreshFailed("No refresh token available")'
          );
        });
        cb.line(
          `let refreshed = try await refreshAuth.${refreshMethod}(${refreshParam.name}: refreshToken)`
        );
        cb.block("guard let newToken = refreshed.accessToken else", () => {
          cb.line(
            'throw PlatformClientError.refreshFailed("Refresh did not return an access token")'
          );
        });
        cb.line("client.setAccessToken(newToken)");
        cb.block("if let newRefresh = refreshed.refreshToken", () => {
          cb.line("client.setRefreshToken(newRefresh)");
        });
        cb.line("return newToken");
        cb.dedent();
        cb.line("}");
      }
      cb.line("return client");
    }
  );
}

function findLoginOperation(
  authOps: OperationDef[],
  flows: Record<string, unknown>
): OperationDef | undefined {
  const loginFlow = (flows as Record<string, Record<string, unknown>>).login;
  if (loginFlow?.operation_name) {
    const opName = loginFlow.operation_name as string;
    return authOps.find(
      (op) => op.name === opName || op.path.endsWith(`/${opName}`)
    );
  }
  return authOps.find((op) => op.path.includes("/login") && op.method === "POST");
}

function findRefreshOperation(authOps: OperationDef[]): OperationDef | undefined {
  return authOps.find(
    (op) => op.path.includes("/refresh") && op.method === "POST"
  );
}
