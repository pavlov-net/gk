---
name: query-knowledge
description: Use when querying or analyzing an gk knowledge graph. Guides effective use of search, retrieval, and graph traversal tools.
---

# Query the Knowledge Graph

You are querying a knowledge graph built with gk to find information, analyze relationships, and answer questions.

## Process

### 1. Understand what's available
Call `list_entity_types` first. This tells you what entity types exist and how many of each, so you can target your queries.

### 2. Choose the right search tool

**`search_keyword`** — Use when you know specific terms, names, or phrases.
- Looking for a specific person: `search_keyword("Jay Gatsby")`
- Finding mentions of a term: `search_keyword("green light")`

**`search_semantic`** — Use when you're looking for concepts or themes, even if the exact words don't appear.
- Thematic query: `search_semantic("loss of innocence")`
- Conceptual search: `search_semantic("economic inequality")`

**`search_hybrid`** — Use when you're not sure which approach fits, or want the best of both.
- Default equal weights: `search_hybrid("the American dream")`
- Favor keywords: `search_hybrid("Gatsby's parties", keyword_weight=2.0, semantic_weight=1.0)`

All searches return observation snippets with scores. Use `entity_types` to narrow results.

### 3. Read full observations
Search results show truncated snippets. Call `read_observation(observation_id)` to get the full text of relevant hits.

### 4. Explore entity profiles
Call `get_entity("name")` to see an entity's full profile:
- Properties (attributes)
- All relationships (both directions)
- Linked observation summaries

### 5. Navigate the graph structure

**`get_relationships`** — Query edges by entity name and/or relationship type.
- All relationships for a person: `get_relationships(entity_name="Gatsby")`
- All relationships of a type: `get_relationships(relationship_type="THEME_OF")`

**`find_paths`** — Discover how two entities connect.
- `find_paths(source="Gatsby", target="Daisy", max_depth=3)`

**`get_neighbors`** — Explore outward from an entity.
- `get_neighbors(entity_name="Gatsby", depth=2)`
- Filter by relationship: `get_neighbors(entity_name="Gatsby", depth=2, relationship_types=["KNOWS"])`

## Query strategies

- **Answering factual questions**: `search_keyword` → `read_observation` → `get_entity`
- **Finding thematic connections**: `search_semantic` → `get_neighbors` → `find_paths`
- **Checking consistency**: `get_entity` on key entities → compare relationships and observations
- **Identifying gaps**: `list_entity_types` → `get_relationships` → look for orphaned or under-connected entities
- **Cross-referencing**: `search_hybrid` with different queries → compare entity overlaps in results
