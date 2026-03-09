import type { Backend } from "./backend";
import type { Config } from "./config";
import { newId } from "./id";
import type { EntityInput, EntityRow } from "./types";

export interface EntityResult {
  id: string;
  name: string;
  type: string;
}

export async function addEntities(
  backend: Backend,
  entities: EntityInput[],
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  const ts = new Date().toISOString();

  await backend.transaction(async () => {
    for (const input of entities) {
      const id = newId();
      const properties = input.properties
        ? JSON.stringify(input.properties)
        : "{}";
      const confidence = input.confidence ?? 0.8;
      const tier = input.staleness_tier ?? "detail";

      await backend.run(
        `INSERT INTO entities (id, name, type, properties, confidence, staleness_tier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name, type) DO UPDATE SET
           properties = excluded.properties,
           confidence = excluded.confidence,
           staleness_tier = excluded.staleness_tier,
           updated_at = excluded.updated_at`,
        [id, input.name, input.type, properties, confidence, tier, ts, ts],
      );

      // Get the actual ID (may differ if upserted)
      const row = await backend.get<{ id: string }>(
        "SELECT id FROM entities WHERE name = ? AND type = ?",
        [input.name, input.type],
      );
      results.push({ id: row!.id, name: input.name, type: input.type });
    }
  });

  return results;
}

export async function getEntity(
  backend: Backend,
  name: string,
  config: Config,
): Promise<
  | (EntityRow & {
      relationships: Array<{
        type: string;
        target: string;
        direction: "outgoing" | "incoming";
      }>;
      observations: string[];
    })
  | undefined
> {
  const entity = await backend.get<EntityRow>(
    "SELECT * FROM entities WHERE name = ?",
    [name],
  );
  if (!entity) return undefined;

  // Bump temporal fields
  const newStability = Math.min(
    entity.stability * config.stability_growth,
    config.max_stability,
  );
  await backend.run(
    `UPDATE entities SET
      access_count = access_count + 1,
      stability = ?,
      last_accessed = ?
    WHERE id = ?`,
    [newStability, new Date().toISOString(), entity.id],
  );

  // Get relationships
  const outgoing = await backend.all<{
    type: string;
    name: string;
  }>(
    `SELECT r.type, e.name FROM relationships r
     JOIN entities e ON e.id = r.to_entity
     WHERE r.from_entity = ?`,
    [entity.id],
  );

  const incoming = await backend.all<{
    type: string;
    name: string;
  }>(
    `SELECT r.type, e.name FROM relationships r
     JOIN entities e ON e.id = r.from_entity
     WHERE r.to_entity = ?`,
    [entity.id],
  );

  const relationships = [
    ...outgoing.map((r) => ({
      type: r.type,
      target: r.name,
      direction: "outgoing" as const,
    })),
    ...incoming.map((r) => ({
      type: r.type,
      target: r.name,
      direction: "incoming" as const,
    })),
  ];

  // Get observation summaries
  const obs = await backend.all<{ content: string }>(
    `SELECT o.content FROM observations o
     JOIN observation_entities oe ON oe.observation_id = o.id
     WHERE oe.entity_id = ?
     ORDER BY o.created_at DESC`,
    [entity.id],
  );

  return {
    ...entity,
    stability: newStability,
    access_count: entity.access_count + 1,
    last_accessed: new Date().toISOString(),
    relationships,
    observations: obs.map((o) => o.content),
  };
}

export async function updateEntities(
  backend: Backend,
  updates: Array<{
    name: string;
    type?: string;
    properties?: Record<string, unknown>;
    confidence?: number;
    staleness_tier?: string;
  }>,
): Promise<number> {
  let updated = 0;
  const ts = new Date().toISOString();

  await backend.transaction(async () => {
    for (const u of updates) {
      const sets: string[] = ["updated_at = ?"];
      const params: unknown[] = [ts];

      if (u.properties !== undefined) {
        sets.push("properties = ?");
        params.push(JSON.stringify(u.properties));
      }
      if (u.confidence !== undefined) {
        sets.push("confidence = ?");
        params.push(u.confidence);
      }
      if (u.staleness_tier !== undefined) {
        sets.push("staleness_tier = ?");
        params.push(u.staleness_tier);
      }

      params.push(u.name);
      const typeClause = u.type ? " AND type = ?" : "";
      if (u.type) params.push(u.type);

      const result = await backend.run(
        `UPDATE entities SET ${sets.join(", ")} WHERE name = ?${typeClause}`,
        params,
      );
      updated += result.changes;
    }
  });

  return updated;
}

export async function deleteEntities(
  backend: Backend,
  names: string[],
): Promise<number> {
  let deleted = 0;

  await backend.transaction(async () => {
    for (const name of names) {
      const result = await backend.run("DELETE FROM entities WHERE name = ?", [
        name,
      ]);
      deleted += result.changes;
    }
  });

  return deleted;
}
