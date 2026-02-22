"""Tests for timeline (chronological observation ordering)."""

from unittest.mock import AsyncMock, patch

import aiosqlite

from src.config import Config
from src.graph import add_entities, get_timeline
from src.models import EntityInput, ObservationInput
from src.observations import add_observations


async def test_get_timeline(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)
    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(content="First event.", entity_names=["Alice"]),
                ObservationInput(content="Second event.", entity_names=["Alice"]),
            ],
            config,
        )

    timeline = await get_timeline(db, entity_names=["Alice"], limit=10)
    assert len(timeline.entries) == 2
    # Should be chronological (oldest first)
    assert timeline.entries[0].content_snippet == "First event."
    assert timeline.entries[1].content_snippet == "Second event."
    assert "Alice" in timeline.entries[0].entity_names


async def test_timeline_filter_by_entity(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person"),
                EntityInput(name="Bob", type="Person"),
            ],
            config,
        )
    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(content="Alice did something.", entity_names=["Alice"]),
                ObservationInput(content="Bob did something.", entity_names=["Bob"]),
            ],
            config,
        )

    timeline = await get_timeline(db, entity_names=["Alice"], limit=10)
    assert len(timeline.entries) == 1
    assert "Alice" in timeline.entries[0].content_snippet


async def test_timeline_no_filter(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)
    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [ObservationInput(content="An event.", entity_names=["Alice"])],
            config,
        )

    timeline = await get_timeline(db, limit=10)
    assert len(timeline.entries) == 1
