import type { Backend } from "./backend";
import type { Config } from "./config";
import { newId } from "./id";
import type {
  EntityInput,
  EntityRow,
  RelationshipInput,
  RelationshipRow,
} from "./types";

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

// --- Relationship CRUD ---

export interface RelationshipResult {
  id: string;
  from_entity: string;
  to_entity: string;
  type: string;
}

async function resolveEntityId(
  backend: Backend,
  name: string,
): Promise<string> {
  const row = await backend.get<{ id: string }>(
    "SELECT id FROM entities WHERE name = ?",
    [name],
  );
  if (!row) throw new Error(`Entity not found: ${name}`);
  return row.id;
}

export async function addRelationships(
  backend: Backend,
  relationships: RelationshipInput[],
): Promise<RelationshipResult[]> {
  const results: RelationshipResult[] = [];
  const ts = new Date().toISOString();

  await backend.transaction(async () => {
    for (const input of relationships) {
      const fromId = await resolveEntityId(backend, input.from_entity);
      const toId = await resolveEntityId(backend, input.to_entity);
      const id = newId();
      const properties = input.properties
        ? JSON.stringify(input.properties)
        : "{}";
      const confidence = input.confidence ?? 0.8;

      await backend.run(
        `INSERT INTO relationships (id, from_entity, to_entity, type, properties, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(from_entity, to_entity, type) DO UPDATE SET
           properties = excluded.properties,
           confidence = excluded.confidence`,
        [id, fromId, toId, input.type, properties, confidence, ts],
      );

      // Get actual ID (may differ if upserted)
      const row = await backend.get<{ id: string }>(
        "SELECT id FROM relationships WHERE from_entity = ? AND to_entity = ? AND type = ?",
        [fromId, toId, input.type],
      );
      results.push({
        id: row!.id,
        from_entity: input.from_entity,
        to_entity: input.to_entity,
        type: input.type,
      });
    }
  });

  return results;
}

export async function getRelationships(
  backend: Backend,
  config: Config,
  options?: {
    entity_name?: string;
    type?: string;
  },
): Promise<Array<RelationshipRow & { from_name: string; to_name: string }>> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.entity_name) {
    conditions.push("(ef.name = ? OR et.name = ?)");
    params.push(options.entity_name, options.entity_name);
  }
  if (options?.type) {
    conditions.push("r.type = ?");
    params.push(options.type);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await backend.all<
    RelationshipRow & { from_name: string; to_name: string }
  >(
    `SELECT r.*, ef.name as from_name, et.name as to_name
     FROM relationships r
     JOIN entities ef ON ef.id = r.from_entity
     JOIN entities et ON et.id = r.to_entity
     ${where}`,
    params,
  );

  // Bump temporal fields on returned relationships
  if (rows.length > 0) {
    const ts = new Date().toISOString();
    for (const row of rows) {
      const newStrength = Math.min(row.strength + 0.1, 10.0);
      const newStability = Math.min(
        row.stability * config.stability_growth,
        config.max_stability,
      );
      await backend.run(
        `UPDATE relationships SET
          strength = ?,
          access_count = access_count + 1,
          stability = ?,
          last_accessed = ?
        WHERE id = ?`,
        [newStrength, newStability, ts, row.id],
      );
    }
  }

  return rows;
}

