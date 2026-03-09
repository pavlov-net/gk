import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { addEntities, updateEntities } from "../src/graph";
import { addObservations } from "../src/observations";
import { searchHybrid, searchKeyword } from "../src/search";
import type { SqliteBackend } from "../src/sqlite";
import { createTestDb } from "./helpers";

const config = loadConfig();

describe("searchKeyword", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("returns FTS results without temporal adjustment", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(db, [
      {
        content: "JWT authentication handles token validation",
        entity_names: ["Auth"],
      },
      { content: "Database connection pooling setup", entity_names: ["Auth"] },
    ]);

    const results = await searchKeyword(db, "authentication JWT");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.entity_names).toContain("Auth");
  });

  test("includes entity_names from junction table", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
    ]);
    await addObservations(db, [
      {
        content: "Auth reads user credentials from database",
        entity_names: ["Auth", "DB"],
      },
    ]);

    const results = await searchKeyword(db, "credentials database");
    expect(results[0]!.entity_names).toContain("Auth");
    expect(results[0]!.entity_names).toContain("DB");
  });

  test("filters by metadata_filters", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Book", type: "document" }]);
    await addObservations(db, [
      {
        content: "Chapter 3 discusses advanced patterns",
        entity_names: ["Book"],
        metadata: { chapter: "3" },
      },
      {
        content: "Chapter 1 covers the basics of the system",
        entity_names: ["Book"],
        metadata: { chapter: "1" },
      },
    ]);

    const results = await searchKeyword(db, "chapter", {
      metadataFilters: { chapter: "3" },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("advanced patterns");
  });

  test("metadata_filters with no match returns empty", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Book", type: "document" }]);
    await addObservations(db, [
      {
        content: "Chapter 3 discusses advanced patterns",
        entity_names: ["Book"],
        metadata: { chapter: "3" },
      },
    ]);

    const results = await searchKeyword(db, "chapter", {
      metadataFilters: { chapter: "99" },
    });
    expect(results).toHaveLength(0);
  });

  test("filters by entity types", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "UseJWT", type: "decision" },
    ]);
    await addObservations(db, [
      {
        content: "Auth uses JWT tokens for validation",
        entity_names: ["Auth"],
      },
      {
        content: "Decided to use JWT for authentication",
        entity_names: ["UseJWT"],
      },
    ]);

    const results = await searchKeyword(db, "JWT", {
      entityTypes: ["decision"],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.entity_names).toContain("UseJWT");
  });
});

describe("searchHybrid", () => {
  let db: SqliteBackend;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("re-ranks by temporal score", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    await addObservations(db, [
      {
        content: "Authentication module handles JWT tokens",
        entity_names: ["Auth"],
      },
    ]);

    const results = await searchHybrid(db, "authentication JWT", config);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("overview-tier ranks higher than detail-tier", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Arch", type: "component" },
      { name: "Impl", type: "component" },
    ]);
    await updateEntities(db, [
      { name: "Arch", staleness_tier: "overview" },
      { name: "Impl", staleness_tier: "detail" },
    ]);
    await addObservations(db, [
      {
        content: "System uses microservices architecture pattern",
        entity_names: ["Arch"],
      },
      {
        content: "Implementation uses microservices framework setup",
        entity_names: ["Impl"],
      },
    ]);

    const results = await searchHybrid(db, "microservices", config);
    expect(results.length).toBe(2);
    // Overview-tier entity's observation should rank higher
    expect(results[0]!.entity_names).toContain("Arch");
  });

  test("bumps access_count on returned results", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "Auth", type: "component" }]);
    const [obs] = await addObservations(db, [
      {
        content: "Authentication module handles JWT tokens",
        entity_names: ["Auth"],
      },
    ]);

    await searchHybrid(db, "authentication", config);

    const row = await db.get<{ access_count: number }>(
      "SELECT access_count FROM observations WHERE id = ?",
      [obs!.id],
    );
    expect(row!.access_count).toBe(1);
  });
});
