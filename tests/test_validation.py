"""Tests for graph validation."""

from unittest.mock import AsyncMock, patch

import aiosqlite

from src.config import Config
from src.graph import add_entities, add_relationships, validate_graph
from src.models import EntityInput, ObservationInput, RelationshipInput
from src.observations import add_observations


async def test_validate_healthy_graph(
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
    await add_relationships(db, [RelationshipInput(source="Alice", target="Bob", type="KNOWS")])
    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(content="Alice is kind.", entity_names=["Alice"]),
                ObservationInput(content="Bob is smart.", entity_names=["Bob"]),
            ],
            config,
        )

    results = await validate_graph(db)
    assert results.issues == []
    assert "healthy" in results.summary.lower() or "no issues" in results.summary.lower()


async def test_validate_island_entities(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Lonely", type="Person")], config)

    results = await validate_graph(db)
    island = [i for i in results.issues if i.category == "island_entity"]
    assert len(island) == 1
    assert "Lonely" in island[0].entity_names


async def test_validate_missing_observations(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="A", type="Node"),
                EntityInput(name="B", type="Node"),
            ],
            config,
        )
    await add_relationships(db, [RelationshipInput(source="A", target="B", type="LINKS")])

    results = await validate_graph(db)
    missing = [i for i in results.issues if i.category == "missing_observations"]
    assert len(missing) == 1
    names = set(missing[0].entity_names)
    assert "A" in names
    assert "B" in names


async def test_validate_empty_graph(db: aiosqlite.Connection) -> None:
    results = await validate_graph(db)
    assert results.issues == []


# ---------------------------------------------------------------------------
# Pyramid staleness tests
# ---------------------------------------------------------------------------


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


async def test_validate_stale_summary(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """Detail newer than summary → stale_summary issue."""
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)

    await _add_obs_at(
        db, config, mock_embeddings,
        "Alice summary.", ["Alice"], {"level": "summary"},
        "2025-01-01T00:00:00+00:00",
    )
    await _add_obs_at(
        db, config, mock_embeddings,
        "Alice new detail.", ["Alice"], {"level": "detail"},
        "2025-01-02T00:00:00+00:00",
    )

    results = await validate_graph(db)
    stale = [i for i in results.issues if i.category == "stale_summary"]
    assert len(stale) == 1
    assert "Alice" in stale[0].entity_names


async def test_validate_stale_overview(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """Detail newer than overview → stale_overview issue."""
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Bob", type="Person")], config)

    await _add_obs_at(
        db, config, mock_embeddings,
        "Bob overview.", ["Bob"], {"level": "overview"},
        "2025-01-01T00:00:00+00:00",
    )
    await _add_obs_at(
        db, config, mock_embeddings,
        "Bob new detail.", ["Bob"], {"level": "detail"},
        "2025-01-02T00:00:00+00:00",
    )

    results = await validate_graph(db)
    stale = [i for i in results.issues if i.category == "stale_overview"]
    assert len(stale) == 1
    assert "Bob" in stale[0].entity_names


async def test_validate_fresh_summary(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """Summary newer than detail → no staleness."""
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Carol", type="Person")], config)

    await _add_obs_at(
        db, config, mock_embeddings,
        "Carol detail.", ["Carol"], {"level": "detail"},
        "2025-01-01T00:00:00+00:00",
    )
    await _add_obs_at(
        db, config, mock_embeddings,
        "Carol summary.", ["Carol"], {"level": "summary"},
        "2025-01-02T00:00:00+00:00",
    )

    results = await validate_graph(db)
    stale = [i for i in results.issues if i.category in ("stale_summary", "stale_overview")]
    assert stale == []


async def test_validate_no_pyramid_no_staleness(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """Observations without level metadata → no staleness issues."""
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Dave", type="Person")], config)

    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(content="Dave fact 1.", entity_names=["Dave"]),
                ObservationInput(content="Dave fact 2.", entity_names=["Dave"]),
            ],
            config,
        )

    results = await validate_graph(db)
    stale = [i for i in results.issues if i.category in ("stale_summary", "stale_overview")]
    assert stale == []


async def test_validate_detail_only_no_staleness(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """Only detail observations, no summaries → no staleness (missing ≠ stale)."""
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Eve", type="Person")], config)

    await _add_obs_at(
        db, config, mock_embeddings,
        "Eve detail 1.", ["Eve"], {"level": "detail"},
        "2025-01-01T00:00:00+00:00",
    )
    await _add_obs_at(
        db, config, mock_embeddings,
        "Eve detail 2.", ["Eve"], {"level": "detail"},
        "2025-01-02T00:00:00+00:00",
    )

    results = await validate_graph(db)
    stale = [i for i in results.issues if i.category in ("stale_summary", "stale_overview")]
    assert stale == []
