import { Database } from "bun:sqlite";
import type { Backend, FTSEntityResult, FTSResult, Row } from "./backend";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  confidence REAL DEFAULT 0.8,
  staleness_tier TEXT DEFAULT 'detail',
  stability REAL DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(name, type)
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  confidence REAL DEFAULT 0.8,
  source TEXT,
  stability REAL DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observation_entities (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (observation_id, entity_id)
);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  from_entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  strength REAL DEFAULT 1.0,
  confidence REAL DEFAULT 0.8,
  stability REAL DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(from_entity, to_entity, type)
);

CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_entity);
CREATE INDEX IF NOT EXISTS idx_obs_entities_entity ON observation_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

-- FTS5 virtual tables (external content — no data duplication)
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  content, content='observations', content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, type, content='entities', content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS obs_fts_ins AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_fts_del AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_fts_upd AFTER UPDATE OF content ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
  INSERT INTO observations_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS ent_fts_ins AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, type) VALUES (NEW.rowid, NEW.name, NEW.type);
END;
CREATE TRIGGER IF NOT EXISTS ent_fts_del AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, type) VALUES('delete', OLD.rowid, OLD.name, OLD.type);
END;
CREATE TRIGGER IF NOT EXISTS ent_fts_upd AFTER UPDATE OF name, type ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, type) VALUES('delete', OLD.rowid, OLD.name, OLD.type);
  INSERT INTO entities_fts(rowid, name, type) VALUES (NEW.rowid, NEW.name, NEW.type);
END;
`;

export class SqliteBackend implements Backend {
  private db: Database;

  constructor(private path: string) {
    this.db = new Database(path);
  }

  async initialize(): Promise<void> {
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA cache_size = -65536"); // 64MB
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    const stmt = this.db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return { changes: result.changes };
  }

  async get<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined> {
    const stmt = this.db.prepare(sql);
    const row = params ? stmt.get(...params) : stmt.get();
    return (row as T | null) ?? undefined;
  }

  async all<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const rows = params ? stmt.all(...params) : stmt.all();
    return rows as T[];
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.run("BEGIN");
    try {
      const result = await fn();
      this.db.run("COMMIT");
      return result;
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }
  }

  async searchObservations(
    query: string,
    options?: { entityTypes?: string[]; limit?: number },
  ): Promise<FTSResult[]> {
    const limit = options?.limit ?? 20;

    if (options?.entityTypes?.length) {
      const placeholders = options.entityTypes.map(() => "?").join(", ");
      const sql = `
        SELECT o.id, o.content, -bm25(observations_fts) as score
        FROM observations_fts
        JOIN observations o ON o.rowid = observations_fts.rowid
        WHERE observations_fts MATCH ?
          AND o.id IN (
            SELECT oe.observation_id FROM observation_entities oe
            JOIN entities e ON e.id = oe.entity_id
            WHERE e.type IN (${placeholders})
          )
        ORDER BY score DESC
        LIMIT ?
      `;
      return this.all<FTSResult>(sql, [query, ...options.entityTypes, limit]);
    }

    const sql = `
      SELECT o.id, o.content, -bm25(observations_fts) as score
      FROM observations_fts
      JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `;
    return this.all<FTSResult>(sql, [query, limit]);
  }

  async searchEntities(
    query: string,
    options?: { types?: string[]; limit?: number },
  ): Promise<FTSEntityResult[]> {
    const limit = options?.limit ?? 20;

    if (options?.types?.length) {
      const placeholders = options.types.map(() => "?").join(", ");
      const sql = `
        SELECT e.id, e.name, e.type, -bm25(entities_fts) as score
        FROM entities_fts
        JOIN entities e ON e.rowid = entities_fts.rowid
        WHERE entities_fts MATCH ?
          AND e.type IN (${placeholders})
        ORDER BY score DESC
        LIMIT ?
      `;
      return this.all<FTSEntityResult>(sql, [query, ...options.types, limit]);
    }

    const sql = `
      SELECT e.id, e.name, e.type, -bm25(entities_fts) as score
      FROM entities_fts
      JOIN entities e ON e.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `;
    return this.all<FTSEntityResult>(sql, [query, limit]);
  }
}
