import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenApiSpec } from "../../src/frontend/index.js";
import { generatePython } from "../../src/backends/python/index.js";
import { emitPydanticFile } from "../../src/backends/python/pydantic-emitter.js";
import { emitPythonResourceFile } from "../../src/backends/python/resource-emitter.js";
import { emitPythonClientFile } from "../../src/backends/python/client-emitter.js";
import { emitPythonChannelFile } from "../../src/backends/python/channel-emitter.js";
import { emitPythonContractTests } from "../../src/backends/contract-tests/python-emitter.js";
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
                properties: { join_code: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Successful response",
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

  it("handles enum types with Literal", () => {
    const memberSchemas = ast.schemas.filter(
      (s) => s.name === "TeamMember" || s.name === "AddTeamMemberInput"
    );
    const memberOutput = emitPydanticFile(memberSchemas);
    expect(memberOutput).toContain("Literal");
    expect(memberOutput).toContain('"admin"');
    expect(memberOutput).toContain('"member"');
  });
});

describe("Python resource emitter", () => {
  const teamsResource = ast.resources.find((r) => r.name === "teams")!;
  const output = emitPythonResourceFile(teamsResource, ast.apiPrefix);

  it("generates resource classes", () => {
    expect(output).toContain("class TeamResource:");
    expect(output).toContain("class MemberResource:");
  });

  it("nests child resources in __init__", () => {
    expect(output).toContain("self.members = MemberResource(http)");
  });

  it("generates async methods", () => {
    expect(output).toContain("async def list(self,");
    expect(output).toContain("async def get(self,");
    expect(output).toContain("async def create(self,");
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
      "async def content(self, config: str) -> dict[str, str]:"
    );
    expect(output).toContain(
      'return await self._http.request_raw(f"/api/v1/configs/{config}/content")'
    );
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
      'result = await client.v1.configs.content("test-value")'
    );
    expect(content).toContain('assert result["content"] is not None');
    expect(content).toContain('assert result["mime_type"]');
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
      "async def join_by_code(self, input: dict) -> dict[str, object]:"
    );
  });
});

describe("Python client emitter", () => {
  const output = emitPythonClientFile(ast);

  it("generates PlatformClient class", () => {
    expect(output).toContain("class PlatformClient:");
  });

  it("has __init__ with keyword-only params", () => {
    expect(output).toContain("def __init__(self, *,");
    expect(output).toContain("base_url: str =");
    expect(output).toContain("access_token: str | None = None");
  });

  it("has version namespace and resource aliases", () => {
    // Version namespace
    expect(output).toContain("self.v1 = V1(self._http)");
    // Backward-compat aliases to default version
    expect(output).toContain("self.teams = self.v1.teams");
    expect(output).toContain("self.agents = self.v1.agents");
  });

  it("has set_access_token method", () => {
    expect(output).toContain("def set_access_token(self, token: str)");
    expect(output).toContain("self._http.set_access_token(token)");
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
    expect(output).toContain("from typing import TYPE_CHECKING");
    expect(output).toContain("if TYPE_CHECKING:");
    expect(output).toContain("from phx_channel.socket import Socket");
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
    expect(output).toContain("def on_message_added(self, callback)");
    expect(output).toContain('self._channel.on("message_added"');
    expect(output).toContain("def on_message_updated(self, callback)");
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
    expect(client).toContain("PlatformClient");
  });

  it("generates channel files", () => {
    expect(
      files["/tmp/test-python-sdk/src/archastro/platform/channels/chat.py"]
    ).toBeDefined();
  });

  it("generates package __init__.py with PlatformClient and version from metadata", () => {
    const init =
      files["/tmp/test-python-sdk/src/archastro/platform/__init__.py"]!;
    expect(init).toContain("from .client import PlatformClient");
    expect(init).toContain("from .v1 import V1");
    expect(init).toContain("_pkg_version");
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

    expect(files[`${pkg}/v2/__init__.py`]).toBeDefined();
    expect(files[`${pkg}/v2/__init__.py`]).toContain("class V2:");
  });

  it("v2 namespace has workflows but v1 does not", () => {
    const v1Ns = files[`${pkg}/v1/__init__.py`]!;
    const v2Ns = files[`${pkg}/v2/__init__.py`]!;
    expect(v1Ns).not.toContain("workflows");
    expect(v2Ns).toContain("self.workflows = WorkflowResource(http)");
  });

  it("client has both v1 and v2 namespaces", () => {
    const client = files[`${pkg}/client.py`]!;
    expect(client).toContain("self.v1 = V1(self._http)");
    expect(client).toContain("self.v2 = V2(self._http)");
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
    expect(init).toContain("from .v2 import V2");
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
    expect(output).toContain("from phx_channel import HarnessServiceClient");
    expect(output).toContain("from phx_channel.channel import ChannelError");
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
