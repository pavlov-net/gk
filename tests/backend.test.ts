import { afterEach, describe, expect, test } from "bun:test";
import type { GraphDB } from "../src/backend";
import { getEmbeddingCoverage } from "../src/observations";
import { createTestDb } from "./helpers";

describe("GraphDB", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("initializes schema with all tables", async () => {
    db = await createTestDb();
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables.map((t) => t.name);
    expect(names).toContain("entities");
    expect(names).toContain("observations");
    expect(names).toContain("observation_entities");
    expect(names).toContain("relationships");
  });

  test("run returns changes count", async () => {
    db = await createTestDb();
    const ts = new Date().toISOString();
    const result = await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["e1", "TestEntity", "component", ts, ts],
    );
    expect(result.changes).toBeGreaterThanOrEqual(1);
  });

  test("get returns single row or undefined", async () => {
    db = await createTestDb();
    const ts = new Date().toISOString();
    await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["e1", "TestEntity", "component", ts, ts],
    );
    const row = await db.get("SELECT * FROM entities WHERE id = ?", ["e1"]);
    expect(row).toBeDefined();
    expect(row!.name).toBe("TestEntity");

    const missing = await db.get("SELECT * FROM entities WHERE id = ?", [
      "nope",
    ]);
    expect(missing).toBeUndefined();
  });

  test("transaction commits on success", async () => {
    db = await createTestDb();
    const ts = new Date().toISOString();
    await db.transaction(async () => {
      await db.run(
        "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["e1", "A", "t", ts, ts],
      );
      await db.run(
        "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["e2", "B", "t", ts, ts],
      );
    });
    const rows = await db.all("SELECT * FROM entities");
    expect(rows).toHaveLength(2);
  });

  test("transaction rolls back on error", async () => {
    db = await createTestDb();
    const ts = new Date().toISOString();
    try {
      await db.transaction(async () => {
        await db.run(
          "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          ["e1", "A", "t", ts, ts],
        );
        throw new Error("deliberate");
      });
    } catch {
      /* expected */
    }
    const rows = await db.all("SELECT * FROM entities");
    expect(rows).toHaveLength(0);
  });

  test("searchObservations returns FTS results", async () => {
    db = await createTestDb();
    const ts = new Date().toISOString();
    await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["e1", "Auth", "component", ts, ts],
    );
    await db.run(
      "INSERT INTO observations (id, content, created_at) VALUES (?, ?, ?)",
      [
        "o1",
        "The authentication module handles JWT token validation and refresh",
        ts,
      ],
    );
    await db.run(
      "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)",
      ["o1", "e1"],
    );
    await db.syncObservationFts(["o1"]);

    const results = await db.searchObservations("authentication JWT");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.id).toBe("o1");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("searchObservations filters by entity types", async () => {
    db = await createTestDb();
    const ts = new Date().toISOString();
    await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["e1", "Auth", "component", ts, ts],
    );
    await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["e2", "UseJWT", "decision", ts, ts],
    );
    await db.run(
      "INSERT INTO observations (id, content, created_at) VALUES (?, ?, ?)",
      ["o1", "Auth uses JWT tokens", ts],
    );
    await db.run(
      "INSERT INTO observations (id, content, created_at) VALUES (?, ?, ?)",
      ["o2", "Decided to use JWT for auth", ts],
    );
    await db.run(
      "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)",
      ["o1", "e1"],
    );
    await db.run(
      "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)",
      ["o2", "e2"],
    );
    await db.syncObservationFts(["o1", "o2"]);

    const results = await db.searchObservations("JWT", {
      entityTypes: ["decision"],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("o2");
  });

  test("searchEntities returns FTS results", async () => {
    db = await createTestDb();
    const ts = new Date().toISOString();
    await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["e1", "Authentication Module", "component", ts, ts],
    );
    await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["e2", "Database Layer", "component", ts, ts],
    );
    await db.syncEntityFts(["Authentication Module", "Database Layer"]);

    const results = await db.searchEntities("authentication");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.name).toBe("Authentication Module");
  });
});

describe("vector storage", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("storeEmbeddings and searchByVector round-trip", async () => {
    db = await createTestDb();

    await db.run(
      "INSERT INTO observations (id, content, created_at) VALUES (?, ?, ?)",
      ["obs1", "test content", new Date().toISOString()],
    );

    const vector = new Float32Array(768);
    vector[0] = 1.0;
    await db.storeEmbeddings([{ id: "obs1", vector }]);

    const queryVec = new Float32Array(768);
    queryVec[0] = 1.0;
    const results = await db.searchByVector(queryVec, 10);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("obs1");
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  test("storeEmbeddings overwrites existing embedding", async () => {
    db = await createTestDb();
    await db.run(
      "INSERT INTO observations (id, content, created_at) VALUES (?, ?, ?)",
      ["obs1", "test content", new Date().toISOString()],
    );

    const v1 = new Float32Array(768);
    v1[0] = 1.0;
    await db.storeEmbeddings([{ id: "obs1", vector: v1 }]);

    const v2 = new Float32Array(768);
    v2[1] = 1.0;
    await db.storeEmbeddings([{ id: "obs1", vector: v2 }]);

    const query = new Float32Array(768);
    query[1] = 1.0;
    const results = await db.searchByVector(query, 10);
    expect(results[0].id).toBe("obs1");
  });

  test("getEmbeddingCoverage reports counts", async () => {
    db = await createTestDb();
    await db.run(
      "INSERT INTO observations (id, content, created_at) VALUES (?, ?, ?)",
      ["obs1", "test content", new Date().toISOString()],
    );

    const coverage = await getEmbeddingCoverage(db);
    expect(coverage.total).toBe(1);
    expect(coverage.embedded).toBe(0);

    const vec = new Float32Array(768);
    await db.storeEmbeddings([{ id: "obs1", vector: vec }]);

    const after = await getEmbeddingCoverage(db);
    expect(after.embedded).toBe(1);
  });
});
