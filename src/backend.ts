import { Database, type SQLQueryBindings } from "bun:sqlite";
import { SQL } from "bun";
import * as sqliteVec from "sqlite-vec";

// ── Result types ──────────────────────────────────────────────

export interface FTSResult {
  id: string;
  content: string;
  /** Higher = more relevant */
  score: number;
  [key: string]: unknown;
}

export interface FTSEntityResult {
  id: string;
  name: string;
  type: string;
  score: number;
  [key: string]: unknown;
}

export type Row = Record<string, unknown>;

// ── Backend interface ─────────────────────────────────────────

export interface Backend {
  /** Which SQL dialect this backend speaks. */
  readonly dialect: Dialect;

  /** Initialize connection and create schema if needed */
  initialize(embeddingDimensions?: number): Promise<void>;

  /** Close connection gracefully */
  close(): Promise<void>;

  /** Execute a write statement. Returns number of affected rows. */
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;

  /** Query a single row. Returns undefined if not found. */
  get<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined>;

  /** Query multiple rows. */
  all<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute in a transaction. Rolls back on error. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Full-text search over observation content.
   * Returns observations ranked by text relevance (BM25 or MATCH score).
   */
  searchObservations(
    query: string,
    options?: {
      entityTypes?: string[];
      metadataFilters?: Record<string, string>;
      limit?: number;
    },
  ): Promise<FTSResult[]>;

  /**
   * Full-text search over entity names.
   */
  searchEntities(
    query: string,
    options?: {
      types?: string[];
      limit?: number;
    },
  ): Promise<FTSEntityResult[]>;

  /** Store vector embeddings for observations. Overwrites existing embeddings. */
  storeEmbeddings(
    items: Array<{ id: string; vector: Float32Array }>,
  ): Promise<void>;

  /** Search observations by vector similarity. Returns nearest neighbors ordered by distance. */
  searchByVector(
    query: Float32Array,
    limit: number,
  ): Promise<Array<{ id: string; distance: number }>>;

  /** Report how many observations have/lack embeddings. */
  getEmbeddingCoverage(): Promise<{ total: number; embedded: number }>;

  /** Sync FTS index after entity insert/upsert. No-op on MySQL (native FULLTEXT). */
  syncEntityFts(names: string[]): Promise<void>;

  /** Remove FTS entries before entity deletion. No-op on MySQL. */
  deleteEntityFts(names: string[]): Promise<void>;

  /** Sync FTS index after observation insert. No-op on MySQL. */
  syncObservationFts(ids: string[]): Promise<void>;

  /** Remove FTS entries before observation deletion. No-op on MySQL. */
  deleteObservationFts(ids: string[]): Promise<void>;
}

// ── Dialect type ──────────────────────────────────────────────

type Dialect = "sqlite" | "mysql";

// ── Schema (shared structure, dialect-specific DDL) ───────────

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  confidence REAL DEFAULT 0.8,
  staleness_tier TEXT DEFAULT 'detail',
  stability REAL DEFAULT 1.0,

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

  last_accessed TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(from_entity, to_entity, type)
);

CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_entity);
CREATE INDEX IF NOT EXISTS idx_obs_entities_entity ON observation_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

