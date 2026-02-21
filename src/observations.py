"""Observation CRUD with entity linking and embedding."""

import json

import aiosqlite

from src.config import Config
from src.embeddings import embed_texts, serialize_embedding
from src.models import (
    AddResult,
    ObservationDetail,
    ObservationInput,
    utcnow,
)


async def add_observations(
    db: aiosqlite.Connection,
    observations: list[ObservationInput],
    config: Config,
) -> AddResult:
    """Batch-add observations. Auto-embeds content and links to entities."""
    result = AddResult()
    if not observations:
        return result

    # Batch embed all observation content
    texts = [obs.content for obs in observations]
    embeddings = await embed_texts(texts, config)

    now = utcnow()
    for obs, embedding in zip(observations, embeddings, strict=True):
        try:
            metadata_json = json.dumps(obs.metadata)
            cursor = await db.execute(
                "INSERT INTO observations (content, metadata, created_at) VALUES (?, ?, ?)",
                (obs.content, metadata_json, now),
            )
            obs_id = cursor.lastrowid
            if obs_id is None:
                result.errors.append("Failed to insert observation (no ID returned)")
                continue

            # Insert embedding into vec0
            blob = serialize_embedding(embedding)
            await db.execute(
                "INSERT INTO observation_embeddings (observation_id, embedding) VALUES (?, ?)",
                (obs_id, blob),
            )

            # Link to entities
            for entity_name in obs.entity_names:
                ecursor = await db.execute("SELECT id FROM entities WHERE name = ?", (entity_name,))
                erow = await ecursor.fetchone()
                if erow is not None:
                    await db.execute(
                        """INSERT OR IGNORE INTO observation_entities
                           (observation_id, entity_id) VALUES (?, ?)""",
                        (obs_id, erow["id"]),
                    )
                else:
                    result.errors.append(
                        f"Entity '{entity_name}' not found, skipping link for observation"
                    )

            result.added += 1
        except Exception as e:
            result.errors.append(f"Observation: {e}")

    await db.commit()
    return result


async def read_observation(
    db: aiosqlite.Connection,
    observation_id: int,
) -> ObservationDetail | None:
    """Read full observation by ID, including linked entity names."""
    cursor = await db.execute(
        "SELECT id, content, metadata, created_at FROM observations WHERE id = ?",
        (observation_id,),
    )
    row = await cursor.fetchone()
    if row is None:
        return None

    # Fetch linked entity names
    ecursor = await db.execute(
        """SELECT e.name FROM entities e
           JOIN observation_entities oe ON e.id = oe.entity_id
           WHERE oe.observation_id = ?""",
        (observation_id,),
    )
    entity_rows = await ecursor.fetchall()

    return ObservationDetail(
        id=row["id"],
        content=row["content"],
        metadata=json.loads(row["metadata"]),
        entity_names=[r["name"] for r in entity_rows],
        created_at=row["created_at"],
    )
