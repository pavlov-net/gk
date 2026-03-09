import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GraphDB } from "../src/backend";

const shouldRun = !!process.env.GK_DOLT_HOST;

describe.skipIf(!shouldRun)("DoltBackend", () => {
  let db: GraphDB;

  beforeAll(async () => {
    db = GraphDB.forMysql({
      host: process.env.GK_DOLT_HOST!,
      port: Number(process.env.GK_DOLT_PORT ?? 3307),
      database: process.env.GK_DOLT_DATABASE ?? "gk_test",
      user: process.env.GK_DOLT_USER ?? "root",
      password: process.env.GK_DOLT_PASSWORD ?? "",
    });
    await db.initialize();
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  test("initializes schema with all tables", async () => {
    const tables = await db.all<{ TABLE_NAME: string }>(
      "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()",
    );
    const names = tables.map((t) => t.TABLE_NAME);
    expect(names).toContain("entities");
    expect(names).toContain("observations");
    expect(names).toContain("observation_entities");
    expect(names).toContain("relationships");
  });

  test("run returns changes count", async () => {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    const result = await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["dt1", "TestEntity", "component", ts, ts],
    );
    expect(result.changes).toBe(1);
    await db.run("DELETE FROM entities WHERE id = ?", ["dt1"]);
  });

  test("get returns single row or undefined", async () => {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["dt2", "TestEntity2", "component", ts, ts],
    );
    const row = await db.get("SELECT * FROM entities WHERE id = ?", ["dt2"]);
    expect(row).toBeDefined();
    expect(row!.name).toBe("TestEntity2");

    const missing = await db.get("SELECT * FROM entities WHERE id = ?", [
      "nope",
    ]);
    expect(missing).toBeUndefined();
    await db.run("DELETE FROM entities WHERE id = ?", ["dt2"]);
  });

  test("searchObservations returns FULLTEXT results", async () => {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["dte1", "Auth", "component", ts, ts],
    );
    await db.run(
      "INSERT INTO observations (id, content, created_at) VALUES (?, ?, ?)",
      [
        "dto1",
        "The authentication module handles JWT token validation and refresh",
        ts,
      ],
    );
    await db.run(
      "INSERT INTO observation_entities (observation_id, entity_id) VALUES (?, ?)",
      ["dto1", "dte1"],
    );

    const results = await db.searchObservations("authentication JWT");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.score).toBeGreaterThan(0);

    await db.run("DELETE FROM observation_entities WHERE observation_id = ?", [
      "dto1",
    ]);
    await db.run("DELETE FROM observations WHERE id = ?", ["dto1"]);
    await db.run("DELETE FROM entities WHERE id = ?", ["dte1"]);
  });

  test("searchEntities returns FULLTEXT results", async () => {
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.run(
      "INSERT INTO entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["dte2", "Authentication Module", "component", ts, ts],
    );

    const results = await db.searchEntities("Authentication");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.name).toBe("Authentication Module");

    await db.run("DELETE FROM entities WHERE id = ?", ["dte2"]);
  });
});
