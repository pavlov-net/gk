import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { addEntities } from "../src/graph";
import {
  addChunkedObservation,
  addObservations,
  readObservation,
} from "../src/observations";
import type { SqliteBackend } from "../src/sqlite";
import { createTestDb } from "./helpers";

const config = loadConfig();

describe("Observation CRUD", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("addObservations links to one entity", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    const results = await addObservations(db, [
      { content: "Auth uses JWT tokens", entity_names: ["Auth"] },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.entity_names).toEqual(["Auth"]);
  });

  test("addObservations links to multiple entities", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);

    const results = await addObservations(db, [
      {
        content: "Auth reads user data from DB",
        entity_names: ["Auth", "DB"],
      },
    ]);
    expect(results[0]!.entity_names).toEqual(["Auth", "DB"]);

    // Verify junction table
    const links = await db.all(
      "SELECT * FROM observation_entities WHERE observation_id = ?",
      [results[0]!.id],
    );
    expect(links).toHaveLength(2);
  });

  test("addObservations throws for missing entity", async () => {
    db = await createTestDb();
    expect(
      addObservations(db, [{ content: "test", entity_names: ["Nope"] }]),
    ).rejects.toThrow("Entity not found: Nope");
  });

  test("readObservation returns content and entity names", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    const [result] = await addObservations(db, [
      { content: "Auth uses JWT", entity_names: ["Auth"] },
    ]);

    const obs = await readObservation(db, result!.id, config);
    expect(obs).toBeDefined();
    expect(obs!.content).toBe("Auth uses JWT");
    expect(obs!.entity_names).toEqual(["Auth"]);
  });

  test("readObservation bumps access_count and stability", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    const [result] = await addObservations(db, [
      { content: "Auth uses JWT", entity_names: ["Auth"] },
    ]);

    const first = await readObservation(db, result!.id, config);
    expect(first!.access_count).toBe(1);
    expect(first!.stability).toBeCloseTo(1.2);

    const second = await readObservation(db, result!.id, config);
    expect(second!.access_count).toBe(2);
    expect(second!.stability).toBeCloseTo(1.44);
  });

  test("readObservation returns undefined for missing", async () => {
    db = await createTestDb();
    const obs = await readObservation(db, "nope", config);
    expect(obs).toBeUndefined();
  });

  test("addChunkedObservation splits at sentence boundaries", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    const longContent = Array.from(
      { length: 20 },
      (_, i) => `Sentence number ${i + 1} about the authentication module.`,
    ).join(" ");

    const results = await addChunkedObservation(db, longContent, ["Auth"], {
      maxChunkSize: 200,
    });

    expect(results.length).toBeGreaterThan(1);

    // All chunks should link to Auth
    for (const r of results) {
      expect(r.entity_names).toEqual(["Auth"]);
    }

    // Check chunk metadata
    const obs = await readObservation(db, results[0]!.id, config);
    const meta = JSON.parse(obs!.metadata);
    expect(meta.chunk_index).toBe(0);
    expect(meta.chunk_total).toBe(results.length);
    expect(meta.chunk_group).toBeDefined();
  });
});
