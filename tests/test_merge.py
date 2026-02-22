"""Tests for entity merge."""

from unittest.mock import AsyncMock, patch

import aiosqlite

from src.config import Config
from src.graph import add_entities, add_relationships, get_entity, merge_entities
from src.models import EntityInput, ObservationInput, RelationshipInput
from src.observations import add_observations


async def test_merge_entities(
    db: aiosqlite.Connection,
    config: Config,
    mock_embeddings: AsyncMock,
    mock_embed_text: AsyncMock,
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Jay Gatsby", type="Person", properties={"wealth": "immense"}),
                EntityInput(name="Gatsby", type="Person", properties={"occupation": "bootlegger"}),
                EntityInput(name="Daisy", type="Person"),
            ],
            config,
        )
    await add_relationships(
        db,
        [
            RelationshipInput(source="Jay Gatsby", target="Daisy", type="LOVES"),
            RelationshipInput(source="Gatsby", target="Daisy", type="KNOWS"),
        ],
    )
    with patch("src.observations.embed_texts", mock_embeddings):
        await add_observations(
            db,
            [
                ObservationInput(content="Gatsby threw lavish parties.", entity_names=["Gatsby"]),
            ],
            config,
        )

    with patch("src.graph.embed_text", mock_embed_text):
        result = await merge_entities(db, ["Gatsby"], "Jay Gatsby", config)

    assert result.merged == 1
    assert result.observations_transferred >= 1

    # "Gatsby" entity should be gone
    entity = await get_entity(db, "Gatsby")
    assert entity is None

    # "Jay Gatsby" should have all relationships and observations
    entity = await get_entity(db, "Jay Gatsby")
    assert entity is not None
    assert len(entity.relationships) >= 2
    assert len(entity.observations) >= 1
    # Merged properties — target wins on conflict
    assert entity.properties.get("wealth") == "immense"
    assert entity.properties.get("occupation") == "bootlegger"


async def test_merge_into_self(
    db: aiosqlite.Connection,
    config: Config,
    mock_embeddings: AsyncMock,
    mock_embed_text: AsyncMock,
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)

    with patch("src.graph.embed_text", mock_embed_text):
        result = await merge_entities(db, ["Alice"], "Alice", config)

    assert result.merged == 0
    assert len(result.errors) == 1
    assert "itself" in result.errors[0]


async def test_merge_nonexistent_source(
    db: aiosqlite.Connection,
    config: Config,
    mock_embeddings: AsyncMock,
    mock_embed_text: AsyncMock,
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)

    with patch("src.graph.embed_text", mock_embed_text):
        result = await merge_entities(db, ["Nobody"], "Alice", config)

    assert result.merged == 0
    assert len(result.errors) == 1
