import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  addEntities,
  addRelationships,
  deleteEntities,
  getEntity,
  getEntityProfile,
  getRelationships,
  listEntityTypes,
  mergeEntities,
  updateEntities,
  updateRelationships,
} from "../src/graph";
import { addObservations } from "../src/observations";
import type { GraphDB } from "../src/backend";
import { createTestDb } from "./helpers";

const config = loadConfig();

describe("Entity CRUD", () => {
  let db: GraphDB;

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

    const result = await deleteEntities(db, ["Auth"]);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const row = await db.get("SELECT * FROM entities WHERE name = ?", ["Auth"]);
    expect(row).toBeUndefined();
  });

  test("deleteEntities with deleteOrphanObservations cleans up orphans", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(db, [
      { content: "Auth handles JWT", entity_names: ["Auth"] },
    ]);

    const result = await deleteEntities(db, ["Auth"], {
      deleteOrphanObservations: true,
    });
    expect(result.deleted).toBe(1);
    expect(result.orphanObservationsDeleted).toBe(1);

    const obs = await db.all("SELECT * FROM observations");
    expect(obs).toHaveLength(0);
  });
});

describe("Relationship CRUD", () => {
  let db: GraphDB;

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

describe("Entity Merging", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("merge transfers observations from source to target", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "AuthModule", type: "component" },
      { name: "Auth", type: "component" },
    ]);
    await addObservations(db, [
      { content: "Handles JWT", entity_names: ["AuthModule"] },
    ]);

    const result = await mergeEntities(db, ["AuthModule"], "Auth");
    expect(result.merged).toBe(true);
    expect(result.observationsMoved).toBe(1);

    // Source deleted
    const source = await db.get("SELECT * FROM entities WHERE name = ?", [
      "AuthModule",
    ]);
    expect(source).toBeUndefined();

    // Observation now linked to target
    const links = await db.all(
      `SELECT e.name FROM observation_entities oe
       JOIN entities e ON e.id = oe.entity_id`,
    );
    expect(links).toHaveLength(1);
    expect((links[0] as { name: string }).name).toBe("Auth");
  });

  test("merge redirects relationships", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "AuthOld", type: "component" },
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "AuthOld", to_entity: "DB", type: "depends_on" },
    ]);

    const result = await mergeEntities(db, ["AuthOld"], "Auth");
    expect(result.relationshipsMoved).toBe(1);

    // Relationship now from Auth → DB
    const rels = await db.all<{ from_entity: string }>(
      `SELECT ef.name as from_entity FROM relationships r
       JOIN entities ef ON ef.id = r.from_entity`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]!.from_entity).toBe("Auth");
  });

  test("merge handles duplicate relationships by keeping max strength", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "AuthOld", type: "component" },
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "AuthOld", to_entity: "DB", type: "depends_on" },
      { from_entity: "Auth", to_entity: "DB", type: "depends_on" },
    ]);

    // Boost AuthOld's strength
    const rel = await db.get<{ id: string }>(
      `SELECT r.id FROM relationships r
       JOIN entities ef ON ef.id = r.from_entity
       WHERE ef.name = 'AuthOld'`,
    );
    await db.run("UPDATE relationships SET strength = 5.0 WHERE id = ?", [
      rel!.id,
    ]);

    await mergeEntities(db, ["AuthOld"], "Auth");

    // Should keep max strength (5.0)
    const remaining = await db.get<{ strength: number }>(
      "SELECT strength FROM relationships WHERE type = 'depends_on'",
    );
    expect(remaining!.strength).toBe(5.0);

    // Only one relationship should remain
    const count = await db.all("SELECT * FROM relationships");
    expect(count).toHaveLength(1);
  });

  test("merge multiple sources into target", async () => {
    db = await createTestDb();
    await addEntities(db, [
      {
        name: "ReactJS",
        type: "library",
        properties: { version: "18" },
      },
      {
        name: "React.js",
        type: "library",
        properties: { repo: "facebook/react" },
      },
      {
        name: "React",
        type: "library",
        properties: { category: "frontend" },
      },
    ]);
    await addObservations(db, [
      { content: "ReactJS is a UI library", entity_names: ["ReactJS"] },
      {
        content: "React.js supports server components",
        entity_names: ["React.js"],
      },
    ]);

    const result = await mergeEntities(db, ["ReactJS", "React.js"], "React");
    expect(result.sourcesMerged).toBe(2);
    expect(result.observationsMoved).toBe(2);

    // Target should have merged properties (target wins)
    const target = await db.get<{ properties: string }>(
      "SELECT properties FROM entities WHERE name = ?",
      ["React"],
    );
    const props = JSON.parse(target!.properties);
    expect(props.category).toBe("frontend"); // target's own
    expect(props.version).toBe("18"); // from ReactJS
    expect(props.repo).toBe("facebook/react"); // from React.js

    // Sources should be deleted
    const sources = await db.all(
      "SELECT * FROM entities WHERE name IN ('ReactJS', 'React.js')",
    );
    expect(sources).toHaveLength(0);
  });

  test("merge is transactional", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    // Should throw — target doesn't exist
    try {
      await mergeEntities(db, ["Auth"], "Nope");
    } catch {
      /* expected */
    }

    // Source should still exist (transaction rolled back)
    const entity = await db.get("SELECT * FROM entities WHERE name = ?", [
      "Auth",
    ]);
    expect(entity).toBeDefined();
  });
});

describe("Entity Profiles", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("getEntityProfile returns full profile with relationships and observations", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "Auth", to_entity: "DB", type: "depends_on" },
    ]);
    await addObservations(db, [
      { content: "Auth handles JWT tokens", entity_names: ["Auth"] },
    ]);

    const profile = await getEntityProfile(db, "Auth", config);
    expect(profile).toBeDefined();
    expect(profile!.name).toBe("Auth");
    expect(profile!.relationships).toHaveLength(1);
    expect(profile!.relationships[0]!.target).toBe("DB");
    expect(profile!.relationships[0]!.direction).toBe("outgoing");
    expect(profile!.observations).toHaveLength(1);
    expect(profile!.observations[0]!.content).toBe("Auth handles JWT tokens");
  });

  test("getEntityProfile truncates long observations", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    const longContent = "A".repeat(500);
    await addObservations(db, [
      { content: longContent, entity_names: ["Auth"] },
    ]);

    const profile = await getEntityProfile(db, "Auth", config, {
      maxObservationLength: 100,
    });
    expect(profile!.observations[0]!.content).toHaveLength(103); // 100 + "..."
    expect(profile!.observations[0]!.content.endsWith("...")).toBe(true);
  });

  test("getEntityProfile returns undefined for missing entity", async () => {
    db = await createTestDb();
    const profile = await getEntityProfile(db, "Nope", config);
    expect(profile).toBeUndefined();
  });
});

describe("listEntityTypes", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("returns type counts", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
      { name: "UseJWT", type: "decision" },
    ]);

    const types = await listEntityTypes(db);
    expect(types).toHaveLength(2);
    expect(types[0]!.type).toBe("component");
    expect(types[0]!.count).toBe(2);
    expect(types[1]!.type).toBe("decision");
    expect(types[1]!.count).toBe(1);
  });
});
