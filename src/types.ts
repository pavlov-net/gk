import { z } from "zod";

// --- Staleness tiers (pyramid model) ---
export const StalenessTier = z.enum(["detail", "summary", "overview"]);
export type StalenessTier = z.infer<typeof StalenessTier>;

export const TIER_WEIGHTS: Record<StalenessTier, number> = {
  overview: 1.0,
  summary: 0.7,
  detail: 0.4,
};

// --- Entity ---
export const EntityRow = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  properties: z.string().default("{}"),
  confidence: z.number().default(0.8),
  staleness_tier: StalenessTier.default("detail"),
  stability: z.number().default(1.0),
  access_count: z.number().int().default(0),
  last_accessed: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type EntityRow = z.infer<typeof EntityRow>;

export const EntityInput = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  staleness_tier: StalenessTier.optional(),
});
export type EntityInput = z.infer<typeof EntityInput>;

// --- Observation ---
export const ObservationRow = z.object({
  id: z.string(),
  content: z.string(),
  metadata: z.string().default("{}"),
  confidence: z.number().default(0.8),
  source: z.string().nullable().default(null),
  stability: z.number().default(1.0),
  access_count: z.number().int().default(0),
  last_accessed: z.string().nullable().default(null),
  created_at: z.string(),
});
export type ObservationRow = z.infer<typeof ObservationRow>;

export const ObservationInput = z.object({
  content: z.string().min(1),
  entity_names: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().optional(),
});
export type ObservationInput = z.infer<typeof ObservationInput>;

// --- Relationship ---
export const RelationshipRow = z.object({
  id: z.string(),
  from_entity: z.string(),
  to_entity: z.string(),
  type: z.string(),
  properties: z.string().default("{}"),
  strength: z.number().default(1.0),
  confidence: z.number().default(0.8),
  stability: z.number().default(1.0),
  access_count: z.number().int().default(0),
  last_accessed: z.string().nullable().default(null),
  created_at: z.string(),
});
export type RelationshipRow = z.infer<typeof RelationshipRow>;

export const RelationshipInput = z.object({
  from_entity: z.string().min(1),
  to_entity: z.string().min(1),
  type: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type RelationshipInput = z.infer<typeof RelationshipInput>;

// --- Search results ---
export const SearchResult = z.object({
  id: z.string(),
  content: z.string(),
  score: z.number(),
  entity_names: z.array(z.string()),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const EntitySearchResult = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  score: z.number(),
});
export type EntitySearchResult = z.infer<typeof EntitySearchResult>;
