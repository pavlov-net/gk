# Knowledge Graph Query Guide

## Step 1: Orient Yourself
Before querying, understand what's in the graph:
- `list_entity_types` — see all entity types and their counts
- `get_stats` — overall graph shape (entity/relationship/observation counts,
  averages, temporal health)

## Step 2: Choose the Right Search Tool

| Query type | Tool | Best for |
|------------|------|----------|
| Exact names, phrases | `search_keyword` | Known terms, specific names, quoted text |
| Concepts + recency | `search_hybrid` | Combines FTS relevance with temporal scoring |
| Find entities | `search_entities` | Discover entities by name |

**search_hybrid** is the default choice — it factors in:
- Full-text relevance (BM25 scoring)
- Temporal retention (recently-accessed knowledge ranks higher)
- Access frequency (Hebbian strengthening for frequently-used knowledge)
- Staleness tier (overview > summary > detail weighting)

Use **search_keyword** when you want raw text relevance without temporal adjustment.

## Step 3: Filter Results
All observation searches support optional filters:
- `entity_types` — restrict to specific entity types (e.g., ["Person", "Place"])
- `metadata_filters` — match metadata fields (e.g., {"level": "overview"},
  {"chapter": "3"})

## Step 4: Read Full Text
Search results return content. Call `read_observation(observation_id)`
to get the full content, metadata, linked entity names, and timestamp.
Reading an observation also strengthens it (increases stability and access count).

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
- `get_timeline` — chronological observation history, filterable by entity names or types

## Query Strategies

- **Factual questions**: `search_keyword` → `read_observation`
- **Conceptual exploration**: `search_hybrid` → `get_neighbors`
- **Entity discovery**: `search_entities` → `get_entity`
- **Temporal analysis**: `get_timeline`
- **Importance ranking**: `get_centrality`
- **Neighborhood map**: `extract_subgraph`
- **High-level only**: search with `metadata_filters: {"level": "overview"}`
- **Source-specific**: search with `metadata_filters: {"chapter": "3"}`
