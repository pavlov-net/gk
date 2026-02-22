"""Tests for centrality metrics."""

from unittest.mock import AsyncMock, patch

import aiosqlite

from src.config import Config
from src.graph import add_entities, add_relationships, get_centrality
from src.models import EntityInput, RelationshipInput


async def test_degree_centrality(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Hub", type="Node"),
                EntityInput(name="Spoke1", type="Node"),
                EntityInput(name="Spoke2", type="Node"),
                EntityInput(name="Spoke3", type="Node"),
            ],
            config,
        )
    await add_relationships(
        db,
        [
            RelationshipInput(source="Hub", target="Spoke1", type="LINKS"),
            RelationshipInput(source="Hub", target="Spoke2", type="LINKS"),
            RelationshipInput(source="Hub", target="Spoke3", type="LINKS"),
        ],
    )

    results = await get_centrality(db, metric="degree", limit=10)
    assert results.metric == "degree"
    assert results.results[0].name == "Hub"
    assert results.results[0].score == 3.0


async def test_pagerank_centrality(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Hub", type="Node"),
                EntityInput(name="Spoke1", type="Node"),
                EntityInput(name="Spoke2", type="Node"),
            ],
            config,
        )
    await add_relationships(
        db,
        [
            RelationshipInput(source="Hub", target="Spoke1", type="LINKS"),
            RelationshipInput(source="Hub", target="Spoke2", type="LINKS"),
        ],
    )

    results = await get_centrality(db, metric="pagerank", limit=10)
    assert results.metric == "pagerank"
    assert len(results.results) == 3
    # Hub should have highest PageRank
    assert results.results[0].name == "Hub"


async def test_degree_centrality_filter_by_name(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="A", type="Node"),
                EntityInput(name="B", type="Node"),
                EntityInput(name="C", type="Node"),
            ],
            config,
        )
    await add_relationships(
        db,
        [
            RelationshipInput(source="A", target="B", type="LINKS"),
            RelationshipInput(source="A", target="C", type="LINKS"),
        ],
    )

    results = await get_centrality(db, metric="degree", entity_names=["A", "B"], limit=10)
    names = {r.name for r in results.results}
    assert "A" in names
    assert "B" in names
    assert "C" not in names


async def test_centrality_empty_graph(db: aiosqlite.Connection) -> None:
    results = await get_centrality(db, metric="degree", limit=10)
    assert results.results == []

    results = await get_centrality(db, metric="pagerank", limit=10)
    assert results.results == []
