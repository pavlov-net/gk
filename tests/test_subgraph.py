"""Tests for subgraph extraction."""

from unittest.mock import AsyncMock, patch

import aiosqlite

from src.config import Config
from src.graph import add_entities, add_relationships, extract_subgraph
from src.models import EntityInput, RelationshipInput


async def test_extract_subgraph(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="A", type="Node"),
                EntityInput(name="B", type="Node"),
                EntityInput(name="C", type="Node"),
                EntityInput(name="D", type="Node"),  # disconnected
            ],
            config,
        )
    await add_relationships(
        db,
        [
            RelationshipInput(source="A", target="B", type="LINKS"),
            RelationshipInput(source="B", target="C", type="LINKS"),
        ],
    )

    subgraph = await extract_subgraph(db, seed_entities=["A"], depth=2, max_entities=50)
    names = {e.name for e in subgraph.entities}
    assert "A" in names
    assert "B" in names
    assert "C" in names
    assert "D" not in names  # disconnected, not in subgraph
    assert len(subgraph.relationships) >= 2
    assert subgraph.seed_entities == ["A"]


async def test_subgraph_depth_limit(
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
            RelationshipInput(source="B", target="C", type="LINKS"),
        ],
    )

    # Depth 1 should only reach B, not C
    subgraph = await extract_subgraph(db, seed_entities=["A"], depth=1, max_entities=50)
    names = {e.name for e in subgraph.entities}
    assert "A" in names
    assert "B" in names
    assert "C" not in names


async def test_subgraph_max_entities(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [EntityInput(name=f"N{i}", type="Node") for i in range(10)],
            config,
        )
    rels = [RelationshipInput(source="N0", target=f"N{i}", type="LINKS") for i in range(1, 10)]
    await add_relationships(db, rels)

    subgraph = await extract_subgraph(db, seed_entities=["N0"], depth=2, max_entities=5)
    assert len(subgraph.entities) <= 5


async def test_subgraph_empty_seeds(db: aiosqlite.Connection) -> None:
    subgraph = await extract_subgraph(db, seed_entities=["Nonexistent"], depth=2)
    assert len(subgraph.entities) == 0
