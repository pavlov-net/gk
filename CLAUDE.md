# gk — Development Guide

## Stack

- **Runtime:** Bun 1.3+ (bun:sqlite for SQLite, Bun.SQL for MySQL/Dolt)
- **Language:** TypeScript (strict mode)
- **Test runner:** `bun test` (bun:test)
- **Linter/formatter:** Biome (`bun run check`)
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.27+
- **Schema validation:** Zod v4

## Architecture

```
src/backend.ts    ← Backend interface + GraphDB (unified SQLite/MySQL impl)
src/graph.ts      ← Entity/relationship CRUD, traversal, analysis (~1200 lines)
src/observations.ts ← Observation CRUD
src/search.ts     ← Search orchestration (keyword, hybrid with temporal re-ranking)
src/scoring.ts    ← Temporal scoring (Hebbian + Ebbinghaus)
src/maintenance.ts ← prune_stale, get_health_report, bulk_update_confidence
src/server.ts     ← MCP server (26 tools, 4 resources, 4 prompts)
src/index.ts      ← Entry point
src/config.ts     ← Zod config schema + env/file loading
src/types.ts      ← Shared types (EntityInput, StalenessTier, etc.)
src/id.ts         ← nanoid wrapper
src/prompts/*.md  ← Domain guide content (extraction, pyramid, query, review)
```

All SQL in graph.ts/observations.ts/search.ts/maintenance.ts uses standard SQL with `?` placeholders through the `Backend` interface. Dialect-specific SQL (FTS, JSON functions) lives only in `backend.ts`.

## Conventions

- **Build order:** entities → relationships → observations
- **Batch operations:** Always prefer batch add/update over one-at-a-time
- **IDs:** 12-char nanoid via `newId()`
- **Timestamps:** ISO 8601 strings for SQLite, TIMESTAMP for MySQL
- **JSON fields:** Stored as TEXT in SQLite, JSON in MySQL. Use `json_extract` in standard SQL (handled by backend layer for MySQL differences)
- **Staleness tiers:** `overview` (1.0) > `summary` (0.7) > `detail` (0.4)
- **Confidence:** 0–1 float, defaults to 0.8

## Testing

```bash
bun test                    # All tests
bun test tests/graph.test.ts # Single file
```

- 96 SQLite tests run always
- 7 Dolt tests skip unless `GK_DOLT_HOST` is set
- Tests use in-memory SQLite (`:memory:`) via `createTestDb()` in `tests/helpers.ts`

## Common Tasks

**Add a new tool:** Register in `src/server.ts` using `server.registerTool()` with Zod schema, handler, and `annotations` (idempotentHint, readOnlyHint, destructiveHint).

**Add a new graph operation:** Add to `src/graph.ts`, import `Backend` from `./backend`, write standard SQL with `?` params.

**Modify schema:** Update both `SQLITE_SCHEMA` and `MYSQL_SCHEMA` in `src/backend.ts`. SQLite uses TEXT types; MySQL uses VARCHAR/TIMESTAMP/JSON with concrete types.
