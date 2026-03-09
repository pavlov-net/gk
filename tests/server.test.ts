import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config";
import { createServer } from "../src/server";
import type { GraphDB } from "../src/backend";
import { createTestDb } from "./helpers";

const config = loadConfig();

async function setup() {
  const db = await createTestDb();
  const mcpServer = createServer(db, config);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  return { db, mcpServer, client };
}

describe("MCP Server", () => {
  let db: GraphDB;
  let client: Client;
  let mcpServer: ReturnType<typeof createServer>;

  afterEach(async () => {
    if (client) await client.close();
    if (mcpServer) await mcpServer.close();
    if (db) await db.close();
  });

  test("lists all registered tools", async () => {
    ({ db, mcpServer, client } = await setup());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("add_entities");
    expect(names).toContain("search");
    expect(names).toContain("get_entity");
    expect(names).toContain("validate_graph");
    expect(names).toContain("prune_stale");
    expect(tools.length).toBeGreaterThanOrEqual(25);
  });

  test("lists resources", async () => {
    ({ db, mcpServer, client } = await setup());
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("gk://guides/extraction");
    expect(uris).toContain("gk://guides/pyramid");
    expect(uris).toContain("gk://guides/query");
    expect(uris).toContain("gk://guides/review");
  });

  test("lists prompts", async () => {
    ({ db, mcpServer, client } = await setup());
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    expect(names).toContain("extraction_guide");
    expect(names).toContain("pyramid_guide");
    expect(names).toContain("query_guide");
    expect(names).toContain("review_guide");
  });

  test("add_entities and get_entity round-trip", async () => {
    ({ db, mcpServer, client } = await setup());

    const addResult = await client.callTool({
      name: "add_entities",
      arguments: {
        entities: [
          { name: "Auth Service", type: "component" },
          { name: "Database", type: "component" },
        ],
      },
    });
    expect(addResult.isError).toBeFalsy();
    const added = JSON.parse(
      (addResult.content as Array<{ text: string }>)[0]!.text,
    );
    expect(added).toHaveLength(2);

    const getResult = await client.callTool({
      name: "get_entity",
      arguments: { name: "Auth Service" },
    });
    expect(getResult.isError).toBeFalsy();
    const entity = JSON.parse(
      (getResult.content as Array<{ text: string }>)[0]!.text,
    );
    expect(entity.name).toBe("Auth Service");
    expect(entity.type).toBe("component");
  });

  test("get_entity returns error for missing entity", async () => {
    ({ db, mcpServer, client } = await setup());
    const result = await client.callTool({
      name: "get_entity",
      arguments: { name: "Nonexistent" },
    });
    expect(result.isError).toBe(true);
  });

  test("add_observations and search_keyword", async () => {
    ({ db, mcpServer, client } = await setup());

    await client.callTool({
      name: "add_entities",
      arguments: {
        entities: [{ name: "Auth", type: "component" }],
      },
    });

    await client.callTool({
      name: "add_observations",
      arguments: {
        observations: [
          {
            content: "Auth uses JWT tokens for session management",
            entity_names: ["Auth"],
          },
        ],
      },
    });

    const searchResult = await client.callTool({
      name: "search_keyword",
      arguments: { query: "JWT" },
    });
    expect(searchResult.isError).toBeFalsy();
    const results = JSON.parse(
      (searchResult.content as Array<{ text: string }>)[0]!.text,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("JWT");
  });

  test("add_relationships and find_paths", async () => {
    ({ db, mcpServer, client } = await setup());

    await client.callTool({
      name: "add_entities",
      arguments: {
        entities: [
          { name: "A", type: "node" },
          { name: "B", type: "node" },
          { name: "C", type: "node" },
        ],
      },
    });

    await client.callTool({
      name: "add_relationships",
      arguments: {
        relationships: [
          { from_entity: "A", to_entity: "B", type: "CONNECTS" },
          { from_entity: "B", to_entity: "C", type: "CONNECTS" },
        ],
      },
    });

    const pathResult = await client.callTool({
      name: "find_paths",
      arguments: { from: "A", to: "C" },
    });
    const paths = JSON.parse(
      (pathResult.content as Array<{ text: string }>)[0]!.text,
    );
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0]).toContain("A");
    expect(paths[0]).toContain("C");
  });

  test("get_stats returns graph statistics", async () => {
    ({ db, mcpServer, client } = await setup());

    await client.callTool({
      name: "add_entities",
      arguments: {
        entities: [{ name: "X", type: "test" }],
      },
    });

    const statsResult = await client.callTool({
      name: "get_stats",
      arguments: {},
    });
    const stats = JSON.parse(
      (statsResult.content as Array<{ text: string }>)[0]!.text,
    );
    expect(stats.entity_count).toBe(1);
    expect(stats.types.test).toBe(1);
  });

  test("validate_graph detects islands", async () => {
    ({ db, mcpServer, client } = await setup());

    await client.callTool({
      name: "add_entities",
      arguments: {
        entities: [{ name: "Lonely", type: "island" }],
      },
    });

    const result = await client.callTool({
      name: "validate_graph",
      arguments: {},
    });
    const validation = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    const islandNames = validation.issues
      .filter((i: { category: string }) => i.category === "island_entity")
      .map((i: { entity_names: string[] }) => i.entity_names[0]);
    expect(islandNames).toContain("Lonely");
  });

  test("read_resource returns guide content", async () => {
    ({ db, mcpServer, client } = await setup());
    const result = await client.readResource({
      uri: "gk://guides/extraction",
    });
    expect(result.contents[0]!.text).toContain("Knowledge Extraction");
  });

  test("get_prompt returns guide as prompt message", async () => {
    ({ db, mcpServer, client } = await setup());
    const result = await client.getPrompt({ name: "extraction_guide" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
  });
});
