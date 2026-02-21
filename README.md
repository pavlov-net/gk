# gk — Agentic Knowledge Graph MCP Server

**A generic, agent-driven knowledge graph server built on SQLite with hybrid search.**

## The Problem

Large Language Models are powerful reasoners, but they lack persistent, structured memory. When an agent processes complex information — technical documentation, research papers, codebases, domain knowledge — the extracted understanding is lost when the conversation ends. Traditional RAG systems treat knowledge as flat document chunks, losing the rich structure of entities, relationships, and contextual observations that make information truly useful.

## The Research

This project is inspired by [A-RAG: Agentic Retrieval-Augmented Generation](https://arxiv.org/abs/2602.03442), which demonstrates that exposing **hierarchical retrieval interfaces** (keyword search, semantic search, chunk read) as separate agent tools significantly outperforms single-shot retrieval pipelines. The key insight: agents make better retrieval decisions than fixed algorithms when given the right tools.

## The Approach

gk is a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that provides agents with tools to both **build** and **query** a knowledge graph. The schema is fully dynamic — the agent decides what entity types, relationship types, and properties make sense for the domain. One database per project.

**Three retrieval tiers** (following A-RAG):
- **Keyword search** — BM25 via SQLite FTS5. Best for exact terms, names, specific phrases.
- **Semantic search** — Vector similarity via sqlite-vec. Best for thematic/conceptual queries.
- **Hybrid search** — Reciprocal Rank Fusion combining both approaches.

Plus **graph traversal** tools for structured navigation: entity profiles, relationship queries, path finding, and multi-hop exploration.

**Two workflows**:
- **Input**: An agent reads source material and extracts entities, relationships, and observations into the graph.
- **Output**: A different agent queries the graph to reason about the domain — finding connections, identifying gaps, answering questions.

## Technology

- **SQLite** — Single-file embedded database. No server to run.
- **[sqlite-vec](https://github.com/asg017/sqlite-vec)** — Vector similarity search extension for SQLite.
- **FTS5** — Built-in full-text search with BM25 ranking.
- **[LiteLLM](https://github.com/BerriAI/litellm)** — Provider-agnostic embedding generation (OpenAI, Cohere, Ollama, etc.).
- **[FastMCP](https://github.com/modelcontextprotocol/python-sdk)** — Official Python SDK for Model Context Protocol servers.

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/gk.git
cd gk

# Install with uv
uv sync
```

## Configuration

Set environment variables to configure the server:

| Variable | Default | Description |
|----------|---------|-------------|
| `GK_DB_PATH` | `knowledge.db` | Path to the SQLite database file |
| `GK_EMBEDDING_MODEL` | `ollama/nomic-embed-text` | LiteLLM model identifier for embeddings |
| `GK_EMBEDDING_DIM` | `768` | Embedding vector dimension |
| `GK_EMBEDDING_BATCH_SIZE` | `100` | Max items per embedding API call |

The default configuration uses a local [Ollama](https://ollama.com/) instance with `nomic-embed-text` — no API key needed. Just run `ollama pull nomic-embed-text` to get started.

To use OpenAI instead, set `GK_EMBEDDING_MODEL=text-embedding-3-small`, `GK_EMBEDDING_DIM=1536`, and `OPENAI_API_KEY`.

## Usage

### As an MCP Server

Add to your Claude Code MCP configuration (`.mcp.json`):

```json
{
  "mcpServers": {
    "gk": {
      "type": "stdio",
      "command": "uv",
      "args": ["run", "--directory", "/path/to/gk", "gk"],
      "env": {
        "GK_DB_PATH": "/path/to/your/project/knowledge.db",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Tools Overview

**Graph Construction (6 tools)**
- `add_entities` — Batch-add entities with auto-embedding. Upserts on name+type.
- `add_relationships` — Batch-add typed edges between entities.
- `add_observations` — Batch-add text chunks linked to entities. Auto-embeds + FTS5.
- `update_entities` — Update entity properties, type, or name. Re-embeds if content changes.
- `update_relationships` — Update relationship type or properties.
- `delete_entities` — Remove entities with cascade options.

**Retrieval (4 tools)**
- `search_keyword` — BM25 full-text search via FTS5.
- `search_semantic` — Vector similarity search via sqlite-vec.
- `search_hybrid` — Reciprocal Rank Fusion combining keyword + semantic.
- `read_observation` — Full text retrieval by observation ID.

**Graph Traversal (5 tools)**
- `get_entity` — Full entity profile with relationships and observation summaries.
- `get_relationships` — Query edges by entity and/or type.
- `list_entity_types` — Introspection: all entity types and their counts.
- `find_paths` — Shortest paths between entities via recursive CTE.
- `get_neighbors` — Multi-hop traversal from an entity.

## Use Cases

- **Research synthesis** — Extract concepts, findings, and relationships from papers. Query across the corpus.
- **Codebase understanding** — Map modules, dependencies, patterns, and design decisions. Query for architectural insight.
- **Domain modeling** — Build knowledge graphs for any domain (legal, medical, financial). Query for analysis.
- **Content analysis** — Extract structure from documents, books, or reports. Query for consistency and gaps.
- **Project memory** — Persist agent-extracted knowledge across sessions. Query to resume context.

## Development

```bash
# Install dev dependencies
uv sync --group dev

# Run type checking
uv run pyright src/

# Run tests
uv run pytest tests/

# Run the server directly
uv run gk
```

## License

MIT
