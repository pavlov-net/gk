# Pyramid Extraction Pattern

Structure observations in three levels using staleness tiers and metadata:

## Level 1: Detail Observations
- Direct quotes, specific facts, granular data points
- Entity staleness_tier: `detail` (weight: 0.4)
- metadata: {"level": "detail", "source": "chapter 3"}
- One observation per fact or quote
- High specificity, links to 1-2 entities

Example:
```
content: "Gatsby's parties were attended by hundreds of people every Saturday night."
entity_names: ["Jay Gatsby"]
metadata: {"level": "detail", "chapter": "3"}
```

## Level 2: Summary Observations
- Synthesized summaries of related details
- Entity staleness_tier: `summary` (weight: 0.7)
- metadata: {"level": "summary", "scope": "character analysis"}
- Covers a theme or topic across multiple details
- Links to 2-5 entities

Example:
```
content: "Gatsby uses his extravagant parties as a social
  mechanism to attract Daisy's attention."
entity_names: ["Jay Gatsby", "Daisy Buchanan"]
metadata: {"level": "summary", "scope": "character motivation"}
```

## Level 3: Overview Observations
- High-level themes, patterns, and conclusions
- Entity staleness_tier: `overview` (weight: 1.0)
- metadata: {"level": "overview", "scope": "thematic analysis"}
- Broad insights spanning many entities
- Links to key entities only

Example:
```
content: "The American Dream is portrayed as fundamentally
  corrupted — wealth cannot buy genuine connection."
entity_names: ["American Dream", "Jay Gatsby"]
metadata: {"level": "overview", "scope": "theme"}
```

## How Tiers Interact with Temporal Dynamics

The staleness tier directly affects search ranking through the scoring formula:

```
score = fts_relevance × retention × hebbian × tier_weight
```

- **Overview** (weight 1.0): Highest natural prominence. These observations stay
  near the top of search results even without frequent access.
- **Summary** (weight 0.7): Middle ground. Important enough to persist, but
  will yield to overviews when both match a query.
- **Detail** (weight 0.4): Most granular. These surface when specifically relevant
  but naturally defer to higher-tier observations.

This means overview-tier knowledge is architecturally durable — it doesn't need
constant re-access to maintain relevance. Details are ephemeral by design: they
strengthen when actively used but gracefully fade when not.

## Workflow
1. First pass: extract **all** detail observations (facts and quotes).
   **Exhaust detail extraction completely** before writing any summaries.
   This means every section of the source material should be covered and
   every entity should have its detail-level observations in place.

2. **Completeness gate (HARD STOP).** Do not proceed to summaries until
   this gate passes cleanly:
   - Run `validate_graph` — there must be **zero** `missing_observations`
     issues. Every entity that has relationships must also have at least
     one detail observation.
   - Pay special attention to **structural/container entities** (chapters,
     sections, modules) — these are the most commonly missed because detail
     observations tend to link to content entities (people, places, concepts)
     rather than the containers that organize them.
   - Run `get_stats` and check that `entities_without_observations` is 0.
   - Fix all gaps before continuing.

3. Second pass: write summary observations (synthesize related details).
   Set entity staleness_tier to `summary` for entities that now have summaries.

4. Third pass: write overview observations (themes and patterns).
   Set entity staleness_tier to `overview` for key thematic entities.

5. Use `metadata_filters` in search to query specific levels
   (e.g., `metadata_filters: {"level": "overview"}`).

This ordering is critical. Adding gap-filling details *after* summaries exist
may cause those summaries to appear stale — even when the new details don't
affect them. Get details right first to avoid unnecessary rework.

## Maintaining Freshness

When you add new detail observations to entities that already have summaries
or overviews, those higher-level observations may need review.

Use v2's temporal tools to manage freshness:
1. Run `prune_stale` — identifies entities with low temporal scores that may
   need attention.
2. Run `get_health_report` — check tier distribution and access patterns.
3. **Triage each flagged entity** before rewriting:
   - Read the new detail(s) and the existing summary side by side
   - If the detail covers a *different aspect* of the entity than the summary
     addresses (e.g., a minor family member's appearance vs. a character arc
     summary), the summary is still accurate — note this and move on
   - Only rewrite when the new information genuinely changes the summary's
     conclusions or makes it misleading
