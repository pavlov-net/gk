---
name: extract-knowledge
description: Use when extracting structured knowledge from unstructured text into the gk knowledge graph. Guides entity identification, relationship mapping, and observation creation.
---

# Extract Knowledge into Graph

You are extracting structured knowledge from source material into a knowledge graph using gk MCP tools.

## Process

### 1. Survey the existing graph
Call `list_entity_types` to understand what's already in the graph. This prevents duplicates and ensures consistency with existing type names.

### 2. Read and analyze source material
Read the source text carefully. Identify:
- **Entities**: People, places, organizations, concepts, themes, events, sentiments, objects — anything that is a "noun" worth tracking
- **Relationships**: How entities connect — KNOWS, LOCATED_IN, CAUSES, THEME_OF, PART_OF, OPPOSES, etc.
- **Observations**: Key passages, quotes, summaries, or descriptions that should be searchable

### 3. Choose entity types consistently
Use the same type names throughout. Common patterns:
- `Person`, `Place`, `Organization`, `Event`, `Theme`, `Concept`, `Sentiment`
- For code: `Module`, `Function`, `Class`, `Pattern`, `Decision`
- For research: `Paper`, `Author`, `Finding`, `Method`, `Dataset`

Use properties for attributes: `{"role": "protagonist", "first_appears": "chapter 1"}`

### 4. Add entities first
Call `add_entities` with a batch of entities. This must happen before relationships or observations can reference them.

```
add_entities([
  {"name": "...", "type": "...", "properties": {"key": "value"}},
  ...
])
```

### 5. Add relationships
Call `add_relationships` to connect entities. Choose relationship types that are descriptive and consistent.

```
add_relationships([
  {"source": "Entity A", "target": "Entity B", "type": "RELATIONSHIP_TYPE"},
  ...
])
```

### 6. Add observations
Call `add_observations` with text content linked to relevant entities. These are the searchable text chunks.

```
add_observations([
  {"content": "The actual text passage...", "entity_names": ["Entity A", "Entity B"]},
  ...
])
```

### 7. Verify
Call `list_entity_types` to confirm what was created. Use `get_entity` on key entities to verify relationships and observations are linked correctly.

## Tips
- **Batch operations**: Send multiple items per call rather than one at a time
- **Link observations broadly**: An observation about a conversation between two people should link to both people and any themes discussed
- **Properties over entities**: Use properties for attributes (age, color, date). Create entities for things that have their own relationships
- **Progressive extraction**: You don't need to capture everything in one pass. Start with major entities and relationships, then add detail
