import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenApiSpec } from "../../src/frontend/index.js";
import { generateTypeScript } from "../../src/backends/typescript/index.js";
import { emitZodSchemaFile } from "../../src/backends/typescript/zod-emitter.js";
import { emitResourceFile } from "../../src/backends/typescript/resource-emitter.js";
import { emitChannelFile } from "../../src/backends/typescript/channel-emitter.js";
import { emitClientFile } from "../../src/backends/typescript/client-emitter.js";
import { emitTypeScriptContractTests } from "../../src/backends/contract-tests/typescript-emitter.js";
import { emitChannelContractTestFile } from "../../src/backends/contract-tests/channel-emitter.js";

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

describe("Zod emitter", () => {
  // Include all team-related schemas (Team, CreateTeamInput, UpdateTeamInput)
  const teamSchemas = ast.schemas.filter((s) =>
    ["Team", "CreateTeamInput", "UpdateTeamInput"].includes(s.name)
  );
  const output = emitZodSchemaFile(teamSchemas);

  it("generates valid Zod import", () => {
    expect(output).toContain('import { z } from "zod"');
  });

  it("generates schema variable with Schema suffix", () => {
    expect(output).toContain("export const teamSchema = z.object(");
    expect(output).toContain("export const createTeamInputSchema = z.object(");
  });

  it("generates inferred type exports", () => {
    expect(output).toContain("export type Team = z.infer<typeof teamSchema>");
    expect(output).toContain(
      "export type CreateTeamInput = z.infer<typeof createTeamInputSchema>"
    );
  });

  it("handles required vs optional fields", () => {
    // id is required → z.string()
    expect(output).toMatch(/id: z\.string\(\)/);
    // description is optional → z.string().optional()
    expect(output).toMatch(/description: z\.string\(\)\.optional\(\)/);
  });

  it("handles enum fields", () => {
    const memberSchemas = ast.schemas.filter(
      (s) => s.name === "TeamMember" || s.name === "AddTeamMemberInput"
    );
    const memberOutput = emitZodSchemaFile(memberSchemas);
    expect(memberOutput).toContain('z.enum(["admin", "member", "viewer"])');
  });
});

describe("Resource emitter", () => {
  const teamsResource = ast.resources.find((r) => r.name === "teams")!;
  const output = emitResourceFile(teamsResource, ast.apiPrefix);

  it("generates resource classes", () => {
    expect(output).toContain("export class TeamResource");
    expect(output).toContain("export class MemberResource");
  });

  it("nests child resources", () => {
    expect(output).toContain("readonly members: MemberResource");
    expect(output).toContain("this.members = new MemberResource(http)");
  });

  it("generates operations with correct signatures", () => {
    // The sample fixture has /api/apps/{app_id}/teams/{team_id} paths
    // Without scopePrefix, app_id is a regular path param on the parent resource
    expect(output).toContain("async list(");
    expect(output).toContain("async get(");
    expect(output).toContain("async create(");
  });

  it("generates full paths from the OpenAPI spec", () => {
    // Paths come directly from the spec — full path preserved
    expect(output).toContain("`/api/apps/${appId}/teams/${teamId}`");
    expect(output).not.toContain("appApiPath");
  });

  it("uses correct HTTP methods", () => {
    expect(output).toContain('method: "POST"');
    expect(output).toContain('method: "PATCH"');
    expect(output).toContain('method: "DELETE"');
  });

  it("types body param with the named schema when requestBody uses $ref", () => {
    // Sample fixture: create_team's requestBody is `$ref: CreateTeamInput`;
    // update_team's is `UpdateTeamInput`. The generated signature must use
    // the named type, NOT `Record<string, unknown>`.
    expect(output).toMatch(/async create\([^)]*input: CreateTeamInput[^)]*\)/);
    expect(output).toMatch(/async update\([^)]*input: UpdateTeamInput[^)]*\)/);
    expect(output).not.toMatch(
      /async (?:create|update)\([^)]*input: Record<string, unknown>/
    );
  });

  it("imports named body schemas from the types barrel", () => {
    // Full production call path includes schemaImports — imports are emitted
    // only when that option is provided (collectSchemaRefs walks body refs).
    const schemaImports: Record<string, string> = {};
    for (const schema of ast.schemas) {
      schemaImports[schema.name] = `../../types/${schema.name}.js`;
    }
    const withImports = emitResourceFile(
      teamsResource,
      ast.apiPrefix,
      { schemaImports }
    );
    expect(withImports).toMatch(
      /import type \{[^}]*\bCreateTeamInput\b[^}]*\} from ["']\.\.\/\.\.\/types\//
    );
    expect(withImports).toMatch(
      /import type \{[^}]*\bUpdateTeamInput\b[^}]*\} from ["']\.\.\/\.\.\/types\//
    );
  });
});

