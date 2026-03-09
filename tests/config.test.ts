import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("returns defaults when no file or env", () => {
    const config = loadConfig();
    expect(config.backend).toBe("sqlite");
    expect(config.db_path).toBe(".gk/knowledge.db");
    expect(config.decay_base_days).toBe(7);
    expect(config.max_stability).toBe(10.0);
    expect(config.stability_growth).toBe(1.2);
  });

  test("accepts overrides", () => {
    const config = loadConfig({ backend: "dolt", db_path: "/tmp/test.db" });
    expect(config.backend).toBe("dolt");
    expect(config.db_path).toBe("/tmp/test.db");
  });

  test("tier_weights have correct defaults", () => {
    const config = loadConfig();
    expect(config.tier_weights.overview).toBe(1.0);
    expect(config.tier_weights.summary).toBe(0.7);
    expect(config.tier_weights.detail).toBe(0.4);
  });
});
