import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SchemaDef } from "../../src/ast/types.js";
import { parseOpenApiSpec } from "../../src/frontend/index.js";
import { generatePython } from "../../src/backends/python/index.js";
import { emitPydanticFile } from "../../src/backends/python/pydantic-emitter.js";
import { emitPythonResourceFile } from "../../src/backends/python/resource-emitter.js";
import { emitPythonClientFile } from "../../src/backends/python/client-emitter.js";
import { emitPythonAuthFile } from "../../src/backends/python/auth-emitter.js";
import { emitPythonChannelFile } from "../../src/backends/python/channel-emitter.js";
import {
  collectTypedDictImports,
  emitTypedDictClass,
} from "../../src/backends/python/typeddict-emitter.js";
import { CodeBuilder } from "../../src/utils/codegen.js";
import { emitPythonContractTests } from "../../src/backends/contract-tests/python-emitter.js";
import { pythonResponseShape } from "../../src/backends/python/response-type.js";
import { emitPythonChannelContractTestFile } from "../../src/backends/contract-tests/channel-emitter-python.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/sample-spec.json"), "utf-8")
);
const versionedFixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/versioned-spec.json"), "utf-8")
);
const docFixture = {
  openapi: "3.0.0",
  info: { title: "Docs API", version: "1.0.0" },
  paths: {
    "/api/v1/teams/join_by_code": {
      post: {
        operationId: "post_api_v1_teams_join_by_code",
        summary: "Join a team using an invite code",
        description:
          "Accepts either `join_code` or `invite_code`.\n\nAdds the caller or provided principal to the team.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  join_code: {
                    type: "string",
                    description: "Invite or join code.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The joined team payload.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      description: "Joined team ID.",
                    },
                  },
                  required: ["id"],
                },
              },
            },
          },
        },
      },
    },
  },
};

const scopedDocFixture = {
  openapi: "3.0.0",
  info: { title: "Scoped Docs API", version: "1.0.0" },
  paths: {
    "/api/v1/agents/{agent}/tools": {
      get: {
        operationId: "get_api_v1_agent_tools",
        summary: "List agent tools",
        parameters: [
          {
            name: "agent",
            in: "path",
            required: true,
            description: "Agent ID that owns the tools.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Agent tool list.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: ["data"],
                },
              },
            },
          },
        },
      },
    },
  },
};


