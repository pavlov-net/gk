import type { Backend } from "./backend";
import type { Config } from "./config";
import { newId } from "./id";
import { computeStabilityGrowth } from "./scoring";
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
  if (entities.length === 0) return [];
  const ts = new Date().toISOString();

  await backend.transaction(async () => {
    for (const input of entities) {
      const id = newId();
      const properties = input.properties
        ? JSON.stringify(input.properties)
        : "{}";
      const confidence = input.confidence ?? 0.8;
      const tier = input.staleness_tier ?? "detail";

      const upsertSql =
        backend.dialect === "mysql"
          ? `INSERT INTO entities (id, name, type, properties, confidence, staleness_tier, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               properties = VALUES(properties),
               confidence = VALUES(confidence),
               staleness_tier = VALUES(staleness_tier),
               updated_at = VALUES(updated_at)`
          : `INSERT INTO entities (id, name, type, properties, confidence, staleness_tier, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(name, type) DO UPDATE SET
               properties = excluded.properties,
               confidence = excluded.confidence,
               staleness_tier = excluded.staleness_tier,
               updated_at = excluded.updated_at`;
      await backend.run(upsertSql, [
        id,
        input.name,
        input.type,
        properties,
        confidence,
        tier,
        ts,
        ts,
      ]);
    }
  });

  // Batch-fetch actual IDs (may differ from generated IDs on upsert)
  const conditions = entities.map(() => "(name = ? AND type = ?)").join(" OR ");
  const params = entities.flatMap((e) => [e.name, e.type]);
  const rows = await backend.all<{ id: string; name: string; type: string }>(
    `SELECT id, name, type FROM entities WHERE ${conditions}`,
    params,
  );
  const idMap = new Map(rows.map((r) => [`${r.name}\0${r.type}`, r.id]));

  // Sync FTS index for inserted/upserted entities
  await backend.syncEntityFts(entities.map((e) => e.name));

  return entities.map((input) => ({
    id: idMap.get(`${input.name}\0${input.type}`)!,
    name: input.name,
    type: input.type,
  }));
}

export async function getEntity(
  backend: Backend,
  name: string,
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
    relationships,
    observations: obs.map((o) => o.content),
  };
}

