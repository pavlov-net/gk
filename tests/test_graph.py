"""Tests for entity/relationship CRUD and graph traversal."""

from unittest.mock import patch

import aiosqlite

from src.config import Config
from src.graph import (
    add_entities,
    add_relationships,
    delete_entities,
    find_paths,
    get_entity,
    get_neighbors,
    get_relationships,
    list_entity_types,
    update_entities,
    update_relationships,
)
from src.models import EntityInput, EntityUpdate, RelationshipInput, RelationshipUpdate


async def test_add_entities(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        result = await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person", properties={"role": "protagonist"}),
                EntityInput(name="Wonderland", type="Place"),
            ],
            config,
        )

    assert result.added == 2
    assert result.errors == []

    # Verify in DB
    cursor = await db.execute("SELECT name, type, properties FROM entities ORDER BY name")
    rows = list(await cursor.fetchall())
    assert len(rows) == 2
    assert rows[0]["name"] == "Alice"
    assert rows[1]["name"] == "Wonderland"


async def test_add_entities_upsert(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)
        result = await add_entities(
            db,
            [EntityInput(name="Alice", type="Person", properties={"age": "7"})],
            config,
        )

    assert result.added == 1
    # Should have updated, not duplicated
    cursor = await db.execute("SELECT COUNT(*) as cnt FROM entities")
    row = await cursor.fetchone()
    assert row is not None
    assert row["cnt"] == 1


async def test_update_entities(
    db: aiosqlite.Connection,
    config: Config,
    mock_embeddings: object,
    mock_embed_text: object,
) -> None:
    with (
        patch("src.graph.embed_texts", mock_embeddings),
        patch("src.graph.embed_text", mock_embed_text),
    ):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)
        result = await update_entities(
            db,
            [EntityUpdate(name="Alice", type="Person", new_name="Alice Liddell")],
            config,
        )

    assert result.updated == 1
    entity = await get_entity(db, "Alice Liddell")
    assert entity is not None
    assert entity.name == "Alice Liddell"


async def test_update_entity_not_found(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        result = await update_entities(
            db,
            [EntityUpdate(name="Nobody", type="Person", new_name="Still Nobody")],
            config,
        )

    assert result.updated == 0
    assert len(result.errors) == 1


async def test_delete_entities(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
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

    result = await delete_entities(db, ["Alice"])
    assert result.deleted == 1

    # Alice gone, Bob remains
    entity = await get_entity(db, "Alice")
    assert entity is None
    entity = await get_entity(db, "Bob")
    assert entity is not None


async def test_add_relationships(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person"),
                EntityInput(name="Wonderland", type="Place"),
            ],
            config,
        )

    result = await add_relationships(
        db,
        [RelationshipInput(source="Alice", target="Wonderland", type="VISITS")],
    )
    assert result.added == 1
    assert result.errors == []


async def test_add_relationship_missing_entity(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)

    result = await add_relationships(
        db,
        [RelationshipInput(source="Alice", target="Nowhere", type="VISITS")],
    )
    assert result.added == 0
    assert len(result.errors) == 1


async def test_update_relationships(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person"),
                EntityInput(name="Wonderland", type="Place"),
            ],
            config,
        )
    await add_relationships(
        db,
        [RelationshipInput(source="Alice", target="Wonderland", type="VISITS")],
    )

    result = await update_relationships(
        db,
        [
            RelationshipUpdate(
                source="Alice", target="Wonderland", type="VISITS", new_type="LIVES_IN"
            )
        ],
    )
    assert result.updated == 1

    rels = await get_relationships(db, entity_name="Alice")
    assert len(rels.relationships) == 1
    assert rels.relationships[0].type == "LIVES_IN"


async def test_get_entity_with_relationships(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person"),
                EntityInput(name="Bob", type="Person"),
                EntityInput(name="Wonderland", type="Place"),
            ],
            config,
        )
    await add_relationships(
        db,
        [
            RelationshipInput(source="Alice", target="Bob", type="KNOWS"),
            RelationshipInput(source="Alice", target="Wonderland", type="VISITS"),
        ],
    )

    entity = await get_entity(db, "Alice")
    assert entity is not None
    assert entity.name == "Alice"
    assert len(entity.relationships) == 2


async def test_get_relationships_filter(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person"),
                EntityInput(name="Bob", type="Person"),
                EntityInput(name="Wonderland", type="Place"),
            ],
            config,
        )
    await add_relationships(
        db,
        [
            RelationshipInput(source="Alice", target="Bob", type="KNOWS"),
            RelationshipInput(source="Alice", target="Wonderland", type="VISITS"),
        ],
    )

    # Filter by type
    rels = await get_relationships(db, relationship_type="KNOWS")
    assert len(rels.relationships) == 1
    assert rels.relationships[0].type == "KNOWS"


async def test_list_entity_types(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Alice", type="Person"),
                EntityInput(name="Bob", type="Person"),
                EntityInput(name="Wonderland", type="Place"),
            ],
            config,
        )

    types = await list_entity_types(db)
    assert len(types.types) == 2
    # Sorted by count descending
    assert types.types[0].type == "Person"
    assert types.types[0].count == 2
    assert types.types[1].type == "Place"
    assert types.types[1].count == 1


async def test_find_paths(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
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
            RelationshipInput(source="A", target="B", type="CONNECTS"),
            RelationshipInput(source="B", target="C", type="CONNECTS"),
        ],
    )

    paths = await find_paths(db, "A", "C", max_depth=3)
    assert len(paths.paths) >= 1
    # Path should be A -> B -> C
    assert paths.paths[0].steps[0].entity_name == "A"
    assert paths.paths[0].steps[-1].entity_name == "C"


async def test_get_neighbors(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(
            db,
            [
                EntityInput(name="Center", type="Node"),
                EntityInput(name="Near1", type="Node"),
                EntityInput(name="Near2", type="Node"),
                EntityInput(name="Far1", type="Node"),
            ],
            config,
        )
    await add_relationships(
        db,
        [
            RelationshipInput(source="Center", target="Near1", type="LINKS"),
            RelationshipInput(source="Center", target="Near2", type="LINKS"),
            RelationshipInput(source="Near1", target="Far1", type="LINKS"),
        ],
    )

    # Depth 1 — should find Near1, Near2
    neighbors = await get_neighbors(db, "Center", depth=1)
    names = {n.name for n in neighbors.neighbors}
    assert "Near1" in names
    assert "Near2" in names
    assert "Far1" not in names

    # Depth 2 — should also find Far1
    neighbors = await get_neighbors(db, "Center", depth=2)
    names = {n.name for n in neighbors.neighbors}
    assert "Far1" in names


async def test_delete_entity_cascades_relationships(
    db: aiosqlite.Connection, config: Config, mock_embeddings: object
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
    await add_relationships(
        db,
        [RelationshipInput(source="Alice", target="Bob", type="KNOWS")],
    )

    await delete_entities(db, ["Alice"])

    # Relationship should be gone too (CASCADE)
    rels = await get_relationships(db, entity_name="Bob")
    assert len(rels.relationships) == 0
