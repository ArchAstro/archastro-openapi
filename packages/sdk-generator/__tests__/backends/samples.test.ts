import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenApiSpec } from "../../src/frontend/index.js";
import {
  generatePythonSamples,
  generateSdkSamples,
  generateTypeScriptSamples,
} from "../../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/sample-spec.json"), "utf-8")
);

const ast = parseOpenApiSpec(fixture, {
  name: "archastro-platform",
  version: "0.1.0",
  baseUrl: "https://platform.archastro.ai",
  apiBase: "/api",
  defaultVersion: "v1",
});

const authOperation = {
  name: "post_api_v1_auth_login",
  operationId: "post_api_v1_auth_login",
  method: "POST" as const,
  path: "/api/v1/auth/login",
  deprecated: false,
  pathParams: [],
  queryParams: [],
  body: {
    schema: "inline",
    contentType: "application/json",
    fields: [
      {
        name: "email",
        type: { kind: "primitive" as const, type: "string" as const },
        required: true,
      },
      {
        name: "password",
        type: { kind: "primitive" as const, type: "string" as const },
        required: true,
      },
    ],
  },
  returnType: { kind: "object" as const, fields: [] },
  errors: [],
  tags: ["auth"],
};

const authAst = {
  ...ast,
  auth: {
    ...ast.auth,
    schemes: {
      publishable_key: {
        type: "apiKey" as const,
        in: "header",
        name: "x-archastro-api-key",
      },
    },
  },
  authOperations: [authOperation],
};

