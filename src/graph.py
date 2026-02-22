"""Entity and relationship CRUD, plus graph traversal via recursive CTEs."""

import json

import aiosqlite

from src.config import Config
from src.embeddings import (
    embed_text,
    embed_texts,
    entity_embedding_text,
    relationship_embedding_text,
    serialize_embedding,
)
from src.models import (
    SNIPPET_LENGTH,
    AddResult,
    CentralityResult,
    CentralityResults,
    DeleteResult,
    EntityDetail,
    EntityInput,
    EntityUpdate,
    GraphStats,
    MergeResult,
    NeighborEntity,
    NeighborResults,
    ObservationSummary,
    PathResult,
    PathResults,
    PathStep,
    PyramidStats,
    RelationshipDetail,
    RelationshipInput,
    RelationshipResults,
    RelationshipUpdate,
    Subgraph,
    SubgraphEntity,
    Timeline,
    TimelineEntry,
    TypeCount,
    TypeCounts,
    UpdateResult,
    ValidationIssue,
    ValidationResults,
    utcnow,
)

# ---------------------------------------------------------------------------
# Entity CRUD
# ---------------------------------------------------------------------------


async def add_entities(
    db: aiosqlite.Connection,
    entities: list[EntityInput],
    config: Config,
) -> AddResult:
    """Batch-add entities with auto-embedding. Upserts on name+type."""
    result = AddResult()
    if not entities:
        return result

    # Batch embed all entities
    embed_inputs = [
        entity_embedding_text(entity.name, entity.type, entity.properties) for entity in entities
    ]
    embeddings = await embed_texts(embed_inputs, config)

    now = utcnow()
    for entity, embedding in zip(entities, embeddings, strict=True):
        try:
            props_json = json.dumps(entity.properties)
            cursor = await db.execute(
                """INSERT INTO entities
                   (name, type, properties, confidence, provenance, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(name, type) DO UPDATE SET
                       properties = excluded.properties,
                       confidence = excluded.confidence,
                       provenance = excluded.provenance,
                       updated_at = excluded.updated_at
                   RETURNING id""",
                (
                    entity.name,
                    entity.type,
                    props_json,
                    entity.confidence,
                    entity.provenance,
                    now,
                    now,
                ),
            )
            row = await cursor.fetchone()
            entity_id: int | None = row[0] if row else None

            if entity_id is not None:
                blob = serialize_embedding(embedding)
                await _upsert_embedding(db, "entity_embeddings", "entity_id", entity_id, blob)
                result.added += 1
        except Exception as e:
            result.errors.append(f"Entity '{entity.name}' ({entity.type}): {e}")

    await db.commit()
    return result


async def update_entities(
    db: aiosqlite.Connection,
    updates: list[EntityUpdate],
    config: Config,
) -> UpdateResult:
    """Update entity properties/type/name. Re-embeds if content changes."""
    result = UpdateResult()

    for update in updates:
        try:
            cursor = await db.execute(
                """SELECT id, name, type, properties, confidence, provenance
                   FROM entities WHERE name = ? AND type = ?""",
                (update.name, update.type),
            )
            row = await cursor.fetchone()
            if row is None:
                result.errors.append(f"Entity '{update.name}' ({update.type}) not found")
                continue

            entity_id: int = row["id"]
            new_name = update.new_name or row["name"]
            new_type = update.new_type or row["type"]
            new_props = (
                json.dumps(update.new_properties)
                if update.new_properties is not None
                else row["properties"]
            )
            new_confidence = (
                update.new_confidence if update.new_confidence is not None else row["confidence"]
            )
            new_provenance = (
                update.new_provenance if update.new_provenance is not None else row["provenance"]
            )

            now = utcnow()
            await db.execute(
                """UPDATE entities
                   SET name = ?, type = ?, properties = ?,
                       confidence = ?, provenance = ?, updated_at = ?
                   WHERE id = ?""",
                (new_name, new_type, new_props, new_confidence, new_provenance, now, entity_id),
            )

            # Re-embed if name, type, or properties changed
            if update.new_name or update.new_type or update.new_properties is not None:
                props = (
                    update.new_properties
                    if update.new_properties is not None
                    else json.loads(row["properties"])
                )
                text = entity_embedding_text(new_name, new_type, props)
                embedding = await embed_text(text, config)
                blob = serialize_embedding(embedding)
                await _upsert_embedding(db, "entity_embeddings", "entity_id", entity_id, blob)

            result.updated += 1
        except Exception as e:
            result.errors.append(f"Entity '{update.name}' ({update.type}): {e}")

    await db.commit()
    return result


