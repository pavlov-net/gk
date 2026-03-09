import mysql from "mysql2/promise";
import type { Backend, FTSEntityResult, FTSResult, Row } from "./backend";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id VARCHAR(16) PRIMARY KEY,
  name VARCHAR(256) NOT NULL,
  type VARCHAR(64) NOT NULL,
  properties JSON,
  confidence FLOAT DEFAULT 0.8,
  staleness_tier VARCHAR(16) DEFAULT 'detail',
  stability FLOAT DEFAULT 1.0,
  access_count INT DEFAULT 0,
  last_accessed DATETIME,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_name_type (name, type),
  FULLTEXT KEY ft_entity_name (name)
);

CREATE TABLE IF NOT EXISTS observations (
  id VARCHAR(16) PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSON,
  confidence FLOAT DEFAULT 0.8,
  source VARCHAR(256),
  stability FLOAT DEFAULT 1.0,
  access_count INT DEFAULT 0,
  last_accessed DATETIME,
  created_at DATETIME NOT NULL,
  FULLTEXT KEY ft_obs_content (content)
);

CREATE TABLE IF NOT EXISTS observation_entities (
  observation_id VARCHAR(16) NOT NULL,
  entity_id VARCHAR(16) NOT NULL,
  PRIMARY KEY (observation_id, entity_id),
  FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relationships (
  id VARCHAR(16) PRIMARY KEY,
  from_entity VARCHAR(16) NOT NULL,
  to_entity VARCHAR(16) NOT NULL,
  type VARCHAR(64) NOT NULL,
  properties JSON,
  strength FLOAT DEFAULT 1.0,
  confidence FLOAT DEFAULT 0.8,
  stability FLOAT DEFAULT 1.0,
  access_count INT DEFAULT 0,
  last_accessed DATETIME,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_rel (from_entity, to_entity, type),
  FOREIGN KEY (from_entity) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (to_entity) REFERENCES entities(id) ON DELETE CASCADE
);

ALTER TABLE relationships ADD INDEX idx_relationships_to (to_entity);
ALTER TABLE observation_entities ADD INDEX idx_obs_entities_entity (entity_id);
ALTER TABLE observations ADD INDEX idx_observations_created (created_at);
ALTER TABLE entities ADD INDEX idx_entities_type (type);
`;

export interface DoltConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export class DoltBackend implements Backend {
  private pool: mysql.Pool;

  constructor(config: DoltConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }

  async initialize(): Promise<void> {
    for (const statement of SCHEMA.split(";").filter((s) => s.trim())) {
      await this.pool.execute(statement);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    const [result] = await this.pool.execute(sql, params);
    const header = result as mysql.ResultSetHeader;
    return { changes: header.affectedRows ?? 0 };
  }

  async get<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined> {
    const [rows] = await this.pool.execute(sql, params);
    const arr = rows as T[];
    return arr[0];
  }

  async all<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const [rows] = await this.pool.execute(sql, params);
    return rows as T[];
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    await conn.beginTransaction();
    // Temporarily replace pool methods to use this connection
    const origPool = this.pool;
    this.pool = conn as unknown as mysql.Pool;
    try {
      const result = await fn();
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      this.pool = origPool;
      conn.release();
    }
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
    const conditions: string[] = [
      "MATCH(o.content) AGAINST(? IN NATURAL LANGUAGE MODE)",
    ];
    const params: unknown[] = [query, query];

    if (options?.entityTypes?.length) {
      const placeholders = options.entityTypes.map(() => "?").join(", ");
      conditions.push(`o.id IN (
        SELECT oe.observation_id FROM observation_entities oe
        JOIN entities e ON e.id = oe.entity_id
        WHERE e.type IN (${placeholders})
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
    const sql = `
      SELECT o.id, o.content, MATCH(o.content) AGAINST(? IN NATURAL LANGUAGE MODE) as score
      FROM observations o
      WHERE ${conditions.join(" AND ")}
      ORDER BY score DESC
      LIMIT ?
    `;
    return this.all<FTSResult>(sql, params);
  }

  async searchEntities(
    query: string,
    options?: { types?: string[]; limit?: number },
  ): Promise<FTSEntityResult[]> {
    const limit = options?.limit ?? 20;

    if (options?.types?.length) {
      const placeholders = options.types.map(() => "?").join(", ");
      const sql = `
        SELECT e.id, e.name, e.type, MATCH(e.name) AGAINST(? IN NATURAL LANGUAGE MODE) as score
        FROM entities e
        WHERE MATCH(e.name) AGAINST(? IN NATURAL LANGUAGE MODE)
          AND e.type IN (${placeholders})
        ORDER BY score DESC
        LIMIT ?
      `;
      return this.all<FTSEntityResult>(sql, [
        query,
        query,
        ...options.types,
        limit,
      ]);
    }

    const sql = `
      SELECT e.id, e.name, e.type, MATCH(e.name) AGAINST(? IN NATURAL LANGUAGE MODE) as score
      FROM entities e
      WHERE MATCH(e.name) AGAINST(? IN NATURAL LANGUAGE MODE)
      ORDER BY score DESC
      LIMIT ?
    `;
    return this.all<FTSEntityResult>(sql, [query, query, limit]);
  }
}