export async function updateRelationships(
  backend: Backend,
  updates: Array<{
    id: string;
    properties?: Record<string, unknown>;
    type?: string;
  }>,
): Promise<number> {
  let updated = 0;

  await backend.transaction(async () => {
    for (const u of updates) {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (u.properties !== undefined) {
        sets.push("properties = ?");
        params.push(JSON.stringify(u.properties));
      }
      if (u.type !== undefined) {
        sets.push("type = ?");
        params.push(u.type);
      }

      if (sets.length === 0) continue;

      params.push(u.id);
      const result = await backend.run(
        `UPDATE relationships SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
      updated += result.changes;
    }
  });

  return updated;
}

// --- Entity Merging ---

export async function mergeEntities(
  backend: Backend,
  sourceName: string,
  targetName: string,
): Promise<{
  merged: boolean;
  observationsMoved: number;
  relationshipsMoved: number;
}> {
  const source = await backend.get<{ id: string }>(
    "SELECT id FROM entities WHERE name = ?",
    [sourceName],
  );
  const target = await backend.get<{ id: string }>(
    "SELECT id FROM entities WHERE name = ?",
    [targetName],
  );

  if (!source) throw new Error(`Source entity not found: ${sourceName}`);
  if (!target) throw new Error(`Target entity not found: ${targetName}`);

  let observationsMoved = 0;
  let relationshipsMoved = 0;

  await backend.transaction(async () => {
    // Move observations: update junction table, ignore duplicates
    const obsLinks = await backend.all<{ observation_id: string }>(
      "SELECT observation_id FROM observation_entities WHERE entity_id = ?",
      [source.id],
    );
    for (const link of obsLinks) {
      const existing = await backend.get(
        "SELECT 1 FROM observation_entities WHERE observation_id = ? AND entity_id = ?",
        [link.observation_id, target.id],
      );
      if (existing) {
        await backend.run(
          "DELETE FROM observation_entities WHERE observation_id = ? AND entity_id = ?",
          [link.observation_id, source.id],
        );
      } else {
        await backend.run(
          "UPDATE observation_entities SET entity_id = ? WHERE observation_id = ? AND entity_id = ?",
          [target.id, link.observation_id, source.id],
        );
        observationsMoved++;
      }
    }

    // Move outgoing relationships
    const outRels = await backend.all<{
      id: string;
      to_entity: string;
      type: string;
      strength: number;
    }>(
      "SELECT id, to_entity, type, strength FROM relationships WHERE from_entity = ?",
      [source.id],
    );
    for (const rel of outRels) {
      const dup = await backend.get<{ id: string; strength: number }>(
        "SELECT id, strength FROM relationships WHERE from_entity = ? AND to_entity = ? AND type = ?",
        [target.id, rel.to_entity, rel.type],
      );
      if (dup) {
        const maxStrength = Math.max(dup.strength, rel.strength);
        await backend.run(
          "UPDATE relationships SET strength = ? WHERE id = ?",
          [maxStrength, dup.id],
        );
        await backend.run("DELETE FROM relationships WHERE id = ?", [rel.id]);
      } else {
        await backend.run(
          "UPDATE relationships SET from_entity = ? WHERE id = ?",
          [target.id, rel.id],
        );
        relationshipsMoved++;
      }
    }

    // Move incoming relationships
    const inRels = await backend.all<{
      id: string;
      from_entity: string;
      type: string;
      strength: number;
    }>(
      "SELECT id, from_entity, type, strength FROM relationships WHERE to_entity = ?",
      [source.id],
    );
    for (const rel of inRels) {
      const dup = await backend.get<{ id: string; strength: number }>(
        "SELECT id, strength FROM relationships WHERE from_entity = ? AND to_entity = ? AND type = ?",
        [rel.from_entity, target.id, rel.type],
      );
      if (dup) {
        const maxStrength = Math.max(dup.strength, rel.strength);
        await backend.run(
          "UPDATE relationships SET strength = ? WHERE id = ?",
          [maxStrength, dup.id],
        );
        await backend.run("DELETE FROM relationships WHERE id = ?", [rel.id]);
      } else {
        await backend.run(
          "UPDATE relationships SET to_entity = ? WHERE id = ?",
          [target.id, rel.id],
        );
        relationshipsMoved++;
      }
    }

    // Delete source entity
    await backend.run("DELETE FROM entities WHERE id = ?", [source.id]);
  });

  return { merged: true, observationsMoved, relationshipsMoved };
}

// --- Entity Profiles + Queries ---

export interface EntityProfile {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
  confidence: number;
  staleness_tier: string;
  stability: number;
  access_count: number;
  last_accessed: string | null;
  created_at: string;
  updated_at: string;
  relationships: Array<{
    type: string;
    target: string;
    direction: "outgoing" | "incoming";
    strength: number;
  }>;
  observations: Array<{
    id: string;
    content: string;
    created_at: string;
  }>;
}

export async function getEntityProfile(
  backend: Backend,
  name: string,
  config: Config,
  options?: { maxObservationLength?: number },
): Promise<EntityProfile | undefined> {
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

  // Get relationships with strength
  const outgoing = await backend.all<{
    type: string;
    name: string;
    strength: number;
  }>(
    `SELECT r.type, e.name, r.strength FROM relationships r
     JOIN entities e ON e.id = r.to_entity
     WHERE r.from_entity = ?`,
    [entity.id],
  );

  const incoming = await backend.all<{
    type: string;
    name: string;
    strength: number;
  }>(
    `SELECT r.type, e.name, r.strength FROM relationships r
     JOIN entities e ON e.id = r.from_entity
     WHERE r.to_entity = ?`,
    [entity.id],
  );

  const relationships = [
    ...outgoing.map((r) => ({
      type: r.type,
      target: r.name,
      direction: "outgoing" as const,
      strength: r.strength,
    })),
    ...incoming.map((r) => ({
      type: r.type,
      target: r.name,
      direction: "incoming" as const,
      strength: r.strength,
    })),
  ];

  // Get observations (truncated)
  const maxLen = options?.maxObservationLength ?? 200;
  const obs = await backend.all<{
    id: string;
    content: string;
    created_at: string;
  }>(
    `SELECT o.id, o.content, o.created_at FROM observations o
     JOIN observation_entities oe ON oe.observation_id = o.id
     WHERE oe.entity_id = ?
     ORDER BY o.created_at DESC`,
    [entity.id],
  );

  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    properties: JSON.parse(
      typeof entity.properties === "string" ? entity.properties : "{}",
    ),
    confidence: entity.confidence,
    staleness_tier: entity.staleness_tier,
    stability: newStability,
    access_count: entity.access_count + 1,
    last_accessed: new Date().toISOString(),
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    relationships,
    observations: obs.map((o) => ({
      id: o.id,
      content:
        o.content.length > maxLen
          ? `${o.content.slice(0, maxLen)}...`
          : o.content,
      created_at: o.created_at,
    })),
  };
}

export async function listEntityTypes(
  backend: Backend,
): Promise<Array<{ type: string; count: number }>> {
  return backend.all<{ type: string; count: number }>(
    "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC",
  );
}
