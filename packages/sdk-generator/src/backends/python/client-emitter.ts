import type { SdkSpec, OperationDef } from "../../ast/types.js";
import { CodeBuilder, generatedHeaderPython } from "../../utils/codegen.js";
import { snakeCase } from "../../utils/naming.js";
import { pyAuthMethodName } from "./auth-emitter.js";
import { pyVersionClassName } from "./namespace-emitter.js";

export function emitPythonClientFile(spec: SdkSpec): string {
  const cb = new CodeBuilder("    ");

  const authOps = spec.authOperations ?? [];
  const hasAuth = authOps.length > 0;

  for (const line of generatedHeaderPython().trim().split("\n")) { cb.line(line); }
  cb.line();

  if (hasAuth) {
    cb.line("from .auth import AuthClient");
  }
  cb.line("from .runtime.http_client import HttpClient");

  // Import version namespace classes
  for (const versionSet of spec.versions) {
    const cls = pyVersionClassName(versionSet.version);
    cb.line(`from .${versionSet.version} import ${cls}`);
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
        cb.line("self.auth = AuthClient(self._http)");
      }

      // Instantiate version namespaces
      for (const versionSet of spec.versions) {
        const cls = pyVersionClassName(versionSet.version);
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
          // Only required params for the factory constructor
          const requiredParams = getOperationRequiredInputParams(loginOp);
          const sig = requiredParams.map((p) => `${p}: str`).join(", ");

          // Discover token field accessors from the response schema
          const accessTokenField = findSdkField(loginOp, "access_token");
          const refreshTokenField = findSdkField(loginOp, "refresh_token");
          const tokenAccessor = accessTokenField
            ? snakeCase(accessTokenField.sdkRole!)
            : "access_token";
          const refreshAccessor = refreshTokenField
            ? snakeCase(refreshTokenField.sdkRole!)
            : "refresh_token";

          const desc = (flows as Record<string, Record<string, unknown>>).login?.description as string
            ?? loginOp.description ?? "Create a client by logging in";
          const authMethod = pyAuthMethodName(loginOp);

          cb.line();
          cb.line("@classmethod");
          cb.pyBlock(
            `async def with_credentials(cls, api_key: str, ${sig}, base_url: str | None = None) -> "PlatformClient"`,
            () => {
              cb.line(`"""${desc.replace(/[^\x20-\x7E]/g, " ")}"""`);
              cb.line("kwargs = {}");
              cb.pyBlock("if base_url", () => { cb.line('kwargs["base_url"] = base_url'); });
              cb.line(`client = cls(default_headers={"${header}": api_key}, **kwargs)`);
              cb.line(`tokens = await client.auth.${authMethod}(${requiredParams.join(", ")})`);
              cb.pyBlock(`if not tokens.${tokenAccessor}`, () => {
                cb.line(`raise ValueError("Login did not return an access token")`);
              });
              cb.line(`client.set_access_token(tokens.${tokenAccessor})`);
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
              cb.line("refresh_auth = AuthClient(refresh_http)");
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

function getOperationRequiredInputParams(op: OperationDef): string[] {
  const params: string[] = [];
  if (op.body?.fields) {
    for (const f of op.body.fields) {
      if (!f.sdkRole && f.required) {
        params.push(snakeCase(f.name));
      }
    }
  }
  for (const p of op.queryParams) {
    if (p.required) {
      params.push(snakeCase(p.name));
    }
  }
  return params;
}

function findSdkField(
  op: OperationDef,
  role: string
): import("../../ast/types.js").FieldDef | undefined {
  if (op.returnType.kind === "object") {
    return op.returnType.fields.find((f) => f.sdkRole === role);
  }
  return undefined;
}