export async function updateEntities(
  backend: Backend,
  config: Config,
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
      // Fetch current entity for spacing-effect stability growth
      const current = await backend.get<{
        stability: number;
        last_accessed: string | null;
      }>("SELECT stability, last_accessed FROM entities WHERE name = ?", [
        u.name,
      ]);

      const sets: string[] = ["updated_at = ?", "last_accessed = ?"];
      const params: unknown[] = [ts, ts];

      if (current) {
        const newStability = computeStabilityGrowth(
          current.stability,
          current.last_accessed,
          config,
        );
        sets.push("stability = ?");
        params.push(newStability);
      }

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
  options?: { deleteOrphanObservations?: boolean },
): Promise<{ deleted: number; orphanObservationsDeleted: number }> {
  if (names.length === 0) return { deleted: 0, orphanObservationsDeleted: 0 };
  let deleted = 0;
  let orphanObservationsDeleted = 0;

  await backend.transaction(async () => {
    const ph = names.map(() => "?").join(", ");

    // Count before deleting (result.changes includes CASCADE effects in bun:sqlite)
    const countRow = await backend.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM entities WHERE name IN (${ph})`,
      names,
    );
    deleted = countRow?.count ?? 0;

    // Clean up FTS before deleting entities
    await backend.deleteEntityFts(names);

    await backend.run(`DELETE FROM entities WHERE name IN (${ph})`, names);

    if (options?.deleteOrphanObservations) {
      const orphans = await backend.all<{ id: string }>(
        `SELECT id FROM observations WHERE NOT EXISTS (
          SELECT 1 FROM observation_entities oe WHERE oe.observation_id = observations.id
        )`,
      );
      orphanObservationsDeleted = orphans.length;
      if (orphans.length > 0) {
        await backend.deleteObservationFts(orphans.map((o) => o.id));
        const orphanPh = orphans.map(() => "?").join(", ");
        await backend.run(
          `DELETE FROM observations WHERE id IN (${orphanPh})`,
          orphans.map((o) => o.id),
        );
      }
    }
  });

  return { deleted, orphanObservationsDeleted };
}

// --- Relationship CRUD ---

export interface RelationshipResult {
  id: string;
  from_entity: string;
  to_entity: string;
  type: string;
}

export async function resolveEntityIds(
  backend: Backend,
  names: string[],
): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const unique = [...new Set(names)];
  const ph = unique.map(() => "?").join(", ");
  const rows = await backend.all<{ id: string; name: string }>(
    `SELECT id, name FROM entities WHERE name IN (${ph})`,
    unique,
  );
  const map = new Map(rows.map((r) => [r.name, r.id]));
  for (const name of unique) {
    if (!map.has(name)) throw new Error(`Entity not found: ${name}`);
  }
  return map;
}

export async function addRelationships(
  backend: Backend,
  relationships: RelationshipInput[],
): Promise<RelationshipResult[]> {
  if (relationships.length === 0) return [];
  const ts = new Date().toISOString();

  // Batch-resolve all entity names upfront
  const allNames = relationships.flatMap((r) => [r.from_entity, r.to_entity]);
  const nameToId = await resolveEntityIds(backend, allNames);

  await backend.transaction(async () => {
    for (const input of relationships) {
      const fromId = nameToId.get(input.from_entity)!;
      const toId = nameToId.get(input.to_entity)!;
      const id = newId();
      const properties = input.properties
        ? JSON.stringify(input.properties)
        : "{}";
      const confidence = input.confidence ?? 0.8;

      const upsertSql =
        backend.dialect === "mysql"
          ? `INSERT INTO relationships (id, from_entity, to_entity, type, properties, confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               properties = VALUES(properties),
               confidence = VALUES(confidence)`
          : `INSERT INTO relationships (id, from_entity, to_entity, type, properties, confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(from_entity, to_entity, type) DO UPDATE SET
               properties = excluded.properties,
               confidence = excluded.confidence`;
      await backend.run(upsertSql, [
        id,
        fromId,
        toId,
        input.type,
        properties,
        confidence,
        ts,
      ]);
    }
  });

  // Batch-fetch actual IDs (may differ from generated IDs on upsert)
  const conditions = relationships
    .map(() => "(from_entity = ? AND to_entity = ? AND type = ?)")
    .join(" OR ");
  const params = relationships.flatMap((r) => [
    nameToId.get(r.from_entity)!,
    nameToId.get(r.to_entity)!,
    r.type,
  ]);
  const rows = await backend.all<{
    id: string;
    from_entity: string;
    to_entity: string;
    type: string;
  }>(
    `SELECT id, from_entity, to_entity, type FROM relationships WHERE ${conditions}`,
    params,
  );
  const relMap = new Map(
    rows.map((r) => [`${r.from_entity}\0${r.to_entity}\0${r.type}`, r.id]),
  );

  return relationships.map((input) => {
    const key = `${nameToId.get(input.from_entity)}\0${nameToId.get(input.to_entity)}\0${input.type}`;
    return {
      id: relMap.get(key)!,
      from_entity: input.from_entity,
      to_entity: input.to_entity,
      type: input.type,
    };
  });
}

export async function getRelationships(
  backend: Backend,
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

  return rows;
}

export async function updateRelationships(
  backend: Backend,
  config: Config,
  updates: Array<{
    id: string;
    properties?: Record<string, unknown>;
    type?: string;
  }>,
): Promise<number> {
  let updated = 0;
  const ts = new Date().toISOString();

  await backend.transaction(async () => {
    for (const u of updates) {
      // Fetch current for spacing-effect stability growth
      const current = await backend.get<{
        stability: number;
        last_accessed: string | null;
      }>("SELECT stability, last_accessed FROM relationships WHERE id = ?", [
        u.id,
      ]);

      const sets: string[] = ["last_accessed = ?"];
      const params: unknown[] = [ts];

      if (current) {
        const newStability = computeStabilityGrowth(
          current.stability,
          current.last_accessed,
          config,
        );
        sets.push("stability = ?");
        params.push(newStability);
      }

      if (u.properties !== undefined) {
        sets.push("properties = ?");
        params.push(JSON.stringify(u.properties));
      }
      if (u.type !== undefined) {
        sets.push("type = ?");
        params.push(u.type);
      }

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
  sourceNames: string[],
  targetName: string,
  options?: { mergeProperties?: boolean },
): Promise<{
  merged: boolean;
  sourcesMerged: number;
  observationsMoved: number;
  relationshipsMoved: number;
}> {
  const mergeProperties = options?.mergeProperties ?? true;
  const target = await backend.get<{ id: string; properties: string }>(
    "SELECT id, properties FROM entities WHERE name = ?",
    [targetName],
  );
  if (!target) throw new Error(`Target entity not found: ${targetName}`);
  if (sourceNames.length === 0)
    return {
      merged: true,
      sourcesMerged: 0,
      observationsMoved: 0,
      relationshipsMoved: 0,
    };

  // Batch-fetch all source entities upfront
  const sourcePh = sourceNames.map(() => "?").join(", ");
  const sources = await backend.all<{
    id: string;
    name: string;
    properties: string;
  }>(
    `SELECT id, name, properties FROM entities WHERE name IN (${sourcePh})`,
    sourceNames,
  );
  if (sources.length === 0)
    return {
      merged: true,
      sourcesMerged: 0,
      observationsMoved: 0,
      relationshipsMoved: 0,
    };

  let sourcesMerged = 0;
  let observationsMoved = 0;
  let relationshipsMoved = 0;

  await backend.transaction(async () => {
    for (const source of sources) {
      // Merge properties (target wins on conflict)
      if (mergeProperties) {
        const sourceProps = JSON.parse(source.properties || "{}");
        const targetProps = JSON.parse(target.properties || "{}");
        const merged = { ...sourceProps, ...targetProps };
        await backend.run("UPDATE entities SET properties = ? WHERE id = ?", [
          JSON.stringify(merged),
          target.id,
        ]);
        target.properties = JSON.stringify(merged);
      }

      // Count non-duplicate obs links that will be moved
      // (result.changes is unreliable with FTS triggers in bun:sqlite)
      const obsCountRow = await backend.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM observation_entities
         WHERE entity_id = ? AND observation_id NOT IN (
           SELECT observation_id FROM observation_entities WHERE entity_id = ?
         )`,
        [source.id, target.id],
      );

      // Move observations: delete duplicate links, move the rest
      await backend.run(
        `DELETE FROM observation_entities
         WHERE entity_id = ? AND observation_id IN (
           SELECT observation_id FROM observation_entities WHERE entity_id = ?
         )`,
        [source.id, target.id],
      );
      await backend.run(
        "UPDATE observation_entities SET entity_id = ? WHERE entity_id = ?",
        [target.id, source.id],
      );
      observationsMoved += obsCountRow?.count ?? 0;

      // Count non-duplicate outgoing rels that will be moved
      const outCountRow = await backend.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM relationships
         WHERE from_entity = ? AND NOT EXISTS (
           SELECT 1 FROM relationships tr
           WHERE tr.from_entity = ? AND tr.to_entity = relationships.to_entity AND tr.type = relationships.type
         )`,
        [source.id, target.id],
      );

      // Move outgoing relationships: update target strength for duplicates, delete source dups, move rest
      await backend.run(
        `UPDATE relationships SET strength = MAX(strength, (
           SELECT sr.strength FROM relationships sr
           WHERE sr.from_entity = ? AND sr.to_entity = relationships.to_entity AND sr.type = relationships.type
         ))
         WHERE from_entity = ? AND EXISTS (
           SELECT 1 FROM relationships sr
           WHERE sr.from_entity = ? AND sr.to_entity = relationships.to_entity AND sr.type = relationships.type
         )`,
        [source.id, target.id, source.id],
      );
      await backend.run(
        `DELETE FROM relationships WHERE from_entity = ? AND EXISTS (
           SELECT 1 FROM relationships tr
           WHERE tr.from_entity = ? AND tr.to_entity = relationships.to_entity AND tr.type = relationships.type
         )`,
        [source.id, target.id],
      );
      await backend.run(
        "UPDATE relationships SET from_entity = ? WHERE from_entity = ?",
        [target.id, source.id],
      );
      relationshipsMoved += outCountRow?.count ?? 0;

      // Count non-duplicate incoming rels that will be moved
      const inCountRow = await backend.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM relationships
         WHERE to_entity = ? AND NOT EXISTS (
           SELECT 1 FROM relationships tr
           WHERE tr.to_entity = ? AND tr.from_entity = relationships.from_entity AND tr.type = relationships.type
         )`,
        [source.id, target.id],
      );

      // Move incoming relationships: same pattern
      await backend.run(
        `UPDATE relationships SET strength = MAX(strength, (
           SELECT sr.strength FROM relationships sr
           WHERE sr.to_entity = ? AND sr.from_entity = relationships.from_entity AND sr.type = relationships.type
         ))
         WHERE to_entity = ? AND EXISTS (
           SELECT 1 FROM relationships sr
           WHERE sr.to_entity = ? AND sr.from_entity = relationships.from_entity AND sr.type = relationships.type
         )`,
        [source.id, target.id, source.id],
      );
      await backend.run(
        `DELETE FROM relationships WHERE to_entity = ? AND EXISTS (
           SELECT 1 FROM relationships tr
           WHERE tr.to_entity = ? AND tr.from_entity = relationships.from_entity AND tr.type = relationships.type
         )`,
        [source.id, target.id],
      );
      await backend.run(
        "UPDATE relationships SET to_entity = ? WHERE to_entity = ?",
        [target.id, source.id],
      );
      relationshipsMoved += inCountRow?.count ?? 0;

      // Delete source entity (FTS cleanup first)
      await backend.deleteEntityFts([source.name]);
      await backend.run("DELETE FROM entities WHERE id = ?", [source.id]);
      sourcesMerged++;
    }
  });

  return { merged: true, sourcesMerged, observationsMoved, relationshipsMoved };
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
  options?: { maxObservationLength?: number },
): Promise<EntityProfile | undefined> {
  const entity = await backend.get<EntityRow>(
    "SELECT * FROM entities WHERE name = ?",
    [name],
  );
  if (!entity) return undefined;

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
    stability: entity.stability,
    last_accessed: entity.last_accessed,
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

export interface ListEntitiesOptions {
  types?: string[];
  limit?: number;
  offset?: number;
}

export async function listEntities(
  backend: Backend,
  options?: ListEntitiesOptions,
): Promise<
  Array<{
    id: string;
    name: string;
    type: string;
    confidence: number;
    staleness_tier: string;
  }>
> {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.types?.length) {
    conditions.push(`type IN (${options.types.map(() => "?").join(", ")})`);
    params.push(...options.types);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit, offset);

  return backend.all(
    `SELECT id, name, type, confidence, staleness_tier
     FROM entities ${where}
     ORDER BY name ASC
     LIMIT ? OFFSET ?`,
    params,
  );
}

