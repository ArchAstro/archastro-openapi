import type { OperationDef, SdkSpec } from "../../ast/types.js";
import { CodeBuilder } from "../../utils/codegen.js";
import { goString, uniqueGoFieldNames } from "./identifiers.js";
import { emitPlainDocComment } from "./model-emitter.js";
import { buildAuthMethodNames, extractGoAuthInputParams } from "./auth-emitter.js";
import { goVersionStructName, uniqueVersionResources } from "./namespace-emitter.js";
import { renderGoFile } from "./type-map.js";

/** Phoenix socket endpoint the platform serves. */
const SOCKET_PATH = "/socket/api/websocket";

/** Members `Client` already owns; alias accessors never take these names. */
const CLIENT_RESERVED = [
  "HTTP",
  "Auth",
  "Close",
  "OpenSocket",
  "RefreshToken",
  "SetAccessToken",
  "SetRefreshToken",
];

/**
 * Generate the Go `Client`: constructor, version namespaces, default-version
 * alias accessors, auth factory constructors, and the socket helper.
 */
export function emitGoClientFile(packageName: string, spec: SdkSpec): string {
  const cb = new CodeBuilder("\t");
  const imports = new Set<string>(["sync"]);

  const authOps = spec.authOperations ?? [];
  const hasAuth = authOps.length > 0;
  const hasChannels = spec.channels.length > 0;
  const schemes = spec.auth?.schemes ?? {};
  const flows = spec.auth?.tokenFlows ?? {};
  const socketApiKeyHeader =
    schemes.publishable_key?.name ?? schemes.secret_key?.name ?? "x-archastro-api-key";

  const defaultVersionSet =
    spec.versions.find((v) => v.version === spec.defaultVersion) ?? spec.versions[0];
  const aliasResources = defaultVersionSet
    ? uniqueVersionResources(defaultVersionSet)
    : [];
  const versionFields = spec.versions.map((v) => goVersionStructName(v.version));
  const aliasNames = uniqueGoFieldNames(
    aliasResources.map((r) => r.name),
    [...CLIENT_RESERVED, ...versionFields]
  );
  // Resource field names inside the default version namespace.
  const defaultVersionFields = defaultVersionSet
    ? uniqueGoFieldNames(uniqueVersionResources(defaultVersionSet).map((r) => r.name))
    : [];

  emitPlainDocComment(
    cb,
    "Client: entry point for the platform API. Configure it with an API key\n" +
      "and/or an access token, then reach resources through the version\n" +
      "namespaces (client.V1.Agents) or the default-version accessors\n" +
      "(client.Agents())."
  );
  cb.block("type Client struct", () => {
    cb.line("// HTTP is the shared transport every resource issues requests through.");
    cb.line("HTTP *HTTPClient");
    if (hasAuth) cb.line("Auth *AuthClient");
    for (let i = 0; i < spec.versions.length; i++) {
      cb.line(`${versionFields[i]} *${versionFields[i]}`);
    }
    cb.line();
    cb.line("baseURL        string");
    cb.line("defaultHeaders map[string]string");
    cb.line();
    cb.line("mu           sync.Mutex");
    cb.line("refreshToken string");
    cb.line("sockets      []*Socket");
  });
  cb.line();

  emitPlainDocComment(
    cb,
    `NewClient: build a client. Without options it targets ${spec.baseUrl}.`
  );
  cb.block("func NewClient(opts ...ClientOption) *Client", () => {
    cb.line(`cfg := newClientConfig(${goString(spec.baseUrl)})`);
    cb.block("for _, opt := range opts", () => {
      cb.line("opt(cfg)");
    });
    cb.line("c := &Client{");
    cb.indent();
    cb.line("HTTP:           newHTTPClient(cfg),");
    cb.line("baseURL:        cfg.BaseURL,");
    cb.line("defaultHeaders: cfg.DefaultHeaders,");
    cb.dedent();
    cb.line("}");
    if (hasAuth) cb.line("c.Auth = newAuthClient(c.HTTP)");
    for (const field of versionFields) {
      cb.line(`c.${field} = new${field}(c.HTTP)`);
    }
    cb.line("return c");
  });

  // Default-version aliases.
  for (let i = 0; i < aliasResources.length; i++) {
    const resource = aliasResources[i]!;
    cb.line();
    emitPlainDocComment(
      cb,
      `${aliasNames[i]}: default-version alias for Client.${goVersionStructName(spec.defaultVersion)}.${defaultVersionFields[i]}.`
    );
    cb.block(
      `func (c *Client) ${aliasNames[i]}() *${resource.className}`,
      () => {
        cb.line(
          `return c.${goVersionStructName(spec.defaultVersion)}.${defaultVersionFields[i]}`
        );
      }
    );
  }

  // Token + lifecycle management.
  cb.line();
  emitPlainDocComment(cb, "SetAccessToken: replace the bearer token sent on every request.");
  cb.block("func (c *Client) SetAccessToken(token string)", () => {
    cb.line("c.HTTP.SetAccessToken(token)");
  });
  cb.line();
  emitPlainDocComment(cb, "SetRefreshToken: store the refresh token used by automatic 401 retry.");
  cb.block("func (c *Client) SetRefreshToken(token string)", () => {
    cb.line("c.mu.Lock()");
    cb.line("defer c.mu.Unlock()");
    cb.line("c.refreshToken = token");
  });
  cb.line();
  emitPlainDocComment(cb, "RefreshToken: the refresh token captured at login, if any.");
  cb.block("func (c *Client) RefreshToken() string", () => {
    cb.line("c.mu.Lock()");
    cb.line("defer c.mu.Unlock()");
    cb.line("return c.refreshToken");
  });
  cb.line();
  emitPlainDocComment(cb, "Close: disconnect every socket this client opened.");
  cb.block("func (c *Client) Close() error", () => {
    cb.line("c.mu.Lock()");
    cb.line("sockets := c.sockets");
    cb.line("c.sockets = nil");
    cb.line("c.mu.Unlock()");
    cb.line("var firstErr error");
    cb.block("for _, socket := range sockets", () => {
      cb.block("if err := socket.Close(); err != nil && firstErr == nil", () => {
        cb.line("firstErr = err");
      });
    });
    cb.line("return firstErr");
  });

  if (hasChannels) {
    imports.add("context");
    imports.add("strings");
    emitSocketHelpers(cb, socketApiKeyHeader);
  }

  if (schemes.secret_key) {
    const header = schemes.secret_key.name ?? "x-archastro-api-key";
    cb.line();
    emitPlainDocComment(
      cb,
      `NewClientWithSecretKey: ${schemes.secret_key.description ?? "build a client authenticated by a secret API key."}`
    );
    cb.block(
      "func NewClientWithSecretKey(key string, opts ...ClientOption) *Client",
      () => {
        cb.line("base := []ClientOption{");
        cb.indent();
        cb.line(`WithDefaultHeaders(map[string]string{${goString(header)}: key}),`);
        cb.dedent();
        cb.line("}");
        cb.line("return NewClient(append(base, opts...)...)");
      }
    );
  }

  if (schemes.publishable_key) {
    const header = schemes.publishable_key.name ?? "x-archastro-api-key";
    cb.line();
    emitPlainDocComment(
      cb,
      "NewClientWithToken: build a client from a publishable key plus an existing access token."
    );
    cb.block(
      "func NewClientWithToken(apiKey string, accessToken string, opts ...ClientOption) *Client",
      () => {
        cb.line("base := []ClientOption{");
        cb.indent();
        cb.line(`WithDefaultHeaders(map[string]string{${goString(header)}: apiKey}),`);
        cb.line("WithAccessToken(accessToken),");
        cb.dedent();
        cb.line("}");
        cb.line("return NewClient(append(base, opts...)...)");
      }
    );
  }

  if (hasAuth && schemes.publishable_key) {
    const loginOp = findLoginOperation(authOps, flows);
    if (loginOp) {
      imports.add("context");
      emitWithCredentials(cb, spec, loginOp, authOps);
    }
  }

  return renderGoFile(packageName, [...imports], cb.toString());
}

