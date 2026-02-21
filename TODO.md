# gk — Future Enhancements

## Search & Retrieval
- [ ] **Relationship embedding** — Embed relationship descriptions (e.g., "Gatsby LOVES Daisy - obsessive, unrequited") for semantic search over edges, not just entities/observations
- [ ] **Entity-level semantic search** — Dedicated `search_entities` tool using entity_embeddings vec0 table (currently entities are found via linked observations)
- [ ] **Search filters** — Filter by metadata fields (date ranges, source, tags), not just entity types
- [ ] **Faceted search results** — Return aggregation counts by entity type, relationship type alongside results
- [ ] **Query expansion** — Automatically expand search queries with synonyms or related terms from the graph
- [ ] **Contextual re-ranking** — Use the agent's conversation context to re-rank search results for relevance

## Graph Intelligence
- [ ] **Entity deduplication / merge tool** — `merge_entities(source_names, target_name)` that consolidates relationships and observations
- [ ] **Community detection** — Identify clusters of closely related entities (Louvain algorithm or similar)
- [ ] **Centrality metrics** — PageRank, betweenness centrality to identify key entities in the graph
- [ ] **Subgraph extraction** — Extract a focused subgraph around a topic for more targeted analysis
- [ ] **Temporal ordering** — Support time-based ordering of events/observations for narrative analysis
- [ ] **Confidence scores** — Track extraction confidence on entities/relationships, allow agents to flag uncertain data

## Observations & Content
- [ ] **Observation chunking** — Automatically chunk long texts into smaller observations with overlap, maintaining entity links
- [ ] **Observation versioning** — Track edits to observations over time, diff between versions
- [ ] **Source provenance** — Track which agent/session created each entity, relationship, observation
- [ ] **Multi-modal observations** — Support image descriptions, structured data tables alongside text
- [ ] **Observation summarization** — Auto-generate summaries when observation count for an entity exceeds threshold

## Infrastructure & Operations
- [ ] **Multi-database support** — Switch between projects/databases without restarting the server
- [ ] **Incremental re-embedding** — When embedding model changes, re-embed all content in background batches
- [ ] **Database migration tooling** — Schema versioning and migration scripts for upgrades
- [ ] **Backup / export** — Export graph to JSON-LD, RDF, or portable format; import from same
- [ ] **Connection pooling** — Multiple concurrent readers via WAL mode optimization
- [ ] **Metrics & observability** — Track tool call counts, latency, embedding API costs

## Visualization & Export
- [ ] **Graph visualization export** — Graphviz DOT, Mermaid, or D3.js JSON for visual exploration
- [ ] **Interactive graph viewer** — Web-based graph explorer (vis.js or cytoscape.js)
- [ ] **Markdown report generation** — `generate_report(topic)` tool that creates a structured markdown document from graph data
- [ ] **Diff between graph states** — Compare graph at two points in time to see what changed

## Agent Experience
- [ ] **Guided extraction prompts** — MCP prompts that help agents structure their extraction approach for different content types
- [ ] **Schema suggestion** — `suggest_types(sample_text)` tool that analyzes text and recommends entity/relationship types
- [ ] **Extraction validation** — `validate_graph()` tool that checks for orphaned entities, missing relationships, inconsistencies
- [ ] **Graph statistics** — `get_stats()` tool returning entity counts, relationship density, observation coverage metrics
- [ ] **Natural language graph queries** — `query_graph(question)` tool that translates natural language to a combination of search + traversal calls

## Skills
- [ ] **Domain-specific skill templates** — Pre-built skills for common domains: research papers, codebases, legal documents, meeting notes
- [ ] **Skill for iterative refinement** — Guide agents through reviewing and improving their initial extraction
- [ ] **Skill for cross-graph analysis** — Compare entities and relationships across multiple project databases
