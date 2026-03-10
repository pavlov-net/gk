import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json";
import type { Backend } from "./backend";
import type { Config } from "./config";
import type { Embedder } from "./embeddings";
import {
  addEntities,
  addRelationships,
  deleteEntities,
  extractSubgraph,
  findPaths,
  getCentrality,
  getEntity,
  getEntityProfile,
  getNeighbors,
  getRelationships,
  getStats,
  getTimeline,
  listEntities,
  listEntityTypes,
  mergeEntities,
  updateEntities,
  updateRelationships,
  validateGraph,
} from "./graph";
import {
  bulkUpdateConfidence,
  getHealthReport,
  pruneStale,
} from "./maintenance";
import {
  addChunkedObservation,
  addObservations,
  backfillEmbeddings,
  readObservation,
} from "./observations";
import { searchHybrid, searchKeyword } from "./search";
import { EntityInput, ObservationInput, RelationshipInput } from "./types";

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function createServer(
  backend: Backend,
  config: Config,
  embedder?: Embedder,
): McpServer {
  const server = new McpServer(
    { name: "gk", version: pkg.version },
    {
      instructions: `gk is an agentic knowledge graph server. You have 28 tools in 4 tiers:

**Tier 1 -- Build the graph (8 tools):**
- add_entities, add_relationships, add_observations (batch creation)
- add_chunked_observation (auto-split long text into linked chunks)
- update_entities, update_relationships (modify existing)
- delete_entities (remove with cascade)
- merge_entities (combine duplicate entities into one)

**Tier 2 -- Search (5 tools):**
- search_keyword (exact terms, names -- BM25)
- search (combines keyword relevance with semantic similarity and temporal scoring -- use when unsure)
- search_entities (find entities by name)
- list_entities (query entities by type without FTS)
- read_observation (full text by ID after finding via search)

**Tier 3 -- Navigate & analyze the graph (10 tools):**
- get_entity (full profile with relationships and observation summaries)
- get_entity_profile (rich profile with truncated observations and relationship strength)
- get_relationships (query edges by entity/type)
- list_entity_types (see what's in the graph)
- find_paths (shortest paths between entities)
- get_neighbors (multi-hop exploration)
- extract_subgraph (pull out a connected neighborhood)
- get_centrality (degree or PageRank importance scores)
- get_timeline (chronological observation history)
- validate_graph (quality checks -- islands, orphans, duplicates)

**Tier 4 -- Maintenance (4 tools):**
- get_stats (aggregate graph statistics)
- prune_stale (find entities with decayed temporal scores)
- get_health_report (type/tier distribution, access patterns, temporal health)
- bulk_update_confidence (batch-set confidence for entities)

**Workflow:** Build entities first, then relationships, then observations.
Search to find relevant observations, read for full text, traverse for structure.
Use validate_graph periodically to check quality. Use merge_entities to consolidate duplicates.
All observations and entities support optional confidence (0-1) and source tracking.
Temporal dynamics: Hebbian strengthening on access, Ebbinghaus decay over time.

**Guides:** Read resources \`gk://guides/extraction\`, \`gk://guides/pyramid\`,
\`gk://guides/query\`, \`gk://guides/review\` for workflow guidance.`,
    },
  );

  // ── Tier 1: Foundation (CRUD) ──────────────────────────────────

  server.registerTool(
    "add_entities",
    {
      description:
        "Batch-add entities to the knowledge graph. Upserts on (name, type).",
      inputSchema: { entities: z.array(EntityInput) },
      annotations: { idempotentHint: true },
    },
    async ({ entities }) => {
      return text(await addEntities(backend, entities));
    },
  );

  server.registerTool(
    "add_relationships",
    {
      description: "Batch-add typed relationships between entities.",
      inputSchema: { relationships: z.array(RelationshipInput) },
      annotations: { idempotentHint: true },
    },
    async ({ relationships }) => {
      return text(await addRelationships(backend, relationships));
    },
  );

  server.registerTool(
    "add_observations",
    {
      description:
        "Batch-add observations linked to entities. Each observation must reference at least one existing entity by name.",
      inputSchema: { observations: z.array(ObservationInput) },
    },
    async ({ observations }) => {
      return text(await addObservations(backend, observations, embedder));
    },
  );

  server.registerTool(
    "add_chunked_observation",
    {
      description:
        "Add a long observation that gets automatically split at sentence boundaries. Chunks share a group ID in metadata.",
      inputSchema: {
        content: z.string().describe("The full text to chunk"),
        entity_names: z.array(z.string()).describe("Entities to link to"),
        metadata: z.record(z.string(), z.unknown()).optional(),
        confidence: z.coerce.number().min(0).max(1).optional(),
        source: z.string().optional(),
        max_chunk_size: z.coerce
          .number()
          .optional()
          .describe("Max chars per chunk (default 2000)"),
      },
    },
    async (args) => {
      return text(
        await addChunkedObservation(
          backend,
          args.content,
          args.entity_names,
          {
            metadata: args.metadata,
            confidence: args.confidence,
            source: args.source,
            maxChunkSize: args.max_chunk_size,
          },
          embedder,
        ),
      );
    },
  );

  server.registerTool(
    "update_entities",
    {
      description:
        "Batch-update entity properties, confidence, or staleness tier by name.",
      inputSchema: {
        updates: z.array(
          z.object({
            name: z.string(),
            type: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            confidence: z.coerce.number().min(0).max(1).optional(),
            staleness_tier: z
              .enum(["detail", "summary", "overview"])
              .optional(),
          }),
        ),
      },
    },
    async ({ updates }) => {
      return text({ updated: await updateEntities(backend, updates) });
    },
  );

  server.registerTool(
    "update_relationships",
    {
      description: "Batch-update relationship properties or type by ID.",
      inputSchema: {
        updates: z.array(
          z.object({
            id: z.string(),
            properties: z.record(z.string(), z.unknown()).optional(),
            type: z.string().optional(),
          }),
        ),
      },
    },
    async ({ updates }) => {
      return text({ updated: await updateRelationships(backend, updates) });
    },
  );

  server.registerTool(
    "delete_entities",
    {
      description:
        "Delete entities by name. Also removes their relationships and observation links. Optionally delete orphaned observations.",
      inputSchema: {
        names: z.array(z.string()),
        delete_orphan_observations: z
          .boolean()
          .optional()
          .describe(
            "Also delete observations no longer linked to any entity (default false)",
          ),
      },
      annotations: { destructiveHint: true },
    },
    async ({ names, delete_orphan_observations }) => {
      return text(
        await deleteEntities(backend, names, {
          deleteOrphanObservations: delete_orphan_observations,
        }),
      );
    },
  );

  server.registerTool(
    "merge_entities",
    {
      description:
        "Merge one or more source entities into target. Transfers observations and relationships, merges properties (target wins), then deletes sources.",
      inputSchema: {
        source_names: z
          .array(z.string())
          .describe("Entities to merge from (will be deleted)"),
        target_name: z.string().describe("Entity to merge into (will be kept)"),
        merge_properties: z
          .boolean()
          .optional()
          .describe(
            "Merge source properties into target, target wins on conflict (default true)",
          ),
      },
      annotations: { destructiveHint: true },
    },
    async ({ source_names, target_name, merge_properties }) => {
      return text(
        await mergeEntities(backend, source_names, target_name, {
          mergeProperties: merge_properties,
        }),
      );
    },
  );

  // ── Tier 2: Search ─────────────────────────────────────────────

  server.registerTool(
    "search_keyword",
    {
      description:
        "Full-text keyword search over observations. Returns raw BM25-ranked results without temporal adjustment.",
      inputSchema: {
        query: z.string().describe("Search query (FTS5 syntax supported)"),
        entity_types: z
          .array(z.string())
          .optional()
          .describe("Filter by entity types"),
        metadata_filters: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Filter by observation metadata key-value pairs (e.g. {chapter: '3'})",
          ),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default 20)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await searchKeyword(backend, args.query, {
          entityTypes: args.entity_types,
          metadataFilters: args.metadata_filters,
          limit: args.limit,
        }),
      );
    },
  );

  server.registerTool(
    "search",
    {
      description:
        "Search observations using keyword matching, semantic similarity (when Ollama is available), and temporal scoring. The default and recommended search tool.",
      inputSchema: {
        query: z.string().describe("Search query"),
        entity_types: z
          .array(z.string())
          .optional()
          .describe("Filter by entity types"),
        metadata_filters: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Filter by observation metadata key-value pairs (e.g. {chapter: '3'})",
          ),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default 20)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await searchHybrid(
          backend,
          args.query,
          config,
          {
            entityTypes: args.entity_types,
            metadataFilters: args.metadata_filters,
            limit: args.limit,
          },
          embedder,
        ),
      );
    },
  );

  server.registerTool(
    "read_observation",
    {
      description:
        "Read a single observation by ID. Returns full content, metadata, linked entities. Also strengthens the observation (Hebbian).",
      inputSchema: {
        id: z.string().describe("Observation ID"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const obs = await readObservation(backend, id, config);
      if (!obs) {
        return {
          content: [{ type: "text" as const, text: "Observation not found" }],
          isError: true,
        };
      }
      return text(obs);
    },
  );

  server.registerTool(
    "search_entities",
    {
      description: "Full-text search over entity names.",
      inputSchema: {
        query: z.string().describe("Search query for entity names"),
        types: z
          .array(z.string())
          .optional()
          .describe("Filter by entity types"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default 20)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await backend.searchEntities(args.query, {
          types: args.types,
          limit: args.limit,
        }),
      );
    },
  );

  server.registerTool(
    "list_entities",
    {
      description:
        "List entities, optionally filtered by type. Use this instead of search_entities when you want all entities of a type rather than searching by name.",
      inputSchema: {
        types: z
          .array(z.string())
          .optional()
          .describe("Filter by entity types"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default 100)"),
        offset: z.coerce
          .number()
          .optional()
          .describe("Pagination offset (default 0)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await listEntities(backend, {
          types: args.types,
          limit: args.limit,
          offset: args.offset,
        }),
      );
    },
  );

  // ── Tier 3: Graph Query ────────────────────────────────────────

  server.registerTool(
    "get_entity",
    {
      description:
        "Get a full entity profile by name. Includes relationships, observations, and temporal fields. Strengthens the entity on access.",
      inputSchema: {
        name: z.string().describe("Entity name"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ name }) => {
      const entity = await getEntity(backend, name, config);
      if (!entity) {
        return {
          content: [{ type: "text" as const, text: "Entity not found" }],
          isError: true,
        };
      }
      return text(entity);
    },
  );

  server.registerTool(
    "get_entity_profile",
    {
      description:
        "Get a rich entity profile with truncated observations and relationship strength. For detailed view use get_entity.",
      inputSchema: {
        name: z.string().describe("Entity name"),
        max_observation_length: z
          .number()
          .optional()
          .describe("Truncate observations to this length (default 200)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      const profile = await getEntityProfile(backend, args.name, config, {
        maxObservationLength: args.max_observation_length,
      });
      if (!profile) {
        return {
          content: [{ type: "text" as const, text: "Entity not found" }],
          isError: true,
        };
      }
      return text(profile);
    },
  );

  server.registerTool(
    "get_relationships",
    {
      description:
        "Query relationships, optionally filtered by entity name and/or type. Strengthens returned relationships on access.",
      inputSchema: {
        entity_name: z
          .string()
          .optional()
          .describe("Filter by entity name (source or target)"),
        type: z.string().optional().describe("Filter by relationship type"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await getRelationships(backend, config, {
          entity_name: args.entity_name,
          type: args.type,
        }),
      );
    },
  );

  server.registerTool(
    "list_entity_types",
    {
      description: "List all entity types with their counts.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      return text(await listEntityTypes(backend));
    },
  );

  server.registerTool(
    "find_paths",
    {
      description:
        "Find shortest path(s) between two entities using bidirectional BFS.",
      inputSchema: {
        from: z.string().describe("Source entity name"),
        to: z.string().describe("Target entity name"),
        max_depth: z
          .number()
          .optional()
          .describe("Max path length (default 5)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await findPaths(backend, args.from, args.to, {
          maxDepth: args.max_depth,
        }),
      );
    },
  );

  server.registerTool(
    "get_neighbors",
    {
      description:
        "Multi-hop neighborhood exploration from an entity. Returns neighbors grouped by depth.",
      inputSchema: {
        name: z.string().describe("Starting entity name"),
        max_depth: z
          .number()
          .optional()
          .describe("How many hops to traverse (default 2)"),
        max_results: z
          .number()
          .optional()
          .describe("Max total neighbors (default 50)"),
        relationship_types: z
          .array(z.string())
          .optional()
          .describe("Only traverse these relationship types"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      const neighbors = await getNeighbors(backend, args.name, config, {
        maxDepth: args.max_depth,
        maxResults: args.max_results,
        relationshipTypes: args.relationship_types,
      });
      // Convert Map to serializable object
      const result: Record<string, Array<{ name: string; type: string }>> = {};
      for (const [depth, entities] of neighbors) {
        result[String(depth)] = entities;
      }
      return text(result);
    },
  );

  server.registerTool(
    "extract_subgraph",
    {
      description:
        "Extract a connected subgraph around seed entities. Returns entities and relationships within the neighborhood.",
      inputSchema: {
        seed_names: z
          .array(z.string())
          .describe("Starting entity names to expand from"),
        max_depth: z
          .number()
          .optional()
          .describe("BFS depth from seeds (default 2)"),
        max_entities: z
          .number()
          .optional()
          .describe("Max entities to collect (default 100)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await extractSubgraph(backend, args.seed_names, {
          maxDepth: args.max_depth,
          maxEntities: args.max_entities,
        }),
      );
    },
  );

  server.registerTool(
    "get_centrality",
    {
      description:
        "Rank entities by importance. Degree mode counts connections; PageRank mode uses iterative link analysis.",
      inputSchema: {
        mode: z
          .enum(["degree", "pagerank"])
          .optional()
          .describe("Centrality metric (default degree)"),
        entity_names: z
          .array(z.string())
          .optional()
          .describe("Only compute centrality for these entities"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Top N results (default 20)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await getCentrality(backend, {
          mode: args.mode,
          entityNames: args.entity_names,
          limit: args.limit,
        }),
      );
    },
  );

  server.registerTool(
    "get_timeline",
    {
      description:
        "Chronological observation history with entity names. Filterable by entity names and/or types.",
      inputSchema: {
        entity_names: z
          .array(z.string())
          .optional()
          .describe("Filter by entity names"),
        entity_types: z
          .array(z.string())
          .optional()
          .describe("Filter by entity types"),
        limit: z.coerce
          .number()
          .optional()
          .describe("Max results (default 50)"),
        offset: z.coerce
          .number()
          .optional()
          .describe("Pagination offset (default 0)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await getTimeline(backend, {
          entityNames: args.entity_names,
          entityTypes: args.entity_types,
          limit: args.limit,
          offset: args.offset,
        }),
      );
    },
  );

  // ── Tier 4: Maintenance ────────────────────────────────────────

  server.registerTool(
    "get_stats",
    {
      description:
        "Graph statistics: entity/relationship/observation counts, type distribution, tier distribution, temporal health.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      return text(await getStats(backend));
    },
  );

  server.registerTool(
    "validate_graph",
    {
      description:
        "Check graph health: island entities (no relationships), orphan observations (no entity links), entities missing observations, duplicate candidates (same name, different types). Returns structured issues with severity/category.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      return text(await validateGraph(backend));
    },
  );

  server.registerTool(
    "prune_stale",
    {
      description:
        "Identify stale entities with temporal scores below threshold. Returns candidates only — never auto-deletes.",
      inputSchema: {
        threshold: z
          .number()
          .optional()
          .describe(
            "Score threshold (default 0.1). Entities below this are stale.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await pruneStale(backend, config, { threshold: args.threshold }),
      );
    },
  );

  server.registerTool(
    "get_health_report",
    {
      description:
        "Detailed health report: type/tier distribution, most/least accessed, temporal health breakdown.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      return text(await getHealthReport(backend));
    },
  );

  server.registerTool(
    "bulk_update_confidence",
    {
      description: "Set confidence score for multiple entities at once.",
      inputSchema: {
        names: z.array(z.string()).describe("Entity names to update"),
        confidence: z.coerce
          .number()
          .min(0)
          .max(1)
          .describe("New confidence value"),
      },
    },
    async ({ names, confidence }) => {
      return text({
        updated: await bulkUpdateConfidence(backend, names, confidence),
      });
    },
  );

  if (process.env.GK_ENABLE_BACKFILL) {
    server.registerTool(
      "backfill_embeddings",
      {
        description:
          "Temporary migration tool -- embeds observations that don't have vectors yet. Run after upgrading to semantic search or changing embedding models.",
        inputSchema: {
          batch_size: z.coerce
            .number()
            .optional()
            .describe("Observations per batch (default 100)"),
          force: z
            .boolean()
            .optional()
            .describe(
              "Re-embed all observations, even those with existing vectors (default false)",
            ),
        },
        annotations: { idempotentHint: true },
      },
      async (args) => {
        if (!embedder) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Backfill unavailable: no embedding provider configured",
              },
            ],
            isError: true,
          };
        }
        return text(
          await backfillEmbeddings(backend, embedder, {
            batchSize: args.batch_size,
            force: args.force,
          }),
        );
      },
    );
  }

  // ── Resources (guides) ─────────────────────────────────────────

  const guideNames = ["extraction", "pyramid", "query", "review"] as const;
  for (const name of guideNames) {
    server.registerResource(
      `guide_${name}`,
      `gk://guides/${name}`,
      {
        description: `${name.charAt(0).toUpperCase() + name.slice(1)} guide for working with the knowledge graph`,
        mimeType: "text/markdown",
      },
      async (uri) => {
        const filePath = `${import.meta.dir}/prompts/${name}.md`;
        const content = await Bun.file(filePath).text();
        return { contents: [{ uri: uri.href, text: content }] };
      },
    );
  }

  // ── Prompts (guides as interactive prompts) ────────────────────

  for (const name of guideNames) {
    server.registerPrompt(
      `${name}_guide`,
      {
        description: `Interactive ${name} guide for the knowledge graph`,
      },
      async () => {
        const filePath = `${import.meta.dir}/prompts/${name}.md`;
        const content = await Bun.file(filePath).text();
        return {
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text: content },
            },
          ],
        };
      },
    );
  }

  return server;
}
