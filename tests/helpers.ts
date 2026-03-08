import { SqliteBackend } from "../src/sqlite";

export async function createTestDb(): Promise<SqliteBackend> {
  const backend = new SqliteBackend(":memory:");
  await backend.initialize();
  return backend;
}

export function now(): string {
  return new Date().toISOString();
}
