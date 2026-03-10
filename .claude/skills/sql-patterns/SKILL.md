---
name: sql-patterns
description: >-
  Use when writing or modifying SQL queries, database operations, FTS search,
  SQLite/Dolt schema, backend methods, or any code in graph.ts, observations.ts,
  search.ts, maintenance.ts, backend.ts. Covers N+1 prevention, FTS sync,
  bun:sqlite gotchas, and query patterns.
user-invocable: false
---

# SQL Patterns for gk

## N+1 Prevention

Never execute SQL inside a loop. Every operation should be a single batched query,
even if it requires subqueries, CTEs, or window functions. The database does the
hard work.

**Bad:**
```typescript
for (const name of names) {
  await backend.get("SELECT id FROM entities WHERE name = ?", [name]);
}
```

**Good:**
```typescript
const ph = names.map(() => "?").join(", ");
const rows = await backend.all(
  `SELECT id, name FROM entities WHERE name IN (${ph})`, names
);
```

For graph traversal (BFS/neighbors/paths), use level-by-level batched frontier
queries — one query per depth level, not per node.

## bun:sqlite `changes` Is Unreliable

`stmt.run().changes` in bun:sqlite includes rows affected by CASCADE deletes
and trigger-fired statements. Never use it for accurate counts.

**Use COUNT-first pattern instead:**
```typescript
const { count } = await backend.get<{ count: number }>(
  `SELECT COUNT(*) as count FROM entities WHERE name IN (${ph})`, names
);
await backend.run(`DELETE FROM entities WHERE name IN (${ph})`, names);
// `count` is the accurate delete count
```

## FTS Is Manually Synced

FTS5 content-sync tables do NOT use triggers. After any INSERT/UPDATE/DELETE
on entities or observations, call the corresponding sync method:

- `backend.syncEntityFts(names)` — after insert/update entities
- `backend.deleteEntityFts(names)` — before deleting entities
- `backend.syncObservationFts(ids)` — after insert/update observations
- `backend.deleteObservationFts(ids)` — before deleting observations

Tests that insert via raw SQL must also call these sync methods.

## Backend Interface Rules

- All SQL goes through `backend.run/get/all` — never direct sqlite access
  outside `backend.ts`
- All values use `?` placeholders, never string interpolation
- Dialect-specific SQL (FTS5, JSON functions, vector ops) lives only in
  `backend.ts` — everything else uses standard SQL
- SQLite uses TEXT types; MySQL/Dolt uses VARCHAR/TIMESTAMP/JSON

## Batch Temporal Bumps

When bumping access counts on multiple rows, use a single UPDATE with SQL
expressions rather than per-row updates:

```typescript
const ph = ids.map(() => "?").join(", ");
await backend.run(
  `UPDATE observations SET
    access_count = access_count + 1,
    stability = MIN(stability * ?, ?),
    last_accessed = ?
  WHERE id IN (${ph})`,
  [config.stability_growth, config.max_stability, ts, ...ids]
);
```
