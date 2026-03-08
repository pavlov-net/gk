import { afterEach, describe, expect, test } from "bun:test";
import type { SqliteBackend } from "../src/sqlite";
import { createTestDb } from "./helpers";

describe("SqliteBackend", () => {
  let db: SqliteBackend;

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

    const results = await db.searchEntities("authentication");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.name).toBe("Authentication Module");
  });
});