export async function listEntityTypes(
  backend: Backend,
): Promise<Array<{ type: string; count: number }>> {
  return backend.all<{ type: string; count: number }>(
    "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC",
  );
}

// --- Neighbors + Path Finding ---

export async function getNeighbors(
  backend: Backend,
  name: string,
  options?: {
    maxDepth?: number;
    maxResults?: number;
    relationshipTypes?: string[];
  },
): Promise<Map<number, Array<{ name: string; type: string }>>> {
  const maxDepth = options?.maxDepth ?? 2;
  const maxResults = options?.maxResults ?? 50;

  const start = await backend.get<{ id: string }>(
    "SELECT id FROM entities WHERE name = ?",
    [name],
  );
  if (!start) return new Map();

  const visited = new Set<string>([start.id]);
  let frontier = [start.id];
  const result = new Map<number, Array<{ name: string; type: string }>>();

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const ph = frontier.map(() => "?").join(", ");
    const relFilter = options?.relationshipTypes?.length
      ? ` AND r.type IN (${options.relationshipTypes.map(() => "?").join(", ")})`
      : "";
    const relParams = options?.relationshipTypes ?? [];

    // Batch fetch all neighbors for entire frontier
    const neighbors = await backend.all<{
      id: string;
      name: string;
      type: string;
    }>(
      `SELECT e.id, e.name, e.type FROM relationships r
       JOIN entities e ON e.id = r.to_entity
       WHERE r.from_entity IN (${ph})${relFilter}
       UNION
       SELECT e.id, e.name, e.type FROM relationships r
       JOIN entities e ON e.id = r.from_entity
       WHERE r.to_entity IN (${ph})${relFilter}`,
      [...frontier, ...relParams, ...frontier, ...relParams],
    );

    const nextFrontier: string[] = [];
    const depthEntities: Array<{ name: string; type: string }> = [];

    for (const n of neighbors) {
      if (!visited.has(n.id)) {
        visited.add(n.id);
        nextFrontier.push(n.id);
        depthEntities.push({ name: n.name, type: n.type });
        if (visited.size >= maxResults + 1) break;
      }
    }

    if (depthEntities.length > 0) {
      result.set(depth, depthEntities);
    }
    frontier = nextFrontier;
    if (visited.size >= maxResults + 1) break;
  }

  return result;
}