async def delete_entities(
    db: aiosqlite.Connection,
    names: list[str],
    delete_orphan_observations: bool = False,
) -> DeleteResult:
    """Remove entities by name. Cascades to relationships and observation links.

    If delete_orphan_observations is True, also deletes observations that
    are no longer linked to any entity after the deletion.
    """
    result = DeleteResult()

    for name in names:
        try:
            cursor = await db.execute("SELECT id FROM entities WHERE name = ?", (name,))
            rows = await cursor.fetchall()
            if not rows:
                result.errors.append(f"Entity '{name}' not found")
                continue

            for row in rows:
                entity_id: int = row["id"]

                # Find observations that will become orphaned
                orphan_obs_ids: list[int] = []
                if delete_orphan_observations:
                    cursor2 = await db.execute(
                        """SELECT oe.observation_id FROM observation_entities oe
                           WHERE oe.entity_id = ?
                           AND NOT EXISTS (
                               SELECT 1 FROM observation_entities oe2
                               WHERE oe2.observation_id = oe.observation_id
                               AND oe2.entity_id != ?
                           )""",
                        (entity_id, entity_id),
                    )
                    orphan_obs_ids = [r["observation_id"] for r in await cursor2.fetchall()]

                # Delete entity (cascades to relationships, observation_entities)
                await db.execute("DELETE FROM entities WHERE id = ?", (entity_id,))

                # Clean up entity embedding
                await db.execute("DELETE FROM entity_embeddings WHERE entity_id = ?", (entity_id,))

                # Delete orphaned observations and their embeddings in batch
                if orphan_obs_ids:
                    ph = ", ".join("?" for _ in orphan_obs_ids)
                    await db.execute(
                        f"DELETE FROM observation_embeddings"
                        f" WHERE observation_id IN ({ph})",
                        orphan_obs_ids,
                    )
                    await db.execute(
                        f"DELETE FROM observations WHERE id IN ({ph})",
                        orphan_obs_ids,
                    )

                result.deleted += 1
        except Exception as e:
            result.errors.append(f"Entity '{name}': {e}")

    await db.commit()
    return result


# ---------------------------------------------------------------------------
# Relationship CRUD
# ---------------------------------------------------------------------------


async def add_relationships(
    db: aiosqlite.Connection,
    relationships: list[RelationshipInput],
    config: Config | None = None,
) -> AddResult:
    """Batch-add typed edges between entities (by name). Embeds if config provided."""
    result = AddResult()
    now = utcnow()

    # Batch-resolve all entity names upfront
    all_names: set[str] = set()
    for rel in relationships:
        all_names.add(rel.source)
        all_names.add(rel.target)
    name_to_id: dict[str, int] = {}
    if all_names:
        names_list = list(all_names)
        placeholders = ", ".join("?" for _ in names_list)
        cursor = await db.execute(
            f"SELECT id, name FROM entities WHERE name IN ({placeholders})", names_list
        )
        for row in await cursor.fetchall():
            name_to_id.setdefault(row["name"], row["id"])

    for rel in relationships:
        try:
            # Resolve entity names to IDs from batch lookup
            source_id = name_to_id.get(rel.source)
            target_id = name_to_id.get(rel.target)

            if source_id is None:
                result.errors.append(f"Source entity '{rel.source}' not found")
                continue
            if target_id is None:
                result.errors.append(f"Target entity '{rel.target}' not found")
                continue

            props_json = json.dumps(rel.properties)
            rel_cursor = await db.execute(
                """INSERT INTO relationships
                   (source_id, target_id, type, properties, confidence, provenance, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(source_id, target_id, type) DO UPDATE SET
                       properties = excluded.properties,
                       confidence = excluded.confidence,
                       provenance = excluded.provenance
                   RETURNING id""",
                (source_id, target_id, rel.type, props_json, rel.confidence, rel.provenance, now),
            )
            rel_row = await rel_cursor.fetchone()

            # Embed relationship if config provided
            if config is not None and rel_row is not None:
                rel_text = relationship_embedding_text(
                    rel.source, rel.type, rel.target, rel.properties
                )
                embedding = await embed_text(rel_text, config)
                blob = serialize_embedding(embedding)
                await _upsert_embedding(
                    db, "relationship_embeddings", "relationship_id", rel_row[0], blob
                )

            result.added += 1
        except Exception as e:
            result.errors.append(f"Relationship '{rel.source}' -> '{rel.target}' ({rel.type}): {e}")

    await db.commit()
    return result


async def update_relationships(
    db: aiosqlite.Connection,
    updates: list[RelationshipUpdate],
    config: Config | None = None,
) -> UpdateResult:
    """Update relationship type or properties. Re-embeds if config provided."""
    result = UpdateResult()

    for update in updates:
        try:
            source_id = await _resolve_entity_id(db, update.source)
            target_id = await _resolve_entity_id(db, update.target)

            if source_id is None:
                result.errors.append(f"Source entity '{update.source}' not found")
                continue
            if target_id is None:
                result.errors.append(f"Target entity '{update.target}' not found")
                continue

            cursor = await db.execute(
                """SELECT id, type, properties, confidence, provenance FROM relationships
                   WHERE source_id = ? AND target_id = ? AND type = ?""",
                (source_id, target_id, update.type),
            )
            row = await cursor.fetchone()
            if row is None:
                result.errors.append(
                    f"Relationship '{update.source}' -> '{update.target}' ({update.type}) not found"
                )
                continue

            rel_id: int = row["id"]
            new_type = update.new_type or row["type"]
            new_props = (
                json.dumps(update.new_properties)
                if update.new_properties is not None
                else row["properties"]
            )
            new_confidence = (
                update.new_confidence if update.new_confidence is not None else row["confidence"]
            )
            new_provenance = (
                update.new_provenance if update.new_provenance is not None else row["provenance"]
            )

            await db.execute(
                """UPDATE relationships
                   SET type = ?, properties = ?, confidence = ?, provenance = ?
                   WHERE id = ?""",
                (new_type, new_props, new_confidence, new_provenance, rel_id),
            )

            # Re-embed if type or properties changed
            if config is not None and (update.new_type or update.new_properties is not None):
                props = (
                    update.new_properties
                    if update.new_properties is not None
                    else json.loads(row["properties"])
                )
                rel_text = relationship_embedding_text(
                    update.source, new_type, update.target, props
                )
                embedding = await embed_text(rel_text, config)
                blob = serialize_embedding(embedding)
                await _upsert_embedding(
                    db, "relationship_embeddings", "relationship_id", rel_id, blob
                )

            result.updated += 1
        except Exception as e:
            result.errors.append(
                f"Relationship '{update.source}' -> '{update.target}' ({update.type}): {e}"
            )

    await db.commit()
    return result


