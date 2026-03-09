import type { Backend } from "./backend";
import type { Config } from "./config";
import { computeScore } from "./scoring";
import type { StalenessTier } from "./types";

export interface StaleCandidate {
  id: string;
  name: string;
  type: string;
  score: number;
  stability: number;
  last_accessed: string | null;
}

export async function pruneStale(
  backend: Backend,
  config: Config,
  options?: { threshold?: number },
): Promise<StaleCandidate[]> {
  const threshold = options?.threshold ?? 0.1;

  // Fetch all entities with their temporal fields in one query
  const entities = await backend.all<{
    id: string;
    name: string;
    type: string;
    stability: number;
    access_count: number;
    last_accessed: string | null;
    staleness_tier: string;
  }>(
    `SELECT id, name, type, stability, access_count, last_accessed, staleness_tier
     FROM entities`,
  );

  const candidates: StaleCandidate[] = [];
  for (const e of entities) {
    const score = computeScore(
      {
        fts_score: 1.0, // Neutral FTS score for pruning evaluation
        stability: e.stability,
        last_accessed: e.last_accessed,
        access_count: e.access_count,
        staleness_tier: e.staleness_tier as StalenessTier,
      },
      config,
    );

    if (score < threshold) {
      candidates.push({
        id: e.id,
        name: e.name,
        type: e.type,
        score,
        stability: e.stability,
        last_accessed: e.last_accessed,
      });
    }
  }

  return candidates.sort((a, b) => a.score - b.score);
}

export async function getHealthReport(backend: Backend): Promise<{
  entity_count_by_type: Record<string, number>;
  tier_distribution: Record<string, number>;
  most_accessed: Array<{ name: string; access_count: number }>;
  least_accessed: Array<{ name: string; access_count: number }>;
  avg_confidence: number;
  temporal_health: { durable: number; stable: number; fragile: number };
}> {
  // Type counts + tier distribution in grouped queries
  const types = await backend.all<{ type: string; count: number }>(
    "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC",
  );
  const typeMap: Record<string, number> = {};
  for (const t of types) typeMap[t.type] = t.count;

  const tiers = await backend.all<{ tier: string; count: number }>(
    "SELECT staleness_tier as tier, COUNT(*) as count FROM entities GROUP BY staleness_tier",
  );
  const tierMap: Record<string, number> = {};
  for (const t of tiers) tierMap[t.tier] = t.count;

  // Most/least accessed + aggregates in single queries
  const mostAccessed = await backend.all<{
    name: string;
    access_count: number;
  }>(
    "SELECT name, access_count FROM entities ORDER BY access_count DESC LIMIT 10",
  );

  const leastAccessed = await backend.all<{
    name: string;
    access_count: number;
  }>(
    "SELECT name, access_count FROM entities ORDER BY access_count ASC LIMIT 10",
  );

  const [agg] = await backend.all<{
    avg_confidence: number;
    durable: number;
    stable: number;
    fragile: number;
  }>(
    `SELECT
      AVG(confidence) as avg_confidence,
      SUM(CASE WHEN stability > 5 THEN 1 ELSE 0 END) as durable,
      SUM(CASE WHEN stability > 1 AND stability <= 5 THEN 1 ELSE 0 END) as stable,
      SUM(CASE WHEN stability <= 1 THEN 1 ELSE 0 END) as fragile
    FROM entities`,
  );

  return {
    entity_count_by_type: typeMap,
    tier_distribution: tierMap,
    most_accessed: mostAccessed,
    least_accessed: leastAccessed,
    avg_confidence: agg?.avg_confidence ?? 0,
    temporal_health: {
      durable: agg?.durable ?? 0,
      stable: agg?.stable ?? 0,
      fragile: agg?.fragile ?? 0,
    },
  };
}

export async function bulkUpdateConfidence(
  backend: Backend,
  names: string[],
  confidence: number,
): Promise<number> {
  if (names.length === 0) return 0;
  const placeholders = names.map(() => "?").join(", ");
  const result = await backend.run(
    `UPDATE entities SET confidence = ?, updated_at = ?
     WHERE name IN (${placeholders})`,
    [confidence, new Date().toISOString(), ...names],
  );
  return result.changes;
}