function emitSocketHelpers(cb: CodeBuilder, apiKeyHeader: string): void {
  cb.line();
  cb.block("func (c *Client) apiKey() string", () => {
    cb.block("for key, value := range c.defaultHeaders", () => {
      cb.block(`if strings.EqualFold(key, ${goString(apiKeyHeader)})`, () => {
        cb.line("return value");
      });
    });
    cb.line('return ""');
  });
  cb.line();
  emitPlainDocComment(
    cb,
    "OpenSocket: open a Phoenix socket to the platform, injecting the\n" +
      "client's API key and current access token as connect params. The\n" +
      "returned socket is closed by Client.Close."
  );
  cb.block(
    "func (c *Client) OpenSocket(ctx context.Context, opts ...SocketOption) (*Socket, error)",
    () => {
      cb.line("params := map[string]string{}");
      cb.block('if key := c.apiKey(); key != ""', () => {
        cb.line('params["api_key"] = key');
      });
      cb.block('if token := c.HTTP.AccessToken(); token != ""', () => {
        cb.line('params["token"] = token');
      });
      cb.block('if params["token"] == ""', () => {
        cb.line("return nil, ErrMissingAccessToken");
      });
      cb.line("base := []SocketOption{WithSocketParams(params)}");
      cb.line(
        `socket := NewSocket(websocketURL(c.baseURL, ${goString(SOCKET_PATH)}), append(base, opts...)...)`
      );
      cb.block("if err := socket.Connect(ctx); err != nil", () => {
        cb.line("return nil, err");
      });
      cb.line("c.mu.Lock()");
      cb.line("c.sockets = append(c.sockets, socket)");
      cb.line("c.mu.Unlock()");
      cb.line("return socket, nil");
    }
  );
}

