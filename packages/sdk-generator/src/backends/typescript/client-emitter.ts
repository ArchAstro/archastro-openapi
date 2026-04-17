import type { SdkSpec, OperationDef } from "../../ast/types.js";
import { CodeBuilder, ImportTracker, generatedHeader } from "../../utils/codegen.js";
import { camelCase } from "../../utils/naming.js";
import { authMethodName } from "./auth-emitter.js";
import { versionClassName } from "./namespace-emitter.js";

export function emitClientFile(spec: SdkSpec): string {
  const cb = new CodeBuilder();
  const imports = new ImportTracker();

  imports.add("./runtime/http-client.js", "HttpClient");
  imports.addType("./runtime/http-client.js", "HttpClientConfig");

  const authOps = spec.authOperations ?? [];
  const hasAuth = authOps.length > 0;
  if (hasAuth) {
    imports.add("./auth.js", "AuthClient");
  }

  // Import version namespace classes
  for (const versionSet of spec.versions) {
    const cls = versionClassName(versionSet.version);
    imports.add(`./${versionSet.version}.js`, cls);
  }

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

  // Import resource types for backward-compat alias type annotations
  if (defaultVersionSet) {
    for (const resource of aliasResources) {
      imports.addType(
        `./${defaultVersionSet.version}/resources/${resource.name}.js`,
        resource.className
      );
    }
  }

  cb.line(generatedHeader());
  cb.line(imports.emit());

  cb.block("export interface PlatformClientConfig", () => {
    cb.line("baseUrl?: string;");
    cb.line("accessToken?: string;");
    cb.line("getAccessToken?: () => string | undefined;");
    cb.line("onRefreshToken?: () => Promise<string>;");
    cb.line("pathPrefix?: string;");
    cb.line("defaultHeaders?: Record<string, string>;");
  });
  cb.line();

  cb.block("export class PlatformClient", () => {
    cb.line("readonly http: HttpClient;");
    if (hasAuth) {
      cb.line("readonly auth: AuthClient;");
    }

    // Version namespace properties
    for (const versionSet of spec.versions) {
      const cls = versionClassName(versionSet.version);
      cb.line(`readonly ${versionSet.version}: ${cls};`);
    }

    // Backward-compat aliases (typed with the resource classes from the namespace)
    if (defaultVersionSet) {
      for (const resource of aliasResources) {
        cb.line(`readonly ${resource.name}: ${resource.className};`);
      }
    }

    cb.line();

    cb.block("constructor(config: PlatformClientConfig = {})", () => {
      cb.line("const httpConfig: HttpClientConfig = {");
      cb.indent();
      cb.line(`baseUrl: config.baseUrl ?? "${spec.baseUrl}",`);
      cb.line("accessToken: config.accessToken,");
      cb.line("getAccessToken: config.getAccessToken,");
      cb.line("onRefreshToken: config.onRefreshToken,");
      cb.line("pathPrefix: config.pathPrefix,");
      cb.line("defaultHeaders: config.defaultHeaders,");
      cb.dedent();
      cb.line("};");
      cb.line();
      cb.line("this.http = new HttpClient(httpConfig);");
      if (hasAuth) {
        cb.line("this.auth = new AuthClient(this.http);");
      }

      // Instantiate version namespaces
      for (const versionSet of spec.versions) {
        const cls = versionClassName(versionSet.version);
        cb.line(`this.${versionSet.version} = new ${cls}(this.http);`);
      }

      // Backward-compat aliases: client.agents = client.v1.agents
      if (defaultVersionSet) {
        for (const resource of aliasResources) {
          cb.line(
            `this.${resource.name} = this.${spec.defaultVersion}.${resource.name};`
          );
        }
      }
    });

    cb.line();

    cb.line();
    cb.line("private _refreshToken?: string;");
    cb.line();

    cb.block("get refreshToken(): string | undefined", () => {
      cb.line("return this._refreshToken;");
    });

    cb.line();

    cb.block("setAccessToken(token: string)", () => {
      cb.line("this.http.setAccessToken(token);");
    });

    cb.line();

    cb.block("setRefreshToken(token: string)", () => {
      cb.line("this._refreshToken = token;");
    });

    // Factory constructors — generated from auth schemes
    const schemes = spec.auth?.schemes ?? {};
    const flows = spec.auth?.tokenFlows ?? {};

    if (Object.keys(schemes).length > 0) {
      cb.line();
      cb.line("// ─── Factory constructors (generated from auth schemes) ───");

      // withSecretKey — from secret_key scheme
      if (schemes.secret_key) {
        const header = schemes.secret_key.name ?? "x-archastro-api-key";
        cb.line();
        cb.line(`/** ${schemes.secret_key.description ?? "Create a client with a secret API key"} */`);
        cb.block(
          `static withSecretKey(key: string, baseUrl?: string): PlatformClient`,
          () => {
            cb.line("return new PlatformClient({");
            cb.indent();
            cb.line("baseUrl,");
            cb.line(`defaultHeaders: { "${header}": key },`);
            cb.dedent();
            cb.line("});");
          }
        );
      }

      // withToken — from publishable_key scheme
      if (schemes.publishable_key) {
        const header = schemes.publishable_key.name ?? "x-archastro-api-key";
        cb.line();
        cb.line("/** Create a client with a publishable key and pre-existing access token. */");
        cb.block(
          `static withToken(apiKey: string, accessToken: string, baseUrl?: string): PlatformClient`,
          () => {
            cb.line("return new PlatformClient({");
            cb.indent();
            cb.line("baseUrl,");
            cb.line("accessToken,");
            cb.line(`defaultHeaders: { "${header}": apiKey },`);
            cb.dedent();
            cb.line("});");
          }
        );
      }

      // withCredentials — find the login operation from auth-tagged ops and
      // use its actual params for the constructor signature
      if (hasAuth && schemes.publishable_key) {
        const loginOp = findLoginOperation(authOps, flows);
        if (loginOp) {
          const header = schemes.publishable_key.name ?? "x-archastro-api-key";
          // Only use REQUIRED params for the factory constructor
          const requiredParams = getOperationRequiredInputParams(loginOp);
          const sig = requiredParams.map((p) => `${p}: string`).join(", ");

          // Discover token field accessors from the login op's response schema
          const accessTokenField = findSdkField(loginOp, "access_token");
          const refreshTokenField = findSdkField(loginOp, "refresh_token");
          const tokenAccessor = accessTokenField
            ? camelCase(accessTokenField.sdkRole!)
            : "accessToken";
          const refreshAccessor = refreshTokenField
            ? camelCase(refreshTokenField.sdkRole!)
            : "refreshToken";

          const desc = flows.login?.description ?? loginOp.description ?? "Create a client by logging in";

          cb.line();
          cb.line(`/** ${desc} */`);
          cb.block(
            `static async withCredentials(apiKey: string, ${sig}, baseUrl?: string): Promise<PlatformClient>`,
            () => {
              cb.line("const client = new PlatformClient({");
              cb.indent();
              cb.line("baseUrl,");
              cb.line(`defaultHeaders: { "${header}": apiKey },`);
              cb.dedent();
              cb.line("});");
              cb.line(
                `const tokens = await client.auth.${authMethodName(loginOp)}(${requiredParams.join(", ")});`
              );
              cb.line(`if (!tokens.${tokenAccessor}) throw new Error("Login did not return an access token");`);
              cb.line(`client.setAccessToken(tokens.${tokenAccessor});`);
              cb.line(`if (tokens.${refreshAccessor}) client.setRefreshToken(tokens.${refreshAccessor});`);
              // Separate refresh-only HttpClient: cannot re-enter the main
              // client's 401 retry, so concurrent dedup is deadlock-free.
              cb.line("const refreshHttp = new HttpClient({");
              cb.indent();
              cb.line(`baseUrl: baseUrl ?? "${spec.baseUrl}",`);
              cb.line(`defaultHeaders: { "${header}": apiKey },`);
              cb.line("refreshOnly: true,");
              cb.dedent();
              cb.line("});");
              cb.line("const refreshAuth = new AuthClient(refreshHttp);");
              cb.line("client.http.setRefreshHandler(async () => {");
              cb.indent();
              cb.line("const rt = client.refreshToken;");
              cb.line(`if (!rt) throw new Error("No refresh token available");`);
              cb.line("const refreshed = await refreshAuth.refresh(rt);");
              cb.line(`if (!refreshed.${tokenAccessor}) throw new Error("Refresh did not return an access token");`);
              cb.line(`client.setAccessToken(refreshed.${tokenAccessor});`);
              cb.line(`if (refreshed.${refreshAccessor}) client.setRefreshToken(refreshed.${refreshAccessor});`);
              cb.line(`return refreshed.${tokenAccessor};`);
              cb.dedent();
              cb.line("});");
              cb.line("return client;");
            }
          );
        }
      }
    }
  });

  return cb.toString();
}

