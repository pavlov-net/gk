import { GraphDB } from "../src/backend";

export async function createTestDb(): Promise<GraphDB> {
  const backend = GraphDB.forSqlite(":memory:");
  await backend.initialize(768);
  return backend;
}