export async function findPaths(
  backend: Backend,
  fromName: string,
  toName: string,
  options?: { maxDepth?: number },
): Promise<string[][]> {
  const maxDepth = options?.maxDepth ?? 5;

  // Batch-resolve both endpoints in one query
  const endpoints = await backend.all<{ id: string; name: string }>(
    "SELECT id, name FROM entities WHERE name IN (?, ?)",
    [fromName, toName],
  );
  const from = endpoints.find((e) => e.name === fromName);
  const to = endpoints.find((e) => e.name === toName);
  if (!from || !to) return [];

  // Level-by-level BFS with batched neighbor queries
  let currentLevel: Array<{ id: string; path: string[] }> = [
    { id: from.id, path: [from.name] },
  ];
  const visited = new Set<string>([from.id]);

  for (let depth = 1; depth <= maxDepth && currentLevel.length > 0; depth++) {
    const frontierIds = currentLevel.map((n) => n.id);
    const ph = frontierIds.map(() => "?").join(", ");

    // Batch fetch all neighbors for entire frontier
    const neighbors = await backend.all<{
      source_id: string;
      id: string;
      name: string;
    }>(
      `SELECT r.from_entity as source_id, e.id, e.name FROM relationships r
       JOIN entities e ON e.id = r.to_entity
       WHERE r.from_entity IN (${ph})
       UNION ALL
       SELECT r.to_entity as source_id, e.id, e.name FROM relationships r
       JOIN entities e ON e.id = r.from_entity
       WHERE r.to_entity IN (${ph})`,
      [...frontierIds, ...frontierIds],
    );

    // Group neighbors by source for path tracking
    const neighborsBySource = new Map<
      string,
      Array<{ id: string; name: string }>
    >();
    for (const n of neighbors) {
      const list = neighborsBySource.get(n.source_id) ?? [];
      list.push({ id: n.id, name: n.name });
      neighborsBySource.set(n.source_id, list);
    }

    const nextLevel: Array<{ id: string; path: string[] }> = [];
    for (const current of currentLevel) {
      const nbrs = neighborsBySource.get(current.id) ?? [];
      for (const n of nbrs) {
        if (n.id === to.id) {
          return [[...current.path, n.name]];
        }
        if (!visited.has(n.id)) {
          visited.add(n.id);
          nextLevel.push({ id: n.id, path: [...current.path, n.name] });
        }
      }
    }

    currentLevel = nextLevel;
  }

  return [];
}

