"""Tests for observation CRUD and entity linking."""

from unittest.mock import patch

import aiosqlite

from src.config import Config
from src.graph import add_entities, get_entity
from src.models import EntityInput, ObservationInput
from src.observations import add_observations, read_observation


async def test_add_observations(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [EntityInput(name="Alice", type="Person")],
            config,
        )

    with patch("src.observations.embed_texts", mock_embeddings):
        result = await add_observations(
            db,
            [
                ObservationInput(
                    content="Alice fell down a very deep well.",
                    entity_names=["Alice"],
                    metadata={"chapter": "1"},
                ),
            ],
            config,
        )

    assert result.added == 1
    assert result.errors == []


async def test_add_observation_links_entities(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person"),
                EntityInput(name="Rabbit", type="Person"),
            ],
            config,
        )

    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(
                    content="Alice followed the White Rabbit down the hole.",
                    entity_names=["Alice", "Rabbit"],
                ),
            ],
            config,
        )

    # Check entity has observation
    entity = await get_entity(db, "Alice")
    assert entity is not None
    assert len(entity.observations) == 1
    assert "Alice followed" in entity.observations[0].content_snippet


async def test_add_observation_missing_entity(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.observations.embed_texts", mock_embeddings):
        result = await add_observations(
            db,
            [
                ObservationInput(
                    content="Some text about nobody.",
                    entity_names=["Nonexistent"],
                ),
            ],
            config,
        )

    # Observation still added, but with an error about the missing entity link
    assert result.added == 1
    assert len(result.errors) == 1
    assert "Nonexistent" in result.errors[0]


async def test_read_observation(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [EntityInput(name="Alice", type="Person")],
            config,
        )

    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(
                    content="Alice was beginning to get very tired of sitting by her sister.",
                    entity_names=["Alice"],
                    metadata={"chapter": "1", "paragraph": "1"},
                ),
            ],
            config,
        )

    # Get the observation ID
    cursor = await db.execute("SELECT id FROM observations LIMIT 1")
    row = await cursor.fetchone()
    assert row is not None
    obs_id: int = row["id"]

    obs = await read_observation(db, obs_id)
    assert obs is not None
    assert obs.content == "Alice was beginning to get very tired of sitting by her sister."
    assert obs.metadata == {"chapter": "1", "paragraph": "1"}
    assert "Alice" in obs.entity_names


async def test_read_observation_not_found(db: aiosqlite.Connection) -> None:
    obs = await read_observation(db, 99999)
    assert obs is None


async def test_multiple_observations_per_entity(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [EntityInput(name="Alice", type="Person")],
            config,
        )

    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(content="First passage about Alice.", entity_names=["Alice"]),
                ObservationInput(content="Second passage about Alice.", entity_names=["Alice"]),
                ObservationInput(content="Third passage about Alice.", entity_names=["Alice"]),
            ],
            config,
        )

    entity = await get_entity(db, "Alice")
    assert entity is not None
    assert len(entity.observations) == 3
