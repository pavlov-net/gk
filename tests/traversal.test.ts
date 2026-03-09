import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  addEntities,
  addRelationships,
  findPaths,
  getNeighbors,
} from "../src/graph";
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
