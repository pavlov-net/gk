# Knowledge Graph Query Guide

## Step 1: Orient Yourself
Before querying, understand what's in the graph:
- `list_entity_types` — see all entity types and their counts
- `get_stats` — overall graph shape (entity/relationship/observation counts,
  averages, pyramid stats if applicable)

## Step 2: Choose the Right Search Tool

| Query type | Tool | Best for |
|------------|------|----------|
| Exact names, phrases | `search_keyword` | Known terms, specific names, quoted text |
| Concepts, themes | `search_semantic` | Thematic queries, conceptual similarity |
| Unsure | `search_hybrid` | Combines both via Reciprocal Rank Fusion |
| Find entities | `search_entities` | Discover entities by description |
| Find relationships | `search_relationships` | Discover edges by description |

Adjust `search_hybrid` weights to favor one approach:
- `keyword_weight=2.0` — emphasize exact matches
- `semantic_weight=2.0` — emphasize conceptual similarity

## Step 3: Filter Results
All observation searches support optional filters:
- `entity_types` — restrict to specific entity types (e.g., ["Person", "Place"])
- `metadata_filters` — match metadata fields (e.g., {"level": "overview"},
  {"chapter": "3"})

## Step 4: Read Full Text
Search results return truncated snippets. Call `read_observation(observation_id)`
to get the full content, metadata, linked entity names, and timestamp.

## Step 5: Explore Graph Structure

**Entity profiles:**
- `get_entity("name")` — full profile with relationships and observation summaries

**Connections:**
- `get_relationships` — query edges by entity name and/or type
- `find_paths(source, target)` — shortest paths between two entities
- `get_neighbors(entity_name, depth=2)` — multi-hop outward exploration
- `extract_subgraph(seed_entities, depth=2)` — connected neighborhood

**Analysis:**
- `get_centrality(metric="degree")` — importance by connection count
- `get_centrality(metric="pagerank")` — importance by graph structure
- `get_timeline` — chronological observation history, filterable by entity or type

## Query Strategies

- **Factual questions**: `search_keyword` → `read_observation`
- **Thematic exploration**: `search_semantic` → `get_neighbors`
- **Entity discovery**: `search_entities` → `get_entity`
- **Relationship discovery**: `search_relationships`
- **Temporal analysis**: `get_timeline`
- **Importance ranking**: `get_centrality`
- **Neighborhood map**: `extract_subgraph`
- **High-level only**: search with `metadata_filters={"level": "overview"}`
