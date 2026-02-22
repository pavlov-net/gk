"""Tests for graph statistics."""

from unittest.mock import AsyncMock, patch

import aiosqlite

from src.config import Config
from src.graph import add_entities, add_relationships, get_stats
from src.models import EntityInput, ObservationInput, RelationshipInput
from src.observations import add_observations


async def _add_obs_at(
    db: aiosqlite.Connection,
    config: Config,
    mock_embeddings: AsyncMock,
    content: str,
    entity_names: list[str],
    metadata: dict[str, str],
    timestamp: str,
) -> None:
    """Add an observation with a controlled timestamp."""
    with (
        patch("src.observations.embed_texts", mock_embeddings),
        patch("src.observations.utcnow", return_value=timestamp),
    ):
        await add_observations(
            db,
            [ObservationInput(content=content, entity_names=entity_names, metadata=metadata)],
            config,
        )


async def test_stats_empty_graph(db: aiosqlite.Connection) -> None:
    stats = await get_stats(db)
    assert stats.entity_count == 0
    assert stats.relationship_count == 0
    assert stats.observation_count == 0
    assert stats.entity_types == {}
    assert stats.relationship_types == {}
    assert stats.avg_relationships_per_entity == 0.0
    assert stats.avg_observations_per_entity == 0.0
    assert stats.entities_without_observations == 0
    assert stats.orphan_observations == 0


async def test_stats_populated_graph(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person"),
                EntityInput(name="Bob", type="Person"),
                EntityInput(name="Acme", type="Company"),
            ],
            config,
        )
    await add_relationships(
        db,
        [
            RelationshipInput(source="Alice", target="Bob", type="KNOWS"),
            RelationshipInput(source="Alice", target="Acme", type="WORKS_AT"),
        ],
    )
    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(content="Alice is a developer.", entity_names=["Alice"]),
                ObservationInput(content="Bob is a designer.", entity_names=["Bob"]),
            ],
            config,
        )

    stats = await get_stats(db)
    assert stats.entity_count == 3
    assert stats.relationship_count == 2
    assert stats.observation_count == 2
    assert stats.entity_types == {"Person": 2, "Company": 1}
    assert stats.relationship_types == {"KNOWS": 1, "WORKS_AT": 1}
    # avg_relationships_per_entity = 2*2 / 3 = 1.333...
    assert abs(stats.avg_relationships_per_entity - 4.0 / 3.0) < 0.01
    # Acme has no observations
    assert stats.entities_without_observations == 1
    assert stats.orphan_observations == 0


# ---------------------------------------------------------------------------
# Pyramid stats tests
# ---------------------------------------------------------------------------


async def test_stats_pyramid_present(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """Level-tagged observations → pyramid field populated."""
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)

    await _add_obs_at(
        db, config, mock_embeddings,
        "Alice detail.", ["Alice"], {"level": "detail"},
        "2025-01-01T00:00:00+00:00",
    )
    await _add_obs_at(
        db, config, mock_embeddings,
        "Alice summary.", ["Alice"], {"level": "summary"},
        "2025-01-02T00:00:00+00:00",
    )

    stats = await get_stats(db)
    assert stats.pyramid is not None
    assert stats.pyramid.detail_count == 1
    assert stats.pyramid.summary_count == 1
    assert stats.pyramid.overview_count == 0


async def test_stats_pyramid_absent(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """No level tags → pyramid is None."""
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Bob", type="Person")], config)

    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [ObservationInput(content="Bob is smart.", entity_names=["Bob"])],
            config,
        )

    stats = await get_stats(db)
    assert stats.pyramid is None


async def test_stats_pyramid_stale_entities(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """Stale scenario → entity listed in stale_summary_entities."""
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Carol", type="Person")], config)

    await _add_obs_at(
        db, config, mock_embeddings,
        "Carol summary.", ["Carol"], {"level": "summary"},
        "2025-01-01T00:00:00+00:00",
    )
    await _add_obs_at(
        db, config, mock_embeddings,
        "Carol new detail.", ["Carol"], {"level": "detail"},
        "2025-01-02T00:00:00+00:00",
    )

    stats = await get_stats(db)
    assert stats.pyramid is not None
    assert "Carol" in stats.pyramid.stale_summary_entities
