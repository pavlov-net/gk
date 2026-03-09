import type { Backend } from "./backend";
import type { Config } from "./config";
import { computeScore } from "./scoring";
import type { SearchResult, StalenessTier } from "./types";

export interface SearchOptions {
  entityTypes?: string[];
  limit?: number;
}

export async function searchKeyword(
  backend: Backend,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 20;
  const ftsResults = await backend.searchObservations(query, {
    entityTypes: options?.entityTypes,
    limit,
  });

  // Enrich with entity names
  const results: SearchResult[] = [];
  for (const r of ftsResults) {
    const entities = await backend.all<{ name: string }>(
      `SELECT e.name FROM entities e
       JOIN observation_entities oe ON oe.entity_id = e.id
       WHERE oe.observation_id = ?`,
      [r.id],
    );
    results.push({
      id: r.id,
      content: r.content,
      score: r.score,
      entity_names: entities.map((e) => e.name),
    });
  }

  return results;
}

export async function searchHybrid(
  backend: Backend,
  query: string,
  config: Config,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 20;

  // Overfetch for re-ranking headroom
  const ftsResults = await backend.searchObservations(query, {
    entityTypes: options?.entityTypes,
    limit: limit * 3,
  });

  // Enrich with temporal fields + entity names, compute final score
  const scored: Array<SearchResult & { finalScore: number }> = [];

  for (const r of ftsResults) {
    // Get temporal fields from observation
    const obs = await backend.get<{
      stability: number;
      access_count: number;
      last_accessed: string | null;
    }>(
      "SELECT stability, access_count, last_accessed FROM observations WHERE id = ?",
      [r.id],
    );
    if (!obs) continue;

    // Get linked entities and their staleness tiers
    const entities = await backend.all<{
      name: string;
      staleness_tier: string;
    }>(
      `SELECT e.name, e.staleness_tier FROM entities e
       JOIN observation_entities oe ON oe.entity_id = e.id
       WHERE oe.observation_id = ?`,
      [r.id],
    );

    // Use the highest tier among linked entities
    const tier = bestTier(
      entities.map((e) => e.staleness_tier as StalenessTier),
    );

    const finalScore = computeScore(
      {
        fts_score: r.score,
        stability: obs.stability,
        last_accessed: obs.last_accessed,
        access_count: obs.access_count,
        staleness_tier: tier,
      },
      config,
    );

    scored.push({
      id: r.id,
      content: r.content,
      score: finalScore,
      entity_names: entities.map((e) => e.name),
      finalScore,
    });
  }

  // Sort by final score, take top N
  scored.sort((a, b) => b.finalScore - a.finalScore);
  const topResults = scored.slice(0, limit);

  // Bump access_count/stability on returned observations
  const ts = new Date().toISOString();
  for (const r of topResults) {
    const obs = await backend.get<{ stability: number }>(
      "SELECT stability FROM observations WHERE id = ?",
      [r.id],
    );
    if (obs) {
      const newStability = Math.min(
        obs.stability * config.stability_growth,
        config.max_stability,
      );
      await backend.run(
        `UPDATE observations SET
          access_count = access_count + 1,
          stability = ?,
          last_accessed = ?
        WHERE id = ?`,
        [newStability, ts, r.id],
      );
    }
  }

  return topResults.map(({ finalScore: _, ...rest }) => rest);
}

function bestTier(tiers: StalenessTier[]): StalenessTier {
  if (tiers.includes("overview")) return "overview";
  if (tiers.includes("summary")) return "summary";
  return "detail";
}
