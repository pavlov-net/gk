# Pyramid Extraction Pattern

Structure observations in three levels using metadata to indicate the level:

## Level 1: Detail Observations
- Direct quotes, specific facts, granular data points
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

## Workflow
1. First pass: extract detail observations (facts and quotes)
2. Second pass: write summary observations (synthesize related details)
3. Third pass: write overview observations (themes and patterns)
4. Use metadata_filters in search to query specific levels

## Maintaining Freshness
When you add new detail observations to entities that already have summaries
or overviews, those higher-level observations may become stale.

After adding new details:
1. Run `validate_graph` — look for `stale_summary` or `stale_overview` issues
2. Run `get_stats` — check the `pyramid` field for `stale_summary_entities`
   and `stale_overview_entities`
3. For each stale entity, review the new details and update the corresponding
   summary or overview observation to incorporate the new information