-- FTS5 virtual tables (external content — no data duplication)
-- Synced manually via Backend.syncEntityFts / syncObservationFts methods
-- (triggers avoided because bun:sqlite changes count includes trigger effects)
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  content, content='observations', content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, type, content='entities', content_rowid='rowid'
);
`;

const MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entities (
    id VARCHAR(16) PRIMARY KEY,
    name VARCHAR(256) NOT NULL,
    type VARCHAR(64) NOT NULL,
    properties JSON DEFAULT ('{}'),
    confidence FLOAT DEFAULT 0.8,
    staleness_tier VARCHAR(16) DEFAULT 'detail',
    stability FLOAT DEFAULT 1.0,

    last_accessed TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    UNIQUE KEY uq_name_type (name, type),
    FULLTEXT KEY ft_entity_name (name),
    KEY idx_entities_type (type)
  )`,
  `CREATE TABLE IF NOT EXISTS observations (
    id VARCHAR(16) PRIMARY KEY,
    content TEXT NOT NULL,
    metadata JSON DEFAULT ('{}'),
    confidence FLOAT DEFAULT 0.8,
    source VARCHAR(256),
    stability FLOAT DEFAULT 1.0,

    last_accessed TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL,
    FULLTEXT KEY ft_obs_content (content),
    KEY idx_observations_created (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS observation_entities (
    observation_id VARCHAR(16) NOT NULL,
    entity_id VARCHAR(16) NOT NULL,
    PRIMARY KEY (observation_id, entity_id),
    KEY idx_obs_entities_entity (entity_id),
    FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS relationships (
    id VARCHAR(16) PRIMARY KEY,
    from_entity VARCHAR(16) NOT NULL,
    to_entity VARCHAR(16) NOT NULL,
    type VARCHAR(64) NOT NULL,
    properties JSON DEFAULT ('{}'),
    strength FLOAT DEFAULT 1.0,
    confidence FLOAT DEFAULT 0.8,
    stability FLOAT DEFAULT 1.0,

    last_accessed TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL,
    UNIQUE KEY uq_rel (from_entity, to_entity, type),
    KEY idx_relationships_to (to_entity),
    FOREIGN KEY (from_entity) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (to_entity) REFERENCES entities(id) ON DELETE CASCADE
  )`,
];

// ── Sanitize FTS5 query ───────────────────────────────────────

