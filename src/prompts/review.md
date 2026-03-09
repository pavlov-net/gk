# Graph Review and Refinement Guide

## Step 1: Check Graph Health
Run `validate_graph` to identify issues:
- **Island entities**: entities with no relationships or observations — add connections or remove
- **Orphan observations**: observations not linked to any entity — link or remove
- **Duplicate candidates**: same name with different types — use merge_entities
- **Missing observations**: entities with relationships but no observations
- **Stale summaries**: summary observations older than latest detail — triage them
- **Stale overviews**: overview observations older than latest detail — triage them

"Stale" means a newer detail exists, not that the summary is wrong.
For each flagged entity: read the new details and the existing summary.
If the summary still accurately reflects the entity, no update is needed.
Only rewrite when genuinely new information changes the summary's conclusions.

## Step 2: Review Statistics
Run `get_stats` to understand the graph shape:
- Check entity type distribution — are types consistent and well-chosen?
- Check avg_relationships_per_entity — very low suggests missing connections
- Check avg_observations_per_entity — very low suggests thin coverage
- Check entities_without_observations — these entities lack descriptive context
- If the graph uses the pyramid pattern, check the `pyramid` field for
  `stale_summary_entities` and `stale_overview_entities` — refresh these

## Step 3: Check Key Entities
Run `get_centrality` (degree or pagerank) to find the most important entities:
- Review top entities with get_entity — are they well-described?
- Do they have sufficient observations?
- Are relationship types consistent?

## Step 4: Review Connections
Run `extract_subgraph` around key entities:
- Are expected connections present?
- Are relationship types meaningful and consistent?
- Are there missing edges that should exist?

## Step 5: Search Quality
Test searches with known queries:
- Does search_keyword find expected observations?
- Does search_semantic find thematically related content?
- Are results well-ranked?

## Step 6: Fix Issues
- Use merge_entities to consolidate duplicates
- Use update_entities / update_relationships to fix types or properties
- Add missing observations for thin entities
- Add missing relationships between related entities
- Set confidence scores to indicate information quality
