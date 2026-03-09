import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  addEntities,
  deleteEntities,
  getEntity,
  updateEntities,
} from "../src/graph";
import type { SqliteBackend } from "../src/sqlite";
import { createTestDb } from "./helpers";

const config = loadConfig();

describe("Entity CRUD", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("addEntities creates new entities with defaults", async () => {
    db = await createTestDb();
    const results = await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "UseJWT", type: "decision" },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe("Auth");
    expect(results[1]!.name).toBe("UseJWT");

    const row = await db.get<{ confidence: number; staleness_tier: string }>(
      "SELECT confidence, staleness_tier FROM entities WHERE name = ?",
      ["Auth"],
    );
    expect(row!.confidence).toBe(0.8);
    expect(row!.staleness_tier).toBe("detail");
  });

  test("addEntities upserts on (name, type) conflict", async () => {
    db = await createTestDb();
    const first = await addEntities(db, [
      {
        name: "Auth",
        type: "component",
        properties: { version: 1 },
      },
    ]);
    const second = await addEntities(db, [
      {
        name: "Auth",
        type: "component",
        properties: { version: 2 },
      },
    ]);

    // Same entity ID
    expect(second[0]!.id).toBe(first[0]!.id);

    // Properties updated
    const row = await db.get<{ properties: string }>(
      "SELECT properties FROM entities WHERE name = ? AND type = ?",
      ["Auth", "component"],
    );
    expect(JSON.parse(row!.properties)).toEqual({ version: 2 });
  });

  test("getEntity returns entity with relationships and observations", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    const entity = await getEntity(db, "Auth", config);
    expect(entity).toBeDefined();
    expect(entity!.name).toBe("Auth");
    expect(entity!.relationships).toEqual([]);
    expect(entity!.observations).toEqual([]);
  });

  test("getEntity bumps access_count and stability", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    const first = await getEntity(db, "Auth", config);
    expect(first!.access_count).toBe(1);
    expect(first!.stability).toBeCloseTo(1.2);

    const second = await getEntity(db, "Auth", config);
    expect(second!.access_count).toBe(2);
    expect(second!.stability).toBeCloseTo(1.44);
  });

  test("getEntity returns undefined for missing entity", async () => {
    db = await createTestDb();
    const entity = await getEntity(db, "Nope", config);
    expect(entity).toBeUndefined();
  });

  test("updateEntities modifies properties", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    const count = await updateEntities(db, [
      { name: "Auth", confidence: 0.95, staleness_tier: "overview" },
    ]);
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await db.get<{ confidence: number; staleness_tier: string }>(
      "SELECT confidence, staleness_tier FROM entities WHERE name = ?",
      ["Auth"],
    );
    expect(row!.confidence).toBe(0.95);
    expect(row!.staleness_tier).toBe("overview");
  });

  test("deleteEntities removes entity", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    const count = await deleteEntities(db, ["Auth"]);
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await db.get("SELECT * FROM entities WHERE name = ?", ["Auth"]);
    expect(row).toBeUndefined();
  });
});