# ---------------------------------------------------------------------------
# Entity detail & relationship queries
# ---------------------------------------------------------------------------


async def get_entity(db: aiosqlite.Connection, name: str) -> EntityDetail | None:
    """Full entity profile: properties, relationships, observation summaries."""
    cursor = await db.execute(
        "SELECT id, name, type, properties FROM entities WHERE name = ?", (name,)
    )
    row = await cursor.fetchone()
    if row is None:
        return None

    entity_id: int = row["id"]
    properties: dict[str, str] = json.loads(row["properties"])

    # Fetch relationships (both directions)
    rel_cursor = await db.execute(
        """SELECT r.type, r.properties,
                  src.name AS source_name, tgt.name AS target_name
           FROM relationships r
           JOIN entities src ON r.source_id = src.id
           JOIN entities tgt ON r.target_id = tgt.id
           WHERE r.source_id = ? OR r.target_id = ?""",
        (entity_id, entity_id),
    )
    rel_rows = await rel_cursor.fetchall()
    relationships = [_row_to_relationship(r) for r in rel_rows]

    # Fetch observation summaries
    obs_cursor = await db.execute(
        """SELECT o.id, o.content, o.created_at
           FROM observations o
           JOIN observation_entities oe ON o.id = oe.observation_id
           WHERE oe.entity_id = ?
           ORDER BY o.created_at DESC""",
        (entity_id,),
    )
    obs_rows = await obs_cursor.fetchall()
    observations = [
        ObservationSummary(
            id=o["id"],
            content_snippet=o["content"][:SNIPPET_LENGTH],
            created_at=o["created_at"],
        )
        for o in obs_rows
    ]

    return EntityDetail(
        name=row["name"],
        type=row["type"],
        properties=properties,
        relationships=relationships,
        observations=observations,
    )


async def get_relationships(
    db: aiosqlite.Connection,
    entity_name: str | None = None,
    relationship_type: str | None = None,
    limit: int = 50,
) -> RelationshipResults:
    """Query edges by entity and/or type."""
    conditions: list[str] = []
    params: list[str | int] = []

    if entity_name is not None:
        conditions.append("(src.name = ? OR tgt.name = ?)")
        params.extend([entity_name, entity_name])

    if relationship_type is not None:
        conditions.append("r.type = ?")
        params.append(relationship_type)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    params.append(limit)

    cursor = await db.execute(
        f"""SELECT r.type, r.properties,
                   src.name AS source_name, tgt.name AS target_name
            FROM relationships r
            JOIN entities src ON r.source_id = src.id
            JOIN entities tgt ON r.target_id = tgt.id
            {where}
            LIMIT ?""",
        params,
    )
    rows = await cursor.fetchall()

    return RelationshipResults(
        relationships=[_row_to_relationship(r) for r in rows]
    )


async def list_entity_types(db: aiosqlite.Connection) -> TypeCounts:
    """Return all entity types and their counts."""
    cursor = await db.execute(
        "SELECT type, COUNT(*) AS count FROM entities GROUP BY type ORDER BY count DESC"
    )
    rows = await cursor.fetchall()
    return TypeCounts(types=[TypeCount(type=r["type"], count=r["count"]) for r in rows])


# ---------------------------------------------------------------------------
# Graph traversal via recursive CTEs
# ---------------------------------------------------------------------------


