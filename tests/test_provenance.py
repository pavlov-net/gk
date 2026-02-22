"""Tests for confidence and provenance fields on entities, relationships, observations."""

from unittest.mock import AsyncMock, patch

import aiosqlite

from src.config import Config
from src.graph import add_entities, add_relationships, update_entities, update_relationships
from src.models import (
    EntityInput,
    EntityUpdate,
    ObservationInput,
    RelationshipInput,
    RelationshipUpdate,
)
from src.observations import add_observations


async def test_add_entity_with_provenance_and_confidence(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        result = await add_entities(
            db,
            [EntityInput(name="Alice", type="Person", confidence=0.95, provenance="agent:test")],
            config,
        )
    assert result.added == 1
    cursor = await db.execute("SELECT confidence, provenance FROM entities WHERE name = 'Alice'")
    row = await cursor.fetchone()
    assert row is not None
    assert row["confidence"] == 0.95
    assert row["provenance"] == "agent:test"


async def test_add_entity_without_provenance(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Bob", type="Person")], config)
    cursor = await db.execute("SELECT confidence, provenance FROM entities WHERE name = 'Bob'")
    row = await cursor.fetchone()
    assert row is not None
    assert row["confidence"] is None
    assert row["provenance"] is None


async def test_update_entity_confidence(
    db: aiosqlite.Connection,
    config: Config,
    mock_embeddings: AsyncMock,
    mock_embed_text: AsyncMock,
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person", confidence=0.5)], config)
    with (
        patch("src.graph.embed_texts", mock_embeddings),
        patch("src.graph.embed_text", mock_embed_text),
    ):
        result = await update_entities(
            db, [EntityUpdate(name="Alice", type="Person", new_confidence=0.99)], config
        )
    assert result.updated == 1
    cursor = await db.execute("SELECT confidence FROM entities WHERE name = 'Alice'")
    row = await cursor.fetchone()
    assert row is not None
    assert row["confidence"] == 0.99


async def test_add_relationship_with_provenance(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [EntityInput(name="A", type="Node"), EntityInput(name="B", type="Node")],
            config,
        )
    result = await add_relationships(
        db,
        [
            RelationshipInput(
                source="A", target="B", type="LINKS", confidence=0.7, provenance="agent:test"
            )
        ],
    )
    assert result.added == 1
    cursor = await db.execute("SELECT confidence, provenance FROM relationships LIMIT 1")
    row = await cursor.fetchone()
    assert row is not None
    assert row["confidence"] == 0.7
    assert row["provenance"] == "agent:test"


async def test_update_relationship_provenance(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [EntityInput(name="A", type="Node"), EntityInput(name="B", type="Node")],
            config,
        )
    await add_relationships(db, [RelationshipInput(source="A", target="B", type="LINKS")])
    result = await update_relationships(
        db,
        [
            RelationshipUpdate(
                source="A",
                target="B",
                type="LINKS",
                new_confidence=0.8,
                new_provenance="agent:updated",
            )
        ],
    )
    assert result.updated == 1
    cursor = await db.execute("SELECT confidence, provenance FROM relationships LIMIT 1")
    row = await cursor.fetchone()
    assert row is not None
    assert row["confidence"] == 0.8
    assert row["provenance"] == "agent:updated"


async def test_add_observation_with_provenance(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)
    with patch("src.observations.embed_texts", mock_embeddings):
        result = await add_observations(
            db,
            [
                ObservationInput(
                    content="Test observation.",
                    entity_names=["Alice"],
                    confidence=0.8,
                    provenance="doc:test.pdf",
                )
            ],
            config,
        )
    assert result.added == 1
    cursor = await db.execute("SELECT confidence, provenance FROM observations LIMIT 1")
    row = await cursor.fetchone()
    assert row is not None
    assert row["confidence"] == 0.8
    assert row["provenance"] == "doc:test.pdf"
