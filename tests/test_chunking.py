"""Tests for observation chunking."""

import json
from unittest.mock import AsyncMock, patch

import aiosqlite

from src.config import Config
from src.graph import add_entities
from src.models import EntityInput
from src.observations import _split_into_chunks, add_chunked_observation


def test_split_short_text() -> None:
    result = _split_into_chunks("Short text.", chunk_size=500, overlap=50)
    assert result == ["Short text."]


def test_split_at_sentence_boundary() -> None:
    text = "First sentence. Second sentence. Third sentence."
    result = _split_into_chunks(text, chunk_size=30, overlap=5)
    assert len(result) >= 2
    # All content should be covered across chunks
    combined = " ".join(c.strip() for c in result)
    assert "First" in combined
    assert "Third" in combined


def test_split_preserves_all_content() -> None:
    text = "A. B. C. D. E. F. G. H. I. J."
    result = _split_into_chunks(text, chunk_size=10, overlap=2)
    # All original content should appear in at least one chunk
    for char in "ABCDEFGHIJ":
        assert any(char in chunk for chunk in result), f"Missing '{char}' in chunks"


async def test_add_chunked_observation(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)

    long_text = ". ".join(f"Sentence {i}" for i in range(50)) + "."
    with patch("src.observations.embed_texts", mock_embeddings):
        result = await add_chunked_observation(
            db,
            long_text,
            config,
            entity_names=["Alice"],
            chunk_size=100,
            chunk_overlap=10,
        )

    assert result.chunk_count > 1
    assert len(result.observation_ids) == result.chunk_count
    assert result.errors == []

    # Check metadata on each chunk
    for obs_id in result.observation_ids:
        cursor = await db.execute("SELECT metadata FROM observations WHERE id = ?", (obs_id,))
        row = await cursor.fetchone()
        assert row is not None
        meta = json.loads(row["metadata"])
        assert "chunk_index" in meta
        assert "chunk_total" in meta
        assert meta["chunk_total"] == str(result.chunk_count)


async def test_chunked_observation_with_provenance(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Bob", type="Person")], config)

    long_text = ". ".join(f"Event {i}" for i in range(30)) + "."
    with patch("src.observations.embed_texts", mock_embeddings):
        result = await add_chunked_observation(
            db,
            long_text,
            config,
            entity_names=["Bob"],
            confidence=0.9,
            provenance="doc:test.pdf",
            chunk_size=80,
        )

    assert result.chunk_count > 1
    # All chunks should have provenance
    for obs_id in result.observation_ids:
        cursor = await db.execute(
            "SELECT confidence, provenance FROM observations WHERE id = ?", (obs_id,)
        )
        row = await cursor.fetchone()
        assert row is not None
        assert row["confidence"] == 0.9
        assert row["provenance"] == "doc:test.pdf"


async def test_chunked_short_content_single_chunk(
    db: aiosqlite.Connection, config: Config, mock_embeddings: AsyncMock
) -> None:
    with patch("src.graph.embed_texts", mock_embeddings):
        await add_entities(db, [EntityInput(name="Alice", type="Person")], config)

    with patch("src.observations.embed_texts", mock_embeddings):
        result = await add_chunked_observation(db, "Short content.", config, entity_names=["Alice"])

    assert result.chunk_count == 1
    assert len(result.observation_ids) == 1
