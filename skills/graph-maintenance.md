---
name: graph-maintenance
description: Use when maintaining, cleaning, or improving an gk knowledge graph. Guides deduplication, consistency fixes, and data hygiene.
---

# Knowledge Graph Maintenance

You are maintaining and improving the quality of a knowledge graph built with gk.

## Common maintenance tasks

### Merge duplicate entities
When the same real-world thing has been added under different names or types:

1. Identify duplicates: `search_keyword("the name")` or `get_relationships` to find entities with overlapping connections
2. Decide which entity to keep (the one with more relationships/observations)
3. Update the entity to keep: `update_entities([{"name": "old_name", "type": "old_type", "new_name": "canonical_name"}])`
4. Delete the duplicate: `delete_entities(["duplicate_name"], delete_orphan_observations=False)` — keep observations, they'll stay in the system even if unlinked

### Fix inconsistent relationship types
When the same kind of relationship has been named differently (e.g., "KNOWS" vs "FRIEND_OF" vs "knows"):

1. Survey: `get_relationships(relationship_type="KNOWS")` and `get_relationships(relationship_type="knows")`
2. Update to consistent casing: `update_relationships([{"source": "A", "target": "B", "type": "knows", "new_type": "KNOWS"}])`

### Fix inconsistent entity types
When the same kind of entity has different type labels:

1. Survey: `list_entity_types` to see all types and counts
2. For each inconsistency: `update_entities([{"name": "...", "type": "person", "new_type": "Person"}])`

### Add missing observations
When entities exist but lack supporting text:

1. Identify: `get_entity("name")` — check if observations list is empty
2. Add observations with relevant text linked to the entity

### Clean up orphaned data
When entities have no relationships and no observations:

1. Check: `get_entity("name")` — if relationships and observations are both empty, the entity may be orphaned
2. Remove if not useful: `delete_entities(["orphan_name"], delete_orphan_observations=True)`

### Enrich entity properties
When entities are missing useful attributes:

1. Review: `get_entity("name")` to see current properties
2. Update: `update_entities([{"name": "...", "type": "...", "new_properties": {"role": "protagonist", "age": "30"}}])`
3. Note: `new_properties` replaces all properties — include existing ones you want to keep

## Maintenance checklist
1. Run `list_entity_types` — are type names consistent and meaningful?
2. Check high-value entities with `get_entity` — do they have relationships and observations?
3. Search for common names with `search_keyword` — are there duplicates?
4. Sample relationships with `get_relationships` — are types consistent?
5. Look for disconnected subgraphs with `get_neighbors` on key entities
