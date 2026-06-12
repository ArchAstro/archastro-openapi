import type { FieldDef, OperationDef, SchemaDef, SdkSpec, TypeRef } from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython } from "../../utils/codegen.js";
import { pythonParameterName } from "./identifiers.js";
import { extractPythonAuthInputParams, pyAuthMethodName } from "./auth-emitter.js";
import { pyAsyncVersionClassName, pyVersionClassName } from "./namespace-emitter.js";

export function emitPythonClientFile(spec: SdkSpec): string {
  const cb = new CodeBuilder("    ");

  const authOps = spec.authOperations ?? [];
  const hasAuth = authOps.length > 0;
  const hasChannels = spec.channels.length > 0;
  const socketApiKeyHeader =
    spec.auth?.schemes?.publishable_key?.name ??
    spec.auth?.schemes?.secret_key?.name ??
    "x-archastro-api-key";

  for (const line of generatedHeaderPython().trim().split("\n")) { cb.line(line); }
  cb.line();

  if (hasChannels) {
    cb.line("from urllib.parse import urlparse, urlunparse");
    cb.line();
    cb.line("from archastro.phx_channel import Socket");
  }
  if (hasAuth) {
    cb.line("from .auth import AsyncAuthClient, AuthClient");
  }
  cb.line("from .runtime.http_client import HttpClient, SyncHttpClient");

  // Import version namespace classes
  for (const versionSet of spec.versions) {
    const cls = pyVersionClassName(versionSet.version);
    const asyncCls = pyAsyncVersionClassName(versionSet.version);
    cb.line(`from .${versionSet.version} import ${asyncCls}, ${cls}`);
  }
  cb.line();

  // Collect default version's unique resources for backward-compat aliases
  const defaultVersionSet =
    spec.versions.find((v) => v.version === spec.defaultVersion) ??
    spec.versions[0];
  const seen = new Set<string>();
  const aliasResources = (defaultVersionSet?.resources ?? []).filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });

  cb.pyBlock("class AsyncPlatformClient", () => {
    const initParams = [
      "self", "*",
      `base_url: str = "${spec.baseUrl}"`,
      "access_token: str | None = None",
      "get_access_token=None",
      "on_refresh_token=None",
      "path_prefix: str | None = None",
      "default_headers: dict[str, str] | None = None",
    ];

    cb.pyBlock(`def __init__(${initParams.join(", ")})`, () => {
      cb.line("self._base_url = base_url");
      cb.line("self._access_token = access_token");
      cb.line("self._get_access_token = get_access_token");
      cb.line("self._default_headers = default_headers or {}");
      cb.line("self._http = HttpClient(");
      cb.indent();
      cb.line("base_url=base_url,");
      cb.line("access_token=access_token,");
      cb.line("get_access_token=get_access_token,");
      cb.line("on_refresh_token=on_refresh_token,");
      cb.line("path_prefix=path_prefix,");
      cb.line("default_headers=default_headers,");
      cb.dedent();
      cb.line(")");
      if (hasAuth) {
        cb.line("self.auth = AsyncAuthClient(self._http)");
      }

      // Instantiate version namespaces
      for (const versionSet of spec.versions) {
        const cls = pyAsyncVersionClassName(versionSet.version);
        cb.line(`self.${versionSet.version} = ${cls}(self._http)`);
      }

      // Backward-compat aliases: self.agents = self.v1.agents
      if (defaultVersionSet) {
        for (const resource of aliasResources) {
          cb.line(
            `self.${resource.name} = self.${spec.defaultVersion}.${resource.name}`
          );
        }
      }

      cb.line("self._refresh_token: str | None = None");
      cb.line("self._extra_http_clients: list[HttpClient] = []");
      if (hasChannels) {
        cb.line("self._sockets: list[Socket] = []");
      }
    });

    cb.line();

    cb.line("@property");
    cb.pyBlock("def refresh_token(self) -> str | None", () => {
      cb.line("return self._refresh_token");
    });

    cb.line();

    cb.pyBlock("def set_access_token(self, token: str)", () => {
      cb.line("self._access_token = token");
      cb.line("self._http.set_access_token(token)");
    });

    cb.line();

    cb.pyBlock("def set_refresh_token(self, token: str)", () => {
      cb.line("self._refresh_token = token");
    });

    cb.line();
    cb.pyBlock("async def __aenter__(self)", () => {
      cb.line("return self");
    });

    cb.line();
    cb.pyBlock("async def __aexit__(self, exc_type, exc, tb)", () => {
      cb.line("await self.close()");
    });

    cb.line();
    cb.pyBlock("async def close(self)", () => {
      cb.pyBlock("try", () => {
        if (hasChannels) {
          cb.pyBlock("try", () => {
            cb.pyBlock("for socket in self._sockets", () => {
              cb.line("await socket.disconnect()");
            });
          });
          cb.pyBlock("finally", () => {
            cb.line("self._sockets.clear()");
          });
        }
        cb.line("await self._http.close()");
      });
      cb.pyBlock("finally", () => {
        cb.pyBlock("for http in self._extra_http_clients", () => {
          cb.line("await http.close()");
        });
        cb.line("self._extra_http_clients.clear()");
      });
    });

    if (hasChannels) {
      cb.line();
      cb.pyBlock("def _current_access_token(self) -> str | None", () => {
        cb.pyBlock("if self._get_access_token", () => {
          cb.line("return self._get_access_token()");
        });
        cb.line("return self._access_token");
      });

      cb.line();
      cb.pyBlock("def _api_key(self) -> str | None", () => {
        cb.pyBlock("for key, value in self._default_headers.items()", () => {
          cb.pyBlock(`if key.lower() == "${socketApiKeyHeader}".lower()`, () => {
            cb.line("return value");
          });
        });
        cb.line("return None");
      });

      cb.line();
      cb.pyBlock("def _socket_params(self, params: dict[str, str] | None = None) -> dict[str, str]", () => {
        cb.line("socket_params: dict[str, str] = {}");
        cb.line("api_key = self._api_key()");
        cb.pyBlock("if api_key", () => {
          cb.line('socket_params["api_key"] = api_key');
        });
        cb.line("token = self._current_access_token()");
        cb.pyBlock("if token", () => {
          cb.line('socket_params["token"] = token');
        });
        cb.pyBlock("if params", () => {
          cb.line("socket_params.update(params)");
        });
        cb.line("return socket_params");
      });

      cb.line();
      cb.pyBlock("def _default_websocket_url(self) -> str", () => {
        cb.line("parsed = urlparse(self._base_url)");
        cb.line('scheme = "wss" if parsed.scheme == "https" else "ws" if parsed.scheme == "http" else parsed.scheme');
        cb.line('path = parsed.path.rstrip("/") + "/socket/api/websocket"');
        cb.line('return urlunparse(parsed._replace(scheme=scheme, path=path, params="", query="", fragment=""))');
      });

      cb.line();
      cb.pyBlock(
        [
          "async def open_socket(",
          "self,",
          "*,",
          "url: str | None = None,",
          "params: dict[str, str] | None = None,",
          "connect: bool = True,",
          "heartbeat_interval: float = 30,",
          "timeout: float = 10,",
          "reconnect_backoff_ms: list[int] | None = None,",
          "auto_reconnect: bool = True,",
          ") -> Socket",
        ].join(" "),
        () => {
          cb.line("socket_params = self._socket_params(params)");
          cb.pyBlock('if connect and not socket_params.get("token")', () => {
            cb.line('raise ValueError("AsyncPlatformClient.open_socket requires an access token")');
          });
          cb.line("socket = Socket(url or self._default_websocket_url(),");
          cb.indent();
          cb.line("params=socket_params,");
          cb.line("heartbeat_interval=heartbeat_interval,");
          cb.line("timeout=timeout,");
          cb.line("reconnect_backoff_ms=reconnect_backoff_ms,");
          cb.line("auto_reconnect=auto_reconnect,");
          cb.dedent();
          cb.line(")");
          cb.pyBlock("if connect", () => {
            cb.line("await socket.connect()");
            cb.pyBlock("if not socket.is_connected", () => {
              cb.line('raise ConnectionError("WebSocket connection failed")');
            });
          });
          cb.line("self._sockets.append(socket)");
          cb.line("return socket");
        }
      );
    }

    const schemes = spec.auth?.schemes ?? {};
    const flows = spec.auth?.tokenFlows ?? {};

    if (Object.keys(schemes).length > 0) {
      cb.line();
      cb.line("# ─── Factory constructors (generated from auth schemes) ───");

      if (schemes.secret_key) {
        const header = schemes.secret_key.name ?? "x-archastro-api-key";
        cb.line();
        cb.line("@classmethod");
        cb.pyBlock(
          `def with_secret_key(cls, key: str, base_url: str | None = None) -> "AsyncPlatformClient"`,
          () => {
            cb.line(`"""${schemes.secret_key.description ?? "Create a client with a secret API key"}"""`);
            cb.line("kwargs = {}");
            cb.pyBlock("if base_url", () => { cb.line('kwargs["base_url"] = base_url'); });
            cb.line(`return cls(default_headers={"${header}": key}, **kwargs)`);
          }
        );
      }

      if (schemes.publishable_key) {
        const header = schemes.publishable_key.name ?? "x-archastro-api-key";
        cb.line();
        cb.line("@classmethod");
        cb.pyBlock(
          `def with_token(cls, api_key: str, access_token: str, base_url: str | None = None) -> "AsyncPlatformClient"`,
          () => {
            cb.line('"""Create a client with a publishable key and pre-existing access token."""');
            cb.line("kwargs = {}");
            cb.pyBlock("if base_url", () => { cb.line('kwargs["base_url"] = base_url'); });
            cb.line(`return cls(access_token=access_token, default_headers={"${header}": api_key}, **kwargs)`);
          }
        );
      }

      if (hasAuth && schemes.publishable_key) {
        const loginOp = findLoginOperation(authOps, flows);
        if (loginOp) {
          const header = schemes.publishable_key.name ?? "x-archastro-api-key";
          // Only required params for the factory constructor
          const requiredParams = getOperationRequiredInputParams(loginOp);
          const sig = requiredParams.map((p) => `${p.name}: str`).join(", ");

          // Discover token field accessors from the response schema
          const accessTokenField = findSdkField(loginOp, "access_token", spec.schemas);
          const refreshTokenField = findSdkField(loginOp, "refresh_token", spec.schemas);
          const tokenAccessor = accessTokenField
            ? pythonParameterName(accessTokenField.sdkRole!)
            : "access_token";
          const refreshAccessor = refreshTokenField
            ? pythonParameterName(refreshTokenField.sdkRole!)
            : "refresh_token";

          const desc = (flows as Record<string, Record<string, unknown>>).login?.description as string
            ?? loginOp.description ?? "Create a client by logging in";
          const authMethod = pyAuthMethodName(loginOp);

          cb.line();
          cb.line("@classmethod");
          cb.pyBlock(
            `async def with_credentials(cls, api_key: str, ${sig}, base_url: str | None = None) -> "AsyncPlatformClient"`,
            () => {
              cb.line(`"""${desc.replace(/[^\x20-\x7E]/g, " ")}"""`);
              cb.line("kwargs = {}");
              cb.pyBlock("if base_url", () => { cb.line('kwargs["base_url"] = base_url'); });
              cb.line(`client = cls(default_headers={"${header}": api_key}, **kwargs)`);
              cb.line(
                `tokens = await client.auth.${authMethod}(${requiredParams.map((p) => p.name).join(", ")})`
              );
              cb.pyBlock(`if not tokens.${tokenAccessor}`, () => {
                cb.line(`raise ValueError("Login did not return an access token")`);
              });
              cb.line(`client.set_access_token(tokens.${tokenAccessor})`);
              if (refreshTokenField) {
                cb.pyBlock(`if tokens.${refreshAccessor}`, () => {
                  cb.line(`client.set_refresh_token(tokens.${refreshAccessor})`);
                });
                // Separate refresh-only HttpClient: cannot re-enter the main
                // client's 401 retry, so concurrent dedup is deadlock-free.
                cb.line("refresh_http = HttpClient(");
                cb.indent();
                cb.line(`base_url=base_url or "${spec.baseUrl}",`);
                cb.line(`default_headers={"${header}": api_key},`);
                cb.line("refresh_only=True,");
                cb.dedent();
                cb.line(")");
                cb.line("client._extra_http_clients.append(refresh_http)");
                cb.line("refresh_auth = AsyncAuthClient(refresh_http)");
                cb.line();
                cb.pyBlock("async def _refresh() -> str", () => {
                  cb.line("rt = client.refresh_token");
                  cb.pyBlock("if not rt", () => {
                    cb.line('raise ValueError("No refresh token available")');
                  });
                  cb.line("refreshed = await refresh_auth.refresh(rt)");
                  cb.pyBlock(`if not refreshed.${tokenAccessor}`, () => {
                    cb.line('raise ValueError("Refresh did not return an access token")');
                  });
                  cb.line(`client.set_access_token(refreshed.${tokenAccessor})`);
                  cb.pyBlock(`if refreshed.${refreshAccessor}`, () => {
                    cb.line(`client.set_refresh_token(refreshed.${refreshAccessor})`);
                  });
                  cb.line(`return refreshed.${tokenAccessor}`);
                });
                cb.line();
                cb.line("client._http.set_refresh_handler(_refresh)");
              }
              cb.line("return client");
            }
          );
        }
      }
    }
  });
  cb.line();
  cb.pyBlock("class PlatformClient", () => {
    const initParams = [
      "self", "*",
      `base_url: str = "${spec.baseUrl}"`,
      "access_token: str | None = None",
      "get_access_token=None",
      "on_refresh_token=None",
      "path_prefix: str | None = None",
      "default_headers: dict[str, str] | None = None",
    ];

    cb.pyBlock(`def __init__(${initParams.join(", ")})`, () => {
      cb.line("self._closed = False");
      cb.line("self._http = SyncHttpClient(");
      cb.indent();
      cb.line("base_url=base_url,");
      cb.line("access_token=access_token,");
      cb.line("get_access_token=get_access_token,");
      cb.line("on_refresh_token=on_refresh_token,");
      cb.line("path_prefix=path_prefix,");
      cb.line("default_headers=default_headers,");
      cb.dedent();
      cb.line(")");
      if (hasAuth) {
        cb.line("self.auth = AuthClient(self._http)");
      }
      for (const versionSet of spec.versions) {
        const cls = pyVersionClassName(versionSet.version);
        cb.line(`self.${versionSet.version} = ${cls}(self._http)`);
      }
      if (defaultVersionSet) {
        for (const resource of aliasResources) {
          cb.line(
            `self.${resource.name} = self.${spec.defaultVersion}.${resource.name}`
          );
        }
      }
      cb.line("self._refresh_token: str | None = None");
      cb.line("self._extra_http_clients: list[SyncHttpClient] = []");
    });

    cb.line();
    cb.line("@property");
    cb.pyBlock("def refresh_token(self) -> str | None", () => {
      cb.line("return self._refresh_token");
    });

    cb.line();
    cb.pyBlock("def set_access_token(self, token: str)", () => {
      cb.line("self._http.set_access_token(token)");
    });

    cb.line();
    cb.pyBlock("def set_refresh_token(self, token: str)", () => {
      cb.line("self._refresh_token = token");
    });

    cb.line();
    cb.pyBlock("def __enter__(self)", () => {
      cb.line("return self");
    });

    cb.line();
    cb.pyBlock("def __exit__(self, exc_type, exc, tb)", () => {
      cb.line("self.close()");
    });

    cb.line();
    cb.pyBlock("def close(self)", () => {
      cb.pyBlock("if self._closed", () => {
        cb.line("return");
      });
      cb.line("self._closed = True");
      cb.pyBlock("try", () => {
        cb.line("self._http.close()");
      });
      cb.pyBlock("finally", () => {
        cb.pyBlock("for http in self._extra_http_clients", () => {
          cb.line("http.close()");
        });
        cb.line("self._extra_http_clients.clear()");
      });
    });

    const schemes = spec.auth?.schemes ?? {};
    const flows = spec.auth?.tokenFlows ?? {};

    if (Object.keys(schemes).length > 0) {
      cb.line();
      cb.line("# ─── Factory constructors (generated from auth schemes) ───");

      if (schemes.secret_key) {
        const header = schemes.secret_key.name ?? "x-archastro-api-key";
        cb.line();
        cb.line("@classmethod");
        cb.pyBlock(
          `def with_secret_key(cls, key: str, base_url: str | None = None) -> "PlatformClient"`,
          () => {
            cb.line(`"""${schemes.secret_key.description ?? "Create a client with a secret API key"}"""`);
            cb.line("kwargs = {}");
            cb.pyBlock("if base_url", () => { cb.line('kwargs["base_url"] = base_url'); });
            cb.line(`return cls(default_headers={"${header}": key}, **kwargs)`);
          }
        );
      }

      if (schemes.publishable_key) {
        const header = schemes.publishable_key.name ?? "x-archastro-api-key";
        cb.line();
        cb.line("@classmethod");
        cb.pyBlock(
          `def with_token(cls, api_key: str, access_token: str, base_url: str | None = None) -> "PlatformClient"`,
          () => {
            cb.line('"""Create a client with a publishable key and pre-existing access token."""');
            cb.line("kwargs = {}");
            cb.pyBlock("if base_url", () => { cb.line('kwargs["base_url"] = base_url'); });
            cb.line(`return cls(access_token=access_token, default_headers={"${header}": api_key}, **kwargs)`);
          }
        );
      }

      if (hasAuth && schemes.publishable_key) {
        const loginOp = findLoginOperation(authOps, flows);
        if (loginOp) {
          const header = schemes.publishable_key.name ?? "x-archastro-api-key";
          const requiredParams = getOperationRequiredInputParams(loginOp);
          const sig = requiredParams.map((p) => `${p.name}: str`).join(", ");
          const accessTokenField = findSdkField(loginOp, "access_token", spec.schemas);
          const refreshTokenField = findSdkField(loginOp, "refresh_token", spec.schemas);
          const tokenAccessor = accessTokenField
            ? pythonParameterName(accessTokenField.sdkRole!)
            : "access_token";
          const refreshAccessor = refreshTokenField
            ? pythonParameterName(refreshTokenField.sdkRole!)
            : "refresh_token";
          const authMethod = pyAuthMethodName(loginOp);

          cb.line();
          cb.line("@classmethod");
          cb.pyBlock(
            `def with_credentials(cls, api_key: str, ${sig}, base_url: str | None = None) -> "PlatformClient"`,
            () => {
              cb.line("kwargs = {}");
              cb.pyBlock("if base_url", () => { cb.line('kwargs["base_url"] = base_url'); });
              cb.line(`client = cls(default_headers={"${header}": api_key}, **kwargs)`);
              cb.line(
                `tokens = client.auth.${authMethod}(${requiredParams.map((p) => p.name).join(", ")})`
              );
              cb.pyBlock(`if not tokens.${tokenAccessor}`, () => {
                cb.line(`raise ValueError("Login did not return an access token")`);
              });
              cb.line(`client.set_access_token(tokens.${tokenAccessor})`);
              if (refreshTokenField) {
                cb.pyBlock(`if tokens.${refreshAccessor}`, () => {
                  cb.line(`client.set_refresh_token(tokens.${refreshAccessor})`);
                });
                cb.line("refresh_http = SyncHttpClient(");
                cb.indent();
                cb.line(`base_url=base_url or "${spec.baseUrl}",`);
                cb.line(`default_headers={"${header}": api_key},`);
                cb.line("refresh_only=True,");
                cb.dedent();
                cb.line(")");
                cb.line("client._extra_http_clients.append(refresh_http)");
                cb.line("refresh_auth = AuthClient(refresh_http)");
                cb.line();
                cb.pyBlock("def _refresh() -> str", () => {
                  cb.line("rt = client.refresh_token");
                  cb.pyBlock("if not rt", () => {
                    cb.line('raise ValueError("No refresh token available")');
                  });
                  cb.line("refreshed = refresh_auth.refresh(rt)");
                  cb.pyBlock(`if not refreshed.${tokenAccessor}`, () => {
                    cb.line('raise ValueError("Refresh did not return an access token")');
                  });
                  cb.line(`client.set_access_token(refreshed.${tokenAccessor})`);
                  cb.pyBlock(`if refreshed.${refreshAccessor}`, () => {
                    cb.line(`client.set_refresh_token(refreshed.${refreshAccessor})`);
                  });
                  cb.line(`return refreshed.${tokenAccessor}`);
                });
                cb.line();
                cb.line("client._http.set_refresh_handler(_refresh)");
              }
              cb.line("return client");
            }
          );
        }
      }
    }
  });

  return cb.toString();
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
  return authOps.find(
    (op) => op.path.includes("/login") && op.method === "POST"
  );
}

function getOperationRequiredInputParams(
  op: OperationDef
): ReturnType<typeof extractPythonAuthInputParams> {
  return extractPythonAuthInputParams(op).filter((param) => param.required);
}

function findSdkField(
  op: OperationDef,
  role: string,
  schemas: SchemaDef[]
): FieldDef | undefined {
  return findSdkFieldInType(op.returnType, role, schemas, new Set());
}

function findSdkFieldInType(
  typeRef: TypeRef,
  role: string,
  schemas: SchemaDef[],
  seenSchemas: Set<string>
): FieldDef | undefined {
  if (typeRef.kind === "object") {
    return typeRef.fields.find((f) => f.sdkRole === role);
  }
  if (typeRef.kind === "ref") {
    if (seenSchemas.has(typeRef.schema)) return undefined;
    seenSchemas.add(typeRef.schema);
    const schema = schemas.find((candidate) => candidate.name === typeRef.schema);
    if (!schema) return undefined;
    return schema.fields.find((f) => f.sdkRole === role);
  }
  if (typeRef.kind === "optional") {
    return findSdkFieldInType(typeRef.inner, role, schemas, seenSchemas);
  }
  return undefined;
}