function emitWithCredentials(
  cb: CodeBuilder,
  spec: SdkSpec,
  loginOp: OperationDef,
  authOps: OperationDef[]
): void {
  const schemes = spec.auth?.schemes ?? {};
  const header = schemes.publishable_key?.name ?? "x-archastro-api-key";
  const methodNames = buildAuthMethodNames(authOps);
  const loginMethod = methodNames[authOps.indexOf(loginOp)]!;
  const loginParams = extractGoAuthInputParams(loginOp).filter((p) => p.required);

  const refreshOp = findRefreshOperation(authOps);
  const refreshMethod = refreshOp ? methodNames[authOps.indexOf(refreshOp)] : undefined;
  const refreshParam = refreshOp
    ? extractGoAuthInputParams(refreshOp).filter((p) => p.required)[0]
    : undefined;

  const sig = ["ctx context.Context", "apiKey string"];
  for (const p of loginParams) sig.push(`${p.name} string`);
  sig.push("opts ...ClientOption");

  cb.line();
  emitPlainDocComment(
    cb,
    "NewClientWithCredentials: log in with credentials and return a ready\n" +
      "client. When the login flow yields a refresh token, automatic 401\n" +
      "token refresh is wired up."
  );
  cb.block(
    `func NewClientWithCredentials(${sig.join(", ")}) (*Client, error)`,
    () => {
      cb.line("base := []ClientOption{");
      cb.indent();
      cb.line(`WithDefaultHeaders(map[string]string{${goString(header)}: apiKey}),`);
      cb.dedent();
      cb.line("}");
      cb.line("client := NewClient(append(base, opts...)...)");
      cb.line(
        `tokens, err := client.Auth.${loginMethod}(ctx, ${loginParams.map((p) => p.name).join(", ")})`
      );
      cb.block("if err != nil", () => {
        cb.line("return nil, err");
      });
      cb.block('if tokens.AccessToken == ""', () => {
        cb.line("return nil, ErrLoginFailed");
      });
      cb.line("client.SetAccessToken(tokens.AccessToken)");

      if (refreshMethod && refreshParam) {
        cb.block('if tokens.RefreshToken != ""', () => {
          cb.line("client.SetRefreshToken(tokens.RefreshToken)");
        });
        cb.line("// Refresh runs on a separate refresh-only client so it can");
        cb.line("// never re-enter the main client's 401 retry.");
        cb.line("refreshBase := []ClientOption{");
        cb.indent();
        cb.line("WithBaseURL(client.baseURL),");
        cb.line(`WithDefaultHeaders(map[string]string{${goString(header)}: apiKey}),`);
        cb.line("withRefreshOnly(),");
        cb.dedent();
        cb.line("}");
        cb.line("refreshClient := NewClient(append(refreshBase, opts...)...)");
        cb.line(
          "client.HTTP.SetRefreshHandler(func(ctx context.Context) (string, error) {"
        );
        cb.indent();
        cb.line("current := client.RefreshToken()");
        cb.block('if current == ""', () => {
          cb.line('return "", ErrRefreshFailed');
        });
        cb.line(
          `refreshed, err := refreshClient.Auth.${refreshMethod}(ctx, current)`
        );
        cb.block("if err != nil", () => {
          cb.line('return "", err');
        });
        cb.block('if refreshed.AccessToken == ""', () => {
          cb.line('return "", ErrRefreshFailed');
        });
        cb.line("client.SetAccessToken(refreshed.AccessToken)");
        cb.block('if refreshed.RefreshToken != ""', () => {
          cb.line("client.SetRefreshToken(refreshed.RefreshToken)");
        });
        cb.line("return refreshed.AccessToken, nil");
        cb.dedent();
        cb.line("})");
      }
      cb.line("return client, nil");
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
    return authOps.find((op) => op.name === opName || op.path.endsWith(`/${opName}`));
  }
  return authOps.find((op) => op.path.includes("/login") && op.method === "POST");
}

function findRefreshOperation(authOps: OperationDef[]): OperationDef | undefined {
  return authOps.find((op) => op.path.includes("/refresh") && op.method === "POST");
}