// --- Graph Analysis ---

export async function extractSubgraph(
  backend: Backend,
  seedNames: string[],
  options?: { maxDepth?: number; maxEntities?: number },
): Promise<{ entities: EntityRow[]; relationships: RelationshipRow[] }> {
  const maxDepth = options?.maxDepth ?? 2;
  const maxEntities = options?.maxEntities ?? 100;

  // Batch-resolve seed IDs
  if (seedNames.length === 0) return { entities: [], relationships: [] };
  const seedPh = seedNames.map(() => "?").join(", ");
  const seedRows = await backend.all<{ id: string }>(
    `SELECT id FROM entities WHERE name IN (${seedPh})`,
    seedNames,
  );
  if (seedRows.length === 0) return { entities: [], relationships: [] };
  const seedIds = seedRows.map((r) => r.id);

  // BFS to collect entity IDs — batch per depth level
  const visited = new Set<string>(seedIds);
  let frontier = [...seedIds];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const ph = frontier.map(() => "?").join(", ");
    const neighbors = await backend.all<{ id: string }>(
      `SELECT DISTINCT e.id FROM relationships r
       JOIN entities e ON e.id = r.to_entity
       WHERE r.from_entity IN (${ph})
       UNION
       SELECT DISTINCT e.id FROM relationships r
       JOIN entities e ON e.id = r.from_entity
       WHERE r.to_entity IN (${ph})`,
      [...frontier, ...frontier],
    );

    const nextFrontier: string[] = [];
    for (const n of neighbors) {
      if (!visited.has(n.id) && visited.size < maxEntities) {
        visited.add(n.id);
        nextFrontier.push(n.id);
      }
    }
    frontier = nextFrontier;
  }

  // Fetch full entity rows
  const entityIds = [...visited];
  const placeholders = entityIds.map(() => "?").join(", ");
  const entities = await backend.all<EntityRow>(
    `SELECT * FROM entities WHERE id IN (${placeholders})`,
    entityIds,
  );

  // Fetch relationships between collected entities
  const relationships = await backend.all<RelationshipRow>(
    `SELECT * FROM relationships
     WHERE from_entity IN (${placeholders}) AND to_entity IN (${placeholders})`,
    [...entityIds, ...entityIds],
  );

  return { entities, relationships };
}