async def find_paths(
    db: aiosqlite.Connection,
    source: str,
    target: str,
    max_depth: int = 5,
) -> PathResults:
    """Find shortest paths between two entities using recursive CTE."""
    cursor = await db.execute(
        """
        WITH RECURSIVE paths(entity_id, path_ids, path_rel_types, depth) AS (
            SELECT id, CAST(id AS TEXT), '', 0
            FROM entities WHERE name = :source
            UNION ALL
            SELECT
                CASE WHEN r.source_id = p.entity_id THEN r.target_id ELSE r.source_id END,
                p.path_ids || ',' || CAST(
                    CASE WHEN r.source_id = p.entity_id THEN r.target_id ELSE r.source_id END
                    AS TEXT),
                CASE WHEN p.path_rel_types = ''
                    THEN r.type ELSE p.path_rel_types || ',' || r.type END,
                p.depth + 1
            FROM paths p
            JOIN relationships r ON (r.source_id = p.entity_id OR r.target_id = p.entity_id)
            WHERE p.depth < :max_depth
              AND INSTR(p.path_ids,
                  CAST(CASE WHEN r.source_id = p.entity_id THEN r.target_id
                       ELSE r.source_id END AS TEXT)) = 0
        )
        SELECT path_ids, path_rel_types, depth
        FROM paths
        WHERE entity_id = (SELECT id FROM entities WHERE name = :target)
        ORDER BY depth
        LIMIT 10
        """,
        {"source": source, "target": target, "max_depth": max_depth},
    )
    rows = await cursor.fetchall()

    # Collect all entity IDs across all paths, batch-resolve in one query
    all_entity_ids: set[int] = set()
    parsed_paths: list[tuple[list[int], list[str]]] = []
    for row in rows:
        path_ids_str: str = row["path_ids"]
        path_rel_str: str = row["path_rel_types"]
        entity_ids = [int(x) for x in path_ids_str.split(",")]
        rel_types: list[str] = path_rel_str.split(",") if path_rel_str else []
        all_entity_ids.update(entity_ids)
        parsed_paths.append((entity_ids, rel_types))

    # One query to fetch all entity details
    id_to_entity: dict[int, tuple[str, str]] = {}
    if all_entity_ids:
        ids_list = list(all_entity_ids)
        placeholders = ", ".join("?" for _ in ids_list)
        ecursor = await db.execute(
            f"SELECT id, name, type FROM entities WHERE id IN ({placeholders})", ids_list
        )
        for erow in await ecursor.fetchall():
            id_to_entity[erow["id"]] = (erow["name"], erow["type"])

    # Build paths from lookup dict
    paths: list[PathResult] = []
    for entity_ids, rel_types in parsed_paths:
        steps: list[PathStep] = []
        for i, eid in enumerate(entity_ids):
            if eid in id_to_entity:
                name, etype = id_to_entity[eid]
                steps.append(
                    PathStep(
                        entity_name=name,
                        entity_type=etype,
                        relationship_type=(
                            rel_types[i - 1] if i > 0 and i - 1 < len(rel_types) else None
                        ),
                    )
                )
        paths.append(PathResult(steps=steps))

    return PathResults(paths=paths)


async def get_neighbors(
    db: aiosqlite.Connection,
    entity_name: str,
    depth: int = 2,
    relationship_types: list[str] | None = None,
) -> NeighborResults:
    """Multi-hop traversal from an entity using recursive CTE."""
    rel_filter = ""
    params: dict[str, str | int] = {"name": entity_name, "max_depth": depth}

    if relationship_types:
        placeholders = ", ".join(f":rt{i}" for i in range(len(relationship_types)))
        rel_filter = f"AND r.type IN ({placeholders})"
        for i, rt in enumerate(relationship_types):
            params[f"rt{i}"] = rt

    cursor = await db.execute(
        f"""
        WITH RECURSIVE neighbors(entity_id, depth, rel_type, direction, visited) AS (
            SELECT id, 0, '', '', CAST(id AS TEXT)
            FROM entities WHERE name = :name
            UNION ALL
            SELECT
                CASE WHEN r.source_id = n.entity_id THEN r.target_id ELSE r.source_id END,
                n.depth + 1,
                r.type,
                CASE WHEN r.source_id = n.entity_id THEN 'outgoing' ELSE 'incoming' END,
                n.visited || ',' || CAST(
                    CASE WHEN r.source_id = n.entity_id THEN r.target_id ELSE r.source_id END
                    AS TEXT)
            FROM neighbors n
            JOIN relationships r ON (r.source_id = n.entity_id OR r.target_id = n.entity_id)
                {rel_filter}
            WHERE n.depth < :max_depth
              AND INSTR(n.visited,
                  CAST(CASE WHEN r.source_id = n.entity_id THEN r.target_id
                       ELSE r.source_id END AS TEXT)) = 0
        )
        SELECT DISTINCT n.entity_id, n.depth, n.rel_type, n.direction,
               e.name, e.type
        FROM neighbors n
        JOIN entities e ON n.entity_id = e.id
        WHERE n.depth > 0
        ORDER BY n.depth, e.name
        """,
        params,
    )
    rows = await cursor.fetchall()

    return NeighborResults(
        neighbors=[
            NeighborEntity(
                name=r["name"],
                type=r["type"],
                depth=r["depth"],
                relationship_type=r["rel_type"],
                relationship_direction=r["direction"],
            )
            for r in rows
        ]
    )


# ---------------------------------------------------------------------------
# Graph intelligence
# ---------------------------------------------------------------------------


