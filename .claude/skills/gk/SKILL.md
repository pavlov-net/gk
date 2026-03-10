---
name: gk
description: >-
  This skill should be used when working with the gk knowledge graph MCP server —
  "extract knowledge", "add to the graph", "query the graph", "search the knowledge graph",
  "maintain the graph", "validate graph quality", "pyramid observations", "graph maintenance".
  Provides workflow orchestration with guides available as MCP resources.
---

# Working with gk Knowledge Graph

gk is an MCP server providing 27 tools in 4 tiers for building, searching,
analyzing, and maintaining knowledge graphs. The server ships with guide
resources containing canonical domain guidance — always read those rather
than relying on remembered patterns.

## Discovering gk Capabilities

On first connection or when unsure about available tools:

1. Check `list_entity_types` and `get_stats` to understand the current graph state
2. Read the relevant guide resource before starting work:
   - `gk://guides/extraction` — entity/relationship extraction from text
   - `gk://guides/pyramid` — hierarchical observation levels (detail/summary/overview)
   - `gk://guides/query` — searching and exploring the graph
   - `gk://guides/review` — reviewing and improving graph quality

## Tool Tiers

**Tier 1 — Build (8 tools):** add_entities, add_relationships, add_observations,
add_chunked_observation, update_entities, update_relationships, delete_entities,
merge_entities

**Tier 2 — Search (5 tools):** search_keyword, search (default, hybrid BM25 + semantic),
search_entities, list_entities, read_observation

**Tier 3 — Navigate & Analyze (10 tools):** get_entity, get_entity_profile,
get_relationships, list_entity_types, find_paths, get_neighbors,
extract_subgraph, get_centrality, get_timeline, validate_graph

**Tier 4 — Maintenance (4 tools):** get_stats, prune_stale, get_health_report,
bulk_update_confidence

## Workflow: Extracting Knowledge

When extracting structured knowledge from text into the graph:

1. Read resource `gk://guides/extraction` from server `gk` — follow its steps in order
2. If using hierarchical observations (detail/summary/overview), also read
   resource `gk://guides/pyramid` from server `gk` for the three-level pattern and freshness guidance
3. Prefer batch operations — send multiple entities/relationships/observations
   per call rather than one at a time

**Entity and relationship types are domain-driven.** Invent types that fit the
material — there is no fixed vocabulary. Check `list_entity_types` first to
match existing conventions.

## Workflow: Querying the Graph

When searching or exploring an existing knowledge graph:

1. Read resource `gk://guides/query` from server `gk` — it covers search tool selection,
   filtering, graph traversal, and query strategies
2. Always start with `list_entity_types` and `get_stats` to orient
3. Use `metadata_filters` to narrow searches (e.g., `{"level": "overview"}`)
4. Call `read_observation` for full text after finding results via search

## Workflow: Graph Maintenance

When maintaining or improving graph quality:

1. Read resource `gk://guides/review` from server `gk` — follow its steps
2. Run `validate_graph` to surface structured issues automatically:
   - Island entities, orphan observations, missing observations,
     duplicate candidates (same name, different types)
3. Run `get_stats` to check coverage metrics:
   - `avg_observations_per_entity`, `entities_without_observations`,
     `relationship_types`, temporal health
4. Run `prune_stale` and `get_health_report` to assess temporal health
5. Use `merge_entities` to consolidate duplicates — supports batch merging
   (multiple sources into one target) with property merging
6. Use `delete_entities` with `delete_orphan_observations: true` to clean up
   entities and their orphaned observations in one step
7. Use `get_centrality(metric="degree")` to find hub entities, then verify
   they are well-described with `get_entity`

## Key Conventions

- **Build order:** entities first, then relationships, then observations
- **Confidence:** 0-1 float for information quality (optional on all items)
- **Source:** free-text source tracking (optional on observations)
- **Metadata:** arbitrary key-value pairs on observations for filtering
  (use `metadata_filters` in search to query by metadata)
- **Pyramid levels:** `{"level": "detail|summary|overview"}` in metadata,
  with staleness tiers on entities controlling search weight
- **Temporal dynamics:** Hebbian strengthening on access (stability grows),
  Ebbinghaus decay over time (unused knowledge fades in rankings).
  Overview-tier knowledge is architecturally durable; details are ephemeral.
- **Staleness tiers:** overview (weight 1.0) > summary (0.7) > detail (0.4)
  — use `prune_stale` and `get_health_report` to manage temporal health
