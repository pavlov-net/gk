"""Entity and relationship CRUD, plus graph traversal via recursive CTEs."""

import json

import aiosqlite

from src.config import Config
from src.embeddings import embed_text, embed_texts, entity_embedding_text, serialize_embedding
from src.models import (
    SNIPPET_LENGTH,
    AddResult,
    DeleteResult,
    EntityDetail,
    EntityInput,
    EntityUpdate,
    NeighborEntity,
    NeighborResults,
    ObservationSummary,
    PathResult,
    PathResults,
    PathStep,
    RelationshipDetail,
    RelationshipInput,
    RelationshipResults,
    RelationshipUpdate,
    TypeCount,
    TypeCounts,
    UpdateResult,
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
                """INSERT INTO entities (name, type, properties, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(name, type) DO UPDATE SET
                       properties = excluded.properties,
                       updated_at = excluded.updated_at""",
                (entity.name, entity.type, props_json, now, now),
            )
            entity_id = cursor.lastrowid

            # For upsert, lastrowid might not be set on UPDATE — fetch it
            if entity_id is None or entity_id == 0:
                cursor2 = await db.execute(
                    "SELECT id FROM entities WHERE name = ? AND type = ?",
                    (entity.name, entity.type),
                )
                row = await cursor2.fetchone()
                if row is not None:
                    entity_id = row["id"]

            if entity_id is not None:
                blob = serialize_embedding(embedding)
                # Upsert into vec0: delete then insert (vec0 doesn't support ON CONFLICT)
                await db.execute("DELETE FROM entity_embeddings WHERE entity_id = ?", (entity_id,))
                await db.execute(
                    "INSERT INTO entity_embeddings (entity_id, embedding) VALUES (?, ?)",
                    (entity_id, blob),
                )
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
                "SELECT id, name, type, properties FROM entities WHERE name = ? AND type = ?",
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

            now = utcnow()
            await db.execute(
                """UPDATE entities SET name = ?, type = ?, properties = ?, updated_at = ?
                   WHERE id = ?""",
                (new_name, new_type, new_props, now, entity_id),
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
                await db.execute("DELETE FROM entity_embeddings WHERE entity_id = ?", (entity_id,))
                await db.execute(
                    "INSERT INTO entity_embeddings (entity_id, embedding) VALUES (?, ?)",
                    (entity_id, blob),
                )

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

                # Delete orphaned observations and their embeddings
                for obs_id in orphan_obs_ids:
                    await db.execute(
                        "DELETE FROM observation_embeddings WHERE observation_id = ?",
                        (obs_id,),
                    )
                    await db.execute("DELETE FROM observations WHERE id = ?", (obs_id,))

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
) -> AddResult:
    """Batch-add typed edges between entities (by name)."""
    result = AddResult()
    now = utcnow()

    for rel in relationships:
        try:
            # Resolve entity names to IDs
            source_id = await _resolve_entity_id(db, rel.source)
            target_id = await _resolve_entity_id(db, rel.target)

            if source_id is None:
                result.errors.append(f"Source entity '{rel.source}' not found")
                continue
            if target_id is None:
                result.errors.append(f"Target entity '{rel.target}' not found")
                continue

            props_json = json.dumps(rel.properties)
            await db.execute(
                """INSERT INTO relationships (source_id, target_id, type, properties, created_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(source_id, target_id, type) DO UPDATE SET
                       properties = excluded.properties""",
                (source_id, target_id, rel.type, props_json, now),
            )
            result.added += 1
        except Exception as e:
            result.errors.append(f"Relationship '{rel.source}' -> '{rel.target}' ({rel.type}): {e}")

    await db.commit()
    return result


async def update_relationships(
    db: aiosqlite.Connection,
    updates: list[RelationshipUpdate],
) -> UpdateResult:
    """Update relationship type or properties."""
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
                """SELECT id, type, properties FROM relationships
                   WHERE source_id = ? AND target_id = ? AND type = ?""",
                (source_id, target_id, update.type),
            )
            row = await cursor.fetchone()
            if row is None:
                result.errors.append(
                    f"Relationship '{update.source}' -> '{update.target}' ({update.type}) not found"
                )
                continue

            new_type = update.new_type or row["type"]
            new_props = (
                json.dumps(update.new_properties)
                if update.new_properties is not None
                else row["properties"]
            )

            await db.execute(
                "UPDATE relationships SET type = ?, properties = ? WHERE id = ?",
                (new_type, new_props, row["id"]),
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
    relationships = [
        RelationshipDetail(
            source=r["source_name"],
            target=r["target_name"],
            type=r["type"],
            properties=json.loads(r["properties"]),
        )
        for r in rel_rows
    ]

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
        relationships=[
            RelationshipDetail(
                source=r["source_name"],
                target=r["target_name"],
                type=r["type"],
                properties=json.loads(r["properties"]),
            )
            for r in rows
        ]
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

    paths: list[PathResult] = []
    for row in rows:
        path_ids_str: str = row["path_ids"]
        path_rel_str: str = row["path_rel_types"]
        entity_ids = [int(x) for x in path_ids_str.split(",")]
        rel_types: list[str] = path_rel_str.split(",") if path_rel_str else []

        # Fetch entity details for this path
        steps: list[PathStep] = []
        for i, eid in enumerate(entity_ids):
            ecursor = await db.execute("SELECT name, type FROM entities WHERE id = ?", (eid,))
            erow = await ecursor.fetchone()
            if erow is not None:
                steps.append(
                    PathStep(
                        entity_name=erow["name"],
                        entity_type=erow["type"],
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
# Helpers
# ---------------------------------------------------------------------------


async def _resolve_entity_id(db: aiosqlite.Connection, name: str) -> int | None:
    """Look up entity ID by name. Returns first match (any type)."""
    cursor = await db.execute("SELECT id FROM entities WHERE name = ?", (name,))
    row = await cursor.fetchone()
    return row["id"] if row is not None else None