async def merge_entities(
    db: aiosqlite.Connection,
    source_names: list[str],
    target_name: str,
    config: Config,
    merge_properties: bool = True,
) -> MergeResult:
    """Merge source entities into target. Reassigns relationships and observations."""
    result = MergeResult()

    # Resolve target entity
    cursor = await db.execute(
        "SELECT id, type, properties FROM entities WHERE name = ?", (target_name,)
    )
    target_row = await cursor.fetchone()
    if target_row is None:
        result.errors.append(f"Target entity '{target_name}' not found")
        return result

    target_id: int = target_row["id"]
    target_props: dict[str, str] = json.loads(target_row["properties"])

    for source_name in source_names:
        if source_name == target_name:
            result.errors.append(f"Cannot merge entity '{source_name}' into itself")
            continue

        cursor = await db.execute(
            "SELECT id, properties FROM entities WHERE name = ?", (source_name,)
        )
        source_row = await cursor.fetchone()
        if source_row is None:
            result.errors.append(f"Source entity '{source_name}' not found")
            continue

        source_id: int = source_row["id"]

        try:
            # Merge properties (target wins on conflict)
            if merge_properties:
                source_props: dict[str, str] = json.loads(source_row["properties"])
                merged_props = {**source_props, **target_props}
                await db.execute(
                    "UPDATE entities SET properties = ? WHERE id = ?",
                    (json.dumps(merged_props), target_id),
                )
                target_props = merged_props

            # Reassign observation links in one batch (IGNORE handles duplicates)
            await db.execute(
                """INSERT OR IGNORE INTO observation_entities (observation_id, entity_id)
                   SELECT observation_id, ? FROM observation_entities WHERE entity_id = ?""",
                (target_id, source_id),
            )
            obs_count_cursor = await db.execute(
                "SELECT COUNT(*) AS cnt FROM observation_entities WHERE entity_id = ?",
                (source_id,),
            )
            obs_count_row = await obs_count_cursor.fetchone()
            result.observations_transferred += obs_count_row["cnt"] if obs_count_row else 0

            # Reassign relationships in batch per side
            for side, other_side in [("source_id", "target_id"), ("target_id", "source_id")]:
                cursor2 = await db.execute(
                    f"""UPDATE relationships SET {side} = ?
                        WHERE {side} = ? AND {other_side} != ?
                        AND NOT EXISTS (
                            SELECT 1 FROM relationships r2
                            WHERE r2.{side} = ? AND r2.{other_side} = relationships.{other_side}
                            AND r2.type = relationships.type
                        )""",
                    (target_id, source_id, target_id, target_id),
                )
                result.relationships_transferred += cursor2.rowcount

            # Delete source entity (cascades remaining relationships)
            await db.execute("DELETE FROM entities WHERE id = ?", (source_id,))
            await db.execute("DELETE FROM entity_embeddings WHERE entity_id = ?", (source_id,))
            result.merged += 1

        except Exception as e:
            result.errors.append(f"Merging '{source_name}': {e}")

    # Re-embed target entity
    if result.merged > 0:
        try:
            cursor = await db.execute(
                "SELECT name, type, properties FROM entities WHERE id = ?", (target_id,)
            )
            row = await cursor.fetchone()
            if row is not None:
                text = entity_embedding_text(
                    row["name"], row["type"], json.loads(row["properties"])
                )
                embedding = await embed_text(text, config)
                blob = serialize_embedding(embedding)
                await _upsert_embedding(db, "entity_embeddings", "entity_id", target_id, blob)
        except Exception as e:
            result.errors.append(f"Re-embedding target: {e}")

    await db.commit()
    return result


async def extract_subgraph(
    db: aiosqlite.Connection,
    seed_entities: list[str] | None = None,
    depth: int = 2,
    max_entities: int = 50,
) -> Subgraph:
    """BFS subgraph extraction from seed entities."""
    # Resolve seeds
    seed_ids: set[int] = set()
    seed_names: list[str] = []

    if seed_entities:
        for name in seed_entities:
            eid = await _resolve_entity_id(db, name)
            if eid is not None:
                seed_ids.add(eid)
                seed_names.append(name)

    if not seed_ids:
        return Subgraph(seed_entities=seed_names)

    # BFS traversal
    visited: dict[int, int] = {}  # entity_id -> depth
    frontier = list(seed_ids)
    for eid in frontier:
        visited[eid] = 0

    current_depth = 0
    while current_depth < depth and len(visited) < max_entities and frontier:
        placeholders = ", ".join("?" for _ in frontier)
        cursor = await db.execute(
            f"""SELECT source_id, target_id FROM relationships
                WHERE source_id IN ({placeholders}) OR target_id IN ({placeholders})""",
            [*frontier, *frontier],
        )
        rel_rows = await cursor.fetchall()

        frontier_set = set(frontier)
        next_frontier: list[int] = []
        for row in rel_rows:
            src: int = row["source_id"]
            tgt: int = row["target_id"]
            for nid in (src, tgt):
                if nid not in visited and nid not in frontier_set and len(visited) < max_entities:
                    visited[nid] = current_depth + 1
                    next_frontier.append(nid)
        frontier = next_frontier
        current_depth += 1

    if not visited:
        return Subgraph(seed_entities=seed_names)

    # Fetch entity details
    ids = list(visited.keys())
    placeholders = ", ".join("?" for _ in ids)
    cursor = await db.execute(
        f"SELECT id, name, type, properties FROM entities WHERE id IN ({placeholders})",
        ids,
    )
    entities = [
        SubgraphEntity(
            name=row["name"],
            type=row["type"],
            properties=json.loads(row["properties"]),
            depth=visited[row["id"]],
        )
        for row in await cursor.fetchall()
    ]

    # Fetch relationships between visited entities
    cursor = await db.execute(
        f"""SELECT r.type, r.properties, src.name AS source_name, tgt.name AS target_name
            FROM relationships r
            JOIN entities src ON r.source_id = src.id
            JOIN entities tgt ON r.target_id = tgt.id
            WHERE r.source_id IN ({placeholders}) AND r.target_id IN ({placeholders})""",
        [*ids, *ids],
    )
    relationships = [_row_to_relationship(r) for r in await cursor.fetchall()]

    return Subgraph(entities=entities, relationships=relationships, seed_entities=seed_names)


async def get_centrality(
    db: aiosqlite.Connection,
    metric: str = "degree",
    entity_names: list[str] | None = None,
    limit: int = 20,
) -> CentralityResults:
    """Compute centrality metrics. Supports 'degree' and 'pagerank'."""
    if metric == "degree":
        return await _degree_centrality(db, entity_names, limit)
    if metric == "pagerank":
        return await _pagerank_centrality(db, entity_names, limit)
    return CentralityResults(metric=metric, results=[])


