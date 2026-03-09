import { afterEach, describe, expect, test } from "bun:test";
import type { GraphDB } from "../src/backend";
import { loadConfig } from "../src/config";
import type { Embedder } from "../src/embeddings";
import { addEntities, updateEntities } from "../src/graph";
import { addObservations } from "../src/observations";
import { searchHybrid, searchKeyword, searchSemantic } from "../src/search";
import { createTestDb } from "./helpers";

function mockEmbedder(queryVector?: Float32Array): Embedder {
  return {
    embed: async (_texts: string[]) =>
      _texts.map(() => queryVector ?? new Float32Array(768)),
    isAvailable: async () => true,
  };
}

const config = loadConfig();

describe("searchKeyword", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("returns FTS results without temporal adjustment", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(db, [
      {
        content: "JWT authentication handles token validation",
        entity_names: ["Auth"],
      },
      { content: "Database connection pooling setup", entity_names: ["Auth"] },
    ]);

    const results = await searchKeyword(db, "authentication JWT");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.entity_names).toContain("Auth");
  });

  test("includes entity_names from junction table", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);
    await addObservations(db, [
      {
        content: "Auth reads user credentials from database",
        entity_names: ["Auth", "DB"],
      },
    ]);

    const results = await searchKeyword(db, "credentials database");
    expect(results[0]!.entity_names).toContain("Auth");
    expect(results[0]!.entity_names).toContain("DB");
  });

  test("filters by metadata_filters", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Book", type: "document" }]);
    await addObservations(db, [
      {
        content: "Chapter 3 discusses advanced patterns",
        entity_names: ["Book"],
        metadata: { chapter: "3" },
      },
      {
        content: "Chapter 1 covers the basics of the system",
        entity_names: ["Book"],
        metadata: { chapter: "1" },
      },
    ]);

    const results = await searchKeyword(db, "chapter", {
      metadataFilters: { chapter: "3" },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("advanced patterns");
  });

  test("metadata_filters with no match returns empty", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Book", type: "document" }]);
    await addObservations(db, [
      {
        content: "Chapter 3 discusses advanced patterns",
        entity_names: ["Book"],
        metadata: { chapter: "3" },
      },
    ]);

    const results = await searchKeyword(db, "chapter", {
      metadataFilters: { chapter: "99" },
    });
    expect(results).toHaveLength(0);
  });

  test("filters by entity types", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "UseJWT", type: "decision" },
    ]);
    await addObservations(db, [
      {
        content: "Auth uses JWT tokens for validation",
        entity_names: ["Auth"],
      },
      {
        content: "Decided to use JWT for authentication",
        entity_names: ["UseJWT"],
      },
    ]);

    const results = await searchKeyword(db, "JWT", {
      entityTypes: ["decision"],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.entity_names).toContain("UseJWT");
  });
});

describe("searchHybrid", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("re-ranks by temporal score", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(db, [
      {
        content: "Authentication module handles JWT tokens",
        entity_names: ["Auth"],
      },
    ]);

    const results = await searchHybrid(db, "authentication JWT", config);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("overview-tier ranks higher than detail-tier", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Arch", type: "component" },
      { name: "Impl", type: "component" },
    ]);
    await updateEntities(db, [
      { name: "Arch", staleness_tier: "overview" },
      { name: "Impl", staleness_tier: "detail" },
    ]);
    await addObservations(db, [
      {
        content: "System uses microservices architecture pattern",
        entity_names: ["Arch"],
      },
      {
        content: "Implementation uses microservices framework setup",
        entity_names: ["Impl"],
      },
    ]);

    const results = await searchHybrid(db, "microservices", config);
    expect(results.length).toBe(2);
    // Overview-tier entity's observation should rank higher
    expect(results[0]!.entity_names).toContain("Arch");
  });

  test("bumps access_count on returned results", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    const [obs] = await addObservations(db, [
      {
        content: "Authentication module handles JWT tokens",
        entity_names: ["Auth"],
      },
    ]);

    await searchHybrid(db, "authentication", config);

    const row = await db.get<{ access_count: number }>(
      "SELECT access_count FROM observations WHERE id = ?",
      [obs!.id],
    );
    expect(row!.access_count).toBe(1);
  });
});

describe("searchSemantic", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("returns observations ranked by vector similarity", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    const ts = new Date().toISOString();
    await db.run(
      "INSERT INTO observations (id, content, created_at) VALUES (?, ?, ?)",
      ["obs1", "JWT authentication", ts],
    );
    const entityRow = await db.get<{ id: string }>(
      "SELECT id FROM entities WHERE name = ?",
      ["Auth"],
    );
    await db.run(
      "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)",
      ["obs1", entityRow!.id],
    );

    const vec = new Float32Array(768);
    vec[0] = 1.0;
    await db.storeEmbeddings([{ id: "obs1", vector: vec }]);

    const queryVec = new Float32Array(768);
    queryVec[0] = 1.0;
    const embedder = mockEmbedder(queryVec);

    const results = await searchSemantic(db, "anything", embedder);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("obs1");
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].entity_names).toContain("Auth");
  });

  test("returns empty when no embeddings exist", async () => {
    db = await createTestDb();
    const embedder = mockEmbedder();
    const results = await searchSemantic(db, "anything", embedder);
    expect(results).toHaveLength(0);
  });
});

describe("searchHybrid with semantic", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("combines BM25 and semantic scores when embedder provided", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(db, [
      {
        content: "Authentication module handles JWT tokens",
        entity_names: ["Auth"],
      },
    ]);

    // Store a vector for the observation
    const obs = await db.get<{ id: string }>(
      "SELECT id FROM observations LIMIT 1",
    );
    const vec = new Float32Array(768);
    vec[0] = 1.0;
    await db.storeEmbeddings([{ id: obs!.id, vector: vec }]);

    const queryVec = new Float32Array(768);
    queryVec[0] = 1.0;
    const embedder = mockEmbedder(queryVec);

    const results = await searchHybrid(
      db,
      "authentication",
      config,
      undefined,
      embedder,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("falls back to BM25-only when no embedder", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(db, [
      {
        content: "Authentication module handles JWT tokens",
        entity_names: ["Auth"],
      },
    ]);

    const results = await searchHybrid(db, "authentication", config);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
