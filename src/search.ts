import type { Backend } from "./backend";
import type { Config } from "./config";
import type { Embedder } from "./embeddings";
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

export async function searchSemantic(
  backend: Backend,
  query: string,
  embedder: Embedder,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 20;
  const [queryVector] = await embedder.embed([query]);
  if (!queryVector) return [];

  const vecResults = await backend.searchByVector(queryVector, limit * 3);
  if (vecResults.length === 0) return [];

  const ids = vecResults.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");

  // Batch-fetch entity names
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
  const namesByObs = new Map<string, string[]>();
  for (const link of entityLinks) {
    const names = namesByObs.get(link.observation_id) ?? [];
    names.push(link.name);
    namesByObs.set(link.observation_id, names);
  }

  // Fetch content
  const obsRows = await backend.all<{ id: string; content: string }>(
    `SELECT id, content FROM observations WHERE id IN (${placeholders})`,
    ids,
  );
  const contentById = new Map(obsRows.map((r) => [r.id, r.content]));

  // Convert distance to similarity score: 1 / (1 + distance)
  let results = vecResults.map((r) => ({
    id: r.id,
    content: contentById.get(r.id) ?? "",
    score: 1 / (1 + r.distance),
    entity_names: namesByObs.get(r.id) ?? [],
  }));

  // Entity type filter
  if (options?.entityTypes?.length) {
    const typeSet = new Set(options.entityTypes);
    const entityTypes = await backend.all<{
      observation_id: string;
      type: string;
    }>(
      `SELECT oe.observation_id, e.type
       FROM observation_entities oe
       JOIN entities e ON e.id = oe.entity_id
       WHERE oe.observation_id IN (${placeholders})`,
      ids,
    );
    const typesByObs = new Map<string, Set<string>>();
    for (const row of entityTypes) {
      const types = typesByObs.get(row.observation_id) ?? new Set();
      types.add(row.type);
      typesByObs.set(row.observation_id, types);
    }
    results = results.filter((r) => {
      const types = typesByObs.get(r.id);
      return types && [...types].some((t) => typeSet.has(t));
    });
  }

  return results.slice(0, limit);
}

export async function searchHybrid(
  backend: Backend,
  query: string,
  config: Config,
  options?: SearchOptions,
  embedder?: Embedder,
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 20;

  // BM25 results (always available)
  const ftsResults = await backend.searchObservations(query, {
    entityTypes: options?.entityTypes,
    metadataFilters: options?.metadataFilters,
    limit: limit * 3,
  });

  // Semantic scores (when embedder available)
  const semanticScores = new Map<string, number>();
  if (embedder) {
    try {
      const [queryVector] = await embedder.embed([query]);
      if (queryVector) {
        const vecResults = await backend.searchByVector(queryVector, limit * 3);
        for (const r of vecResults) {
          semanticScores.set(r.id, 1 / (1 + r.distance));
        }
      }
    } catch {
      // Fall back to BM25-only
    }
  }

  if (ftsResults.length === 0 && semanticScores.size === 0) return [];

  // Normalize BM25 scores to 0-1
  const maxBm25 = Math.max(...ftsResults.map((r) => r.score), 0.001);
  const bm25Scores = new Map<string, number>();
  for (const r of ftsResults) {
    bm25Scores.set(r.id, r.score / maxBm25);
  }

  // Collect all candidate IDs
  const allIds = [
    ...new Set([...ftsResults.map((r) => r.id), ...semanticScores.keys()]),
  ];
  const placeholders = allIds.map(() => "?").join(", ");

  // Batch-fetch temporal fields
  const temporalRows = await backend.all<{
    id: string;
    stability: number;
    access_count: number;
    last_accessed: string | null;
  }>(
    `SELECT id, stability, access_count, last_accessed
     FROM observations WHERE id IN (${placeholders})`,
    allIds,
  );
  const temporalById = new Map(temporalRows.map((r) => [r.id, r]));

  // Batch-fetch entity names + staleness tiers
  const entityLinks = await backend.all<{
    observation_id: string;
    name: string;
    staleness_tier: string;
  }>(
    `SELECT oe.observation_id, e.name, e.staleness_tier
     FROM observation_entities oe
     JOIN entities e ON e.id = oe.entity_id
     WHERE oe.observation_id IN (${placeholders})`,
    allIds,
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

  // Build content map from FTS results
  const contentById = new Map<string, string>();
  for (const r of ftsResults) {
    contentById.set(r.id, r.content);
  }

  // Fetch content for semantic-only results
  const missingContentIds = allIds.filter((id) => !contentById.has(id));
  if (missingContentIds.length > 0) {
    const missingPh = missingContentIds.map(() => "?").join(", ");
    const contentRows = await backend.all<{ id: string; content: string }>(
      `SELECT id, content FROM observations WHERE id IN (${missingPh})`,
      missingContentIds,
    );
    for (const row of contentRows) {
      contentById.set(row.id, row.content);
    }
  }

  // Score and rank
  const scored: Array<SearchResult & { finalScore: number }> = [];
  for (const id of allIds) {
    const temporal = temporalById.get(id);
    if (!temporal) continue;

    const entities = entitiesByObs.get(id) ?? [];
    const tier = bestTier(
      entities.map((e) => e.staleness_tier as StalenessTier),
    );

    const bm25Norm = bm25Scores.get(id) ?? 0;
    const semScore = semanticScores.get(id) ?? 0;

    // Weighted combination of text relevance signals
    const textScore =
      semanticScores.size > 0
        ? config.keyword_weight * bm25Norm + config.semantic_weight * semScore
        : bm25Norm;

    const finalScore = computeScore(
      {
        fts_score: textScore,
        stability: temporal.stability,
        last_accessed: temporal.last_accessed,
        access_count: temporal.access_count,
        staleness_tier: tier,
      },
      config,
    );

    scored.push({
      id,
      content: contentById.get(id) ?? "",
      score: finalScore,
      entity_names: entities.map((e) => e.name),
      finalScore,
    });
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);
  const topResults = scored.slice(0, limit);

  // Batch-bump access counts on returned observations
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
