import { afterEach, describe, expect, mock, test } from "bun:test";
import type { GraphDB } from "../src/backend";
import { loadConfig } from "../src/config";
import type { Embedder } from "../src/embeddings";
import { addEntities } from "../src/graph";
import {
  addChunkedObservation,
  addObservations,
  backfillEmbeddings,
  getEmbeddingCoverage,
  readObservation,
} from "../src/observations";
import { createTestDb } from "./helpers";

const config = loadConfig();

describe("Observation CRUD", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("addObservations links to one entity", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    const results = await addObservations(
      db,
      [{ content: "Auth uses JWT tokens", entity_names: ["Auth"] }],
      config,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.entity_names).toEqual(["Auth"]);
  });

  test("addObservations links to multiple entities", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);

    const results = await addObservations(
      db,
      [
        {
          content: "Auth reads user data from DB",
          entity_names: ["Auth", "DB"],
        },
      ],
      config,
    );
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
      addObservations(
        db,
        [{ content: "test", entity_names: ["Nope"] }],
        config,
      ),
    ).rejects.toThrow("Entity not found: Nope");
  });

  test("readObservation returns content and entity names", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    const [result] = await addObservations(
      db,
      [{ content: "Auth uses JWT", entity_names: ["Auth"] }],
      config,
    );

    const obs = await readObservation(db, result!.id);
    expect(obs).toBeDefined();
    expect(obs!.content).toBe("Auth uses JWT");
    expect(obs!.entity_names).toEqual(["Auth"]);
  });

  test("readObservation is read-only — does not bump temporal fields", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    const [result] = await addObservations(
      db,
      [{ content: "Auth uses JWT", entity_names: ["Auth"] }],
      config,
    );

    await readObservation(db, result!.id);
    await readObservation(db, result!.id);

    const row = await db.get<{
      stability: number;
      last_accessed: string | null;
    }>("SELECT stability, last_accessed FROM observations WHERE id = ?", [
      result!.id,
    ]);
    expect(row!.stability).toBe(1.0);
    expect(row!.last_accessed).toBeNull();
  });

  test("readObservation returns undefined for missing", async () => {
    db = await createTestDb();
    const obs = await readObservation(db, "nope");
    expect(obs).toBeUndefined();
  });

  test("addObservations bumps entity stability (write-only temporal)", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    await addObservations(
      db,
      [{ content: "Auth uses JWT", entity_names: ["Auth"] }],
      config,
    );

    const row = await db.get<{
      stability: number;
      last_accessed: string | null;
    }>("SELECT stability, last_accessed FROM entities WHERE name = ?", [
      "Auth",
    ]);
    expect(row!.stability).toBeGreaterThan(1.0);
    expect(row!.last_accessed).not.toBeNull();
  });

  test("addChunkedObservation splits at sentence boundaries", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);

    const longContent = Array.from(
      { length: 20 },
      (_, i) => `Sentence number ${i + 1} about the authentication module.`,
    ).join(" ");

    const results = await addChunkedObservation(
      db,
      longContent,
      ["Auth"],
      config,
      {
        maxChunkSize: 200,
      },
    );

    expect(results.length).toBeGreaterThan(1);

    // All chunks should link to Auth
    for (const r of results) {
      expect(r.entity_names).toEqual(["Auth"]);
    }

    // Check chunk metadata
    const obs = await readObservation(db, results[0]!.id);
    const meta = JSON.parse(obs!.metadata);
    expect(meta.chunk_index).toBe(0);
    expect(meta.chunk_total).toBe(results.length);
    expect(meta.chunk_group).toBeDefined();
  });
});

function mockEmbedder(): Embedder {
  return {
    embed: mock(async (texts: string[]) =>
      texts.map(() => new Float32Array(768)),
    ) as Embedder["embed"],
    isAvailable: mock(async () => true) as Embedder["isAvailable"],
  };
}

describe("addObservations with embedder", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("stores embeddings when embedder is provided", async () => {
    db = await createTestDb();
    const embedder = mockEmbedder();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(
      db,
      [{ content: "JWT handles tokens", entity_names: ["Auth"] }],
      config,
      embedder,
    );

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    const coverage = await getEmbeddingCoverage(db);
    expect(coverage.embedded).toBe(1);
  });

  test("succeeds without embedder (no vectors stored)", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    const results = await addObservations(
      db,
      [{ content: "JWT handles tokens", entity_names: ["Auth"] }],
      config,
    );

    expect(results).toHaveLength(1);
    const coverage = await getEmbeddingCoverage(db);
    expect(coverage.embedded).toBe(0);
  });

  test("succeeds when embedder throws (graceful degradation)", async () => {
    db = await createTestDb();
    const embedder: Embedder = {
      embed: async () => {
        throw new Error("Ollama down");
      },
      isAvailable: async () => false,
    };
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    const results = await addObservations(
      db,
      [{ content: "JWT handles tokens", entity_names: ["Auth"] }],
      config,
      embedder,
    );

    expect(results).toHaveLength(1);
    const coverage = await getEmbeddingCoverage(db);
    expect(coverage.embedded).toBe(0);
  });
});

describe("backfillEmbeddings", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("embeds observations that lack vectors", async () => {
    db = await createTestDb();
    const embedder = mockEmbedder();

    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(
      db,
      [
        { content: "JWT handles tokens", entity_names: ["Auth"] },
        { content: "OAuth2 flow", entity_names: ["Auth"] },
      ],
      config,
    );

    const before = await getEmbeddingCoverage(db);
    expect(before.embedded).toBe(0);

    const result = await backfillEmbeddings(db, embedder);
    expect(result.embedded).toBe(2);
    expect(result.skipped).toBe(0);

    const after = await getEmbeddingCoverage(db);
    expect(after.embedded).toBe(2);
  });

  test("skips already-embedded observations", async () => {
    db = await createTestDb();
    const embedder = mockEmbedder();

    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(
      db,
      [{ content: "JWT handles tokens", entity_names: ["Auth"] }],
      config,
      embedder,
    );

    const result = await backfillEmbeddings(db, embedder);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("force re-embeds everything", async () => {
    db = await createTestDb();
    const embedder = mockEmbedder();

    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(
      db,
      [{ content: "JWT handles tokens", entity_names: ["Auth"] }],
      config,
      embedder,
    );

    const result = await backfillEmbeddings(db, embedder, { force: true });
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
