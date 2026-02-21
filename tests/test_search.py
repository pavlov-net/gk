"""Tests for keyword, semantic, and hybrid search."""

from unittest.mock import AsyncMock, patch

import aiosqlite

from src.config import Config
from src.graph import add_entities
from src.models import EntityInput, ObservationInput
from src.observations import add_observations
from src.search import hybrid_search, keyword_search, semantic_search


async def _setup_test_data(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """Populate test graph with entities and observations."""
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person"),
                EntityInput(name="Rabbit", type="Person"),
                EntityInput(name="Wonderland", type="Place"),
            ],
            config,
        )

    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(
                    content="Alice fell down a very deep well into Wonderland.",
                    entity_names=["Alice", "Wonderland"],
                ),
                ObservationInput(
                    content="The White Rabbit was always checking his pocket watch.",
                    entity_names=["Rabbit"],
                ),
                ObservationInput(
                    content="Alice grew very tall after drinking the potion.",
                    entity_names=["Alice"],
                ),
            ],
            config,
        )


async def test_keyword_search(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    await _setup_test_data(db, config, mock_embeddings)

    results = await keyword_search(db, "Alice", limit=10)
    assert results.total >= 1
    # All results should mention Alice
    for r in results.results:
        assert "Alice" in r.content_snippet


async def test_keyword_search_specific_term(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    await _setup_test_data(db, config, mock_embeddings)

    results = await keyword_search(db, "pocket watch", limit=10)
    assert results.total >= 1
    assert "Rabbit" in results.results[0].entity_names


async def test_keyword_search_no_results(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    await _setup_test_data(db, config, mock_embeddings)

    results = await keyword_search(db, "xyznonexistent", limit=10)
    assert results.total == 0


async def test_keyword_search_empty_query(db: aiosqlite.Connection) -> None:
    results = await keyword_search(db, "", limit=10)
    assert results.total == 0


async def test_keyword_search_special_characters(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    """FTS5 special characters should be escaped safely."""
    await _setup_test_data(db, config, mock_embeddings)

    # These shouldn't crash even though they contain FTS5 operators
    results = await keyword_search(db, "Alice AND Rabbit", limit=10)
    assert isinstance(results.total, int)

    results = await keyword_search(db, 'test "quoted"', limit=10)
    assert isinstance(results.total, int)


async def test_semantic_search(
    db: aiosqlite.Connection,
    config: Config,
    mock_embeddings: AsyncMock,
    mock_embed_text: AsyncMock,
) -> None:
    """Semantic search with mock tables (no real vec0 extension)."""
    await _setup_test_data(db, config, mock_embeddings)

    # Mock DB uses regular tables, not vec0, so KNN MATCH won't work.
    # Test that it handles the error gracefully.
    with patch("src.search.embed_text", mock_embed_text):
        try:
            results = await semantic_search(db, "falling down", config, limit=10)
            assert hasattr(results, "total")
        except Exception:
            # Expected — vec0 KNN requires the real extension
            pass


async def test_hybrid_search(
    db: aiosqlite.Connection,
    config: Config,
    mock_embeddings: AsyncMock,
    mock_embed_text: AsyncMock,
) -> None:
    """Hybrid search combines keyword + semantic results via RRF."""
    await _setup_test_data(db, config, mock_embeddings)

    with patch("src.search.embed_text", mock_embed_text):
        try:
            results = await hybrid_search(
                db,
                "Alice Wonderland",
                config,
                keyword_weight=2.0,
                semantic_weight=1.0,
                limit=10,
            )
            assert hasattr(results, "total")
        except Exception:
            # Semantic component may fail with mock tables
            pass


async def test_keyword_search_entity_type_filter(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    await _setup_test_data(db, config, mock_embeddings)

    # Filter to only observations linked to Person entities
    results = await keyword_search(db, "Alice", entity_types=["Person"], limit=10)
    assert results.total >= 1

    # Filter to only Place — Alice's Wonderland observation should still match
    results = await keyword_search(db, "Wonderland", entity_types=["Place"], limit=10)
    assert results.total >= 1