async def _degree_centrality(
    db: aiosqlite.Connection,
    entity_names: list[str] | None,
    limit: int,
) -> CentralityResults:
    """Degree centrality via SQL COUNT."""
    name_filter = ""
    params: list[str | int] = []
    if entity_names:
        placeholders = ", ".join("?" for _ in entity_names)
        name_filter = f"WHERE e.name IN ({placeholders})"
        params = list(entity_names)
    params.append(limit)

    cursor = await db.execute(
        f"""SELECT e.name, e.type, COUNT(r.id) AS score
            FROM entities e
            LEFT JOIN relationships r ON r.source_id = e.id OR r.target_id = e.id
            {name_filter}
            GROUP BY e.id, e.name, e.type
            ORDER BY score DESC
            LIMIT ?""",
        params,
    )
    rows = await cursor.fetchall()
    return CentralityResults(
        metric="degree",
        results=[
            CentralityResult(name=r["name"], type=r["type"], score=float(r["score"])) for r in rows
        ],
    )


async def _pagerank_centrality(
    db: aiosqlite.Connection,
    entity_names: list[str] | None,
    limit: int,
) -> CentralityResults:
    """PageRank via iterative Python computation."""
    # Load all entities
    cursor = await db.execute("SELECT id, name, type FROM entities")
    entity_rows = await cursor.fetchall()
    if not entity_rows:
        return CentralityResults(metric="pagerank", results=[])

    id_to_info: dict[int, tuple[str, str]] = {}
    for row in entity_rows:
        id_to_info[row["id"]] = (row["name"], row["type"])

    # Load adjacency
    cursor = await db.execute("SELECT source_id, target_id FROM relationships")
    rel_rows = await cursor.fetchall()

    incoming: dict[int, list[int]] = {eid: [] for eid in id_to_info}
    out_degree: dict[int, int] = {eid: 0 for eid in id_to_info}

    for row in rel_rows:
        src: int = row["source_id"]
        tgt: int = row["target_id"]
        if src in id_to_info and tgt in id_to_info:
            incoming[tgt].append(src)
            out_degree[src] += 1
            # Treat as undirected for PageRank
            incoming[src].append(tgt)
            out_degree[tgt] += 1

    n = len(id_to_info)
    d = 0.85
    scores = {eid: 1.0 / n for eid in id_to_info}

    for _ in range(20):
        new_scores: dict[int, float] = {}
        for eid in id_to_info:
            rank = (1 - d) / n
            for neighbor in incoming[eid]:
                if out_degree[neighbor] > 0:
                    rank += d * scores[neighbor] / out_degree[neighbor]
            new_scores[eid] = rank
        scores = new_scores

    # Sort and filter
    sorted_entities = sorted(scores.items(), key=lambda x: x[1], reverse=True)

    if entity_names:
        name_set = set(entity_names)
        sorted_entities = [(eid, s) for eid, s in sorted_entities if id_to_info[eid][0] in name_set]

    results = [
        CentralityResult(name=id_to_info[eid][0], type=id_to_info[eid][1], score=score)
        for eid, score in sorted_entities[:limit]
    ]

    return CentralityResults(metric="pagerank", results=results)


async def get_timeline(
    db: aiosqlite.Connection,
    entity_names: list[str] | None = None,
    entity_types: list[str] | None = None,
    limit: int = 50,
) -> Timeline:
    """Observations in chronological order, optionally filtered by entity."""
    conditions: list[str] = []
    params: list[str | int] = []

    if entity_names:
        placeholders = ", ".join("?" for _ in entity_names)
        conditions.append(f"""o.id IN (
            SELECT oe.observation_id FROM observation_entities oe
            JOIN entities e ON oe.entity_id = e.id
            WHERE e.name IN ({placeholders})
        )""")
        params.extend(entity_names)

    if entity_types:
        placeholders = ", ".join("?" for _ in entity_types)
        conditions.append(f"""o.id IN (
            SELECT oe.observation_id FROM observation_entities oe
            JOIN entities e ON oe.entity_id = e.id
            WHERE e.type IN ({placeholders})
        )""")
        params.extend(entity_types)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    params.append(limit)

    cursor = await db.execute(
        f"""SELECT o.id, o.content, o.created_at
            FROM observations o
            {where}
            ORDER BY o.created_at ASC
            LIMIT ?""",
        params,
    )
    rows = await cursor.fetchall()

    # Batch-fetch entity names for all observations
    obs_ids = [row["id"] for row in rows]
    entity_map: dict[int, list[str]] = {oid: [] for oid in obs_ids}
    if obs_ids:
        placeholders = ", ".join("?" for _ in obs_ids)
        ecursor = await db.execute(
            f"""SELECT oe.observation_id, e.name FROM entities e
                JOIN observation_entities oe ON e.id = oe.entity_id
                WHERE oe.observation_id IN ({placeholders})""",
            obs_ids,
        )
        for erow in await ecursor.fetchall():
            entity_map[erow["observation_id"]].append(erow["name"])

    entries: list[TimelineEntry] = [
        TimelineEntry(
            observation_id=row["id"],
            content_snippet=row["content"][:SNIPPET_LENGTH],
            entity_names=entity_map.get(row["id"], []),
            created_at=row["created_at"],
        )
        for row in rows
    ]

    return Timeline(entries=entries)