function sanitizeFts5(query: string): string {
  // Wrap each whitespace-delimited token in double quotes so FTS5
  // treats special characters (apostrophes, hyphens, etc.) as literals.
  // Double quotes inside tokens are escaped by doubling them.
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

/** Build a tagged template call from a SQL string with ? placeholders. */
function sqlQuery(db: SQL, sql: string, params: unknown[] = []) {
  const parts = sql.split("?");
  const strings = Object.assign(parts, { raw: parts });
  return db(strings as TemplateStringsArray, ...params);
}

// ── Unified backend ──────────────────────────────────────────

export interface MysqlConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export class GraphDB implements Backend {
  readonly dialect: Dialect;
  private sqlite?: Database;
  private mysql?: SQL;
  private mysqlConfig?: MysqlConfig;

  private constructor(dialect: Dialect) {
    this.dialect = dialect;
  }

  static forSqlite(path: string): GraphDB {
    const db = new GraphDB("sqlite");
    db.sqlite = new Database(path);
    return db;
  }

  static forMysql(config: MysqlConfig): GraphDB {
    const db = new GraphDB("mysql");
    db.mysqlConfig = config;
    return db;
  }

  /** Connect to MySQL, creating the target database if it doesn't exist. */
  private async connectMysql(): Promise<void> {
    const config = this.mysqlConfig!;
    // Bootstrap: connect to information_schema to create the target database
    const bootstrap = new SQL({
      adapter: "mysql",
      hostname: config.host,
      port: config.port,
      database: "information_schema",
      username: config.user,
      password: config.password,
    });
    try {
      await bootstrap.unsafe(
        `CREATE DATABASE IF NOT EXISTS \`${config.database}\``,
      );
    } finally {
      await bootstrap.end();
    }
    // Now connect to the target database
    this.mysql = new SQL({
      adapter: "mysql",
      hostname: config.host,
      port: config.port,
      database: config.database,
      username: config.user,
      password: config.password,
    });
  }

  async initialize(embeddingDimensions?: number): Promise<void> {
    if (this.sqlite) {
      sqliteVec.load(this.sqlite);
      this.sqlite.run("PRAGMA journal_mode = WAL");
      this.sqlite.run("PRAGMA foreign_keys = ON");
      this.sqlite.run("PRAGMA cache_size = -65536"); // 64MB
      this.sqlite.run("PRAGMA busy_timeout = 5000");
      this.sqlite.exec(SQLITE_SCHEMA);

      if (embeddingDimensions) {
        this.sqlite.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS observation_vectors USING vec0(observation_id TEXT PRIMARY KEY, embedding float[${embeddingDimensions}] distance_metric=cosine)`,
        );
      }

      // Auto-migrate: drop removed access_count column
      this.migrateDropAccessCount();
    } else {
      await this.connectMysql();
      for (const statement of MYSQL_SCHEMA) {
        await this.mysql!.unsafe(statement);
      }
      if (embeddingDimensions) {
        await this.mysql!.unsafe(
          `CREATE TABLE IF NOT EXISTS observation_vectors (
            observation_id VARCHAR(16) PRIMARY KEY,
            embedding VECTOR(${embeddingDimensions}) NOT NULL,
            FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
          )`,
        );
        await this.mysql!.unsafe(
          "CREATE VECTOR INDEX IF NOT EXISTS vec_idx ON observation_vectors(embedding)",
        );
      }
    }
  }

  private migrateDropAccessCount(): void {
    if (!this.sqlite) return;
    const tables = ["entities", "observations", "relationships"];
    for (const table of tables) {
      const cols = this.sqlite
        .query(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "access_count")) {
        this.sqlite.exec(`ALTER TABLE ${table} DROP COLUMN access_count`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.sqlite) {
      this.sqlite.close();
    } else if (this.mysql) {
      await this.mysql.end();
    }
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    if (this.sqlite) {
      const stmt = this.sqlite.query(sql);
      const result = params
        ? stmt.run(...(params as SQLQueryBindings[]))
        : stmt.run();
      return { changes: result.changes };
    }
    const result = await sqlQuery(this.mysql!, sql, params as unknown[]);
    return {
      changes:
        (result as unknown as { affectedRows?: number }).affectedRows ?? 0,
    };
  }

  async get<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined> {
    if (this.sqlite) {
      const stmt = this.sqlite.query(sql);
      const row = params
        ? stmt.get(...(params as SQLQueryBindings[]))
        : stmt.get();
      return (row as T | null) ?? undefined;
    }
    const rows = await sqlQuery(this.mysql!, sql, params as unknown[]);
    return (rows[0] as T) ?? undefined;
  }

  async all<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    if (this.sqlite) {
      const stmt = this.sqlite.query(sql);
      const rows = params
        ? stmt.all(...(params as SQLQueryBindings[]))
        : stmt.all();
      return rows as T[];
    }
    const rows = await sqlQuery(this.mysql!, sql, params as unknown[]);
    return rows as T[];
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.sqlite) {
      this.sqlite.run("BEGIN");
      try {
        const result = await fn();
        this.sqlite.run("COMMIT");
        return result;
      } catch (err) {
        this.sqlite.run("ROLLBACK");
        throw err;
      }
    }
    // Bun.SQL threads the connection properly via sql.begin()
    return this.mysql!.begin(async () => fn());
  }

  async searchObservations(
    query: string,
    options?: {
      entityTypes?: string[];
      metadataFilters?: Record<string, string>;
      limit?: number;
    },
  ): Promise<FTSResult[]> {
    const limit = options?.limit ?? 20;

    if (this.dialect === "sqlite") {
      const safeQuery = sanitizeFts5(query);
      if (!safeQuery) return [];
      const conditions: string[] = ["observations_fts MATCH ?"];
      const params: unknown[] = [safeQuery];

      if (options?.entityTypes?.length) {
        const ph = options.entityTypes.map(() => "?").join(", ");
        conditions.push(`o.id IN (
          SELECT oe.observation_id FROM observation_entities oe
          JOIN entities e ON e.id = oe.entity_id
          WHERE e.type IN (${ph})
        )`);
        params.push(...options.entityTypes);
      }

      if (options?.metadataFilters) {
        for (const [key, value] of Object.entries(options.metadataFilters)) {
          conditions.push(`json_extract(o.metadata, '$.' || ?) = ?`);
          params.push(key, value);
        }
      }

      params.push(limit);
      return this.all<FTSResult>(
        `SELECT o.id, o.content, -bm25(observations_fts) as score
         FROM observations_fts
         JOIN observations o ON o.rowid = observations_fts.rowid
         WHERE ${conditions.join(" AND ")}
         ORDER BY score DESC
         LIMIT ?`,
        params,
      );
    }

    // MySQL / Dolt — FULLTEXT
    const conditions: string[] = [
      "MATCH(o.content) AGAINST(? IN NATURAL LANGUAGE MODE)",
    ];
    const params: unknown[] = [query, query]; // one for SELECT score, one for WHERE

    if (options?.entityTypes?.length) {
      const ph = options.entityTypes.map(() => "?").join(", ");
      conditions.push(`o.id IN (
        SELECT oe.observation_id FROM observation_entities oe
        JOIN entities e ON e.id = oe.entity_id
        WHERE e.type IN (${ph})
      )`);
      params.push(...options.entityTypes);
    }

    if (options?.metadataFilters) {
      for (const [key, value] of Object.entries(options.metadataFilters)) {
        conditions.push(
          `JSON_UNQUOTE(JSON_EXTRACT(o.metadata, CONCAT('$.', ?))) = ?`,
        );
        params.push(key, value);
      }
    }

    params.push(limit);
    return this.all<FTSResult>(
      `SELECT o.id, o.content, MATCH(o.content) AGAINST(? IN NATURAL LANGUAGE MODE) as score
       FROM observations o
       WHERE ${conditions.join(" AND ")}
       ORDER BY score DESC
       LIMIT ?`,
      params,
    );
  }

  async searchEntities(
    query: string,
    options?: { types?: string[]; limit?: number },
  ): Promise<FTSEntityResult[]> {
    const limit = options?.limit ?? 20;

    if (this.dialect === "sqlite") {
      const safeQuery = sanitizeFts5(query);
      if (!safeQuery) return [];
      const typeClause = options?.types?.length
        ? `AND e.type IN (${options.types.map(() => "?").join(", ")})`
        : "";
      return this.all<FTSEntityResult>(
        `SELECT e.id, e.name, e.type, -bm25(entities_fts) as score
         FROM entities_fts
         JOIN entities e ON e.rowid = entities_fts.rowid
         WHERE entities_fts MATCH ?
           ${typeClause}
         ORDER BY score DESC
         LIMIT ?`,
        [safeQuery, ...(options?.types ?? []), limit],
      );
    }

    // MySQL / Dolt — FULLTEXT
    const typeClause = options?.types?.length
      ? `AND e.type IN (${options.types.map(() => "?").join(", ")})`
      : "";
    return this.all<FTSEntityResult>(
      `SELECT e.id, e.name, e.type,
              MATCH(e.name) AGAINST(? IN NATURAL LANGUAGE MODE) as score
       FROM entities e
       WHERE MATCH(e.name) AGAINST(? IN NATURAL LANGUAGE MODE)
         ${typeClause}
       ORDER BY score DESC
       LIMIT ?`,
      [query, query, ...(options?.types ?? []), limit],
    );
  }

  async storeEmbeddings(
    items: Array<{ id: string; vector: Float32Array }>,
  ): Promise<void> {
    if (items.length === 0) return;

    if (this.dialect === "sqlite") {
      const del = this.sqlite!.query(
        "DELETE FROM observation_vectors WHERE observation_id = ?",
      );
      const ins = this.sqlite!.query(
        "INSERT INTO observation_vectors (observation_id, embedding) VALUES (?, ?)",
      );
      this.sqlite!.run("BEGIN");
      try {
        for (const { id, vector } of items) {
          del.run(id);
          ins.run(id, vector);
        }
        this.sqlite!.run("COMMIT");
      } catch (e) {
        this.sqlite!.run("ROLLBACK");
        throw e;
      }
    } else {
      for (const { id, vector } of items) {
        const vecStr = `[${Array.from(vector).join(",")}]`;
        await sqlQuery(
          this.mysql!,
          "INSERT INTO observation_vectors (observation_id, embedding) VALUES (?, VEC_FromText(?)) ON DUPLICATE KEY UPDATE embedding = VEC_FromText(?)",
          [id, vecStr, vecStr],
        );
      }
    }
  }

  async searchByVector(
    query: Float32Array,
    limit: number,
  ): Promise<Array<{ id: string; distance: number }>> {
    if (this.dialect === "sqlite") {
      return this.sqlite!.query(
        `SELECT observation_id AS id, distance
           FROM observation_vectors
           WHERE embedding MATCH ?
           AND k = ?
           ORDER BY distance`,
      ).all(query, limit) as Array<{ id: string; distance: number }>;
    }

    const vecStr = `[${Array.from(query).join(",")}]`;
    return this.all(
      `SELECT observation_id AS id,
              VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS distance
       FROM observation_vectors
       ORDER BY distance
       LIMIT ?`,
      [vecStr, limit],
    );
  }

  async getEmbeddingCoverage(): Promise<{ total: number; embedded: number }> {
    const row = await this.get<{ total: number; embedded: number }>(
      `SELECT COUNT(o.id) as total, COUNT(v.observation_id) as embedded
       FROM observations o
       LEFT JOIN observation_vectors v ON v.observation_id = o.id`,
    );
    return { total: row?.total ?? 0, embedded: row?.embedded ?? 0 };
  }

  async syncEntityFts(names: string[]): Promise<void> {
    if (!this.sqlite || names.length === 0) return;
    const ph = names.map(() => "?").join(", ");
    const rows = this.sqlite
      .query(`SELECT rowid, name, type FROM entities WHERE name IN (${ph})`)
      .all(...(names as SQLQueryBindings[])) as Array<{
      rowid: number;
      name: string;
      type: string;
    }>;

    const del = this.sqlite.query(
      "INSERT INTO entities_fts(entities_fts, rowid, name, type) VALUES('delete', ?, ?, ?)",
    );
    const ins = this.sqlite.query(
      "INSERT INTO entities_fts(rowid, name, type) VALUES(?, ?, ?)",
    );
    for (const row of rows) {
      try {
        del.run(row.rowid, row.name, row.type);
      } catch {}
      ins.run(row.rowid, row.name, row.type);
    }
  }

  async deleteEntityFts(names: string[]): Promise<void> {
    if (!this.sqlite || names.length === 0) return;
    const ph = names.map(() => "?").join(", ");
    const rows = this.sqlite
      .query(`SELECT rowid, name, type FROM entities WHERE name IN (${ph})`)
      .all(...(names as SQLQueryBindings[])) as Array<{
      rowid: number;
      name: string;
      type: string;
    }>;

    const del = this.sqlite.query(
      "INSERT INTO entities_fts(entities_fts, rowid, name, type) VALUES('delete', ?, ?, ?)",
    );
    for (const row of rows) {
      try {
        del.run(row.rowid, row.name, row.type);
      } catch {}
    }
  }

  async syncObservationFts(ids: string[]): Promise<void> {
    if (!this.sqlite || ids.length === 0) return;
    const ph = ids.map(() => "?").join(", ");
    const rows = this.sqlite
      .query(`SELECT rowid, content FROM observations WHERE id IN (${ph})`)
      .all(...(ids as SQLQueryBindings[])) as Array<{
      rowid: number;
      content: string;
    }>;

    const del = this.sqlite.query(
      "INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', ?, ?)",
    );
    const ins = this.sqlite.query(
      "INSERT INTO observations_fts(rowid, content) VALUES(?, ?)",
    );
    for (const row of rows) {
      try {
        del.run(row.rowid, row.content);
      } catch {}
      ins.run(row.rowid, row.content);
    }
  }

  async deleteObservationFts(ids: string[]): Promise<void> {
    if (!this.sqlite || ids.length === 0) return;
    const ph = ids.map(() => "?").join(", ");
    const rows = this.sqlite
      .query(`SELECT rowid, content FROM observations WHERE id IN (${ph})`)
      .all(...(ids as SQLQueryBindings[])) as Array<{
      rowid: number;
      content: string;
    }>;

    const del = this.sqlite.query(
      "INSERT INTO observations_fts(observations_fts, rowid, content) VALUES('delete', ?, ?)",
    );
    for (const row of rows) {
      try {
        del.run(row.rowid, row.content);
      } catch {}
    }
  }
}
