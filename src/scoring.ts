import type { Config } from "./config";
import type { StalenessTier } from "./types";
import { TIER_WEIGHTS } from "./types";

export interface ScorableItem {
  fts_score: number;
  stability: number;
  last_accessed: string | null;
  access_count: number;
  staleness_tier: StalenessTier;
}

/**
 * Ebbinghaus retention with adaptive stability (Engram model).
 * retention = exp(-0.693 * days_since_access / half_life)
 * half_life = stability * decay_base_days
 */
export function computeRetention(
  stability: number,
  lastAccessed: string | null,
  config: Config,
): number {
  if (!lastAccessed) return 1.0;
  const daysSince =
    (Date.now() - new Date(lastAccessed).getTime()) / 86_400_000;
  if (daysSince <= 0) return 1.0;
  const halfLife = stability * config.decay_base_days;
  return Math.exp((-Math.LN2 * daysSince) / halfLife);
}

/**
 * Combined score: fts * retention * hebbian * tier_weight
 */
export function computeScore(item: ScorableItem, config: Config): number {
  const retention = computeRetention(
    item.stability,
    item.last_accessed,
    config,
  );
  const hebbian = 1 + Math.log(item.access_count + 1);
  const tierWeight =
    config.tier_weights[item.staleness_tier] ??
    TIER_WEIGHTS[item.staleness_tier];
  return item.fts_score * retention * hebbian * tierWeight;
}