export async function getCentrality(
  backend: Backend,
  options?: {
    mode?: "degree" | "pagerank";
    limit?: number;
    entityNames?: string[];
  },
): Promise<Array<{ name: string; type: string; score: number }>> {
  const mode = options?.mode ?? "degree";
  const limit = options?.limit ?? 20;

  if (mode === "degree") {
    const nameFilter = options?.entityNames?.length
      ? ` AND e.name IN (${options.entityNames.map(() => "?").join(", ")})`
      : "";
    const nameParams = options?.entityNames ?? [];
    return backend.all<{ name: string; type: string; score: number }>(
      `SELECT e.name, e.type, COUNT(*) as score
       FROM entities e
       JOIN relationships r ON (e.id = r.from_entity OR e.id = r.to_entity)
       WHERE 1=1${nameFilter}
       GROUP BY e.id, e.name, e.type
       ORDER BY score DESC
       LIMIT ?`,
      [...nameParams, limit],
    );
  }

  // PageRank: iterative computation
  const entities = await backend.all<{
    id: string;
    name: string;
    type: string;
  }>("SELECT id, name, type FROM entities");
  const relationships = await backend.all<{
    from_entity: string;
    to_entity: string;
  }>("SELECT from_entity, to_entity FROM relationships");

  const n = entities.length;
  if (n === 0) return [];

  const damping = 0.85;
  const iterations = 20;
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < entities.length; i++) {
    idToIdx.set(entities[i]!.id, i);
  }

  // Build adjacency: outgoing neighbors
  const outLinks: number[][] = Array.from({ length: n }, () => []);
  for (const r of relationships) {
    const from = idToIdx.get(r.from_entity);
    const to = idToIdx.get(r.to_entity);
    if (from !== undefined && to !== undefined) {
      outLinks[from]!.push(to);
    }
  }

  let scores = new Float64Array(n).fill(1.0 / n);

  for (let iter = 0; iter < iterations; iter++) {
    const newScores = new Float64Array(n).fill((1 - damping) / n);
    for (let i = 0; i < n; i++) {
      const links = outLinks[i]!;
      if (links.length > 0) {
        const share = (damping * scores[i]!) / links.length;
        for (const j of links) {
          newScores[j] = newScores[j]! + share;
        }
      } else {
        // Dangling node: distribute evenly
        const share = (damping * scores[i]!) / n;
        for (let j = 0; j < n; j++) {
          newScores[j] = newScores[j]! + share;
        }
      }
    }
    scores = newScores;
  }

  const nameSet = options?.entityNames?.length
    ? new Set(options.entityNames)
    : null;
  const ranked = entities
    .map((e, i) => ({ name: e.name, type: e.type, score: scores[i]! }))
    .filter((e) => !nameSet || nameSet.has(e.name))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

