import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  addEntities,
  addRelationships,
  extractSubgraph,
  findPaths,
  getCentrality,
  getNeighbors,
  getStats,
  getTimeline,
  validateGraph,
} from "../src/graph";
import { addObservations } from "../src/observations";
import type { SqliteBackend } from "../src/sqlite";
import { createTestDb } from "./helpers";

const config = loadConfig();

describe("getNeighbors", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("returns neighbors grouped by depth", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
      { name: "C", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "A", to_entity: "B", type: "uses" },
      { from_entity: "B", to_entity: "C", type: "uses" },
    ]);

    const neighbors = await getNeighbors(db, "A", config, { maxDepth: 2 });
    expect(neighbors.get(1)!).toHaveLength(1);
    expect(neighbors.get(1)![0]!.name).toBe("B");
    expect(neighbors.get(2)!).toHaveLength(1);
    expect(neighbors.get(2)![0]!.name).toBe("C");
  });

  test("respects maxDepth", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
      { name: "C", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "A", to_entity: "B", type: "uses" },
      { from_entity: "B", to_entity: "C", type: "uses" },
    ]);

    const neighbors = await getNeighbors(db, "A", config, { maxDepth: 1 });
    expect(neighbors.get(1)!).toHaveLength(1);
    expect(neighbors.has(2)).toBe(false);
  });

  test("handles cycles without infinite loop", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
      { name: "C", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "A", to_entity: "B", type: "uses" },
      { from_entity: "B", to_entity: "C", type: "uses" },
      { from_entity: "C", to_entity: "A", type: "uses" },
    ]);

    const neighbors = await getNeighbors(db, "A", config, { maxDepth: 5 });
    // Bidirectional: B (via A→B) and C (via C→A) are both depth-1 neighbors
    expect(neighbors.get(1)!).toHaveLength(2);
    expect(neighbors.has(2)).toBe(false);
  });

  test("bumps strength on traversed edges", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "A", to_entity: "B", type: "uses" },
    ]);

    await getNeighbors(db, "A", config, { maxDepth: 1 });

    const row = await db.get<{ strength: number; access_count: number }>(
      "SELECT strength, access_count FROM relationships WHERE type = 'uses'",
    );
    expect(row!.strength).toBeCloseTo(1.1);
    expect(row!.access_count).toBe(1);
  });

  test("returns empty for missing entity", async () => {
    db = await createTestDb();
    const neighbors = await getNeighbors(db, "Nope", config);
    expect(neighbors.size).toBe(0);
  });
});

describe("findPaths", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("finds linear path A→B→C", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
      { name: "C", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "A", to_entity: "B", type: "uses" },
      { from_entity: "B", to_entity: "C", type: "uses" },
    ]);

    const paths = await findPaths(db, "A", "C");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual(["A", "B", "C"]);
  });

  test("returns shortest path", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
      { name: "C", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "A", to_entity: "B", type: "uses" },
      { from_entity: "B", to_entity: "C", type: "uses" },
      { from_entity: "A", to_entity: "C", type: "direct" },
    ]);

    const paths = await findPaths(db, "A", "C");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual(["A", "C"]);
  });

  test("handles cycles without infinite loop", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
      { name: "C", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "A", to_entity: "B", type: "uses" },
      { from_entity: "B", to_entity: "C", type: "uses" },
      { from_entity: "C", to_entity: "A", type: "uses" },
    ]);

    const paths = await findPaths(db, "A", "C");
    expect(paths).toHaveLength(1);
    // Bidirectional: C is directly reachable from A via the C→A edge
    expect(paths[0]).toEqual(["A", "C"]);
  });

  test("returns empty when no path exists", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
    ]);
    // No relationships

    const paths = await findPaths(db, "A", "B");
    expect(paths).toHaveLength(0);
  });

  test("returns empty for missing entities", async () => {
    db = await createTestDb();
    const paths = await findPaths(db, "Nope", "Also Nope");
    expect(paths).toHaveLength(0);
  });
});

describe("extractSubgraph", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("extracts entities and relationships from seed", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
      { name: "C", type: "component" },
      { name: "D", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "A", to_entity: "B", type: "uses" },
      { from_entity: "B", to_entity: "C", type: "uses" },
      { from_entity: "C", to_entity: "D", type: "uses" },
    ]);

    const sub = await extractSubgraph(db, ["A"], { maxDepth: 1 });
    expect(sub.entities).toHaveLength(2); // A + B
    expect(sub.relationships).toHaveLength(1); // A→B
  });
});

describe("getCentrality", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("degree centrality ranks hub nodes highest", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Hub", type: "component" },
      { name: "A", type: "component" },
      { name: "B", type: "component" },
      { name: "C", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "Hub", to_entity: "A", type: "uses" },
      { from_entity: "Hub", to_entity: "B", type: "uses" },
      { from_entity: "Hub", to_entity: "C", type: "uses" },
    ]);

    const centrality = await getCentrality(db, { mode: "degree" });
    expect(centrality[0]!.name).toBe("Hub");
    expect(centrality[0]!.score).toBe(3);
  });

  test("pagerank mode returns results", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "A", type: "component" },
      { name: "B", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "A", to_entity: "B", type: "uses" },
    ]);

    const centrality = await getCentrality(db, { mode: "pagerank" });
    expect(centrality).toHaveLength(2);
    expect(centrality[0]!.score).toBeGreaterThan(0);
  });
});

describe("getTimeline", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("returns observations ordered by created_at", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(db, [
      { content: "First observation", entity_names: ["Auth"] },
      { content: "Second observation", entity_names: ["Auth"] },
    ]);

    const timeline = await getTimeline(db);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]!.entity_names).toContain("Auth");
  });

  test("filters by entity name", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);
    await addObservations(db, [
      { content: "Auth observation", entity_names: ["Auth"] },
      { content: "DB observation", entity_names: ["DB"] },
    ]);

    const timeline = await getTimeline(db, { entityName: "Auth" });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.content).toBe("Auth observation");
  });
});

describe("getStats", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("returns aggregate statistics", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
      { name: "UseJWT", type: "decision" },
    ]);
    await addRelationships(db, [
      { from_entity: "Auth", to_entity: "DB", type: "depends_on" },
    ]);
    await addObservations(db, [
      { content: "Auth uses JWT", entity_names: ["Auth"] },
    ]);

    const stats = await getStats(db);
    expect(stats.entity_count).toBe(3);
    expect(stats.relationship_count).toBe(1);
    expect(stats.observation_count).toBe(1);
    expect(stats.types.component).toBe(2);
    expect(stats.types.decision).toBe(1);
    expect(stats.temporal_health.fragile).toBe(3); // all stability=1.0
  });
});

describe("validateGraph", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("identifies islands and missing observations", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Connected", type: "component" },
      { name: "Island", type: "component" },
      { name: "Other", type: "component" },
    ]);
    await addRelationships(db, [
      { from_entity: "Connected", to_entity: "Other", type: "uses" },
    ]);

    const validation = await validateGraph(db);
    expect(validation.islands).toContain("Island");
    expect(validation.islands).not.toContain("Connected");
    expect(validation.missingObservations).toHaveLength(3); // none have observations
  });
});
