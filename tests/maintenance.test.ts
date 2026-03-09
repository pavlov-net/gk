import { afterEach, describe, expect, test } from "bun:test";
import type { GraphDB } from "../src/backend";
import { loadConfig } from "../src/config";
import { addEntities } from "../src/graph";
import {
  bulkUpdateConfidence,
  getHealthReport,
  pruneStale,
} from "../src/maintenance";
import { createTestDb } from "./helpers";

const config = loadConfig();

describe("pruneStale", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("identifies stale entities", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Fresh", type: "component" },
      { name: "Stale", type: "component" },
    ]);

    // Make "Stale" old by setting last_accessed to 100 days ago
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();
    await db.run(
      "UPDATE entities SET last_accessed = ?, access_count = 0, stability = 0.1 WHERE name = ?",
      [oldDate, "Stale"],
    );

    const candidates = await pruneStale(db, config);
    const names = candidates.map((c) => c.name);
    expect(names).toContain("Stale");
  });

  test("never auto-deletes — returns candidates only", async () => {
    db = await createTestDb();
    await addEntities(db, [{ name: "A", type: "component" }]);
    const oldDate = new Date(Date.now() - 100 * 86400000).toISOString();
    await db.run(
      "UPDATE entities SET last_accessed = ?, stability = 0.1 WHERE name = ?",
      [oldDate, "A"],
    );

    await pruneStale(db, config);

    // Entity should still exist
    const row = await db.get("SELECT * FROM entities WHERE name = ?", ["A"]);
    expect(row).toBeDefined();
  });
});

describe("getHealthReport", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("returns health report with all fields", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
      { name: "UseJWT", type: "decision" },
    ]);

    const report = await getHealthReport(db);
    expect(report.entity_count_by_type.component).toBe(2);
    expect(report.entity_count_by_type.decision).toBe(1);
    expect(report.most_accessed).toHaveLength(3);
    expect(report.temporal_health.fragile).toBe(3);
  });
});

describe("bulkUpdateConfidence", () => {
  let db: GraphDB;

  afterEach(async () => {
    if (db) await db.close();
  });

  test("updates confidence for multiple entities", async () => {
    db = await createTestDb();
    await addEntities(db, [
      { name: "Auth", type: "component" },
      { name: "DB", type: "component" },
      { name: "Cache", type: "component" },
    ]);

    const count = await bulkUpdateConfidence(db, ["Auth", "DB"], 0.95);
    expect(count).toBeGreaterThanOrEqual(2);

    const auth = await db.get<{ confidence: number }>(
      "SELECT confidence FROM entities WHERE name = ?",
      ["Auth"],
    );
    expect(auth!.confidence).toBe(0.95);

    // Cache should be unchanged
    const cache = await db.get<{ confidence: number }>(
      "SELECT confidence FROM entities WHERE name = ?",
      ["Cache"],
    );
    expect(cache!.confidence).toBe(0.8);
  });
});
