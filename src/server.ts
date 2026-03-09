import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Backend } from "./backend";
import type { Config } from "./config";
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
  readObservation,
} from "./observations";
import { searchHybrid, searchKeyword } from "./search";
import { EntityInput, ObservationInput, RelationshipInput } from "./types";

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function createServer(backend: Backend, config: Config): McpServer {
  const server = new McpServer(
    { name: "gk", version: "0.2.0" },
    {
      instructions: `gk is an agentic knowledge graph server. You have 26 tools in 4 tiers:

**Tier 1 -- Build the graph (8 tools):**
- add_entities, add_relationships, add_observations (batch creation)
- add_chunked_observation (auto-split long text into linked chunks)
- update_entities, update_relationships (modify existing)
- delete_entities (remove with cascade)
- merge_entities (combine duplicate entities into one)

**Tier 2 -- Search (4 tools):**
- search_keyword (exact terms, names -- BM25)
- search_hybrid (combines keyword relevance with temporal scoring -- use when unsure)
- search_entities (find entities by name)
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
      return text(await addObservations(backend, observations));
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
        confidence: z.number().min(0).max(1).optional(),
        source: z.string().optional(),
        max_chunk_size: z
          .number()
          .optional()
          .describe("Max chars per chunk (default 2000)"),
      },
    },
    async (args) => {
      return text(
        await addChunkedObservation(backend, args.content, args.entity_names, {
          metadata: args.metadata,
          confidence: args.confidence,
          source: args.source,
          maxChunkSize: args.max_chunk_size,
        }),
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
            confidence: z.number().min(0).max(1).optional(),
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
        "Delete entities by name. Also removes their relationships and observation links.",
      inputSchema: { names: z.array(z.string()) },
      annotations: { destructiveHint: true },
    },
    async ({ names }) => {
      return text({ deleted: await deleteEntities(backend, names) });
    },
  );

  server.registerTool(
    "merge_entities",
    {
      description:
        "Merge source entity into target. Transfers observations and relationships, then deletes source.",
      inputSchema: {
        source_name: z
          .string()
          .describe("Entity to merge from (will be deleted)"),
        target_name: z.string().describe("Entity to merge into (will be kept)"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ source_name, target_name }) => {
      return text(await mergeEntities(backend, source_name, target_name));
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
        limit: z.number().optional().describe("Max results (default 20)"),
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
    "search_hybrid",
    {
      description:
        "Hybrid search combining FTS relevance with temporal scoring (retention, Hebbian strengthening, staleness tier). Default search tool.",
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
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await searchHybrid(backend, args.query, config, {
          entityTypes: args.entity_types,
          metadataFilters: args.metadata_filters,
          limit: args.limit,
        }),
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
        limit: z.number().optional().describe("Max results (default 20)"),
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
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      const neighbors = await getNeighbors(backend, args.name, config, {
        maxDepth: args.max_depth,
        maxResults: args.max_results,
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
        limit: z.number().optional().describe("Top N results (default 20)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await getCentrality(backend, {
          mode: args.mode,
          limit: args.limit,
        }),
      );
    },
  );

  server.registerTool(
    "get_timeline",
    {
      description:
        "Chronological observation history with entity names. Filterable by entity name or type.",
      inputSchema: {
        entity_name: z.string().optional().describe("Filter by entity name"),
        entity_type: z.string().optional().describe("Filter by entity type"),
        limit: z.number().optional().describe("Max results (default 50)"),
        offset: z.number().optional().describe("Pagination offset (default 0)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => {
      return text(
        await getTimeline(backend, {
          entityName: args.entity_name,
          entityType: args.entity_type,
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
        "Check graph health: island entities (no relationships), orphan observations (no entity links), entities missing observations.",
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
        confidence: z.number().min(0).max(1).describe("New confidence value"),
      },
    },
    async ({ names, confidence }) => {
      return text({
        updated: await bulkUpdateConfidence(backend, names, confidence),
      });
    },
  );

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