async def _scalar(db: aiosqlite.Connection, sql: str) -> int:
    """Execute a query returning a single COUNT(*) AS cnt value."""
    cursor = await db.execute(sql)
    row = await cursor.fetchone()
    return row["cnt"] if row else 0


async def _check_pyramid_staleness(db: aiosqlite.Connection) -> PyramidStats | None:
    """Check pyramid observation level distribution and staleness.

    Returns None if no observations have level metadata.
    """
    # Level distribution
    cursor = await db.execute(
        """SELECT COALESCE(json_extract(metadata, '$.level'), '_unlabeled') AS level,
                  COUNT(*) AS cnt
           FROM observations GROUP BY level"""
    )
    rows = await cursor.fetchall()
    if not rows:
        return None

    counts: dict[str, int] = {r["level"]: r["cnt"] for r in rows}
    detail_count = counts.get("detail", 0)
    summary_count = counts.get("summary", 0)
    overview_count = counts.get("overview", 0)
    unlabeled_count = counts.get("_unlabeled", 0)

    # No pyramid-labeled observations at all → return None
    if detail_count == 0 and summary_count == 0 and overview_count == 0:
        return None

    # Staleness detection
    cursor = await db.execute(
        """SELECT e.name,
                  MAX(CASE WHEN json_extract(o.metadata, '$.level') = 'detail'
                      THEN o.created_at END) AS latest_detail,
                  MAX(CASE WHEN json_extract(o.metadata, '$.level') = 'summary'
                      THEN o.created_at END) AS latest_summary,
                  MAX(CASE WHEN json_extract(o.metadata, '$.level') = 'overview'
                      THEN o.created_at END) AS latest_overview
           FROM entities e
           JOIN observation_entities oe ON oe.entity_id = e.id
           JOIN observations o ON o.id = oe.observation_id
           WHERE json_extract(o.metadata, '$.level') IS NOT NULL
           GROUP BY e.id, e.name
           HAVING latest_detail IS NOT NULL
             AND ((latest_summary IS NOT NULL AND latest_detail > latest_summary)
               OR (latest_overview IS NOT NULL AND latest_detail > latest_overview))"""
    )
    stale_rows = await cursor.fetchall()

    stale_summary: list[str] = []
    stale_overview: list[str] = []
    for row in stale_rows:
        if row["latest_summary"] is not None and row["latest_detail"] > row["latest_summary"]:
            stale_summary.append(row["name"])
        if row["latest_overview"] is not None and row["latest_detail"] > row["latest_overview"]:
            stale_overview.append(row["name"])

    return PyramidStats(
        detail_count=detail_count,
        summary_count=summary_count,
        overview_count=overview_count,
        unlabeled_count=unlabeled_count,
        stale_summary_entities=stale_summary,
        stale_overview_entities=stale_overview,
    )


async def get_stats(db: aiosqlite.Connection) -> GraphStats:
    """Aggregate statistics about the knowledge graph."""
    counts_cursor = await db.execute(
        """SELECT
            (SELECT COUNT(*) FROM entities) AS entity_count,
            (SELECT COUNT(*) FROM relationships) AS relationship_count,
            (SELECT COUNT(*) FROM observations) AS observation_count"""
    )
    counts_row = await counts_cursor.fetchone()
    entity_count: int = counts_row["entity_count"] if counts_row else 0
    relationship_count: int = counts_row["relationship_count"] if counts_row else 0
    observation_count: int = counts_row["observation_count"] if counts_row else 0

    # Entity types
    cursor = await db.execute(
        "SELECT type, COUNT(*) AS cnt FROM entities GROUP BY type ORDER BY cnt DESC"
    )
    entity_types = {r["type"]: r["cnt"] for r in await cursor.fetchall()}

    # Relationship types
    cursor = await db.execute(
        "SELECT type, COUNT(*) AS cnt FROM relationships GROUP BY type ORDER BY cnt DESC"
    )
    relationship_types = {r["type"]: r["cnt"] for r in await cursor.fetchall()}

    # Averages
    avg_rels = relationship_count * 2.0 / entity_count if entity_count > 0 else 0.0
    avg_obs_cursor = await db.execute(
        """SELECT AVG(cnt) AS avg_cnt FROM (
            SELECT COUNT(oe.observation_id) AS cnt FROM entities e
            LEFT JOIN observation_entities oe ON oe.entity_id = e.id
            GROUP BY e.id
        )"""
    )
    avg_obs_row = await avg_obs_cursor.fetchone()
    avg_obs = float(avg_obs_row["avg_cnt"]) if avg_obs_row and avg_obs_row["avg_cnt"] else 0.0

    entities_without_obs = await _scalar(
        db,
        """SELECT COUNT(*) AS cnt FROM entities e
           WHERE NOT EXISTS (
               SELECT 1 FROM observation_entities oe
               WHERE oe.entity_id = e.id)""",
    )
    orphan_obs = await _scalar(
        db,
        """SELECT COUNT(*) AS cnt FROM observations o
           WHERE NOT EXISTS (
               SELECT 1 FROM observation_entities oe
               WHERE oe.observation_id = o.id)""",
    )

    pyramid = await _check_pyramid_staleness(db)

    return GraphStats(
        entity_count=entity_count,
        relationship_count=relationship_count,
        observation_count=observation_count,
        entity_types=entity_types,
        relationship_types=relationship_types,
        avg_relationships_per_entity=round(avg_rels, 2),
        avg_observations_per_entity=round(avg_obs, 2),
        entities_without_observations=entities_without_obs,
        orphan_observations=orphan_obs,
        pyramid=pyramid,
    )