/**
 * Find the login operation — look for a token flow with constructor: "with_credentials"
 * or fall back to an auth-tagged operation named "login" or "create" under "/auth/login".
 */
function findLoginOperation(
  authOps: OperationDef[],
  flows: Record<string, unknown>
): OperationDef | undefined {
  // Check if a flow specifies an operation name
  const loginFlow = (flows as Record<string, Record<string, unknown>>).login;
  if (loginFlow?.operation_name) {
    const opName = loginFlow.operation_name as string;
    return authOps.find((op) => op.name === opName || op.path.endsWith(`/${opName}`));
  }

  // Fall back to heuristic: find operation with "login" in the path
  return authOps.find(
    (op) => op.path.includes("/login") && op.method === "POST"
  );
}

/**
 * Get only REQUIRED input params for an operation (for factory constructors).
 */
function getOperationRequiredInputParams(op: OperationDef): string[] {
  const params: string[] = [];
  if (op.body?.fields) {
    for (const f of op.body.fields) {
      if (!f.sdkRole && f.required) {
        params.push(camelCase(f.name));
      }
    }
  }
  for (const p of op.queryParams) {
    if (p.required) {
      params.push(camelCase(p.name));
    }
  }
  return params;
}

/** Find a field with a specific sdkRole in an operation's response schema. */
function findSdkField(
  op: OperationDef,
  role: string
): import("../../ast/types.js").FieldDef | undefined {
  if (op.returnType.kind === "object") {
    return op.returnType.fields.find((f) => f.sdkRole === role);
  }
  return undefined;
}
