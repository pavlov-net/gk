# gk — Future Enhancements

## Search & Retrieval
- [ ] **Query expansion** — Automatically expand search queries with synonyms or related terms from the graph
- [ ] **Contextual re-ranking** — Use the agent's conversation context to re-rank search results for relevance

## Graph Intelligence
- [ ] **Community detection** — Identify clusters of closely related entities (Louvain algorithm or similar)

## Observations & Content
- [ ] **Observation versioning** — Track edits to observations over time, diff between versions
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
- [ ] **Schema suggestion** — `suggest_types(sample_text)` tool that analyzes text and recommends entity/relationship types
- [ ] **Natural language graph queries** — `query_graph(question)` tool that translates natural language to search + traversal calls

## Skills
- [ ] **Domain-specific skill templates** — Pre-built skills for common domains: research papers, codebases, legal documents, meeting notes
- [ ] **Skill for cross-graph analysis** — Compare entities and relationships across multiple project databases