describe("Resource emitter types inline request bodies", () => {
  // docFixture's /teams/join_by_code has an inline `{ join_code: string }`
  // body — no $ref. The generated signature must emit a typed object
  // literal, not `Record<string, unknown>`.
  const docAst = parseOpenApiSpec(docFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const teamsResource = docAst.resources.find((r) => r.name === "teams")!;
  const output = emitResourceFile(teamsResource, "/api/v1");

  it("emits an inline object type with the body's fields", () => {
    // Optional field on an inline object is rendered as `T | undefined`
    // by typeRefToTS — cover both spellings to avoid tying the assertion
    // to that formatting detail.
    expect(output).toMatch(
      /input: \{\s*join_code\?: string(?: \| undefined)?\s*\}/
    );
    expect(output).not.toContain("input: Record<string, unknown>");
  });
});

describe("Resource emitter preserves array query params", () => {
  // An earlier version cast `params` to a scalars-only Record at the call
  // boundary, silently discarding array-typed filter types like `string[]`.
  // The cast must match HttpClient.request's QueryValue union so arrays
  // stay type-safe on the way to appendQueryString.
  const arrayQueryFixture = {
    openapi: "3.0.0",
    info: { title: "Array Query API", version: "1.0.0" },
    paths: {
      "/api/v1/activity_feed": {
        get: {
          operationId: "get_api_v1_activity_feed",
          parameters: [
            {
              name: "kind",
              in: "query",
              schema: { type: "array", items: { type: "string" } },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { data: { type: "array", items: { type: "string" } } },
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

  const ast = parseOpenApiSpec(arrayQueryFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const resource = ast.resources.find((r) => r.name === "activity_feed")!;
  const output = emitResourceFile(resource, "/api/v1");

  it("types array query params as arrays in the method signature", () => {
    expect(output).toMatch(/kind\?: string\[\]/);
  });

  it("casts params to a type that permits primitive arrays", () => {
    expect(output).toContain(
      "query: params as Record<string, string | number | boolean | Array<string | number | boolean> | undefined>"
    );
    expect(output).not.toContain(
      "query: params as Record<string, string | number | boolean | undefined>"
    );
  });
});

describe("Resource emitter uses requestRaw for raw responses", () => {
  const rawAst = parseOpenApiSpec(rawFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const configsResource = rawAst.resources.find((r) => r.name === "configs")!;
  const output = emitResourceFile(configsResource, "/api/v1");

  it("emits requestRaw and raw return shape", () => {
    expect(output).toContain(
      "async content(config: string): Promise<{ content: ArrayBuffer; mimeType: string }>"
    );
    expect(output).toContain(
      "return this.http.requestRaw(`/api/v1/configs/${config}/content`);"
    );
  });
});

describe("TypeScript contract tests include raw response operations", () => {
  const rawAst = parseOpenApiSpec(rawFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const files = emitTypeScriptContractTests(rawAst, {
    outDir: "/tmp/test-sdk",
  });
  const content =
    files["/tmp/test-sdk/__tests__/contract/v1/configs.contract.test.ts"]!;

  it("emits happy-path assertions for raw content and mime type", () => {
    expect(content).toContain(
      'const result = await client.v1.configs.content("test-value");'
    );
    expect(content).toContain("expect(result.content).toBeDefined();");
    expect(content).toContain("expect(result.mimeType).toBeTruthy();");
  });
});

describe("Channel contract test emitter", () => {
  const chat = ast.channels.find((c) => c.name === "Chat")!;
  const output = emitChannelContractTestFile(
    chat,
    "../../../src/channels/chat.js"
  );

  it("imports the channel-harness client and the generated channel class", () => {
    expect(output).toContain(
      'from "@archastro/channel-harness"'
    );
    expect(output).toContain("ChannelJoinError");
    expect(output).toContain("ChannelReplyError");
    expect(output).toContain("HarnessServiceClient");
    expect(output).toContain(
      'import { ChatChannel } from "../../../src/channels/chat.js"'
    );
  });

  it("reads harness URLs from env vars inside bootHarness, not at module scope", () => {
    expect(output).toContain("process.env.ARCHASTRO_HARNESS_WS_URL");
    expect(output).toContain("process.env.ARCHASTRO_HARNESS_CONTROL_URL");
    // Module-scope guards crash vitest collection for the whole file.
    // The env-var check must live inside bootHarness() so a missing var
    // surfaces as a test failure instead of a collection error.
    const bootBody = output.slice(output.indexOf("async function bootHarness"));
    expect(bootBody).toContain("process.env.ARCHASTRO_HARNESS_WS_URL");
    expect(bootBody).toContain("process.env.ARCHASTRO_HARNESS_CONTROL_URL");
    expect(output).toContain(
      "new HarnessServiceClient({ wsUrl, controlUrl })"
    );
    expect(output).toContain("await client.reset()");
    expect(output).toContain("await client.openSocket()");
  });

  it("emits a happy-path join test using the generated static join method", () => {
    expect(output).toContain(
      'describe("ChatChannel.joinTeamThread (api:chat:team:{team_id}:thread:{thread_id})"'
    );
    expect(output).toContain(
      "const channel = await ChatChannel.joinTeamThread(rig.socket,"
    );
    expect(output).toContain("expect(channel).toBeInstanceOf(ChatChannel)");
    expect(output).toContain("expect(channel.joinResponse).toBeDefined()");
  });

  it("registers replyError scenarios over HTTP instead of in-process closures", () => {
    expect(output).toContain(
      "await rig.client.registerScenario({"
    );
    expect(output).toContain(
      'topic: "api:chat:team:test-id:thread:test-id"'
    );
    expect(output).toContain(
      'onJoin: [{ type: "replyError", payload: { reason: "test_error" } }]'
    );
    expect(output).toContain("expect(err).toBeInstanceOf(ChannelJoinError)");
  });

  it("emits a describe block per inbound message with autoReply scenarios", () => {
    expect(output).toContain('describe("ChatChannel.sendMessage (send_message)"');
    expect(output).toContain('onJoin: [{ type: "autoReply" }]');
    expect(output).toContain(
      '"send_message": [{ type: "autoReply" }]'
    );
    expect(output).toContain("const reply = await channel.sendMessage(");
  });

  it("asserts observed params via the HTTP observation API for required fields", () => {
    expect(output).toContain(
      'await rig.client.observations("api:chat:team:test-id:thread:test-id", "send_message")'
    );
    expect(output).toContain("expect(observed).toHaveLength(1)");
    expect(output).toContain(
      "expect(observed[0]!.params).toEqual(expect.objectContaining("
    );
    expect(output).toContain('content: "test content"');
  });

  it("emits a ChannelReplyError guard when a message has required params", () => {
    expect(output).toContain("rejects.toBeInstanceOf(ChannelReplyError)");
  });

  it("emits a describe block per server push that uses autoPush + handler", () => {
    expect(output).toContain(
      'describe("ChatChannel.onMessageAdded (message_added)"'
    );
    expect(output).toContain(
      '{ type: "autoPush", event: "message_added" }'
    );
    expect(output).toContain(
      "const payload = await nextPush((cb) => channel.onMessageAdded(cb));"
    );
  });

  it("emits a clean-leave test", () => {
    expect(output).toContain('describe("ChatChannel.leave"');
    expect(output).toContain("await channel.leave();");
  });
});

describe("Channel contract test emitter — edge cases", () => {
  it("skips the missing-required-params test when payload is all-optional", () => {
    const output = emitChannelContractTestFile(
      {
        name: "AllOptional",
        className: "AllOptionalChannel",
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
      },
      "../../../src/channels/all_optional.js"
    );

    expect(output).toContain(
      "describe(\"AllOptionalChannel.joinRoom"
    );
    expect(output).not.toContain("rejects.toBeInstanceOf(ChannelJoinError)");
    // Error-reply test still emits regardless of payload shape.
    expect(output).toContain(
      "const err = await AllOptionalChannel.joinRoom(rig.socket,"
    );
  });

  it("numbers joins when a channel defines multiple unnamed join patterns", () => {
    const output = emitChannelContractTestFile(
      {
        name: "Multi",
        className: "MultiChannel",
        joins: [
          {
            topicPattern: "a:{id}",
            params: [
              {
                name: "id",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
            returnType: { kind: "unknown" },
          },
          {
            topicPattern: "b:{id}",
            params: [
              {
                name: "id",
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
      "../../../src/channels/multi.js"
    );
    expect(output).toContain('MultiChannel.join1 (a:{id})');
    expect(output).toContain('MultiChannel.join2 (b:{id})');
  });
});

describe("Resource emitter uses summary and description in method docs", () => {
  const docAst = parseOpenApiSpec(docFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });
  const teamsResource = docAst.resources.find((r) => r.name === "teams")!;
  const output = emitResourceFile(teamsResource, "/api/v1");

  it("renders the summary and long description into the JSDoc block", () => {
    expect(output).toContain("/**");
    expect(output).toContain("Join a team using an invite code");
    expect(output).toContain("Accepts either `join_code` or `invite_code`.");
    expect(output).toContain(
      "Adds the caller or provided principal to the team."
    );
  });
});

describe("Client emitter", () => {
  const output = emitClientFile(ast);

  it("generates PlatformClient class", () => {
    expect(output).toContain("export class PlatformClient");
  });

  it("generates PlatformClientConfig interface", () => {
    expect(output).toContain("export interface PlatformClientConfig");
    expect(output).toContain("baseUrl?: string");
    expect(output).toContain("accessToken?: string");
    expect(output).toContain("getAccessToken?: () => string | undefined");
  });

  it("has version namespace and resource aliases", () => {
    // Version namespace
    expect(output).toContain("readonly v1: V1");
    expect(output).toContain("this.v1 = new V1(this.http)");
    // Backward-compat aliases to default version
    expect(output).toContain("readonly teams: TeamResource");
    expect(output).toContain("readonly agents: AgentResource");
    expect(output).toContain("this.teams = this.v1.teams");
    expect(output).toContain("this.agents = this.v1.agents");
  });

  it("has setAccessToken method", () => {
    expect(output).toContain("setAccessToken(token: string)");
    expect(output).toContain("this.http.setAccessToken(token)");
  });

  it("includes default base URL", () => {
    expect(output).toContain(
      'baseUrl: config.baseUrl ?? "https://platform.archastro.ai"'
    );
  });
});

describe("Channel emitter", () => {
  const chat = ast.channels.find((c) => c.name === "Chat")!;
  const output = emitChannelFile(chat);

  it("generates channel class", () => {
    expect(output).toContain("export class ChatChannel");
  });

  it("imports Channel and Socket from local phx_channel", () => {
    expect(output).toContain(
      'import type { Channel } from "../phx_channel/channel.js"'
    );
    expect(output).toContain(
      'import type { Socket } from "../phx_channel/socket.js"'
    );
  });

  it("generates named topic builder from join name", () => {
    expect(output).toContain(
      "static topicTeamThread(teamId: string, threadId: string)"
    );
    expect(output).toContain("`api:chat:team:${teamId}:thread:${threadId}`");
  });

  it("generates named join method with non-topic params in the signature", () => {
    expect(output).toContain(
      "static async joinTeamThread(socket: Socket, teamId: string, threadId: string, payload?: { limit?: number }): Promise<ChatChannel>"
    );
    expect(output).toContain("ChatChannel.topicTeamThread(teamId, threadId)");
    expect(output).toContain("socket.channel(topic)");
  });

  it("passes payload to channel.join() and exposes the response", () => {
    expect(output).toContain(
      "const joinResponse = await channel.join(payload);"
    );
    expect(output).toContain("return new ChatChannel(channel, joinResponse);");
  });

  it("constructor accepts and exposes joinResponse", () => {
    expect(output).toContain(
      "constructor(private channel: Channel, public readonly joinResponse?: unknown) {}"
    );
  });

  it("generates leave method", () => {
    expect(output).toContain("async leave(): Promise<void>");
    expect(output).toContain("await this.channel.leave()");
  });

  it("generates message methods", () => {
    expect(output).toContain("async sendMessage(");
    expect(output).toContain('this.channel.push("send_message"');
  });

  it("generates push event handlers", () => {
    expect(output).toContain("onMessageAdded(callback:");
    expect(output).toContain('this.channel.on("message_added"');
    expect(output).toContain("onMessageUpdated(callback:");
    expect(output).toContain('this.channel.on("message_updated"');
  });
});

describe("Channel emitter edge cases", () => {
  it("emits channel.join() with no argument when all params are topic-only", () => {
    const out = emitChannelFile({
      name: "Object",
      className: "ObjectChannel",
      joins: [
        {
          topicPattern: "object:{objectId}",
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
      "static async joinById(socket: Socket, objectId: string): Promise<ObjectChannel>"
    );
    expect(out).toContain("const joinResponse = await channel.join();");
    expect(out).not.toContain("await channel.join(payload)");
  });

  it("emits non-optional payload argument when a payload param is required", () => {
    const out = emitChannelFile({
      name: "Required",
      className: "RequiredChannel",
      joins: [
        {
          topicPattern: "room:{roomId}",
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
      "static async joinRoom(socket: Socket, roomId: string, payload: { token: string; limit?: number }): Promise<RequiredChannel>"
    );
    expect(out).toContain("const joinResponse = await channel.join(payload);");
  });
});

describe("Full TypeScript generation", () => {
  const files = generateTypeScript(ast, { outDir: "/tmp/test-sdk" });

  it("generates type files", () => {
    const typeFiles = Object.keys(files).filter((f) => f.includes("/types/"));
    expect(typeFiles.length).toBeGreaterThan(0);

    // Should have a types index
    expect(files["/tmp/test-sdk/src/types/index.ts"]).toBeDefined();
  });

  it("generates versioned resource files", () => {
    expect(files["/tmp/test-sdk/src/v1/resources/teams.ts"]).toBeDefined();
    expect(files["/tmp/test-sdk/src/v1/resources/agents.ts"]).toBeDefined();
    expect(files["/tmp/test-sdk/src/v1/resources/index.ts"]).toBeDefined();
    // Namespace file
    expect(files["/tmp/test-sdk/src/v1.ts"]).toBeDefined();
    expect(files["/tmp/test-sdk/src/v1.ts"]).toContain("export class V1");
  });

  it("generates client file", () => {
    expect(files["/tmp/test-sdk/src/client.ts"]).toBeDefined();
    expect(files["/tmp/test-sdk/src/client.ts"]).toContain("PlatformClient");
  });

  it("generates channel files", () => {
    expect(files["/tmp/test-sdk/src/channels/chat.ts"]).toBeDefined();
    expect(files["/tmp/test-sdk/src/channels/chat.ts"]).toContain(
      "ChatChannel"
    );
  });

  it("generates main index with all exports", () => {
    const idx = files["/tmp/test-sdk/src/index.ts"]!;
    expect(idx).toContain("export * from");
    expect(idx).toContain("PlatformClient");
    expect(idx).toContain("ChatChannel");
    // Version namespace export
    expect(idx).toContain('export { V1 } from "./v1.js"');
  });

  it("all generated files have auto-generated header", () => {
    for (const content of Object.values(files)) {
      expect(content).toContain("auto-generated");
    }
  });

  it("versioned resource files use correct import depth", () => {
    const teamResource = files["/tmp/test-sdk/src/v1/resources/teams.ts"]!;
    expect(teamResource).toContain('from "../../runtime/http-client.js"');
  });
});

describe("Multi-version TypeScript generation", () => {
  const multiAst = parseOpenApiSpec(versionedFixture, {
    name: "archastro-platform",
    version: "0.2.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });

  const files = generateTypeScript(multiAst, { outDir: "/tmp/test-multi-sdk" });

  it("generates v1 and v2 resource directories", () => {
    expect(
      files["/tmp/test-multi-sdk/src/v1/resources/teams.ts"]
    ).toBeDefined();
    expect(
      files["/tmp/test-multi-sdk/src/v1/resources/agents.ts"]
    ).toBeDefined();
    expect(
      files["/tmp/test-multi-sdk/src/v2/resources/teams.ts"]
    ).toBeDefined();
    expect(
      files["/tmp/test-multi-sdk/src/v2/resources/agents.ts"]
    ).toBeDefined();
    expect(
      files["/tmp/test-multi-sdk/src/v2/resources/workflows.ts"]
    ).toBeDefined();
  });

  it("generates namespace files for both versions", () => {
    expect(files["/tmp/test-multi-sdk/src/v1.ts"]).toBeDefined();
    expect(files["/tmp/test-multi-sdk/src/v1.ts"]).toContain("export class V1");

    expect(files["/tmp/test-multi-sdk/src/v2.ts"]).toBeDefined();
    expect(files["/tmp/test-multi-sdk/src/v2.ts"]).toContain("export class V2");
  });

  it("v2 namespace has workflows but v1 does not", () => {
    const v1Ns = files["/tmp/test-multi-sdk/src/v1.ts"]!;
    const v2Ns = files["/tmp/test-multi-sdk/src/v2.ts"]!;
    expect(v1Ns).not.toContain("workflows");
    expect(v2Ns).toContain("readonly workflows: WorkflowResource");
  });

  it("client has both v1 and v2 namespaces", () => {
    const client = files["/tmp/test-multi-sdk/src/client.ts"]!;
    expect(client).toContain("readonly v1: V1");
    expect(client).toContain("readonly v2: V2");
    expect(client).toContain("this.v1 = new V1(this.http)");
    expect(client).toContain("this.v2 = new V2(this.http)");
  });

  it("client has backward-compat aliases to default version (v1)", () => {
    const client = files["/tmp/test-multi-sdk/src/client.ts"]!;
    expect(client).toContain("this.teams = this.v1.teams");
    expect(client).toContain("this.agents = this.v1.agents");
    // Should NOT alias v2-only resources
    expect(client).not.toContain("this.workflows");
  });

  it("v1 resources use /api/v1/ paths", () => {
    const v1Teams = files["/tmp/test-multi-sdk/src/v1/resources/teams.ts"]!;
    expect(v1Teams).toContain("`/api/v1/teams`");
  });

  it("v2 resources use /api/v2/ paths", () => {
    const v2Teams = files["/tmp/test-multi-sdk/src/v2/resources/teams.ts"]!;
    expect(v2Teams).toContain("`/api/v2/teams`");
  });

  it("main index exports both version namespaces", () => {
    const idx = files["/tmp/test-multi-sdk/src/index.ts"]!;
    expect(idx).toContain('export { V1 } from "./v1.js"');
    expect(idx).toContain('export { V2 } from "./v2.js"');
  });

  it("types are shared, not duplicated per version", () => {
    const typeFiles = Object.keys(files).filter((f) => f.includes("/types/"));
    // Types should be in src/types/, not src/v1/types/ or src/v2/types/
    expect(
      typeFiles.every((f) => f.startsWith("/tmp/test-multi-sdk/src/types/"))
    ).toBe(true);
  });
});
