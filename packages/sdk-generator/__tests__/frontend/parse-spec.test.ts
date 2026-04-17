import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenApiSpec, detectVersions } from "../../src/frontend/index.js";

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
                schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
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

describe("parseOpenApiSpec", () => {
  const ast = parseOpenApiSpec(fixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiPrefix: "/api",
    scopePrefix: "/apps/{app_id}",
  });

  it("populates top-level metadata", () => {
    expect(ast.name).toBe("archastro-platform");
    expect(ast.version).toBe("0.1.0");
    expect(ast.baseUrl).toBe("https://platform.archastro.ai");
    expect(ast.apiPrefix).toBe("/api");
    // Versioning fields
    expect(ast.versions).toBeDefined();
    expect(ast.versions.length).toBe(1);
    expect(ast.versions[0]!.version).toBe("v1");
    expect(ast.defaultVersion).toBe("v1");
  });

  it("parses schemas", () => {
    const names = ast.schemas.map((s) => s.name).sort();
    expect(names).toContain("Team");
    expect(names).toContain("CreateTeamInput");
    expect(names).toContain("TeamMember");
    expect(names).toContain("Agent");
    expect(names).toContain("AgentSession");
  });

  it("parses Team schema fields", () => {
    const team = ast.schemas.find((s) => s.name === "Team")!;
    expect(team).toBeDefined();

    const fieldNames = team.fields.map((f) => f.name);
    expect(fieldNames).toContain("id");
    expect(fieldNames).toContain("name");
    expect(fieldNames).toContain("description");
    expect(fieldNames).toContain("created_at");

    const id = team.fields.find((f) => f.name === "id")!;
    expect(id.required).toBe(true);
    expect(id.type).toEqual({ kind: "primitive", type: "string" });

    const desc = team.fields.find((f) => f.name === "description")!;
    expect(desc.required).toBe(false);
    expect(desc.type.kind).toBe("optional");
  });

  it("infers resource tree with nesting", () => {
    // Should have top-level resources: teams, agents
    const topNames = ast.resources.map((r) => r.name).sort();
    expect(topNames).toContain("teams");
    expect(topNames).toContain("agents");
  });

  it("nests members under teams", () => {
    const teams = ast.resources.find((r) => r.name === "teams")!;
    expect(teams).toBeDefined();
    expect(teams.children.length).toBeGreaterThan(0);

    const members = teams.children.find((r) => r.name === "members");
    expect(members).toBeDefined();
    expect(members!.className).toBe("MemberResource");
  });

  it("nests sessions under agents", () => {
    const agents = ast.resources.find((r) => r.name === "agents")!;
    expect(agents).toBeDefined();
    expect(agents.children.length).toBeGreaterThan(0);

    const sessions = agents.children.find((r) => r.name === "sessions");
    expect(sessions).toBeDefined();
  });

  it("merges resources with same name but different path structures", () => {
    // /agents/{agent_id}/sessions (scoped list) and /agents/sessions/{session_id} (unscoped get)
    // should be merged into a single "sessions" child resource
    const agents = ast.resources.find((r) => r.name === "agents")!;
    const sessionsChildren = agents.children.filter((r) => r.name === "sessions");
    expect(sessionsChildren.length).toBe(1);

    const sessions = sessionsChildren[0]!;
    const opNames = sessions.operations.map((o) => o.name).sort();
    expect(opNames).toContain("list"); // from /agents/{agent_id}/sessions
    expect(opNames).toContain("get");  // from /agents/sessions/{session_id}
  });

  it("folds action endpoints into parent resource operations", () => {
    const agents = ast.resources.find((r) => r.name === "agents")!;
    // POST /agents/{id}/deactivate should be an operation on agents, not a child resource
    const opNames = agents.operations.map((o) => o.name);
    expect(opNames).toContain("deactivate");
    // Should NOT have a "deactivate" child resource
    const deactivateChild = agents.children.find((r) => r.name === "deactivate");
    expect(deactivateChild).toBeUndefined();
  });

  it("folds GET action endpoints into parent resource operations", () => {
    const agents = ast.resources.find((r) => r.name === "agents")!;
    // GET /agents/{id}/export should be an operation on agents, not a child resource
    const opNames = agents.operations.map((o) => o.name);
    expect(opNames).toContain("export");
    // Should NOT have an "export" child resource
    const exportChild = agents.children.find((r) => r.name === "export");
    expect(exportChild).toBeUndefined();
  });

  it("names GET action operations by the action segment, not 'list'", () => {
    const agents = ast.resources.find((r) => r.name === "agents")!;
    const exportOp = agents.operations.find((o) => o.name === "export");
    expect(exportOp).toBeDefined();
    // Should NOT be named "list" — it's an action, not a collection
    const listOps = agents.operations.filter((o) => o.name === "list");
    // The only list should be for the agents collection itself, not export
    expect(listOps.every((o) => !o.path.includes("/export"))).toBe(true);
  });

  it("assigns correct operations to teams", () => {
    const teams = ast.resources.find((r) => r.name === "teams")!;
    const opNames = teams.operations.map((o) => o.name).sort();
    expect(opNames).toContain("list");
    expect(opNames).toContain("create");
    expect(opNames).toContain("get");
    expect(opNames).toContain("update");
    expect(opNames).toContain("delete");
  });

  it("detects pagination on list operations", () => {
    const teams = ast.resources.find((r) => r.name === "teams")!;
    const list = teams.operations.find((o) => o.name === "list")!;
    expect(list.pagination).toBeDefined();
    expect(list.pagination!.style).toBe("offset");
  });

  it("extracts query params", () => {
    const teams = ast.resources.find((r) => r.name === "teams")!;
    const list = teams.operations.find((o) => o.name === "list")!;
    const queryNames = list.queryParams.map((p) => p.name);
    expect(queryNames).toContain("page");
    expect(queryNames).toContain("pageSize");
    expect(queryNames).toContain("search");
  });

  it("extracts body references", () => {
    const teams = ast.resources.find((r) => r.name === "teams")!;
    const create = teams.operations.find((o) => o.name === "create")!;
    expect(create.body).toBeDefined();
    expect(create.body!.schema).toBe("CreateTeamInput");
  });

  it("extracts errors", () => {
    const teams = ast.resources.find((r) => r.name === "teams")!;
    const create = teams.operations.find((o) => o.name === "create")!;
    expect(create.errors.length).toBeGreaterThan(0);
    expect(create.errors[0]!.status).toBe(422);
  });

  it("parses channels from x-channels", () => {
    expect(ast.channels.length).toBe(1);

    const chat = ast.channels[0]!;
    expect(chat.name).toBe("Chat");
    expect(chat.className).toBe("ChatChannel");
  });

  it("parses channel joins", () => {
    const chat = ast.channels[0]!;
    expect(chat.joins.length).toBe(1);

    const join = chat.joins[0]!;
    expect(join.topicPattern).toBe(
      "api:chat:team:{team_id}:thread:{thread_id}"
    );
    expect(join.params.length).toBe(3); // team_id, thread_id, limit
  });

  it("parses channel messages", () => {
    const chat = ast.channels[0]!;
    expect(chat.messages.length).toBe(1);
    expect(chat.messages[0]!.event).toBe("send_message");
  });

  it("parses channel pushes", () => {
    const chat = ast.channels[0]!;
    expect(chat.pushes.length).toBe(2);
    const events = chat.pushes.map((p) => p.event).sort();
    expect(events).toEqual(["message_added", "message_updated"]);
  });

  it("produces auth config with schemes and flows", () => {
    expect(ast.auth.schemes).toBeDefined();
    expect(ast.auth.tokenFlows).toBeDefined();
    expect(ast.auth.channelAuth).toBeDefined();
  });
});

