"""Observation CRUD with entity linking and embedding."""

import json

import aiosqlite

from src.config import Config
from src.embeddings import embed_texts, serialize_embedding
from src.models import (
    AddResult,
    ChunkResult,
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
                """INSERT INTO observations
                   (content, metadata, confidence, provenance, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (obs.content, metadata_json, obs.confidence, obs.provenance, now),
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


def _split_into_chunks(text: str, chunk_size: int, overlap: int) -> list[str]:
    """Split text at sentence boundaries near chunk_size."""
    if len(text) <= chunk_size:
        return [text]

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        if end >= len(text):
            chunks.append(text[start:])
            break
        # Find sentence boundary near end
        boundary = -1
        for sep in [". ", ".\n", "\n\n", "\n", " "]:
            found = text.rfind(sep, start + chunk_size // 2, end + 1)
            if found != -1:
                boundary = found + len(sep)
                break
        if boundary == -1:
            boundary = end
        chunks.append(text[start:boundary])
        start = max(start + 1, boundary - overlap)
    return chunks


async def add_chunked_observation(
    db: aiosqlite.Connection,
    content: str,
    config: Config,
    entity_names: list[str] | None = None,
    metadata: dict[str, str] | None = None,
    confidence: float | None = None,
    provenance: str | None = None,
    chunk_size: int = 500,
    chunk_overlap: int = 50,
) -> ChunkResult:
    """Split content into chunks at sentence boundaries and add as linked observations."""
    result = ChunkResult()
    entity_names = entity_names or []
    metadata = metadata or {}

    chunks = _split_into_chunks(content, chunk_size, chunk_overlap)
    result.chunk_count = len(chunks)

    # Build observations from chunks
    observations = [
        ObservationInput(
            content=chunk,
            entity_names=entity_names,
            metadata={**metadata, "chunk_index": str(i), "chunk_total": str(len(chunks))},
            confidence=confidence,
            provenance=provenance,
        )
        for i, chunk in enumerate(chunks)
    ]

    # Use add_observations for the actual insertion
    add_result = await add_observations(db, observations, config)

    # Collect IDs of inserted observations
    if add_result.added > 0:
        cursor = await db.execute(
            "SELECT id FROM observations ORDER BY id DESC LIMIT ?",
            (add_result.added,),
        )
        rows = await cursor.fetchall()
        result.observation_ids = sorted(r["id"] for r in rows)

        # Set parent_id metadata on all chunks (first chunk's ID)
        if len(result.observation_ids) > 1:
            parent_id = str(result.observation_ids[0])
            placeholders = ", ".join("?" for _ in result.observation_ids)
            await db.execute(
                f"""UPDATE observations
                    SET metadata = json_set(metadata, '$.parent_id', ?)
                    WHERE id IN ({placeholders})""",
                [parent_id, *result.observation_ids],
            )
            await db.commit()

    result.errors = add_result.errors
    return result
