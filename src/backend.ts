export interface FTSResult {
  id: string;
  content: string;
  /** Higher = more relevant */
  score: number;
}

export interface FTSEntityResult {
  id: string;
  name: string;
  type: string;
  score: number;
}

export type Row = Record<string, unknown>;

export interface Backend {
  /** Initialize connection and create schema if needed */
  initialize(): Promise<void>;

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
}