describe("parseOpenApiSpec preserves summary and description separately", () => {
  const ast = parseOpenApiSpec(docFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });

  it("keeps both fields on operations", () => {
    const teams = ast.resources.find((r) => r.name === "teams")!;
    const joinByCode = teams.operations.find((o) => o.name === "joinByCode")!;

    expect(joinByCode.summary).toBe("Join a team using an invite code");
    expect(joinByCode.description).toContain("Accepts either");
  });
});

describe("parseOpenApiSpec detects raw responses", () => {
  const ast = parseOpenApiSpec(rawFixture, {
    name: "archastro-platform",
    version: "0.1.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });

  it("marks non-json successful responses as raw", () => {
    const configs = ast.resources.find((r) => r.name === "configs")!;
    const content = configs.operations.find((o) => o.name === "content")!;
    expect(content.rawResponse).toBe(true);
  });
});

describe("detectVersions", () => {
  it("detects version prefixes from paths", () => {
    const paths = [
      "/api/v1/teams",
      "/api/v1/agents",
      "/api/v2/teams",
      "/api/v2/workflows",
    ];
    const groups = detectVersions(paths, "/api");
    expect(groups.size).toBe(2);
    expect(groups.get("v1")).toEqual(["/api/v1/teams", "/api/v1/agents"]);
    expect(groups.get("v2")).toEqual(["/api/v2/teams", "/api/v2/workflows"]);
  });

  it("returns empty map when no versions match", () => {
    const paths = ["/api/teams", "/api/agents"];
    const groups = detectVersions(paths, "/api");
    expect(groups.size).toBe(0);
  });

  it("handles single version", () => {
    const paths = ["/api/v1/teams", "/api/v1/agents"];
    const groups = detectVersions(paths, "/api");
    expect(groups.size).toBe(1);
    expect(groups.has("v1")).toBe(true);
  });
});

describe("parseOpenApiSpec with multi-version spec", () => {
  const ast = parseOpenApiSpec(versionedFixture, {
    name: "archastro-platform",
    version: "0.2.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v1",
  });

  it("detects two versions", () => {
    expect(ast.versions.length).toBe(2);
    const versionNames = ast.versions.map((v) => v.version);
    expect(versionNames).toEqual(["v1", "v2"]);
  });

  it("sets correct apiPrefix per version", () => {
    const v1 = ast.versions.find((v) => v.version === "v1")!;
    const v2 = ast.versions.find((v) => v.version === "v2")!;
    expect(v1.apiPrefix).toBe("/api/v1");
    expect(v2.apiPrefix).toBe("/api/v2");
  });

  it("v1 has teams and agents resources", () => {
    const v1 = ast.versions.find((v) => v.version === "v1")!;
    const names = v1.resources.map((r) => r.name).sort();
    expect(names).toContain("teams");
    expect(names).toContain("agents");
  });

  it("v2 has teams, agents, and workflows", () => {
    const v2 = ast.versions.find((v) => v.version === "v2")!;
    const names = v2.resources.map((r) => r.name).sort();
    expect(names).toContain("teams");
    expect(names).toContain("agents");
    expect(names).toContain("workflows");
  });

  it("v1 does not have workflows", () => {
    const v1 = ast.versions.find((v) => v.version === "v1")!;
    const names = v1.resources.map((r) => r.name);
    expect(names).not.toContain("workflows");
  });

  it("backward-compat resources match default version (v1)", () => {
    const v1 = ast.versions.find((v) => v.version === "v1")!;
    expect(ast.resources).toEqual(v1.resources);
    expect(ast.apiPrefix).toBe("/api/v1");
  });

  it("operations use full versioned paths", () => {
    const v1 = ast.versions.find((v) => v.version === "v1")!;
    const v1Teams = v1.resources.find((r) => r.name === "teams")!;
    const v1List = v1Teams.operations.find((o) => o.name === "list")!;
    expect(v1List.path).toBe("/api/v1/teams");

    const v2 = ast.versions.find((v) => v.version === "v2")!;
    const v2Teams = v2.resources.find((r) => r.name === "teams")!;
    const v2List = v2Teams.operations.find((o) => o.name === "list")!;
    expect(v2List.path).toBe("/api/v2/teams");
  });

  it("schemas are shared across versions", () => {
    expect(ast.schemas.length).toBeGreaterThan(0);
    const names = ast.schemas.map((s) => s.name);
    expect(names).toContain("Team");
    expect(names).toContain("Agent");
    expect(names).toContain("Workflow");
  });
});

describe("parseOpenApiSpec with multi-version spec and v2 default", () => {
  const ast = parseOpenApiSpec(versionedFixture, {
    name: "archastro-platform",
    version: "0.2.0",
    baseUrl: "https://platform.archastro.ai",
    apiBase: "/api",
    defaultVersion: "v2",
  });

  it("backward-compat resources match v2", () => {
    const v2 = ast.versions.find((v) => v.version === "v2")!;
    expect(ast.resources).toEqual(v2.resources);
    expect(ast.apiPrefix).toBe("/api/v2");
    expect(ast.defaultVersion).toBe("v2");
  });
});