export async function getTimeline(
  backend: Backend,
  options?: {
    entityName?: string;
    entityNames?: string[];
    entityType?: string;
    entityTypes?: string[];
    limit?: number;
    offset?: number;
  },
): Promise<
  Array<{
    id: string;
    content: string;
    created_at: string;
    entity_names: string[];
  }>
> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Support both singular and plural entity name filters
  const namesList =
    options?.entityNames ?? (options?.entityName ? [options.entityName] : []);
  if (namesList.length > 0) {
    const placeholders = namesList.map(() => "?").join(", ");
    conditions.push(`e.name IN (${placeholders})`);
    params.push(...namesList);
  }

  // Support both singular and plural entity type filters
  const typesList =
    options?.entityTypes ?? (options?.entityType ? [options.entityType] : []);
  if (typesList.length > 0) {
    const placeholders = typesList.map(() => "?").join(", ");
    conditions.push(`e.type IN (${placeholders})`);
    params.push(...typesList);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await backend.all<{
    id: string;
    content: string;
    created_at: string;
    entity_names: string;
  }>(
    `SELECT o.id, o.content, o.created_at, GROUP_CONCAT(DISTINCT e.name) as entity_names
     FROM observations o
     JOIN observation_entities oe ON oe.observation_id = o.id
     JOIN entities e ON e.id = oe.entity_id
     ${where}
     GROUP BY o.id
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    created_at: r.created_at,
    entity_names: r.entity_names ? r.entity_names.split(",") : [],
  }));
}

export async function getStats(backend: Backend): Promise<{
  entity_count: number;
  relationship_count: number;
  observation_count: number;
  types: Record<string, number>;
  relationship_types: Record<string, number>;
  avg_confidence: number;
  avg_relationships_per_entity: number;
  avg_observations_per_entity: number;
  entities_without_observations: number;
  orphan_observations: number;
  tier_distribution: Record<string, number>;
  temporal_health: { durable: number; stable: number; fragile: number };
  embedding_coverage: { total: number; embedded: number };
}> {
  // Single query: all counts, avg confidence, temporal health, and orphan counts
  const [counts] = await backend.all<{
    entity_count: number;
    relationship_count: number;
    observation_count: number;
    avg_confidence: number;
    durable: number;
    stable: number;
    fragile: number;
    entities_without_observations: number;
    orphan_observations: number;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM entities) as entity_count,
      (SELECT COUNT(*) FROM relationships) as relationship_count,
      (SELECT COUNT(*) FROM observations) as observation_count,
      (SELECT AVG(confidence) FROM entities) as avg_confidence,
      (SELECT COUNT(*) FROM entities WHERE stability > 5) as durable,
      (SELECT COUNT(*) FROM entities WHERE stability > 1 AND stability <= 5) as stable,
      (SELECT COUNT(*) FROM entities WHERE stability <= 1) as fragile,
      (SELECT COUNT(*) FROM entities WHERE id NOT IN (SELECT entity_id FROM observation_entities)) as entities_without_observations,
      (SELECT COUNT(*) FROM observations WHERE id NOT IN (SELECT observation_id FROM observation_entities)) as orphan_observations`,
  );

  // Entity type distribution
  const types = await backend.all<{ type: string; count: number }>(
    "SELECT type, COUNT(*) as count FROM entities GROUP BY type",
  );
  const typesMap: Record<string, number> = {};
  for (const t of types) typesMap[t.type] = t.count;

  // Relationship type distribution
  const relTypes = await backend.all<{ type: string; count: number }>(
    "SELECT type, COUNT(*) as count FROM relationships GROUP BY type",
  );
  const relTypesMap: Record<string, number> = {};
  for (const t of relTypes) relTypesMap[t.type] = t.count;

  // Tier distribution
  const tiers = await backend.all<{ staleness_tier: string; count: number }>(
    "SELECT staleness_tier, COUNT(*) as count FROM entities GROUP BY staleness_tier",
  );
  const tierMap: Record<string, number> = {};
  for (const t of tiers) tierMap[t.staleness_tier] = t.count;

  // Average observations per entity
  const avgObsRow = await backend.get<{ avg_obs: number }>(
    `SELECT AVG(cnt) as avg_obs FROM (
      SELECT COUNT(oe.observation_id) as cnt
      FROM entities e
      LEFT JOIN observation_entities oe ON oe.entity_id = e.id
      GROUP BY e.id
    )`,
  );

  // Embedding coverage
  const embeddingCoverage = await backend.getEmbeddingCoverage();

  const entityCount = counts!.entity_count;
  const relCount = counts!.relationship_count;

  return {
    entity_count: entityCount,
    relationship_count: relCount,
    observation_count: counts!.observation_count,
    types: typesMap,
    relationship_types: relTypesMap,
    avg_confidence: counts!.avg_confidence ?? 0,
    avg_relationships_per_entity:
      entityCount > 0 ? (relCount * 2) / entityCount : 0,
    avg_observations_per_entity: avgObsRow?.avg_obs ?? 0,
    entities_without_observations: counts!.entities_without_observations,
    orphan_observations: counts!.orphan_observations,
    tier_distribution: tierMap,
    temporal_health: {
      durable: counts!.durable,
      stable: counts!.stable,
      fragile: counts!.fragile,
    },
    embedding_coverage: embeddingCoverage,
  };
}

