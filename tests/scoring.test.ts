import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { computeRetention, computeScore } from "../src/scoring";

const config = loadConfig();

describe("computeRetention", () => {
  test("returns ~1.0 for just-accessed item", () => {
    const retention = computeRetention(1.0, new Date().toISOString(), config);
    expect(retention).toBeCloseTo(1.0, 1);
  });

  test("returns ~0.5 at one half-life", () => {
    const halfLifeDays = 1.0 * config.decay_base_days; // 7 days
    const accessed = new Date(
      Date.now() - halfLifeDays * 86400000,
    ).toISOString();
    const retention = computeRetention(1.0, accessed, config);
    expect(retention).toBeCloseTo(0.5, 1);
  });

  test("higher stability = slower decay", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const lowStability = computeRetention(1.0, thirtyDaysAgo, config);
    const highStability = computeRetention(5.0, thirtyDaysAgo, config);
    expect(highStability).toBeGreaterThan(lowStability);
  });

  test("returns 1.0 for null last_accessed (new knowledge)", () => {
    expect(computeRetention(1.0, null, config)).toBe(1.0);
  });
});

describe("computeScore", () => {
  test("combines fts * retention * hebbian * tier", () => {
    const score = computeScore(
      {
        fts_score: 2.0,
        stability: 1.0,
        last_accessed: new Date().toISOString(),
        access_count: 10,
        staleness_tier: "overview",
      },
      config,
    );
    // 2.0 * ~1.0 * (1 + ln(11)) * 1.0 ≈ 2.0 * 3.4 ≈ 6.8
    expect(score).toBeGreaterThan(5);
  });

  test("overview > detail at equal access", () => {
    const base = {
      fts_score: 1.0,
      stability: 1.0,
      last_accessed: new Date().toISOString(),
      access_count: 5,
    };
    const overview = computeScore(
      { ...base, staleness_tier: "overview" as const },
      config,
    );
    const detail = computeScore(
      { ...base, staleness_tier: "detail" as const },
      config,
    );
    expect(overview).toBeGreaterThan(detail);
  });

  test("recently accessed > stale at equal FTS score", () => {
    const base = {
      fts_score: 1.0,
      stability: 1.0,
      access_count: 5,
      staleness_tier: "summary" as const,
    };
    const fresh = computeScore(
      { ...base, last_accessed: new Date().toISOString() },
      config,
    );
    const stale = computeScore(
      {
        ...base,
        last_accessed: new Date(Date.now() - 60 * 86400000).toISOString(),
      },
      config,
    );
    expect(fresh).toBeGreaterThan(stale);
  });
});
