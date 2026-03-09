# Graph Review and Refinement Guide

## Step 1: Check Graph Health
Run `validate_graph` to identify issues:
- **Island entities**: entities with no relationships — add connections or remove
- **Orphan observations**: observations not linked to any entity — link or remove
- **Missing observations**: entities with no observations — add context
- **Duplicate candidates**: same name with different types — use `merge_entities`

## Step 2: Review Statistics
Run `get_stats` to understand the graph shape:
- Check entity type distribution — are types consistent and well-chosen?
- Check `relationship_types` — are relationship types meaningful and consistent?
- Check `avg_relationships_per_entity` — very low suggests missing connections
- Check `avg_observations_per_entity` — very low suggests thin coverage
- Check `entities_without_observations` — these entities lack descriptive context
- Check temporal health — fragile (stability ≤ 1) entities may need attention

Run `get_health_report` for more detail:
- Most/least accessed entities — are important entities being accessed?
- Tier distribution — is the pyramid properly structured?
- Temporal health breakdown (durable/stable/fragile)

## Step 3: Check Key Entities
Run `get_centrality` (degree or pagerank) to find the most important entities:
- Review top entities with `get_entity` — are they well-described?
- Do they have sufficient observations?
- Are relationship types consistent?

## Step 4: Review Connections
Run `extract_subgraph` around key entities:
- Are expected connections present?
- Are relationship types meaningful and consistent?
- Are there missing edges that should exist?

## Step 5: Search Quality
Test searches with known queries:
- Does `search_keyword` find expected observations?
- Does `search_hybrid` rank important results highly?
- Are recently-accessed results appropriately promoted?

## Step 6: Temporal Health
- Run `prune_stale` to identify knowledge that has decayed below threshold
- Review candidates — some may need to be re-accessed to strengthen them
- Use `bulk_update_confidence` to adjust confidence scores in bulk
- Consider promoting important detail entities to `summary` or `overview` tier

### Staleness Triage
When `prune_stale` or `get_health_report` flags entities with low temporal scores,
**triage before acting**:

1. Read the flagged entity with `get_entity` and review its observations
2. If the entity represents genuinely outdated knowledge, consider updating
   or removing it
3. If the entity is still relevant but simply hasn't been accessed recently,
   accessing it via search or `get_entity` will naturally strengthen it
4. For pyramid-structured graphs: if new details were added after existing
   summaries, read the new details and the summary side by side — only
   rewrite when the new information genuinely changes the summary's conclusions

## Step 7: Fix Issues
- Use `merge_entities` to consolidate duplicates (supports batch: multiple sources into one target)
- Use `update_entities` / `update_relationships` to fix types or properties
- Add missing observations for thin entities
- Add missing relationships between related entities
- Set confidence scores to indicate information quality
- Use `delete_entities` with `delete_orphan_observations: true` to clean up
  entities and their orphaned observations in one step
