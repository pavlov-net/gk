import type { Config } from "./config";
import type { StalenessTier } from "./types";
import { TIER_WEIGHTS } from "./types";

export interface ScorableItem {
  fts_score: number;
  stability: number;
  last_accessed: string | null;
  staleness_tier: StalenessTier;
}

/**
 * Power-law forgetting curve (FSRS-style).
 * R(t, S) = (1 + t / (S * decay_base_days))^(-0.5)
 *
 * More accurate than exponential for modeling memory decay.
 * Returns 1.0 for null last_accessed (new knowledge).
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
  return (1 + daysSince / (stability * config.decay_base_days)) ** -0.5;
}

/**
 * Multiplicative scoring with temporal floor.
 *
 * final = content_score * (floor + (1 - floor) * retention * tier_weight)
 *
 * - Zero content match always scores zero (no irrelevant results)
 * - Fully decayed knowledge keeps `floor` fraction of content score (still findable)
 * - Fresh, well-maintained knowledge keeps full content score
 */
export function computeScore(item: ScorableItem, config: Config): number {
  const retention = computeRetention(
    item.stability,
    item.last_accessed,
    config,
  );
  const tierWeight =
    config.tier_weights[item.staleness_tier] ??
    TIER_WEIGHTS[item.staleness_tier];

  const temporal = retention * tierWeight;
  const floor = config.temporal_floor;
  return item.fts_score * (floor + (1 - floor) * temporal);
}

/**
 * Compute stability growth with spacing effect (FSRS-inspired).
 *
 * Stability grows MORE when the entity has decayed (low retention).
 * Writing to a neglected entity strengthens it more than writing to a fresh one.
 *
 * growth = base_growth * (1 + spacing_factor * (1 - retention))
 */
export function computeStabilityGrowth(
  stability: number,
  lastAccessed: string | null,
  config: Config,
): number {
  const retention = computeRetention(stability, lastAccessed, config);
  const growth =
    config.stability_growth * (1 + config.spacing_factor * (1 - retention));
  return Math.min(stability * growth, config.max_stability);
}