async def validate_graph(db: aiosqlite.Connection) -> ValidationResults:
    """Check graph for quality issues."""
    issues: list[ValidationIssue] = []

    # Island entities (no relationships, no observations)
    cursor = await db.execute(
        """SELECT e.name FROM entities e
           WHERE NOT EXISTS (
               SELECT 1 FROM relationships r
               WHERE r.source_id = e.id OR r.target_id = e.id)
           AND NOT EXISTS (
               SELECT 1 FROM observation_entities oe
               WHERE oe.entity_id = e.id)"""
    )
    island_rows = await cursor.fetchall()
    if island_rows:
        names = [r["name"] for r in island_rows]
        issues.append(
            ValidationIssue(
                severity="warning",
                category="island_entity",
                message=f"{len(names)} island entities (no relationships or observations)",
                entity_names=names,
            )
        )

    # Orphan observations (not linked to any entity)
    cursor = await db.execute(
        """SELECT o.id FROM observations o
           WHERE NOT EXISTS (
               SELECT 1 FROM observation_entities oe
               WHERE oe.observation_id = o.id)"""
    )
    orphan_rows = list(await cursor.fetchall())
    if orphan_rows:
        issues.append(
            ValidationIssue(
                severity="warning",
                category="orphan_observation",
                message=f"{len(orphan_rows)} observations not linked to any entity",
            )
        )

    # Duplicate name candidates (same name, different types)
    cursor = await db.execute(
        """SELECT name, COUNT(DISTINCT type) AS type_count
           FROM entities GROUP BY name HAVING type_count > 1"""
    )
    dup_rows = await cursor.fetchall()
    for row in dup_rows:
        issues.append(
            ValidationIssue(
                severity="warning",
                category="duplicate_candidate",
                message=(
                    f"Entity '{row['name']}' exists with "
                    f"{row['type_count']} different types — merge candidate"
                ),
                entity_names=[row["name"]],
            )
        )

    # Entities without observations (but with relationships — not islands)
    cursor = await db.execute(
        """SELECT e.name FROM entities e
           WHERE NOT EXISTS (
               SELECT 1 FROM observation_entities oe
               WHERE oe.entity_id = e.id)
           AND EXISTS (
               SELECT 1 FROM relationships r
               WHERE r.source_id = e.id OR r.target_id = e.id)"""
    )
    no_obs_rows = await cursor.fetchall()
    if no_obs_rows:
        names = [r["name"] for r in no_obs_rows]
        issues.append(
            ValidationIssue(
                severity="warning",
                category="missing_observations",
                message=f"{len(names)} entities have relationships but no observations",
                entity_names=names,
            )
        )

    # Pyramid staleness
    pyramid = await _check_pyramid_staleness(db)
    if pyramid is not None:
        if pyramid.stale_summary_entities:
            issues.append(
                ValidationIssue(
                    severity="warning",
                    category="stale_summary",
                    message=(
                        f"{len(pyramid.stale_summary_entities)} entities have summary "
                        "observations older than their latest detail"
                    ),
                    entity_names=pyramid.stale_summary_entities,
                )
            )
        if pyramid.stale_overview_entities:
            issues.append(
                ValidationIssue(
                    severity="warning",
                    category="stale_overview",
                    message=(
                        f"{len(pyramid.stale_overview_entities)} entities have overview "
                        "observations older than their latest detail"
                    ),
                    entity_names=pyramid.stale_overview_entities,
                )
            )

    # Build summary
    if not issues:
        summary = "No issues found. Graph looks healthy."
    else:
        counts: dict[str, int] = {}
        for issue in issues:
            counts[issue.category] = counts.get(issue.category, 0) + 1
        parts = [f"{v} {k}" for k, v in counts.items()]
        summary = f"Found {len(issues)} issues: {', '.join(parts)}"

    return ValidationResults(issues=issues, summary=summary)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _row_to_relationship(row: aiosqlite.Row) -> RelationshipDetail:
    """Convert a database row with source_name, target_name, type, properties to model."""
    return RelationshipDetail(
        source=row["source_name"],
        target=row["target_name"],
        type=row["type"],
        properties=json.loads(row["properties"]),
    )


async def _resolve_entity_id(db: aiosqlite.Connection, name: str) -> int | None:
    """Look up entity ID by name. Returns first match (any type)."""
    cursor = await db.execute("SELECT id FROM entities WHERE name = ?", (name,))
    row = await cursor.fetchone()
    return row["id"] if row is not None else None


async def _upsert_embedding(
    db: aiosqlite.Connection,
    table: str,
    id_column: str,
    id_value: int,
    blob: bytes,
) -> None:
    """Delete-then-insert into an embedding table (vec0 lacks ON CONFLICT)."""
    await db.execute(f"DELETE FROM {table} WHERE {id_column} = ?", (id_value,))
    await db.execute(
        f"INSERT INTO {table} ({id_column}, embedding) VALUES (?, ?)",
        (id_value, blob),
    )
