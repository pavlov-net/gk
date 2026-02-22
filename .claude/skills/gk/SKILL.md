---
name: gk-knowledge-graph
description: >-
  This skill should be used when working with the gk knowledge graph MCP server —
  "extract knowledge", "add to the graph", "query the graph", "search the knowledge graph",
  "maintain the graph", "validate graph quality", "pyramid observations", "graph maintenance".
  Provides workflow orchestration with guides available as MCP resources.
---

# Working with gk Knowledge Graph

gk is an MCP server providing 24 tools for building, searching, and analyzing
knowledge graphs. The server ships with guide resources containing canonical
domain guidance — always read those rather than relying on remembered patterns.

## Discovering gk Capabilities

On first connection or when unsure about available tools:

1. Check `list_entity_types` and `get_stats` to understand the current graph state
2. Read the relevant guide resource before starting work:
   - `gk://guides/extraction` — entity/relationship extraction from text
   - `gk://guides/pyramid` — hierarchical observation levels
   - `gk://guides/query` — searching and exploring the graph
   - `gk://guides/review` — reviewing and improving graph quality

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
3. Search results return truncated snippets — call `read_observation`
   for full text

## Workflow: Graph Maintenance

When maintaining or improving graph quality:

1. Read resource `gk://guides/review` from server `gk` — follow its steps
2. Run `validate_graph` to surface issues automatically:
   - Island entities, orphan observations, duplicate candidates
   - Stale summaries/overviews (pyramid freshness)
3. Run `get_stats` to check coverage metrics and pyramid staleness
4. Use `merge_entities` to consolidate duplicates — it handles observation
   and relationship transfer automatically
5. Use `get_centrality(metric="degree")` to find hub entities, then verify
   they are well-described with `get_entity`

## Key Conventions

- **Build order:** entities first, then relationships, then observations
- **Confidence:** 0-1 float for information quality (optional on all items)
- **Provenance:** free-text source tracking (optional on all items)
- **Metadata:** arbitrary key-value pairs on observations for filtering
- **Pyramid levels:** `{"level": "detail|summary|overview"}` in metadata
- **Staleness:** a summary/overview is stale when a newer detail exists
  for the same entity — the server detects this, the agent must fix it