export interface ValidationIssue {
  severity: "warning" | "error";
  category: string;
  message: string;
  entity_names: string[];
}

export async function validateGraph(backend: Backend): Promise<{
  issues: ValidationIssue[];
  summary: string;
}> {
  const issues: ValidationIssue[] = [];

  // Islands: entities with no relationships
  const islands = await backend.all<{ name: string }>(
    `SELECT e.name FROM entities e
     WHERE e.id NOT IN (
       SELECT from_entity FROM relationships
       UNION
       SELECT to_entity FROM relationships
     )`,
  );
  for (const e of islands) {
    issues.push({
      severity: "warning",
      category: "island_entity",
      message: `Entity "${e.name}" has no relationships`,
      entity_names: [e.name],
    });
  }

  // Orphan observations: no entity links
  const orphans = await backend.all<{ id: string }>(
    `SELECT o.id FROM observations o
     WHERE o.id NOT IN (SELECT observation_id FROM observation_entities)`,
  );
  for (const o of orphans) {
    issues.push({
      severity: "warning",
      category: "orphan_observation",
      message: `Observation "${o.id}" has no entity links`,
      entity_names: [],
    });
  }

  // Entities with zero observations
  const missing = await backend.all<{ name: string }>(
    `SELECT e.name FROM entities e
     WHERE e.id NOT IN (SELECT entity_id FROM observation_entities)`,
  );
  for (const e of missing) {
    issues.push({
      severity: "warning",
      category: "missing_observations",
      message: `Entity "${e.name}" has no observations`,
      entity_names: [e.name],
    });
  }

  // Duplicate candidates: same name, different types
  const duplicates = await backend.all<{
    name: string;
    type_count: number;
    types: string;
  }>(
    `SELECT name, COUNT(DISTINCT type) as type_count, GROUP_CONCAT(DISTINCT type) as types
     FROM entities GROUP BY name HAVING type_count > 1`,
  );
  for (const d of duplicates) {
    issues.push({
      severity: "warning",
      category: "duplicate_candidate",
      message: `Entity "${d.name}" exists with ${d.type_count} types: ${d.types}`,
      entity_names: [d.name],
    });
  }

  // Build summary
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.category] = (counts[issue.category] ?? 0) + 1;
  }
  const summary =
    issues.length === 0
      ? "No issues found."
      : `Found ${issues.length} issues: ${Object.entries(counts)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ")}`;

  return { issues, summary };
}
