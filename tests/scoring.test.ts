import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import {
  computeRetention,
  computeScore,
  computeStabilityGrowth,
} from "../src/scoring";

const config = loadConfig();

describe("computeRetention", () => {
  test("returns ~1.0 for just-accessed item", () => {
    const retention = computeRetention(1.0, new Date().toISOString(), config);
    expect(retention).toBeCloseTo(1.0, 1);
  });

  test("returns ~0.5 at one half-life (power-law)", () => {
    // Power-law: R = (1 + t/(S*d))^(-0.5)
    // At t = S*d: R = (1+1)^(-0.5) = 1/sqrt(2) ≈ 0.707
    const halfLifeDays = 1.0 * config.decay_base_days;
    const accessed = new Date(
      Date.now() - halfLifeDays * 86400000,
    ).toISOString();
    const retention = computeRetention(1.0, accessed, config);
    expect(retention).toBeCloseTo(Math.SQRT1_2, 1);
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
  test("multiplicative scoring with temporal floor", () => {
    const score = computeScore(
      {
        fts_score: 1.0,
        stability: 1.0,
        last_accessed: new Date().toISOString(),
        staleness_tier: "overview",
      },
      config,
    );
    // fresh overview: retention ≈ 1.0, tierWeight = 1.0
    // score = 1.0 * (0.1 + 0.9 * 1.0 * 1.0) = 1.0
    expect(score).toBeCloseTo(1.0, 1);
  });

  test("zero content match always scores zero", () => {
    const score = computeScore(
      {
        fts_score: 0.0,
        stability: 5.0,
        last_accessed: new Date().toISOString(),
        staleness_tier: "overview",
      },
      config,
    );
    expect(score).toBe(0);
  });

  test("overview > detail at equal stability", () => {
    const base = {
      fts_score: 1.0,
      stability: 1.0,
      last_accessed: new Date().toISOString(),
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

  test("fully decayed keeps temporal floor fraction", () => {
    const score = computeScore(
      {
        fts_score: 1.0,
        stability: 0.1,
        last_accessed: new Date(Date.now() - 365 * 86400000).toISOString(),
        staleness_tier: "detail",
      },
      config,
    );
    // Even fully decayed, score >= fts_score * temporal_floor
    expect(score).toBeGreaterThanOrEqual(config.temporal_floor * 0.99);
  });
});

describe("computeStabilityGrowth", () => {
  test("grows more when retention is low (spacing effect)", () => {
    const freshGrowth = computeStabilityGrowth(
      1.0,
      new Date().toISOString(),
      config,
    );
    const staleGrowth = computeStabilityGrowth(
      1.0,
      new Date(Date.now() - 60 * 86400000).toISOString(),
      config,
    );
    expect(staleGrowth).toBeGreaterThan(freshGrowth);
  });

  test("capped at max_stability", () => {
    const result = computeStabilityGrowth(config.max_stability, null, config);
    expect(result).toBeLessThanOrEqual(config.max_stability);
  });
});
