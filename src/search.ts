import type { Backend } from "./backend";
import type { Config } from "./config";
import { computeScore } from "./scoring";
import type { SearchResult, StalenessTier } from "./types";

export interface SearchOptions {
  entityTypes?: string[];
  metadataFilters?: Record<string, string>;
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
    metadataFilters: options?.metadataFilters,
    limit,
  });

  if (ftsResults.length === 0) return [];

  // Batch-fetch entity names for all results in one query
  const ids = ftsResults.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");
  const entityLinks = await backend.all<{
    observation_id: string;
    name: string;
  }>(
    `SELECT oe.observation_id, e.name
     FROM observation_entities oe
     JOIN entities e ON e.id = oe.entity_id
     WHERE oe.observation_id IN (${placeholders})`,
    ids,
  );

  // Group entity names by observation
  const namesByObs = new Map<string, string[]>();
  for (const link of entityLinks) {
    const names = namesByObs.get(link.observation_id) ?? [];
    names.push(link.name);
    namesByObs.set(link.observation_id, names);
  }

  return ftsResults.map((r) => ({
    id: r.id,
    content: r.content,
    score: r.score,
    entity_names: namesByObs.get(r.id) ?? [],
  }));
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
    metadataFilters: options?.metadataFilters,
    limit: limit * 3,
  });

  if (ftsResults.length === 0) return [];

  // Batch-fetch temporal fields + entity names in two queries (not N+1)
  const ids = ftsResults.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");

  // 1) Temporal fields for all matched observations
  const temporalRows = await backend.all<{
    id: string;
    stability: number;
    access_count: number;
    last_accessed: string | null;
  }>(
    `SELECT id, stability, access_count, last_accessed
     FROM observations WHERE id IN (${placeholders})`,
    ids,
  );
  const temporalById = new Map(temporalRows.map((r) => [r.id, r]));

  // 2) Entity names + staleness tiers for all matched observations
  const entityLinks = await backend.all<{
    observation_id: string;
    name: string;
    staleness_tier: string;
  }>(
    `SELECT oe.observation_id, e.name, e.staleness_tier
     FROM observation_entities oe
     JOIN entities e ON e.id = oe.entity_id
     WHERE oe.observation_id IN (${placeholders})`,
    ids,
  );
  const entitiesByObs = new Map<
    string,
    Array<{ name: string; staleness_tier: string }>
  >();
  for (const link of entityLinks) {
    const entries = entitiesByObs.get(link.observation_id) ?? [];
    entries.push({ name: link.name, staleness_tier: link.staleness_tier });
    entitiesByObs.set(link.observation_id, entries);
  }

  // Score and rank
  const scored: Array<SearchResult & { finalScore: number }> = [];
  for (const r of ftsResults) {
    const temporal = temporalById.get(r.id);
    if (!temporal) continue;

    const entities = entitiesByObs.get(r.id) ?? [];
    const tier = bestTier(
      entities.map((e) => e.staleness_tier as StalenessTier),
    );

    const finalScore = computeScore(
      {
        fts_score: r.score,
        stability: temporal.stability,
        last_accessed: temporal.last_accessed,
        access_count: temporal.access_count,
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

  scored.sort((a, b) => b.finalScore - a.finalScore);
  const topResults = scored.slice(0, limit);

  // Batch-bump access_count/stability on returned observations
  if (topResults.length > 0) {
    const ts = new Date().toISOString();
    const topIds = topResults.map((r) => r.id);
    const topPlaceholders = topIds.map(() => "?").join(", ");

    await backend.run(
      `UPDATE observations SET
        access_count = access_count + 1,
        stability = MIN(stability * ?, ?),
        last_accessed = ?
      WHERE id IN (${topPlaceholders})`,
      [config.stability_growth, config.max_stability, ts, ...topIds],
    );
  }

  return topResults.map(({ finalScore: _, ...rest }) => rest);
}

function bestTier(tiers: StalenessTier[]): StalenessTier {
  if (tiers.includes("overview")) return "overview";
  if (tiers.includes("summary")) return "summary";
  return "detail";
}