const rawFixture = {
  openapi: "3.0.0",
  info: { title: "Raw API", version: "1.0.0" },
  paths: {
    "/api/v1/configs/{config}/content": {
      get: {
        operationId: "get_api_v1_configs_content",
        parameters: [
          {
            name: "config",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Raw config content",
            content: {
              "*/*": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
        },
      },
    },
  },
};

const ast = parseOpenApiSpec(fixture, {
  name: "archastro-platform",
  version: "0.1.0",
  baseUrl: "https://platform.archastro.ai",
  apiPrefix: "/api",
  scopePrefix: "/apps/{app_id}",
});

describe("Pydantic emitter", () => {
  const teamSchemas = ast.schemas.filter((s) =>
    ["Team", "CreateTeamInput", "UpdateTeamInput"].includes(s.name)
  );
  const output = emitPydanticFile(teamSchemas);

  it("imports pydantic BaseModel", () => {
    expect(output).toContain("from pydantic import BaseModel");
  });

  it("generates model classes", () => {
    expect(output).toContain("class Team(BaseModel):");
    expect(output).toContain("class CreateTeamInput(BaseModel):");
  });

  it("handles required vs optional fields", () => {
    expect(output).toMatch(/id: str/);
    expect(output).toMatch(/name: str/);
    expect(output).toMatch(/description: Optional\[str\] = None/);
  });

  it("imports typing modules as needed", () => {
    expect(output).toContain("from typing import");
    expect(output).toContain("Optional");
  });

  it("emits `from datetime import datetime` only when a field actually uses it", () => {
    const noDatetime = emitPydanticFile([
      {
        name: "Plain",
        fields: [{ name: "id", type: { kind: "primitive", type: "string" }, required: true }],
      },
    ]);
    expect(noDatetime).not.toContain("from datetime import datetime");
  });

  it("emits `datetime` (not `str`) for date-time fields and imports it", () => {
    // Synthetic schema covers both required and optional datetime fields, so a
    // single assertion exercises the whole pipeline: TypeRef → annotation → import.
    const out = emitPydanticFile([
      {
        name: "Event",
        fields: [
          {
            name: "created_at",
            type: { kind: "primitive", type: "datetime" },
            required: true,
          },
          {
            name: "updated_at",
            type: {
              kind: "optional",
              inner: { kind: "primitive", type: "datetime" },
            },
            required: false,
          },
        ],
      },
    ]);
    expect(out).toContain("from datetime import datetime");
    expect(out).toMatch(/created_at: datetime$/m);
    expect(out).toMatch(/updated_at: Optional\[datetime\] = None/);
    // Sanity: not the old behavior.
    expect(out).not.toMatch(/created_at: str$/m);
  });

  it("handles enum types with Literal", () => {
    const memberSchemas = ast.schemas.filter(
      (s) => s.name === "TeamMember" || s.name === "AddTeamMemberInput"
    );
    const memberOutput = emitPydanticFile(memberSchemas);
    expect(memberOutput).toContain("Literal");
    expect(memberOutput).toContain('"admin"');
    expect(memberOutput).toContain('"member"');
  });

  it("aliases Python keyword fields while preserving the wire key", () => {
    const out = emitPydanticFile([
      {
        name: "AgentTool",
        fields: [
          {
            name: "async",
            type: {
              kind: "optional",
              inner: { kind: "primitive", type: "boolean" },
            },
            required: false,
            description: "Whether the tool executes asynchronously",
          },
        ],
      },
    ]);

    expect(out).toContain("from pydantic import BaseModel, ConfigDict, Field");
    expect(out).toContain("model_config = ConfigDict(populate_by_name=True)");
    expect(out).toContain(
      'async_: Optional[bool] = Field(default=None, alias="async", description="Whether the tool executes asynchronously")'
    );
    expect(out).not.toContain("async: Optional[bool]");
  });

  it("emits model docstrings and Field descriptions from schema docs", () => {
    const out = emitPydanticFile([
      {
        name: "DocumentedThing",
        description: "A documented thing.",
        fields: [
          {
            name: "id",
            type: { kind: "primitive", type: "string" },
            required: true,
            description: "Stable thing ID.",
          },
        ],
      },
    ]);

    expect(out).toContain('"""');
    expect(out).toContain("A documented thing.");
    expect(out).toContain(
      'id: str = Field(..., description="Stable thing ID.")'
    );
  });

  it("emits Any rather than the object builtin for free-form fields", () => {
    // A field named `object` shadows the builtin when pydantic resolves
    // deferred annotations against the class namespace; `dict[str, object]`
    // silently becomes `dict[str, None]` and every value fails validation.
    const out = emitPydanticFile([
      {
        name: "AttachmentLike",
        fields: [
          {
            name: "object",
            type: { kind: "map", valueType: { kind: "unknown" } },
            required: true,
          },
          {
            name: "payload",
            type: { kind: "object", fields: [] },
            required: true,
          },
        ],
      },
    ]);

    expect(out).toContain("object: dict[str, Any]");
    expect(out).toContain("payload: dict[str, Any]");
    expect(out).not.toContain("dict[str, object]");
    expect(out).toMatch(/from typing import .*Any/);
  });

  it("uniquely aliases fields when sanitized Python names collide", () => {
    const out = emitPydanticFile([
      {
        name: "Collision",
        fields: [
          {
            name: "async",
            type: {
              kind: "optional",
              inner: { kind: "primitive", type: "boolean" },
            },
            required: false,
          },
          {
            name: "async_",
            type: {
              kind: "optional",
              inner: { kind: "primitive", type: "string" },
            },
            required: false,
          },
        ],
      },
    ]);

    expect(out).toContain('async_: Optional[bool] = Field(default=None, alias="async")');
    expect(out).toContain(
      'async_2: Optional[str] = Field(default=None, alias="async_")'
    );
  });
});

describe("Python resource emitter", () => {
  const teamsResource = ast.resources.find((r) => r.name === "teams")!;
  const output = emitPythonResourceFile(teamsResource, ast.apiPrefix);

  it("generates resource classes", () => {
    expect(output).toContain("class TeamResource:");
    expect(output).toContain("class MemberResource:");
    expect(output).toContain("class AsyncTeamResource:");
    expect(output).toContain("class AsyncMemberResource:");
  });

  it("generates typed sync resource classes without a Sync prefix", () => {
    expect(output).toContain("def __init__(self, http: SyncHttpClient):");
    expect(output).toContain("self.members = MemberResource(http)");
    expect(output).not.toContain("class SyncTeamResource:");
    expect(output).not.toContain("class SyncMemberResource:");
  });

  it("nests child resources in __init__", () => {
    expect(output).toContain("self.members = MemberResource(http)");
    expect(output).toContain("self.members = AsyncMemberResource(http)");
  });

  it("generates async methods", () => {
    expect(output).toContain("async def list(self,");
    expect(output).toContain("async def get(self,");
    expect(output).toContain("async def create(self,");
  });

  it("generates sync methods with the same public signatures", () => {
    expect(output).toContain("def list(self,");
    expect(output).toContain("def get(self,");
    expect(output).toContain("def create(self,");
    expect(output).toContain("return self._http.request(");
  });

  it("uses snake_case params", () => {
    expect(output).toContain("team_id: str");
  });

  it("uses await for HTTP requests", () => {
    expect(output).toContain("return await self._http.request(");
  });

  it("uses full paths from the spec (no app_api_path)", () => {
    expect(output).not.toContain("app_api_path");
    expect(output).toContain('f"/api/apps/{app_id}/teams/{team_id}"');
  });
});

describe("Python resource emitter uses request_raw for raw responses", () => {
  const rawAst = parseOpenApiSpec(rawFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const configsResource = rawAst.resources.find((r) => r.name === "configs")!;
  const output = emitPythonResourceFile(configsResource, "/api/v1");

  it("emits request_raw and dict return type", () => {
    expect(output).toContain(
      "async def content(self, config: str) -> Dict[str, str]:"
    );
    expect(output).toContain(
      'return await self._http.request_raw(f"/api/v1/configs/{config}/content")'
    );
  });
});

describe("Python resource emitter passes response_type for typed responses", () => {
  const widgetFixture = {
    openapi: "3.0.0",
    info: { title: "Widget API", version: "1.0.0" },
    paths: {
      "/api/v1/widgets": {
        get: {
          operationId: "get_api_v1_widgets",
          responses: {
            "200": {
              description: "All widgets",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Widget" },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/widgets/{widget}": {
        get: {
          operationId: "get_api_v1_widgets_widget",
          parameters: [
            { name: "widget", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "One widget",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Widget" },
                },
              },
            },
          },
        },
        delete: {
          operationId: "delete_api_v1_widgets_widget",
          parameters: [
            { name: "widget", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "204": { description: "Deleted" } },
        },
      },
      "/api/v1/widgets/{widget}/share": {
        post: {
          operationId: "post_api_v1_widgets_widget_share",
          parameters: [
            { name: "widget", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Share result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/widgets/{widget}/avatar": {
        get: {
          operationId: "get_api_v1_widgets_widget_avatar",
          parameters: [
            { name: "widget", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Raw avatar bytes",
              content: { "*/*": { schema: { type: "string", format: "binary" } } },
            },
          },
        },
      },
      "/api/v1/widgets/paged": {
        get: {
          operationId: "get_api_v1_widgets_paged",
          responses: {
            "200": {
              description: "Paged widgets",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Widget" },
                      },
                    },
                    required: ["data"],
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Widget: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
  };

  const widgetAst = parseOpenApiSpec(widgetFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const widgetsResource = widgetAst.resources.find((r) => r.name === "widgets")!;
  const output = emitPythonResourceFile(widgetsResource, "/api/v1");

  it("passes the schema class for $ref responses in both transports", () => {
    expect(output).toContain(
      'return await self._http.request(f"/api/v1/widgets/{widget}", response_type=Widget)'
    );
    expect(output).toContain(
      'return self._http.request(f"/api/v1/widgets/{widget}", response_type=Widget)'
    );
  });

  it("passes list[Model] for array-of-$ref responses", () => {
    expect(output).toContain(
      'return await self._http.request(f"/api/v1/widgets", response_type=list[Widget])'
    );
    expect(output).toContain(
      'return self._http.request(f"/api/v1/widgets", response_type=list[Widget])'
    );
  });

  it("passes the hoisted BaseModel for inline object responses", () => {
    expect(output).toContain("class WidgetShareResponse(BaseModel):");
    expect(output).toContain("response_type=WidgetShareResponse");
  });

  it("omits response_type for 204/void responses", () => {
    expect(output).toContain(
      'await self._http.request(f"/api/v1/widgets/{widget}", method="DELETE")'
    );
    expect(output).toContain("Returns:");
    expect(output).toContain("Deleted");
  });

  it("omits response_type for raw byte responses", () => {
    expect(output).toContain(
      'return await self._http.request_raw(f"/api/v1/widgets/{widget}/avatar")'
    );
  });

  describe("contract tests assert the deserialized shapes", () => {
    const files = emitPythonContractTests(widgetAst, {
      outDir: "/tmp/test-python-sdk",
    });
    const content =
      files["/tmp/test-python-sdk/tests/contract/v1/test_widgets.py"]!;

    it("imports BaseModel and asserts concrete model classes for typed responses", () => {
      expect(content).toContain("from pydantic import BaseModel");
      expect(content).toContain("assert isinstance(result, BaseModel)");
      expect(content).toContain('assert type(result).__name__ == "Widget"');
      expect(content).toContain(
        'assert type(result).__name__ == "WidgetShareResponse"'
      );
    });

    it("asserts lists of concrete model instances for list responses", () => {
      expect(content).toContain("assert isinstance(result, list)");
      expect(content).toContain(
        'assert all(type(item).__name__ == "Widget" for item in result)'
      );
    });

    it("asserts attribute access for data-array responses", () => {
      expect(content).toContain("assert isinstance(result.data, list)");
      expect(content).not.toContain('assert "data" in result');
      expect(content).not.toContain('result["data"]');
    });

    it("keeps raw and void assertions unchanged", () => {
      expect(content).toContain('assert result["content"] is not None');
      expect(content).toContain('assert result["mime_type"]');
      expect(content).toContain("assert result is None");
    });
  });

  it("fails generation when a model is buried in an undeserialized shape", () => {
    expect(() =>
      pythonResponseShape({
        name: "get",
        operationId: "get_widget_or_gadget",
        method: "GET",
        path: "/api/v1/widgets/mixed",
        deprecated: false,
        pathParams: [],
        queryParams: [],
        returnType: {
          kind: "union",
          variants: [
            { kind: "ref", schema: "Widget" },
            { kind: "ref", schema: "Gadget" },
          ],
        },
        errors: [],
      })
    ).toThrow(/not deserialized/);
  });
});

describe("Python contract tests include raw response operations", () => {
  const rawAst = parseOpenApiSpec(rawFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const files = emitPythonContractTests(rawAst, {
    outDir: "/tmp/test-python-sdk",
  });
  const content =
    files["/tmp/test-python-sdk/tests/contract/v1/test_configs.py"]!;

  it("emits happy-path assertions for raw content and mime type", () => {
    expect(content).toContain(
      'result = client.v1.configs.content("test-value")'
    );
    expect(content).toContain('assert result["content"] is not None');
    expect(content).toContain('assert result["mime_type"]');
  });

  it("uses the sync PlatformClient in generated Python REST contract tests", () => {
    expect(content).toContain("from archastro.platform import AsyncPlatformClient, PlatformClient");
    expect(content).toContain("def _client() -> PlatformClient:");
    expect(content).toContain("return PlatformClient(");
    expect(content).toContain("def test_configs_content_success():");
    expect(content).toContain("result = client.v1.configs.content(");
    expect(content).toContain("finally:");
    expect(content).toContain("client.close()");
  });

  it("also emits async REST contract tests for AsyncPlatformClient", () => {
    expect(content).toContain("def _async_client() -> AsyncPlatformClient:");
    expect(content).toContain("return AsyncPlatformClient(");
    expect(content).toContain("@pytest.mark.asyncio");
    expect(content).toContain("async def test_async_configs_content_success():");
    expect(content).toContain("result = await client.v1.configs.content(");
    expect(content).toContain("await client.close()");
  });

  it("emits async REST contract error cases when the operation declares 4xx responses", () => {
    const files = emitPythonContractTests(ast, { outDir: "/tmp/test-python-sdk" });
    const teams = files["/tmp/test-python-sdk/tests/contract/v1/test_teams.py"]!;

    expect(teams).toContain("async def test_async_teams_get_error_404():");
    expect(teams).toContain("with pytest.raises(ApiError) as exc_info:");
    expect(teams).toContain("await ec.v1.teams.get(");
    expect(teams).toContain("assert exc_info.value.status == 404");
  });
});

describe("Python resource emitter uses summary and description in method docstrings", () => {
  const docAst = parseOpenApiSpec(docFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const teamsResource = docAst.resources.find((r) => r.name === "teams")!;
  const output = emitPythonResourceFile(teamsResource, "/api/v1");

  it("renders the summary and long description into method docstrings", () => {
    expect(output).toContain('"""');
    expect(output).toContain("Join a team using an invite code");
    expect(output).toContain("Accepts either `join_code` or `invite_code`.");
    expect(output).toContain(
      "Adds the caller or provided principal to the team."
    );
    expect(output).toContain(
      "async def join_by_code(self, input: TeamJoinByCodeInput) -> TeamJoinByCodeResponse:"
    );
    expect(output).toContain("Args:");
    expect(output).toContain("    input.join_code: Invite or join code.");
    expect(output).toContain("Returns:");
    expect(output).toContain("    The joined team payload.");
    expect(output).toContain(
      'id: str = Field(..., description="Joined team ID.")'
    );
  });
});

describe("Python resource emitter preserves scoped path parameter docs", () => {
  const scopedAst = parseOpenApiSpec(scopedDocFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiPrefix: "/api/v1",
    scopePrefix: "/agents/{agent}",
  });
  const toolsResource = scopedAst.resources.find((r) => r.name === "tools")!;
  const output = emitPythonResourceFile(toolsResource, "/api/v1");

  it("renders docs for resource-level scope params", () => {
    expect(output).toContain("async def list(self, agent: str)");
    expect(output).toContain("Args:");
    expect(output).toContain("    agent: Agent ID that owns the tools.");
    expect(output).toContain("Returns:");
    expect(output).toContain("    Agent tool list.");
  });
});

describe("Python contract tests sanitize generated query kwargs", () => {
  const keywordQueryAst = parseOpenApiSpec(
    {
      openapi: "3.0.0",
      info: { title: "Keyword query API", version: "1.0.0" },
      paths: {
        "/api/v1/tools": {
          get: {
            operationId: "get_api_v1_tools",
            parameters: [
              {
                name: "async",
                in: "query",
                required: true,
                schema: { type: "boolean" },
              },
              {
                name: "async_",
                in: "query",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "string" } },
                      required: ["id"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      name: "archastro-platform",
      version: "0.1.0",
      baseUrl: "https://platform.archastro.ai",
      apiBase: "/api",
      defaultVersion: "v1",
    }
  );

  const files = emitPythonContractTests(keywordQueryAst, {
    outDir: "/tmp/test-python-keyword-query",
  });
  const content =
    files["/tmp/test-python-keyword-query/tests/contract/v1/test_tools.py"]!;

  it("uses sanitized kwargs that match the generated SDK method signature", () => {
    expect(content).toContain(
      'client.v1.tools.list(async_=True, async_2="test-value")'
    );
    expect(content).not.toContain("async=True");
  });
});

describe("Python auth emitter", () => {
  const output = emitPythonAuthFile({
    authOperations: [
      {
        name: "login",
        operationId: "post_auth_login",
        method: "POST",
        path: "/api/v1/auth/login",
        summary: "Log in",
        description: "Authenticates a user.",
        deprecated: false,
        pathParams: [],
        queryParams: [],
        body: {
          fields: [
            {
              name: "email",
              type: { kind: "primitive", type: "string" },
              required: true,
              description: "Email address.",
            },
          ],
        },
        returnType: {
          kind: "object",
          fields: [
            {
              name: "token",
              type: { kind: "primitive", type: "string" },
              required: true,
              sdkRole: "access_token",
            },
          ],
        },
        returnDescription: "Credential bundle.",
        errors: [],
      },
      {
        name: "allowed_auth_methods",
        operationId: "get_allowed_auth_methods",
        method: "GET",
        path: "/api/v1/auth/allowed_auth_methods",
        summary: "List auth methods",
        deprecated: false,
        pathParams: [],
        queryParams: [],
        returnType: {
          kind: "object",
          fields: [
            {
              name: "methods",
              type: {
                kind: "array",
                items: { kind: "primitive", type: "string" },
              },
              required: true,
            },
          ],
        },
        returnDescription: "Authentication method catalogue.",
        errors: [],
      },
    ],
    schemas: [],
  } as any);

  it("returns AuthTokens only for operations with token-role response fields", () => {
    expect(output).toContain("async def login(self, email: str) -> AuthTokens:");
    expect(output).toContain("class AsyncAuthClient:");
    expect(output).toContain("class AuthClient:");
    expect(output).toContain("def login(self, email: str) -> AuthTokens:");
    expect(output).toContain("data = self._http.request(");
    expect(output).toContain("access_token=data.get(\"token\")");
    expect(output).toContain("async def allowed_auth_methods(self) -> dict:");
    expect(output).toContain("def allowed_auth_methods(self) -> dict:");
    expect(output).toMatch(
      /async def allowed_auth_methods\(self\) -> dict:[\s\S]+?data = await self\._http\.request\([\s\S]+?return data/
    );
    expect(output).not.toMatch(
      /allowed_auth_methods[\s\S]+?return AuthTokens\([\s\S]+?access_token=None/
    );
  });

  it("emits pdoc-visible auth method docstrings", () => {
    expect(output).toContain("Log in");
    expect(output).toContain("Authenticates a user.");
    expect(output).toContain("Args:");
    expect(output).toContain("    email: Email address.");
    expect(output).toContain("Returns:");
    expect(output).toContain("    Credential bundle.");
    expect(output).toContain("    Authentication method catalogue.");
  });

  it("uniquifies sanitized auth params while preserving body wire keys", () => {
    const out = emitPythonAuthFile({
      authOperations: [
        {
          name: "login",
          operationId: "post_auth_login",
          method: "POST",
          path: "/api/v1/auth/login",
          deprecated: false,
          pathParams: [],
          queryParams: [],
          body: {
            fields: [
              {
                name: "async",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
              {
                name: "async_",
                type: { kind: "primitive", type: "string" },
                required: false,
              },
            ],
          },
          returnType: { kind: "object", fields: [] },
          errors: [],
        },
      ],
      schemas: [],
    } as any);

    expect(out).toContain(
      "async def login(self, async_: str, async_2: str | None = None) -> dict:"
    );
    expect(out).toContain('body["async"] = async_');
    expect(out).toContain("if async_2 is not None:");
    expect(out).toContain('body["async_"] = async_2');
    expect(out).not.toContain("async_: str, async_:");
  });
});

describe("Python client emitter", () => {
  const output = emitPythonClientFile(ast);

  it("generates distinct sync and async client classes", () => {
    expect(output).toContain("class PlatformClient:");
    expect(output).toContain("class AsyncPlatformClient:");
    expect(output).toContain("self._http = SyncHttpClient(");
    expect(output).toContain("self.v1 = V1(self._http)");
    expect(output).toContain("self.v1 = AsyncV1(self._http)");
    expect(output).not.toContain("PlatformClient = AsyncPlatformClient");
  });

  it("generates a sync HTTP-backed PlatformClient", () => {
    expect(output).toContain("from .runtime.http_client import HttpClient, SyncHttpClient");
    expect(output).not.toContain("class _SyncRunner:");
    expect(output).not.toContain("class _SyncResourceProxy:");
  });

  it("has __init__ with keyword-only params", () => {
    expect(output).toContain("def __init__(self, *,");
    expect(output).toContain("base_url: str =");
    expect(output).toContain("access_token: str | None = None");
  });

  it("has version namespace and resource aliases", () => {
    expect(output).toContain("self.v1 = V1(self._http)");
    expect(output).toContain("self.v1 = AsyncV1(self._http)");
    // Backward-compat aliases to default version
    expect(output).toContain("self.teams = self.v1.teams");
    expect(output).toContain("self.agents = self.v1.agents");
  });

  it("has set_access_token method", () => {
    expect(output).toContain("def set_access_token(self, token: str)");
    expect(output).toContain("self._http.set_access_token(token)");
  });

  it("generates close methods for async and sync clients", () => {
    expect(output).toContain("self._extra_http_clients: list[HttpClient] = []");
    expect(output).toContain("self._extra_http_clients: list[SyncHttpClient] = []");
    expect(output).toContain("async def close(self):");
    expect(output).toContain("await self._http.close()");
    expect(output).toContain("for http in self._extra_http_clients:");
    expect(output).toContain("def close(self):");
    expect(output).toContain("self._http.close()");
  });

  it("generates context managers for async and sync clients", () => {
    expect(output).toContain("async def __aenter__(self):");
    expect(output).toContain("async def __aexit__(self, exc_type, exc, tb):");
    expect(output).toContain("def __enter__(self):");
    expect(output).toContain("def __exit__(self, exc_type, exc, tb):");
  });

  it("generates an authenticated socket convenience on AsyncPlatformClient only", () => {
    const asyncClass = output.slice(
      output.indexOf("class AsyncPlatformClient:"),
      output.indexOf("class PlatformClient:")
    );
    const syncClass = output.slice(output.indexOf("class PlatformClient:"));

    expect(output).toContain("from urllib.parse import urlparse, urlunparse");
    expect(output).toContain("from archastro.phx_channel import Socket");
    expect(asyncClass).toContain("self._base_url = base_url");
    expect(asyncClass).toContain("self._default_headers = default_headers or {}");
    expect(asyncClass).toContain("self._sockets: list[Socket] = []");
    expect(asyncClass).toContain("async def open_socket(");
    expect(asyncClass).toContain("url: str | None = None");
    expect(asyncClass).toContain("params: dict[str, str] | None = None");
    expect(asyncClass).toContain("connect: bool = True");
    expect(asyncClass).toContain('socket = Socket(url or self._default_websocket_url()');
    expect(asyncClass).toContain("await socket.connect()");
    expect(asyncClass).toContain("if not socket.is_connected:");
    expect(asyncClass).toContain('raise ConnectionError("WebSocket connection failed")');
    expect(asyncClass).toContain("return socket");
    expect(asyncClass).toContain('socket_params["api_key"] = api_key');
    expect(asyncClass).toContain('socket_params["token"] = token');
    expect(asyncClass).toContain("await socket.disconnect()");
    expect(syncClass).not.toContain("open_socket");
    expect(syncClass).not.toContain("self._sockets");
  });

  it("uniquifies with_credentials params using the auth method mapping", () => {
    const out = emitPythonClientFile({
      baseUrl: "https://api.example.test",
      versions: [],
      defaultVersion: "v1",
      schemas: [],
      resources: [],
      channels: [],
      auth: {
        schemes: {
          publishable_key: { type: "apiKey", name: "x-api-key" },
        },
        tokenFlows: {
          login: { operation_name: "login" },
        },
      },
      authOperations: [
        {
          name: "login",
          operationId: "post_auth_login",
          method: "POST",
          path: "/api/v1/auth/login",
          deprecated: false,
          pathParams: [],
          queryParams: [],
          body: {
            fields: [
              {
                name: "async",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
              {
                name: "async_",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
          },
          returnType: {
            kind: "object",
            fields: [
              {
                name: "token",
                type: { kind: "primitive", type: "string" },
                required: true,
                sdkRole: "access_token",
              },
            ],
          },
          errors: [],
        },
      ],
    } as any);

    expect(out).toContain(
      'async def with_credentials(cls, api_key: str, async_: str, async_2: str, base_url: str | None = None) -> "AsyncPlatformClient":'
    );
    expect(out).toContain(
      'def with_credentials(cls, api_key: str, async_: str, async_2: str, base_url: str | None = None) -> "PlatformClient":'
    );
    expect(out).toContain("tokens = await client.auth.login(async_, async_2)");
    expect(out).not.toContain("client.auth.login(async_, async_)");
    expect(out).not.toContain("tokens.refresh_token");
    expect(out).not.toContain("set_refresh_handler(_refresh)");
  });

  it("keeps refresh handling when auth tokens are returned through a nullable schema ref", () => {
    const tokenSchema = {
      name: "AuthTokens",
      fields: [
        {
          name: "token",
          type: { kind: "primitive", type: "string" },
          required: true,
          sdkRole: "access_token",
        },
        {
          name: "refresh_token",
          type: { kind: "primitive", type: "string" },
          required: false,
          sdkRole: "refresh_token",
        },
      ],
    };
    const out = emitPythonClientFile({
      baseUrl: "https://api.example.test",
      versions: [],
      defaultVersion: "v1",
      schemas: [tokenSchema],
      resources: [],
      channels: [],
      auth: {
        schemes: {
          publishable_key: { type: "apiKey", name: "x-api-key" },
        },
        tokenFlows: {
          login: { operation_name: "login" },
        },
      },
      authOperations: [
        {
          name: "login",
          operationId: "post_auth_login",
          method: "POST",
          path: "/api/v1/auth/login",
          deprecated: false,
          pathParams: [],
          queryParams: [],
          body: {
            fields: [
              {
                name: "email",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
              {
                name: "password",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
          },
          returnType: {
            kind: "nullable",
            inner: { kind: "ref", schema: "AuthTokens" },
          },
          errors: [],
        },
        {
          name: "refresh",
          operationId: "post_auth_refresh",
          method: "POST",
          path: "/api/v1/auth/refresh",
          deprecated: false,
          pathParams: [],
          queryParams: [],
          body: {
            fields: [
              {
                name: "refresh_token",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
          },
          returnType: { kind: "ref", schema: "AuthTokens" },
          errors: [],
        },
      ],
    } as any);

    expect(out).toContain("if tokens.refresh_token:");
    expect(out).toContain("client.set_refresh_token(tokens.refresh_token)");
    expect(out).toContain("client._http.set_refresh_handler(_refresh)");
    expect(out).toContain("refresh_auth = AuthClient(refresh_http)");
  });
});

describe("Python channel emitter", () => {
  const chat = ast.channels.find((c) => c.name === "Chat")!;
  const output = emitPythonChannelFile(chat);

  it("generates channel class", () => {
    expect(output).toContain("class ChatChannel:");
  });

  it("generates named topic builder from join name", () => {
    expect(output).toContain("@staticmethod");
    expect(output).toContain(
      "def topic_team_thread(team_id: str, thread_id: str)"
    );
    expect(output).toContain('f"api:chat:team:{team_id}:thread:{thread_id}"');
  });

  it("generates named join classmethod with typed socket and keyword-only payload params", () => {
    expect(output).toContain("@classmethod");
    expect(output).toContain(
      'async def join_team_thread(cls, socket: "Socket", team_id: str, thread_id: str, *, limit: int | None = None) -> "ChatChannel":'
    );
  });

  it("captures channel.join payload and response", () => {
    expect(output).toContain("payload: dict[str, object] = {}");
    expect(output).toContain("if limit is not None:");
    expect(output).toContain('payload["limit"] = limit');
    expect(output).toContain("join_response = await channel.join(payload)");
    expect(output).toContain("return cls(channel, join_response)");
  });

  it("constructor accepts and exposes join_response", () => {
    expect(output).toContain(
      "def __init__(self, channel, join_response=None):"
    );
    expect(output).toContain("self._channel = channel");
    expect(output).toContain("self.join_response = join_response");
  });

  it("imports Socket only for type checking", () => {
    expect(output).toContain("TYPE_CHECKING");
    expect(output).toContain("if TYPE_CHECKING:");
    expect(output).toContain("from archastro.phx_channel.socket import Socket");
  });

  it("generates leave method", () => {
    expect(output).toContain("async def leave(self):");
    expect(output).toContain("await self._channel.leave()");
  });

  it("generates async message methods", () => {
    expect(output).toContain("async def send_message(self,");
    expect(output).toContain('self._channel.push("send_message"');
  });

  it("generates push event handlers", () => {
    expect(output).toContain("def on_message_added(self, callback:");
    expect(output).toContain('self._channel.on("message_added"');
    expect(output).toContain("def on_message_updated(self, callback:");
  });

  it("types message payloads + push callbacks via generated TypedDicts", () => {
    expect(output).toContain("from typing import");
    expect(output).toContain("TypedDict");
    // Required appears only when there's a mix of required + optional fields.
    expect(output).toContain("class SendMessageInput(TypedDict");
    expect(output).toContain("payload: SendMessageInput");
    expect(output).toContain("class MessageAddedPayload(TypedDict");
    expect(output).toContain(
      "callback: Callable[[MessageAddedPayload], None]"
    );
    expect(output).toContain("from collections.abc import Callable");
  });
});

describe("TypedDict emitter", () => {
  function render(
    className: string,
    fields: Parameters<typeof emitTypedDictClass>[2],
    description?: string
  ): string {
    const cb = new CodeBuilder("    ");
    emitTypedDictClass(cb, className, fields, description);
    return cb.toString();
  }

  it("uses bare TypedDict (no total=False) when every field is required", () => {
    const out = render("AllRequiredInput", [
      { name: "a", type: { kind: "primitive", type: "string" }, required: true },
      { name: "b", type: { kind: "primitive", type: "integer" }, required: true },
    ]);
    expect(out).toContain("class AllRequiredInput(TypedDict):");
    expect(out).not.toContain("total=False");
    expect(out).not.toContain("Required[");
    expect(out).toContain("a: str");
    expect(out).toContain("b: int");
  });

  it("uses total=False with Required[] for required keys in mixed schemas", () => {
    const out = render("MixedInput", [
      { name: "id", type: { kind: "primitive", type: "string" }, required: true },
      {
        name: "tag",
        type: { kind: "optional", inner: { kind: "primitive", type: "string" } },
        required: false,
      },
    ]);
    expect(out).toContain("class MixedInput(TypedDict, total=False):");
    expect(out).toContain("id: Required[str]");
    expect(out).toContain("tag: Optional[str]");
  });

  it("uses total=False without Required[] when every field is optional", () => {
    const out = render("AllOptionalInput", [
      {
        name: "x",
        type: { kind: "optional", inner: { kind: "primitive", type: "string" } },
        required: false,
      },
    ]);
    expect(out).toContain("class AllOptionalInput(TypedDict, total=False):");
    expect(out).not.toContain("Required[");
  });

  it("emits an empty class with `pass` when there are no fields", () => {
    const out = render("EmptyInput", []);
    expect(out).toMatch(/class EmptyInput\(TypedDict(, total=False)?\):/);
    expect(out).toContain("pass");
  });

  it("renders class-level descriptions as TypedDict class docstrings", () => {
    const out = render(
      "DocumentedInput",
      [{ name: "id", type: { kind: "primitive", type: "string" }, required: true }],
      "Multi-line\ndescription text"
    );
    expect(out).toContain("class DocumentedInput(TypedDict):");
    expect(out).toContain('"""');
    expect(out).toContain("Multi-line");
    expect(out).toContain("description text");
  });

  it("renders field descriptions as TypedDict attribute docstrings", () => {
    const out = render("FieldDocsInput", [
      {
        name: "id",
        type: { kind: "primitive", type: "string" },
        required: true,
        description: "Resource identifier",
      },
    ]);
    expect(out).toContain("id: str");
    expect(out).toContain('"Resource identifier"');
  });

  it("uses functional syntax for Python keyword keys without renaming wire keys", () => {
    const out = render(
      "ToolInput",
      [
        {
          name: "async",
          type: {
            kind: "optional",
            inner: { kind: "primitive", type: "boolean" },
          },
          required: false,
          description: "Whether the tool executes asynchronously",
        },
        {
          name: "kind",
          type: { kind: "primitive", type: "string" },
          required: true,
          description: "Tool kind.",
        },
      ],
      "Input for creating a tool."
    );

    expect(out).toContain("ToolInput = TypedDict(");
    expect(out).toContain('"ToolInput",');
    expect(out).toContain('"async": Optional[bool]');
    expect(out).toContain('"kind": Required[str]');
    expect(out).toContain('"""');
    expect(out).toContain("Input for creating a tool.");
    expect(out).toContain("Attributes:");
    expect(out).toContain("    async: Whether the tool executes asynchronously");
    expect(out).toContain("    kind: Tool kind.");
    expect(out).not.toContain("class ToolInput");
    expect(out).not.toContain("async: Optional[bool]");
  });

  describe("collectTypedDictImports", () => {
    it("returns empty when no TypedDicts are emitted", () => {
      expect(collectTypedDictImports([])).toEqual(new Set());
    });

    it("emits TypedDict alone when every field is required (no Required needed)", () => {
      const imports = collectTypedDictImports([
        {
          fields: [
            { name: "a", type: { kind: "primitive", type: "string" }, required: true },
          ],
        },
      ]);
      expect(imports.has("TypedDict")).toBe(true);
      expect(imports.has("Required")).toBe(false);
    });

    it("emits Required when at least one mixed group has required fields", () => {
      const imports = collectTypedDictImports([
        {
          fields: [
            { name: "id", type: { kind: "primitive", type: "string" }, required: true },
            {
              name: "tag",
              type: { kind: "optional", inner: { kind: "primitive", type: "string" } },
              required: false,
            },
          ],
        },
      ]);
      expect(imports.has("TypedDict")).toBe(true);
      expect(imports.has("Required")).toBe(true);
      expect(imports.has("Optional")).toBe(true);
    });

    it("collects nested typing imports through optional/array/union/map", () => {
      const imports = collectTypedDictImports([
        {
          fields: [
            {
              name: "list_field",
              type: {
                kind: "array",
                items: {
                  kind: "optional",
                  inner: { kind: "enum", values: ["a", "b"] },
                },
              },
              required: false,
            },
          ],
        },
      ]);
      expect(imports.has("Optional")).toBe(true);
      expect(imports.has("Literal")).toBe(true);
    });
  });
});

describe("Python resource emitter typed bodies", () => {
  function teamsResourceWith(
    ops: Array<Parameters<typeof emitPythonResourceFile>[0]["operations"][number]>
  ): Parameters<typeof emitPythonResourceFile>[0] {
    return {
      name: "teams",
      className: "TeamResource",
      path: "/teams",
      scopeParams: [],
      operations: ops,
      children: [],
    };
  }

  it("prefixes inline-input class names with the resource short name to avoid collisions", () => {
    const teams = teamsResourceWith([]);
    const members = {
      name: "members",
      className: "MemberResource",
      path: "/teams/{team}/members",
      scopeParams: [],
      operations: [
        {
          name: "create",
          operationId: "post_members",
          method: "POST" as const,
          path: "/api/v1/teams/{team}/members",
          deprecated: false,
          pathParams: [{ name: "team", type: { kind: "primitive" as const, type: "string" as const }, required: true }],
          queryParams: [],
          body: {
            schema: "CreateInput",
            contentType: "application/json",
            fields: [{ name: "user", type: { kind: "primitive" as const, type: "string" as const }, required: true }],
          },
          returnType: { kind: "unknown" as const },
          errors: [],
        },
      ],
      children: [],
    };
    const teamWithCreate = {
      ...teams,
      operations: [
        {
          name: "create",
          operationId: "post_team",
          method: "POST" as const,
          path: "/api/v1/teams",
          deprecated: false,
          pathParams: [],
          queryParams: [],
          body: {
            schema: "CreateInput",
            contentType: "application/json",
            fields: [{ name: "name", type: { kind: "primitive" as const, type: "string" as const }, required: true }],
          },
          returnType: { kind: "unknown" as const },
          errors: [],
        },
      ],
      children: [members],
    };
    const out = emitPythonResourceFile(teamWithCreate, "/api/v1");
    // Two distinct class names — no late definition wins because of identical names.
    expect(out).toContain("class MemberCreateInput");
    expect(out).toContain("class TeamCreateInput");
    expect(out).toContain("input: MemberCreateInput");
    expect(out).toContain("input: TeamCreateInput");
  });

  it("uses the existing Pydantic model name for $ref bodies (no TypedDict emitted)", () => {
    const out = emitPythonResourceFile(
      teamsResourceWith([
        {
          name: "create",
          operationId: "post_team",
          method: "POST",
          path: "/api/v1/teams",
          deprecated: false,
          pathParams: [],
          queryParams: [],
          body: { schema: "CreateTeamInput", contentType: "application/json" },
          returnType: { kind: "ref", schema: "Team" },
          errors: [],
        },
      ]),
      "/api/v1"
    );
    expect(out).toContain("input: CreateTeamInput");
    expect(out).not.toContain("class CreateTeamInput(TypedDict");
  });

  it("falls back to `input: dict` for bodies with no schema or fields (defensive)", () => {
    const out = emitPythonResourceFile(
      teamsResourceWith([
        {
          name: "create",
          operationId: "post_team",
          method: "POST",
          path: "/api/v1/teams",
          deprecated: false,
          pathParams: [],
          queryParams: [],
          body: { schema: "", contentType: "application/json" },
          returnType: { kind: "unknown" },
          errors: [],
        },
      ]),
      "/api/v1"
    );
    expect(out).toContain("input: Dict[str, Any]");
    expect(out).not.toContain("(TypedDict");
  });

  it("hoists nested inline objects in inputs as sibling TypedDicts", () => {
    // Inline `acl` object inside a request body should be a real type, not
    // `dict[str, object] | None`. Same for nested array items (`add: AclGrant[]`).
    const out = emitPythonResourceFile(
      {
        name: "teams",
        className: "TeamResource",
        path: "/teams",
        scopeParams: [],
        operations: [
          {
            name: "create",
            operationId: "post_team",
            method: "POST",
            path: "/api/v1/teams",
            deprecated: false,
            pathParams: [],
            queryParams: [],
            body: {
              schema: "CreateInput",
              contentType: "application/json",
              fields: [
                { name: "name", type: { kind: "primitive", type: "string" }, required: true },
                {
                  name: "acl",
                  required: false,
                  type: {
                    kind: "optional",
                    inner: {
                      kind: "object",
                      fields: [
                        {
                          name: "add",
                          required: false,
                          type: {
                            kind: "array",
                            items: {
                              kind: "object",
                              fields: [
                                {
                                  name: "principal",
                                  type: { kind: "primitive", type: "string" },
                                  required: true,
                                },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    // Sibling TypedDict for the `acl` object — named via parent + field path.
    expect(out).toContain("class TeamCreateInputAcl(TypedDict, total=False):");
    // Sibling TypedDict for the array items inside `acl.add`.
    expect(out).toContain("class TeamCreateInputAclAddItem(TypedDict):");
    expect(out).toContain("principal: str");
    // Parent reference uses the hoisted name, not dict[str, object].
    // Raw emitter renders Optional[X]; ruff's pyupgrade rewrites to `X | None`
    // post-generation in the SDK repo, but we assert raw output here.
    expect(out).toContain("acl: Optional[TeamCreateInputAcl]");
    expect(out).toContain("add: list[TeamCreateInputAclAddItem]");
  });

  it("maps empty objects (genuine freeform metadata) to dict[str, Any]", () => {
    const out = emitPythonResourceFile(
      {
        name: "teams",
        className: "TeamResource",
        path: "/teams",
        scopeParams: [],
        operations: [
          {
            name: "create",
            operationId: "post_team",
            method: "POST",
            path: "/api/v1/teams",
            deprecated: false,
            pathParams: [],
            queryParams: [],
            body: {
              schema: "CreateInput",
              contentType: "application/json",
              fields: [
                { name: "name", type: { kind: "primitive", type: "string" }, required: true },
                {
                  name: "metadata",
                  required: false,
                  type: {
                    kind: "optional",
                    // Object with NO fields = freeform key/value bag.
                    inner: { kind: "object", fields: [] },
                  },
                },
              ],
            },
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    expect(out).toContain("metadata: Optional[dict[str, Any]]");
    expect(out).not.toContain("class TeamCreateInputMetadata");
  });

  it("hoists nested inline objects in response models as sibling BaseModels", () => {
    const out = emitPythonResourceFile(
      {
        name: "teams",
        className: "TeamResource",
        path: "/teams",
        scopeParams: [],
        operations: [
          {
            name: "list",
            operationId: "get_teams",
            method: "GET",
            path: "/api/v1/teams",
            deprecated: false,
            pathParams: [],
            queryParams: [],
            returnType: {
              kind: "object",
              fields: [
                {
                  name: "data",
                  required: false,
                  type: {
                    kind: "optional",
                    inner: {
                      kind: "array",
                      items: {
                        kind: "object",
                        fields: [
                          { name: "id", type: { kind: "primitive", type: "string" }, required: true },
                          { name: "name", type: { kind: "primitive", type: "string" }, required: true },
                        ],
                      },
                    },
                  },
                },
              ],
            },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    expect(out).toContain("class TeamListResponseDataItem(BaseModel):");
    expect(out).toContain("class TeamListResponse(BaseModel):");
    expect(out).toContain("data: Optional[list[TeamListResponseDataItem]] = None");
  });

  it("hoists nested inline objects inside channel push payloads as sibling TypedDicts", () => {
    const out = emitPythonChannelFile({
      name: "Doc",
      className: "DocChannel",
      joins: [
        {
          topicPattern: "doc",
          name: "join",
          params: [],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [],
      pushes: [
        {
          event: "snapshot",
          payloadType: {
            kind: "object",
            fields: [
              {
                name: "cursor",
                required: false,
                type: {
                  kind: "optional",
                  inner: {
                    kind: "object",
                    fields: [
                      { name: "line", type: { kind: "primitive", type: "integer" }, required: true },
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    });
    expect(out).toContain("class SnapshotPayloadCursor(TypedDict):");
    expect(out).toContain("cursor: Optional[SnapshotPayloadCursor]");
  });

  it("emits a Pydantic response model for inline-object response schemas", () => {
    // The frontend parses inline `{type: object, properties: ...}` responses
    // as TypeRef.kind === "object". Emitter must hoist these as named
    // BaseModels so callers do `result.data` instead of `result["data"]`.
    const out = emitPythonResourceFile(
      {
        name: "teams",
        className: "TeamResource",
        path: "/teams",
        scopeParams: [],
        operations: [
          {
            name: "list",
            operationId: "get_teams",
            method: "GET",
            path: "/api/v1/teams",
            deprecated: false,
            pathParams: [],
            queryParams: [],
            returnType: {
              kind: "object",
              fields: [
                {
                  name: "data",
                  type: {
                    kind: "optional",
                    inner: { kind: "array", items: { kind: "ref", schema: "Team" } },
                  },
                  required: false,
                },
                {
                  name: "has_next",
                  type: {
                    kind: "optional",
                    inner: { kind: "primitive", type: "boolean" },
                  },
                  required: false,
                },
              ],
            },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    expect(out).toContain("from pydantic import BaseModel");
    expect(out).toContain("class TeamListResponse(BaseModel):");
    expect(out).toContain("data: Optional[list[Team]] = None");
    expect(out).toContain("has_next: Optional[bool] = None");
    expect(out).toContain("async def list(self) -> TeamListResponse:");
  });

  it("imports Pydantic alias helpers for keyword fields in inline response models", () => {
    const out = emitPythonResourceFile(
      {
        name: "tools",
        className: "ToolResource",
        path: "/tools",
        scopeParams: [],
        operations: [
          {
            name: "list",
            operationId: "get_tools",
            method: "GET",
            path: "/api/v1/tools",
            deprecated: false,
            pathParams: [],
            queryParams: [],
            returnType: {
              kind: "object",
              fields: [
                {
                  name: "async",
                  type: {
                    kind: "optional",
                    inner: { kind: "primitive", type: "boolean" },
                  },
                  required: false,
                },
              ],
            },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );

    expect(out).toContain("from pydantic import BaseModel, ConfigDict, Field");
    expect(out).toContain("class ToolListResponse(BaseModel):");
    expect(out).toContain("model_config = ConfigDict(populate_by_name=True)");
    expect(out).toContain('async_: Optional[bool] = Field(default=None, alias="async")');
  });

  it("prefixes inline-response class names with the resource short name", () => {
    // Two sibling resources both have a `list` op with inline responses.
    // The emitted models must not collide.
    const team = {
      name: "teams",
      className: "TeamResource",
      path: "/teams",
      scopeParams: [],
      operations: [
        {
          name: "list",
          operationId: "get_teams",
          method: "GET" as const,
          path: "/api/v1/teams",
          deprecated: false,
          pathParams: [],
          queryParams: [],
          returnType: {
            kind: "object" as const,
            fields: [
              { name: "id", type: { kind: "primitive" as const, type: "string" as const }, required: true },
            ],
          },
          errors: [],
        },
      ],
      children: [
        {
          name: "members",
          className: "MemberResource",
          path: "/teams/{team}/members",
          scopeParams: [],
          operations: [
            {
              name: "list",
              operationId: "get_members",
              method: "GET" as const,
              path: "/api/v1/teams/{team}/members",
              deprecated: false,
              pathParams: [
                { name: "team", type: { kind: "primitive" as const, type: "string" as const }, required: true },
              ],
              queryParams: [],
              returnType: {
                kind: "object" as const,
                fields: [
                  { name: "id", type: { kind: "primitive" as const, type: "string" as const }, required: true },
                ],
              },
              errors: [],
            },
          ],
          children: [],
        },
      ],
    };
    const out = emitPythonResourceFile(team, "/api/v1");
    expect(out).toContain("class TeamListResponse(BaseModel):");
    expect(out).toContain("class MemberListResponse(BaseModel):");
  });

  it("leaves $ref response types alone (no inline model emitted)", () => {
    const out = emitPythonResourceFile(
      {
        name: "agents",
        className: "AgentResource",
        path: "/agents",
        scopeParams: [],
        operations: [
          {
            name: "list",
            operationId: "get_agents",
            method: "GET",
            path: "/api/v1/agents",
            deprecated: false,
            pathParams: [],
            queryParams: [],
            returnType: { kind: "ref", schema: "AgentListResponse" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    expect(out).toContain("-> AgentListResponse:");
    expect(out).not.toContain("class AgentListResponse(BaseModel)");
  });

  it("types empty inline responses as dict[str, Any]", () => {
    const out = emitPythonResourceFile(
      {
        name: "ping",
        className: "PingResource",
        path: "/ping",
        scopeParams: [],
        operations: [
          {
            name: "ping",
            operationId: "get_ping",
            method: "GET",
            path: "/api/v1/ping",
            deprecated: false,
            pathParams: [],
            queryParams: [],
            returnType: { kind: "object", fields: [] },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    expect(out).toContain("-> Dict[str, Any]:");
    expect(out).not.toContain("(BaseModel)");
  });

  it("splays query params as keyword-only args with types and None defaults", () => {
    const out = emitPythonResourceFile(
      {
        name: "teams",
        className: "TeamResource",
        path: "/teams",
        scopeParams: [],
        operations: [
          {
            name: "list",
            operationId: "get_teams",
            method: "GET",
            path: "/api/v1/teams",
            deprecated: false,
            pathParams: [],
            queryParams: [
              {
                name: "page",
                type: { kind: "primitive", type: "integer" },
                required: false,
                description: "Page number",
              },
              {
                name: "page_size",
                type: { kind: "primitive", type: "integer" },
                required: false,
              },
              {
                name: "sort",
                type: { kind: "primitive", type: "string" },
                required: false,
              },
            ],
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    expect(out).toContain(
      "async def list(self, *, page: int | None = None, page_size: int | None = None, sort: str | None = None)"
    );
    // Should NOT use the **params catch-all anymore.
    expect(out).not.toContain("**params");
  });

  it("emits required query params before the `*` separator with no default", () => {
    const out = emitPythonResourceFile(
      {
        name: "search",
        className: "SearchResource",
        path: "/search",
        scopeParams: [],
        operations: [
          {
            name: "run",
            operationId: "get_search",
            method: "GET",
            path: "/api/v1/search",
            deprecated: false,
            pathParams: [],
            queryParams: [
              {
                name: "q",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
              {
                name: "limit",
                type: { kind: "primitive", type: "integer" },
                required: false,
              },
            ],
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    expect(out).toContain(
      "async def run(self, q: str, *, limit: int | None = None)"
    );
  });

  it("drops optional query params from the dict when caller passes None", () => {
    // We render a literal dict in the call site so consumers don't need to
    // think about which keys to omit. The runtime can drop None values, but
    // exposing them as `None` keys in the wire dict is wrong — verify the
    // emitter builds a conditional dict instead.
    const out = emitPythonResourceFile(
      {
        name: "teams",
        className: "TeamResource",
        path: "/teams",
        scopeParams: [],
        operations: [
          {
            name: "list",
            operationId: "get_teams",
            method: "GET",
            path: "/api/v1/teams",
            deprecated: false,
            pathParams: [],
            queryParams: [
              {
                name: "page",
                type: { kind: "primitive", type: "integer" },
                required: false,
              },
            ],
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    // Build query dict only with non-None values so the runtime never sends
    // `?page=null` and the user can omit any optional kwarg.
    expect(out).toMatch(/query: dict\[str, object\] = \{\}/);
    expect(out).toMatch(/if page is not None:\s+query\["page"\] = page/);
    expect(out).toContain('return await self._http.request(f"/api/v1/teams", query=query)');
  });

  it("sanitizes Python keyword query params while preserving wire keys", () => {
    const out = emitPythonResourceFile(
      {
        name: "agent_tools",
        className: "AgentToolResource",
        path: "/agent_tools",
        scopeParams: [],
        operations: [
          {
            name: "list",
            operationId: "list_agent_tools",
            method: "GET",
            path: "/api/v1/agent_tools",
            deprecated: false,
            pathParams: [],
            queryParams: [
              {
                name: "async",
                type: { kind: "primitive", type: "boolean" },
                required: false,
              },
            ],
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );

    expect(out).toContain("async def list(self, *, async_: bool | None = None)");
    expect(out).toContain("if async_ is not None:");
    expect(out).toContain('query["async"] = async_');
    expect(out).not.toContain("async: bool | None");
  });

  it("uses OpenAPI wire names for SDK-renamed query params", () => {
    const out = emitPythonResourceFile(
      {
        name: "slack_channel_bindings",
        className: "SlackChannelBindingResource",
        path: "/slack_channel_bindings",
        scopeParams: [],
        operations: [
          {
            name: "get",
            operationId: "get_slack_channel_binding",
            method: "GET",
            path: "/api/v1/slack_channel_bindings/{channel}",
            deprecated: false,
            pathParams: [
              {
                name: "channel",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
            queryParams: [
              {
                name: "slackTeamId",
                wireName: "slack_team_id",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
              {
                name: "perPage",
                wireName: "per_page",
                type: { kind: "primitive", type: "integer" },
                required: false,
              },
            ],
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );

    expect(out).toContain(
      "async def get(self, channel: str, slack_team_id: str, *, per_page: int | None = None)"
    );
    expect(out).toContain('query["slack_team_id"] = slack_team_id');
    expect(out).toContain('query["per_page"] = per_page');
    expect(out).not.toContain('query["slackTeamId"]');
    expect(out).not.toContain('query["perPage"]');
  });

  it("uniquely sanitizes colliding Python query params while preserving wire keys", () => {
    const out = emitPythonResourceFile(
      {
        name: "agent_tools",
        className: "AgentToolResource",
        path: "/agent_tools",
        scopeParams: [],
        operations: [
          {
            name: "list",
            operationId: "list_agent_tools",
            method: "GET",
            path: "/api/v1/agent_tools",
            deprecated: false,
            pathParams: [],
            queryParams: [
              {
                name: "async",
                type: { kind: "primitive", type: "boolean" },
                required: false,
              },
              {
                name: "async_",
                type: { kind: "primitive", type: "string" },
                required: false,
              },
            ],
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );

    expect(out).toContain(
      "async def list(self, *, async_: bool | None = None, async_2: str | None = None)"
    );
    expect(out).toContain('query["async"] = async_');
    expect(out).toContain('query["async_"] = async_2');
  });

  it("imports Literal when only query params use enum types", () => {
    const out = emitPythonResourceFile(
      {
        name: "knowledge_sources",
        className: "KnowledgeSourceResource",
        path: "/knowledge_sources",
        scopeParams: [],
        operations: [
          {
            name: "list",
            operationId: "list_knowledge_sources",
            method: "GET",
            path: "/api/v1/knowledge_sources",
            deprecated: false,
            pathParams: [],
            queryParams: [
              {
                name: "ownerScope",
                type: { kind: "enum", values: ["any", "individual", "system"] },
                required: false,
              },
            ],
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );

    expect(out).toContain("from typing import Any, Literal");
    expect(out).toContain(
      'owner_scope: Literal["any", "individual", "system"] | None = None'
    );
  });

  it("imports `datetime` when a TypedDict body field uses it", () => {
    const out = emitPythonResourceFile(
      {
        name: "events",
        className: "EventResource",
        path: "/events",
        scopeParams: [],
        operations: [
          {
            name: "create",
            operationId: "post_event",
            method: "POST",
            path: "/api/v1/events",
            deprecated: false,
            pathParams: [],
            queryParams: [],
            body: {
              schema: "CreateInput",
              contentType: "application/json",
              fields: [
                {
                  name: "scheduled_at",
                  type: { kind: "primitive", type: "datetime" },
                  required: true,
                },
              ],
            },
            returnType: { kind: "unknown" },
            errors: [],
          },
        ],
        children: [],
      },
      "/api/v1"
    );
    expect(out).toContain("from datetime import datetime");
    expect(out).toContain("scheduled_at: datetime");
  });
});

describe("Python channel emitter typed payloads", () => {
  it("keeps `payload: dict` for messages with no params (nothing to type)", () => {
    const out = emitPythonChannelFile({
      name: "Ping",
      className: "PingChannel",
      joins: [
        {
          topicPattern: "ping",
          name: "join",
          params: [],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [
        {
          event: "ping",
          params: [],
          returnType: { kind: "unknown" },
        },
      ],
      pushes: [],
    });
    expect(out).toContain("async def ping(self, payload: dict)");
    expect(out).not.toContain("class PingInput(TypedDict");
  });

  it("does not emit a TypedDict for non-object push payloads but still types the callback", () => {
    const out = emitPythonChannelFile({
      name: "Cursor",
      className: "CursorChannel",
      joins: [
        {
          topicPattern: "cursor",
          name: "join",
          params: [],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [],
      pushes: [
        {
          event: "tick",
          payloadType: { kind: "primitive", type: "integer" },
        },
      ],
    });
    expect(out).not.toContain("class TickPayload(TypedDict");
    expect(out).toContain("def on_tick(self, callback: Callable[[int], None]) -> Callable[[], None]");
  });

  it("uses the existing Pydantic model name when push payload is a $ref", () => {
    const out = emitPythonChannelFile({
      name: "Doc",
      className: "DocChannel",
      joins: [
        {
          topicPattern: "doc",
          name: "join",
          params: [],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [],
      pushes: [
        {
          event: "snapshot",
          payloadType: { kind: "ref", schema: "Document" },
        },
      ],
    });
    expect(out).not.toContain("class SnapshotPayload(TypedDict");
    expect(out).toContain("callback: Callable[[Document], None]");
  });

  it("falls back to dict[str, object] for an empty inline-object push payload", () => {
    const out = emitPythonChannelFile({
      name: "Vacuum",
      className: "VacuumChannel",
      joins: [
        {
          topicPattern: "vac",
          name: "join",
          params: [],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [],
      pushes: [
        {
          event: "anything",
          payloadType: { kind: "object", fields: [] },
        },
      ],
    });
    expect(out).toContain("callback: Callable[[dict[str, object]], None]");
    expect(out).not.toContain("class AnythingPayload(TypedDict");
  });

  it("includes the spec description on the generated TypedDict class", () => {
    const out = emitPythonChannelFile({
      name: "Chat",
      className: "ChatChannel",
      joins: [
        {
          topicPattern: "chat",
          name: "join",
          params: [],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [
        {
          event: "send_message",
          description: "Send a chat message",
          params: [
            { name: "content", type: { kind: "primitive", type: "string" }, required: true },
          ],
          returnType: { kind: "unknown" },
        },
      ],
      pushes: [],
    });
    expect(out).toContain("# Send a chat message");
    expect(out).toContain("class SendMessageInput(TypedDict):");
    expect(out).toContain("content: str");
  });

  it("imports `datetime` when a generated TypedDict uses it", () => {
    const out = emitPythonChannelFile({
      name: "Stamp",
      className: "StampChannel",
      joins: [
        {
          topicPattern: "stamp",
          name: "join",
          params: [],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [
        {
          event: "tick",
          params: [
            { name: "at", type: { kind: "primitive", type: "datetime" }, required: true },
          ],
          returnType: { kind: "unknown" },
        },
      ],
      pushes: [],
    });
    expect(out).toContain("from datetime import datetime");
    expect(out).toContain("at: datetime");
  });
});

describe("Python channel emitter edge cases", () => {
  it("emits await channel.join() with no args when all params are topic-only", () => {
    const out = emitPythonChannelFile({
      name: "Object",
      className: "ObjectChannel",
      joins: [
        {
          topicPattern: "object:{object_id}",
          name: "join_by_id",
          params: [
            {
              name: "objectId",
              type: { kind: "primitive", type: "string" },
              required: true,
            },
          ],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [],
      pushes: [],
    });
    expect(out).toContain(
      'async def join_by_id(cls, socket: "Socket", object_id: str) -> "ObjectChannel":'
    );
    expect(out).toContain("join_response = await channel.join()");
    expect(out).not.toContain("payload: dict");
  });

  it("emits required payload params without default and without None guard", () => {
    const out = emitPythonChannelFile({
      name: "Required",
      className: "RequiredChannel",
      joins: [
        {
          topicPattern: "room:{room_id}",
          name: "join_room",
          params: [
            {
              name: "roomId",
              type: { kind: "primitive", type: "string" },
              required: true,
            },
            {
              name: "token",
              type: { kind: "primitive", type: "string" },
              required: true,
            },
            {
              name: "limit",
              type: { kind: "primitive", type: "integer" },
              required: false,
            },
          ],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [],
      pushes: [],
    });
    expect(out).toContain(
      'async def join_room(cls, socket: "Socket", room_id: str, *, token: str, limit: int | None = None) -> "RequiredChannel":'
    );
    expect(out).toContain('payload["token"] = token');
    expect(out).toContain("if limit is not None:");
    expect(out).toContain('payload["limit"] = limit');
    expect(out).toContain("join_response = await channel.join(payload)");
  });

  it("preserves the spec field name as the payload key when the kwarg is snake_cased", () => {
    const out = emitPythonChannelFile({
      name: "Casing",
      className: "CasingChannel",
      joins: [
        {
          topicPattern: "doc:{docId}",
          name: "join_document",
          params: [
            {
              name: "docId",
              type: { kind: "primitive", type: "string" },
              required: true,
            },
            {
              name: "userId",
              type: { kind: "primitive", type: "string" },
              required: true,
            },
            {
              name: "afterCursor",
              type: { kind: "primitive", type: "string" },
              required: false,
            },
          ],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [],
      pushes: [],
    });
    // Kwarg is snake_case for idiom, but the dict key must match the spec's
    // field name — otherwise the wire field is renamed and server-side
    // validation rejects a payload the caller thought was correct.
    expect(out).toContain("user_id: str");
    expect(out).toContain('payload["userId"] = user_id');
    expect(out).toContain("after_cursor: str | None = None");
    expect(out).toContain('payload["afterCursor"] = after_cursor');
    expect(out).not.toContain('payload["user_id"]');
    expect(out).not.toContain('payload["after_cursor"]');
  });

  it("uniquifies topic and payload params after keyword sanitization", () => {
    const out = emitPythonChannelFile({
      name: "KeywordJoin",
      className: "KeywordJoinChannel",
      joins: [
        {
          topicPattern: "room:{async}",
          name: "join_async",
          params: [
            {
              name: "async",
              type: { kind: "primitive", type: "string" },
              required: true,
            },
            {
              name: "async_",
              type: { kind: "primitive", type: "string" },
              required: true,
            },
          ],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [],
      pushes: [],
    });

    expect(out).toContain("def topic_async(async_: str) -> str:");
    expect(out).toContain(
      'async def join_async(cls, socket: "Socket", async_: str, *, async_2: str) -> "KeywordJoinChannel":'
    );
    expect(out).toContain("topic = cls.topic_async(async_)");
    expect(out).toContain('payload["async_"] = async_2');
    expect(out).not.toMatch(/payload\["async_"\] = async_\n/);
  });

  it("keeps distinct payload params when only their snake_case form matches the topic var", () => {
    const out = emitPythonChannelFile({
      name: "CaseCollision",
      className: "CaseCollisionChannel",
      joins: [
        {
          topicPattern: "room:{fooBar}",
          name: "join_room",
          params: [
            {
              name: "foo_bar",
              type: { kind: "primitive", type: "string" },
              required: true,
            },
          ],
          returnType: { kind: "unknown" },
        },
      ],
      messages: [],
      pushes: [],
    });

    expect(out).toContain(
      'async def join_room(cls, socket: "Socket", foo_bar: str, *, foo_bar_2: str) -> "CaseCollisionChannel":'
    );
    expect(out).toContain("topic = cls.topic_room(foo_bar)");
    expect(out).toContain('payload["foo_bar"] = foo_bar_2');
    expect(out).toContain("join_response = await channel.join(payload)");
  });
});

describe("Full Python generation", () => {
  const files = generatePython(ast, { outDir: "/tmp/test-python-sdk" });

  it("generates type files", () => {
    const typeFiles = Object.keys(files).filter((f) => f.includes("/types/"));
    expect(typeFiles.length).toBeGreaterThan(0);
    expect(
      files["/tmp/test-python-sdk/src/archastro/platform/types/__init__.py"]
    ).toBeDefined();
  });

  it("generates versioned resource files", () => {
    expect(
      files["/tmp/test-python-sdk/src/archastro/platform/v1/resources/teams.py"]
    ).toBeDefined();
    expect(
      files[
        "/tmp/test-python-sdk/src/archastro/platform/v1/resources/agents.py"
      ]
    ).toBeDefined();
    // Namespace file
    expect(
      files["/tmp/test-python-sdk/src/archastro/platform/v1/__init__.py"]
    ).toBeDefined();
  });

  it("generates client file", () => {
    const client =
      files["/tmp/test-python-sdk/src/archastro/platform/client.py"]!;
    expect(client).toBeDefined();
    expect(client).toContain("class PlatformClient:");
    expect(client).toContain("AsyncPlatformClient");
    expect(client).not.toContain("PlatformClient = AsyncPlatformClient");
  });

  it("generates channel files", () => {
    expect(
      files["/tmp/test-python-sdk/src/archastro/platform/channels/chat.py"]
    ).toBeDefined();
  });

  it("generates package __init__.py with PlatformClient, AsyncPlatformClient, and version from metadata", () => {
    const init =
      files["/tmp/test-python-sdk/src/archastro/platform/__init__.py"]!;
    expect(init).toContain("from .client import AsyncPlatformClient, PlatformClient");
    expect(init).toContain("from .v1 import V1");
    expect(init).toContain("_pkg_version");
    // The distro-name passed to importlib.metadata must match the
    // configured SDK name so `__version__` resolves for whatever package
    // the SDK is published under.
    expect(init).toContain(`_pkg_version("${ast.name}")`);
  });

  it("versioned resource files use correct import depth", () => {
    const teamResource =
      files[
        "/tmp/test-python-sdk/src/archastro/platform/v1/resources/teams.py"
      ]!;
    expect(teamResource).toContain(
      "from ...runtime.http_client import HttpClient"
    );
  });
});

describe("Multi-version Python generation", () => {
  const multiAst = parseOpenApiSpec(versionedFixture, {
    name: "archastro-platform",
    version: "0.2.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });

  const pkg = "/tmp/test-multi-python-sdk/src/archastro/platform";
  const files = generatePython(multiAst, {
    outDir: "/tmp/test-multi-python-sdk",
  });

  it("generates v1 and v2 resource directories", () => {
    expect(files[`${pkg}/v1/resources/teams.py`]).toBeDefined();
    expect(files[`${pkg}/v1/resources/agents.py`]).toBeDefined();
    expect(files[`${pkg}/v2/resources/teams.py`]).toBeDefined();
    expect(files[`${pkg}/v2/resources/agents.py`]).toBeDefined();
    expect(files[`${pkg}/v2/resources/workflows.py`]).toBeDefined();
  });

  it("generates namespace files for both versions", () => {
    expect(files[`${pkg}/v1/__init__.py`]).toBeDefined();
    expect(files[`${pkg}/v1/__init__.py`]).toContain("class V1:");
    expect(files[`${pkg}/v1/__init__.py`]).toContain("class AsyncV1:");

    expect(files[`${pkg}/v2/__init__.py`]).toBeDefined();
    expect(files[`${pkg}/v2/__init__.py`]).toContain("class V2:");
    expect(files[`${pkg}/v2/__init__.py`]).toContain("class AsyncV2:");
  });

  it("v2 namespace has workflows but v1 does not", () => {
    const v1Ns = files[`${pkg}/v1/__init__.py`]!;
    const v2Ns = files[`${pkg}/v2/__init__.py`]!;
    expect(v1Ns).not.toContain("workflows");
    expect(v2Ns).toContain("self.workflows = WorkflowResource(http)");
    expect(v2Ns).toContain("self.workflows = AsyncWorkflowResource(http)");
  });

  it("version namespaces include sync and async resource namespaces", () => {
    const v1Ns = files[`${pkg}/v1/__init__.py`]!;
    expect(v1Ns).toContain("class V1:");
    expect(v1Ns).toContain("class AsyncV1:");
    expect(v1Ns).toContain("from .resources.teams import AsyncTeamResource, TeamResource");
    expect(v1Ns).toContain("def __init__(self, http: SyncHttpClient):");
    expect(v1Ns).toContain("def __init__(self, http: HttpClient):");
    expect(v1Ns).toContain("self.teams = TeamResource(http)");
    expect(v1Ns).toContain("self.teams = AsyncTeamResource(http)");
    expect(v1Ns).not.toContain("SyncTeamResource");
    expect(v1Ns).not.toContain("class SyncV1:");
  });

  it("client has both v1 and v2 namespaces", () => {
    const client = files[`${pkg}/client.py`]!;
    expect(client).toContain("self.v1 = AsyncV1(self._http)");
    expect(client).toContain("self.v1 = V1(self._http)");
    expect(client).toContain("self.v2 = AsyncV2(self._http)");
    expect(client).toContain("self.v2 = V2(self._http)");
    expect(client).not.toContain("SyncV1");
    expect(client).not.toContain("SyncV2");
  });

  it("client has backward-compat aliases to default version (v1)", () => {
    const client = files[`${pkg}/client.py`]!;
    expect(client).toContain("self.teams = self.v1.teams");
    expect(client).toContain("self.agents = self.v1.agents");
    // Should NOT alias v2-only resources
    expect(client).not.toContain("self.workflows");
  });

  it("v1 resources use /api/v1/ paths", () => {
    const v1Teams = files[`${pkg}/v1/resources/teams.py`]!;
    expect(v1Teams).toContain('f"/api/v1/teams"');
  });

  it("v2 resources use /api/v2/ paths", () => {
    const v2Teams = files[`${pkg}/v2/resources/teams.py`]!;
    expect(v2Teams).toContain('f"/api/v2/teams"');
  });

  it("package __init__.py exports both version namespaces", () => {
    const init = files[`${pkg}/__init__.py`]!;
    expect(init).toContain("from .v1 import V1");
    expect(init).toContain("from .v1 import AsyncV1");
    expect(init).toContain("from .v2 import V2");
    expect(init).toContain("from .v2 import AsyncV2");
  });

  it("types are shared, not duplicated per version", () => {
    const typeFiles = Object.keys(files).filter((f) => f.includes("/types/"));
    expect(typeFiles.every((f) => f.startsWith(`${pkg}/types/`))).toBe(true);
  });

  it("generates version directory __init__.py files", () => {
    expect(files[`${pkg}/v1/__init__.py`]).toBeDefined();
    expect(files[`${pkg}/v2/__init__.py`]).toBeDefined();
    expect(files[`${pkg}/v1/resources/__init__.py`]).toBeDefined();
    expect(files[`${pkg}/v2/resources/__init__.py`]).toBeDefined();
  });
});

describe("Python channel contract test emitter", () => {
  const chat = ast.channels.find((c) => c.name === "Chat")!;
  const output = emitPythonChannelContractTestFile(
    chat,
    "archastro.platform.channels.chat"
  );

  it("imports phx_channel HarnessServiceClient + ChannelError + the channel class", () => {
    expect(output).toContain("from archastro.phx_channel import HarnessServiceClient");
    expect(output).toContain("from archastro.phx_channel.channel import ChannelError");
    expect(output).toContain(
      "from archastro.platform.channels.chat import ChatChannel"
    );
  });

  it("exposes a `rig` fixture that resets + opens a socket through the harness client", () => {
    // Use @pytest_asyncio.fixture (not @pytest.fixture) so the async fixture
    // works regardless of the consumer's asyncio_mode setting.
    expect(output).toContain("@pytest_asyncio.fixture");
    expect(output).toContain("async def rig(harness_service)");
    expect(output).toContain(
      'ws_url=harness_service["wsUrl"]'
    );
    expect(output).toContain("await client.reset()");
    expect(output).toContain("await client.open_socket()");
  });

  it("marks the module as async so strict asyncio_mode consumers still work", () => {
    expect(output).toContain("pytestmark = pytest.mark.asyncio");
    expect(output).toContain("import pytest_asyncio");
  });

  it("emits a join happy-path test via the generated classmethod", () => {
    expect(output).toContain(
      "async def test_chat_join_team_thread_joins_and_receives_contract_valid_reply(rig)"
    );
    expect(output).toContain(
      "channel = await ChatChannel.join_team_thread(socket, \"test-id\", \"test-id\""
    );
    expect(output).toContain("assert isinstance(channel, ChatChannel)");
    expect(output).toContain("assert channel.join_response is not None");
  });

  it("registers replyError scenarios over HTTP, not closures", () => {
    expect(output).toContain("await client.register_scenario({");
    expect(output).toContain(
      '"topic": "api:chat:team:test-id:thread:test-id"'
    );
    expect(output).toContain(
      '"onJoin": [{"type": "replyError", "payload": {"reason": "test_error"}}]'
    );
    expect(output).toContain("with pytest.raises(ChannelError)");
  });

  it("drives the raw socket for missing-required-param joins to bypass the typed kwarg guard", () => {
    // Chat's required params are all topic vars, so the generator correctly
    // skips the missing-required test. Use an inline channel with a genuine
    // payload-required field to exercise the raw-socket guard path.
    const out = emitPythonChannelContractTestFile(
      {
        name: "Room",
        className: "RoomChannel",
        joins: [
          {
            topicPattern: "room:{room_id}",
            name: "join_room",
            params: [
              {
                name: "room_id",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
              {
                name: "token",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
            returnType: { kind: "unknown" },
          },
        ],
        messages: [],
        pushes: [],
      },
      "archastro.platform.channels.room"
    );
    expect(out).toContain(
      "async def test_room_join_room_rejects_when_required_params_missing(rig)"
    );
    expect(out).toContain('channel = socket.channel("room:test-id")');
    expect(out).toContain("await channel.join({})");
    expect(out).toContain("with pytest.raises(ChannelError)");
  });

  it("emits a happy-push test that asserts reply envelope + observed params", () => {
    expect(output).toContain(
      'async def test_chat_send_message_sends_valid_push_and_receives_contract_valid_reply(rig)'
    );
    expect(output).toContain(
      '"onMessage": {'
    );
    expect(output).toContain(
      '"send_message": [{"type": "autoReply"}]'
    );
    expect(output).toContain(
      "reply = await channel.send_message("
    );
    expect(output).toContain('assert reply["status"] == "ok"');
    expect(output).toContain(
      'observed = await client.observations("api:chat:team:test-id:thread:test-id", "send_message")'
    );
    expect(output).toContain('assert observed[0]["params"]["content"] == "test content"');
  });

  it("emits an error-envelope test when a push has required fields", () => {
    expect(output).toContain(
      "async def test_chat_send_message_returns_error_envelope_when_required_missing(rig)"
    );
    expect(output).toContain("reply = await channel.send_message({})");
    expect(output).toContain('assert reply["status"] == "error"');
  });

  it("emits an autoPush handler test per server-push event", () => {
    expect(output).toContain(
      "async def test_chat_on_message_added_delivers_contract_valid_payloads(rig)"
    );
    expect(output).toContain(
      '{"type": "autoPush", "event": "message_added"}'
    );
    expect(output).toContain("channel.on_message_added(handler)");
    expect(output).toContain(
      "payload = await asyncio.wait_for(future, timeout=1.0)"
    );
  });

  it("emits a clean-leave test", () => {
    expect(output).toContain(
      "async def test_chat_leave_leaves_cleanly_through_generated_leave(rig)"
    );
    expect(output).toContain("await channel.leave()");
  });

  it("matches runtime-safe names for keyword channel methods and join kwargs", () => {
    const out = emitPythonChannelContractTestFile(
      {
        name: "Keyword",
        className: "KeywordChannel",
        joins: [
          {
            topicPattern: "keyword:{async}",
            name: "join_async",
            params: [
              {
                name: "async",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
              {
                name: "async_",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
            returnType: { kind: "unknown" },
          },
        ],
        messages: [
          {
            event: "async",
            params: [
              {
                name: "content",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
            returnType: { kind: "object", fields: [] },
          },
        ],
        pushes: [
          {
            event: "async",
            payloadType: {
              kind: "object",
              fields: [
                {
                  name: "content",
                  type: { kind: "primitive", type: "string" },
                  required: true,
                },
              ],
            },
          },
        ],
      },
      "archastro.platform.channels.keyword"
    );

    expect(out).toContain(
      'channel = await KeywordChannel.join_async(socket, "test-value", async_2="test-value")'
    );
    expect(out).toContain("reply = await channel.async_(");
    expect(out).toContain("channel.on_async_(handler)");
    expect(out).not.toContain("channel.async(");
    expect(out).not.toContain("channel.on_async(handler)");
    expect(out).not.toContain("async_=\"test-value\"");
  });

  it("does not drop payload kwargs whose snake_case matches a camelCase topic var", () => {
    const out = emitPythonChannelContractTestFile(
      {
        name: "CaseCollision",
        className: "CaseCollisionChannel",
        joins: [
          {
            topicPattern: "room:{fooBar}",
            name: "join_room",
            params: [
              {
                name: "foo_bar",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
            returnType: { kind: "unknown" },
          },
        ],
        messages: [],
        pushes: [],
      },
      "archastro.platform.channels.case_collision"
    );

    expect(out).toContain(
      'channel = await CaseCollisionChannel.join_room(socket, "test-value", foo_bar_2="test-value")'
    );
    expect(out).toContain('await channel.join({})');
    expect(out).not.toContain(
      'CaseCollisionChannel.join_room(socket, "test-value")'
    );
  });
});

describe("Python contract-tests emitter wires channels into the conftest", () => {
  it("adds harness-service spawn + fixture when channels exist", () => {
    const files = emitPythonContractTests(ast, { outDir: "/tmp/test-python-sdk" });
    const conftest = files["/tmp/test-python-sdk/tests/contract/conftest.py"]!;

    expect(conftest).toContain("_start_harness_service()");
    expect(conftest).toContain("_stop_harness_service()");
    expect(conftest).toContain('ARCHASTRO_HARNESS_WS_URL');
    expect(conftest).toContain('ARCHASTRO_HARNESS_CONTROL_URL');
    expect(conftest).toContain("def harness_service()");
    expect(conftest).toContain("@archastro/channel-harness/dist/bin.js");
  });

  it("uses locked local Node tooling instead of npx or ad hoc npm install guidance", () => {
    const files = emitPythonContractTests(ast, { outDir: "/tmp/test-python-sdk" });
    const conftest = files["/tmp/test-python-sdk/tests/contract/conftest.py"]!;

    expect(conftest).toContain("PRISM_BIN = os.environ.get(");
    expect(conftest).toContain("../../node_modules/.bin/prism");
    expect(conftest).toContain("[PRISM_BIN,");
    expect(conftest).toContain("npm ci --ignore-scripts");
    expect(conftest).not.toContain('"npx"');
    expect(conftest).not.toContain("npm install @archastro/channel-harness");
  });

  it("uses deterministic Prism responses for generated shape contracts", () => {
    const files = emitPythonContractTests(ast, { outDir: "/tmp/test-python-sdk" });
    const conftest = files["/tmp/test-python-sdk/tests/contract/conftest.py"]!;

    expect(conftest).not.toContain('"--dynamic"');
  });

  it("emits per-channel test files under tests/contract/channels/", () => {
    const files = emitPythonContractTests(ast, { outDir: "/tmp/test-python-sdk" });
    expect(
      files["/tmp/test-python-sdk/tests/contract/channels/test_chat.py"]
    ).toBeDefined();
  });

  it("omits harness plumbing when the spec has no channels", () => {
    const chanlessSpec = parseOpenApiSpec(
      {
        openapi: "3.0.0",
        info: { title: "No channels", version: "1.0.0" },
        paths: {},
      },
      {
        name: "archastro-platform",
        version: "0.1.0",
        baseUrl: "https://platform.archastro.ai",
        apiBase: "/api",
        defaultVersion: "v1",
      }
    );
    const files = emitPythonContractTests(chanlessSpec, {
      outDir: "/tmp/test-python-sdk-chanless",
    });
    const conftest =
      files["/tmp/test-python-sdk-chanless/tests/contract/conftest.py"]!;
    expect(conftest).not.toContain("_start_harness_service");
    expect(conftest).not.toContain("ARCHASTRO_HARNESS_WS_URL");
  });
});

describe("Pydantic emitter — enum edge cases", () => {
  it("emits Literal with a single value for single-value enums (discriminator on union variants)", () => {
    const out = emitPydanticFile([
      {
        name: "EchoVariant",
        fields: [
          {
            name: "type",
            type: { kind: "enum", values: ["echo"] },
            required: true,
            default: "echo",
          },
          {
            name: "message",
            type: { kind: "primitive", type: "string" },
            required: true,
          },
        ],
      },
    ]);
    expect(out).toMatch(/type: Literal\["echo"\] = "echo"/);
    expect(out).toContain("from typing import");
    expect(out).toMatch(/from typing import [^\n]*Literal/);
  });
});

describe("Pydantic emitter — discriminated unions", () => {
  const echoVariant: SchemaDef = {
    name: "EchoVariant",
    fields: [
      {
        name: "type",
        type: { kind: "enum", values: ["echo"] },
        required: true,
        default: "echo",
      },
      {
        name: "message",
        type: { kind: "primitive", type: "string" },
        required: true,
      },
    ],
  };
  const delayVariant: SchemaDef = {
    name: "DelayVariant",
    fields: [
      {
        name: "type",
        type: { kind: "enum", values: ["delay"] },
        required: true,
        default: "delay",
      },
      {
        name: "duration_ms",
        type: { kind: "primitive", type: "integer" },
        required: true,
      },
    ],
  };
  const builtinConfig: SchemaDef = {
    name: "BuiltinConfig",
    description: "Tagged union of builtin transforms.",
    fields: [],
    unionType: {
      kind: "union",
      variants: [
        { kind: "ref", schema: "EchoVariant" },
        { kind: "ref", schema: "DelayVariant" },
      ],
      discriminator: {
        propertyName: "type",
        mapping: { echo: "EchoVariant", delay: "DelayVariant" },
      },
    },
  };
  const output = emitPydanticFile([echoVariant, delayVariant, builtinConfig]);

  it("emits variant classes with a Literal-typed discriminator + default", () => {
    expect(output).toContain("class EchoVariant(BaseModel):");
    expect(output).toContain("class DelayVariant(BaseModel):");
    expect(output).toMatch(/type: Literal\["echo"\] = "echo"/);
    expect(output).toMatch(/type: Literal\["delay"\] = "delay"/);
  });

  it("emits the union as Annotated[Union[...], Field(discriminator=...)]", () => {
    expect(output).toContain(
      'BuiltinConfig = Annotated[Union[EchoVariant, DelayVariant], Field(discriminator="type")]'
    );
  });

  it("imports Annotated + Union from typing and Field from pydantic", () => {
    expect(output).toMatch(/from typing import [^\n]*Annotated/);
    expect(output).toMatch(/from typing import [^\n]*Union/);
    expect(output).toMatch(/from pydantic import [^\n]*\bField\b/);
  });

  it("does NOT emit a `class BuiltinConfig(BaseModel)` for the union", () => {
    expect(output).not.toContain("class BuiltinConfig(BaseModel):");
  });
});

describe("Pydantic emitter — plain oneOf (no discriminator)", () => {
  const circle: SchemaDef = {
    name: "Circle",
    fields: [
      {
        name: "radius",
        type: { kind: "primitive", type: "float" },
        required: true,
      },
    ],
  };
  const square: SchemaDef = {
    name: "Square",
    fields: [
      {
        name: "side",
        type: { kind: "primitive", type: "float" },
        required: true,
      },
    ],
  };
  const anyShape: SchemaDef = {
    name: "AnyShape",
    fields: [],
    unionType: {
      kind: "union",
      variants: [
        { kind: "ref", schema: "Circle" },
        { kind: "ref", schema: "Square" },
      ],
    },
  };
  const output = emitPydanticFile([circle, square, anyShape]);

  it("emits a Union type alias (no Field discriminator) when no discriminator is present", () => {
    expect(output).toContain("AnyShape = Union[Circle, Square]");
    expect(output).toMatch(/from typing import [^\n]*Union/);
    expect(output).not.toContain('Field(discriminator=');
  });
});

describe("Python resource emitter streams SSE operations", () => {
  const sseFixture = {
    openapi: "3.0.0",
    info: { title: "SSE API", version: "1.0.0" },
    paths: {
      "/api/v1/ai/chat/completions/stream": {
        post: {
          operationId: "post_api_v1_ai_chat_completions_stream",
          summary: "Stream a chat completion",
          "x-sdk-streaming": {
            type: "sse",
            events: {
              message_delta: {
                type: "object",
                properties: { delta: { type: "string" } },
              },
            },
          },
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { model: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "SSE stream",
              content: { "text/event-stream": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  };

  const sseAst = parseOpenApiSpec(sseFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const output = sseAst.resources
    .map((r) => emitPythonResourceFile(r, "/api/v1"))
    .join("\n");

  it("emits an async generator over the runtime stream_sse iterator", () => {
    expect(output).toContain("async for event in self._http.stream_sse(");
    expect(output).toContain("yield event");
  });

  it("types the events as a discriminated TypedDict union (parity with TS)", () => {
    expect(output).toContain("class CompletionStreamEventMessageDelta(TypedDict):");
    expect(output).toContain('event: Literal["message_delta"]');
    expect(output).toContain(
      "CompletionStreamEvent = CompletionStreamEventMessageDelta"
    );
    expect(output).toMatch(
      /async def \w+\(self.*\) -> AsyncIterator\[CompletionStreamEvent\]/
    );
    expect(output).toMatch(/def \w+\(self.*\) -> Iterator\[CompletionStreamEvent\]/);
    expect(output).not.toContain("AsyncIterator[Dict[str, Any]]");
  });

  it("passes the POST method and body to stream_sse", () => {
    expect(output).toContain('method="POST"');
    expect(output).toContain("body=");
  });

  it("does not emit a normal request() call for the stream", () => {
    expect(output).not.toContain("self._http.request(");
    expect(output).not.toContain("self._http.request_raw(");
  });
});
