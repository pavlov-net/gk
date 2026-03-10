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

function distanceToSimilarity(distance: number): number {
  // Cosine distance ranges 0 (identical) to 2 (opposite)
  return 1 - distance / 2;
}

async function fetchEntityNames(
  backend: Backend,
  ids: string[],
): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const links = await backend.all<{ observation_id: string; name: string }>(
    `SELECT oe.observation_id, e.name
     FROM observation_entities oe
     JOIN entities e ON e.id = oe.entity_id
     WHERE oe.observation_id IN (${placeholders})`,
    ids,
  );
  const map = new Map<string, string[]>();
  for (const link of links) {
    const names = map.get(link.observation_id) ?? [];
    names.push(link.name);
    map.set(link.observation_id, names);
  }
  return map;
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

  const namesByObs = await fetchEntityNames(
    backend,
    ftsResults.map((r) => r.id),
  );

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

  const namesByObs = await fetchEntityNames(backend, ids);

  // Fetch content
  const obsRows = await backend.all<{ id: string; content: string }>(
    `SELECT id, content FROM observations WHERE id IN (${placeholders})`,
    ids,
  );
  const contentById = new Map(obsRows.map((r) => [r.id, r.content]));

  let results = vecResults.map((r) => ({
    id: r.id,
    content: contentById.get(r.id) ?? "",
    score: distanceToSimilarity(r.distance),
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
          semanticScores.set(r.id, distanceToSimilarity(r.distance));
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
    last_accessed: string | null;
  }>(
    `SELECT id, stability, last_accessed
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

  return topResults.map(({ finalScore: _, ...rest }) => rest);
}

function bestTier(tiers: StalenessTier[]): StalenessTier {
  if (tiers.includes("overview")) return "overview";
  if (tiers.includes("summary")) return "summary";
  return "detail";
}
