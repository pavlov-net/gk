# gk — Knowledge Graph MCP Server

**A knowledge graph server for LLM agents, built on Bun with SQLite and optional Dolt.**

## What It Does

gk is an [MCP](https://modelcontextprotocol.io/) server that gives agents tools to build, search, and analyze knowledge graphs. The schema is fully dynamic — the agent decides what entity types, relationship types, and properties fit the domain. One database per project.

**26 tools across four tiers:**

| Tier | Tools | Purpose |
|------|-------|---------|
| Build (8) | `add_entities`, `add_relationships`, `add_observations`, `add_chunked_observation`, `update_entities`, `update_relationships`, `delete_entities`, `merge_entities` | Construct and maintain the graph |
| Search (4) | `search_keyword`, `search_hybrid`, `search_entities`, `read_observation` | Find information via BM25 full-text search |
| Navigate (10) | `get_entity`, `get_entity_profile`, `get_relationships`, `list_entity_types`, `find_paths`, `get_neighbors`, `extract_subgraph`, `get_centrality`, `get_timeline`, `validate_graph` | Traverse and analyze graph structure |
| Maintain (4) | `get_stats`, `prune_stale`, `get_health_report`, `bulk_update_confidence` | Monitor and maintain graph quality |

**Built-in domain guidance** — Four guides ship as both MCP prompts and resources, covering extraction, pyramid observations, querying, and review.

**Temporal dynamics** — Hebbian strengthening on access (stability grows), Ebbinghaus decay over time (unused knowledge fades in search rankings). Overview-tier knowledge is architecturally durable; details are ephemeral.

## Technology

- **[Bun](https://bun.sh)** — Runtime, test runner, package manager
- **SQLite** via `bun:sqlite` — Embedded database with FTS5 full-text search
- **[Dolt](https://www.dolthub.com/)** (optional) — MySQL-compatible database with git-like versioning, via `Bun.SQL`
- **[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)** — Model Context Protocol server

## Quick Start

```bash
# Clone and install
git clone https://github.com/yourusername/gk.git
cd gk && bun install

# Initialize a database
bun run . init

# Run tests
bun test
```

### As an MCP Server

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "gk": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "--bun", "/path/to/gk"],
      "env": {
        "GK_DB_PATH": "/path/to/your/project/knowledge.db"
      }
    }
  }
}
```

## Configuration

Environment variables or `gk.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `GK_BACKEND` | `sqlite` | Backend: `sqlite` or `dolt` |
| `GK_DB_PATH` | `.gk/knowledge.db` | SQLite database path |
| `GK_DOLT_HOST` | `127.0.0.1` | Dolt server host |
| `GK_DOLT_PORT` | `3307` | Dolt server port |
| `GK_DOLT_DATABASE` | `gk` | Dolt database name |
| `GK_DOLT_USER` | `root` | Dolt user |
| `GK_DOLT_PASSWORD` | *(empty)* | Dolt password |
| `GK_DECAY_BASE_DAYS` | `7` | Temporal decay half-life |

## Guides

| Resource URI | Prompt | Description |
|---|---|---|
| `gk://guides/extraction` | `extraction` | Extracting entities and relationships from text |
| `gk://guides/pyramid` | `pyramid` | Hierarchical observations: detail/summary/overview |
| `gk://guides/query` | `query` | Searching and exploring the graph |
| `gk://guides/review` | `review` | Reviewing and improving graph quality |

## Development

```bash
bun test              # Run tests (96 pass, 7 Dolt tests skip without GK_DOLT_HOST)
bun run check         # Biome lint + format check
```

## License

MIT