describe("SDK sample emitters", () => {
  it("generates TypeScript channel samples from generated channel API names", () => {
    const samples = generateTypeScriptSamples(ast, { include: ["channels"] });
    const chat = samples.channels.find((channel) => channel.name === "Chat");

    expect(chat).toBeDefined();
    expect(chat?.className).toBe("ChatChannel");
    expect(chat?.joins[0]?.samples[0]).toMatchObject({
      language: "typescript",
      label: "TypeScript",
    });
    expect(chat?.joins[0]?.samples[0]?.code).toContain(
      'import { ChatChannel } from "@archastro/sdk";'
    );
    expect(chat?.joins[0]?.samples[0]?.code).toContain(
      'import { Socket } from "@archastro/sdk/phx_channel";'
    );
    expect(chat?.joins[0]?.samples[0]?.code).toContain(
      "ChatChannel.topicTeamThread"
    );
    expect(chat?.joins[0]?.samples[0]?.code).toContain(
      "ChatChannel.joinTeamThread(socket"
    );
    expect(chat?.joins[0]?.samples[0]?.code).toContain("limit: 1");

    expect(chat?.messages[0]?.samples[0]?.code).toContain(
      "await channel.sendMessage({"
    );
    expect(chat?.messages[0]?.samples[0]?.code).toContain(
      'content: "test content"'
    );
    expect(chat?.pushes[0]?.samples[0]?.code).toContain(
      "channel.onMessageAdded((payload) => {"
    );
  });

  it("generates TypeScript REST operation samples from generated resource API names", () => {
    const samples = generateTypeScriptSamples(ast, { include: ["operations"] });
    const listTeams = samples.operations.find(
      (operation) => operation.operationId === "list_teams"
    );
    const createTeam = samples.operations.find(
      (operation) => operation.operationId === "create_team"
    );

    expect(samples.channels).toEqual([]);
    expect(listTeams?.samples[0]).toMatchObject({
      language: "typescript",
      label: "TypeScript",
    });
    expect(listTeams?.samples[0]?.code).toContain(
      'import { PlatformClient } from "@archastro/sdk";'
    );
    expect(listTeams?.samples[0]?.code).toContain(
      'const result = await client.v1.apps.teams.list("test-id");'
    );
    expect(createTeam?.samples[0]?.code).toContain(
      'const result = await client.v1.apps.teams.create("test-id", { name: "test-name" });'
    );
  });

  it("generates TypeScript auth operation samples from generated auth client API names", () => {
    const samples = generateTypeScriptSamples(authAst, { include: ["operations"] });
    const login = samples.operations.find(
      (operation) => operation.operationId === "post_api_v1_auth_login"
    );

    expect(login?.samples[0]?.code).toContain(
      'import { PlatformClient } from "@archastro/sdk";'
    );
    expect(login?.samples[0]?.code).toContain(
      'const result = await client.auth.login("test@example.com", "Password1234!");'
    );
  });

  it("generates Python channel samples from generated async channel API names", () => {
    const samples = generatePythonSamples(ast, { include: ["channels"] });
    const chat = samples.channels.find((channel) => channel.name === "Chat");

    expect(chat).toBeDefined();
    expect(chat?.joins[0]?.samples[0]).toMatchObject({
      language: "python",
      label: "Python",
    });
    expect(chat?.joins[0]?.samples[0]?.code).toContain(
      "from archastro.platform import AsyncPlatformClient"
    );
    expect(chat?.joins[0]?.samples[0]?.code).toContain(
      "from archastro.platform.channels.chat import ChatChannel"
    );
    expect(chat?.joins[0]?.samples[0]?.code).toContain(
      "async with AsyncPlatformClient() as client:"
    );
    expect(chat?.joins[0]?.samples[0]?.code).toContain(
      "await ChatChannel.join_team_thread("
    );
    expect(chat?.joins[0]?.samples[0]?.code).toContain("limit=1");

    expect(chat?.messages[0]?.samples[0]?.code).toContain(
      "reply = await channel.send_message({"
    );
    expect(chat?.messages[0]?.samples[0]?.code).toContain(
      '"content": "test content"'
    );
    expect(chat?.pushes[0]?.samples[0]?.code).toContain(
      "unsubscribe = channel.on_message_added(handle_message_added)"
    );
  });

  it("generates Python REST operation samples from generated async resource API names", () => {
    const samples = generatePythonSamples(ast, { include: ["operations"] });
    const listTeams = samples.operations.find(
      (operation) => operation.operationId === "list_teams"
    );
    const createTeam = samples.operations.find(
      (operation) => operation.operationId === "create_team"
    );

    expect(samples.channels).toEqual([]);
    expect(listTeams?.samples[0]).toMatchObject({
      language: "python",
      label: "Python",
    });
    expect(listTeams?.samples[0]?.code).toContain(
      "from archastro.platform import AsyncPlatformClient"
    );
    expect(listTeams?.samples[0]?.code).toContain(
      'result = await client.v1.apps.teams.list("test-id")'
    );
    expect(createTeam?.samples[0]?.code).toContain(
      'result = await client.v1.apps.teams.create("test-id", {"name": "test-name"})'
    );
  });

  it("generates Python auth operation samples from generated async auth client API names", () => {
    const samples = generatePythonSamples(authAst, { include: ["operations"] });
    const login = samples.operations.find(
      (operation) => operation.operationId === "post_api_v1_auth_login"
    );

    expect(login?.samples[0]?.code).toContain(
      'AsyncPlatformClient(default_headers={"x-archastro-api-key": api_key})'
    );
    expect(login?.samples[0]?.code).toContain(
      'result = await client.auth.login("test@example.com", "Password1234!")'
    );
  });

  it("uses the generated Python token helper when publishable key auth exists", () => {
    const samples = generatePythonSamples(
      {
        ...ast,
        auth: {
          ...ast.auth,
          schemes: {
            publishable_key: {
              type: "apiKey",
              in: "header",
              name: "x-archastro-api-key",
            },
          },
        },
      },
      { include: ["channels"] }
    );
    const chat = samples.channels.find((channel) => channel.name === "Chat");

    expect(chat?.joins[0]?.samples[0]?.code).toContain(
      "async with AsyncPlatformClient.with_token(api_key, access_token) as client:"
    );
  });

  it("merges TypeScript and Python channel samples into one bundle", () => {
    const samples = generateSdkSamples(ast, {
      languages: ["typescript", "python"],
      include: ["channels", "operations"],
    });
    const chat = samples.channels.find((channel) => channel.name === "Chat");

    expect(chat?.joins[0]?.samples.map((sample) => sample.language)).toEqual([
      "typescript",
      "python",
    ]);
    expect(chat?.messages[0]?.samples.map((sample) => sample.language)).toEqual([
      "typescript",
      "python",
    ]);
    expect(chat?.pushes[0]?.samples.map((sample) => sample.language)).toEqual([
      "typescript",
      "python",
    ]);
    expect(samples.operations[0]?.samples.map((sample) => sample.language)).toEqual([
      "typescript",
      "python",
    ]);
  });
});
