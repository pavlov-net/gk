import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  addEntities,
  addRelationships,
  deleteEntities,
  getEntity,
  getRelationships,
  updateEntities,
  updateRelationships,
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

describe("Relationship CRUD", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("addRelationships creates relationships between entities", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);

    const results = await addRelationships(db, [
      { from_entity: "Auth", to_entity: "DB", type: "depends_on" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.from_entity).toBe("Auth");
    expect(results[0]!.to_entity).toBe("DB");
    expect(results[0]!.type).toBe("depends_on");
  });

  test("addRelationships upserts on conflict", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);

    const first = await addRelationships(db, [
      {
        from_entity: "Auth",
        to_entity: "DB",
        type: "depends_on",
        confidence: 0.5,
      },
    ]);
    const second = await addRelationships(db, [
      {
        from_entity: "Auth",
        to_entity: "DB",
        type: "depends_on",
        confidence: 0.9,
      },
    ]);

    expect(second[0]!.id).toBe(first[0]!.id);

    const row = await db.get<{ confidence: number }>(
      "SELECT confidence FROM relationships WHERE id = ?",
      [first[0]!.id],
    );
    expect(row!.confidence).toBe(0.9);
  });

  test("addRelationships throws for nonexistent entity", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    expect(
      addRelationships(db, [
        { from_entity: "Auth", to_entity: "Nope", type: "depends_on" },
      ]),
    ).rejects.toThrow("Entity not found: Nope");
  });

  test("getRelationships returns relationships with names", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "Auth", to_entity: "DB", type: "depends_on" },
    ]);

    const rels = await getRelationships(db, config, {
      entity_name: "Auth",
    });
    expect(rels).toHaveLength(1);
    expect(rels[0]!.from_name).toBe("Auth");
    expect(rels[0]!.to_name).toBe("DB");
  });

  test("getRelationships bumps strength on retrieval", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "Auth", to_entity: "DB", type: "depends_on" },
    ]);

    await getRelationships(db, config, { entity_name: "Auth" });

    const row = await db.get<{ strength: number; access_count: number }>(
      "SELECT strength, access_count FROM relationships WHERE type = 'depends_on'",
    );
    expect(row!.strength).toBeCloseTo(1.1);
    expect(row!.access_count).toBe(1);
  });

  test("getRelationships filters by type", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
      { name: "Cache", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "Auth", to_entity: "DB", type: "depends_on" },
      { from_entity: "Auth", to_entity: "Cache", type: "uses" },
    ]);

    const rels = await getRelationships(db, config, { type: "uses" });
    expect(rels).toHaveLength(1);
    expect(rels[0]!.to_name).toBe("Cache");
  });

  test("updateRelationships modifies properties", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);
    const [rel] = await addRelationships(db, [
      { from_entity: "Auth", to_entity: "DB", type: "depends_on" },
    ]);

    const count = await updateRelationships(db, [
      { id: rel!.id, properties: { critical: true } },
    ]);
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await db.get<{ properties: string }>(
      "SELECT properties FROM relationships WHERE id = ?",
      [rel!.id],
    );
    expect(JSON.parse(row!.properties)).toEqual({ critical: true });
  });
});
