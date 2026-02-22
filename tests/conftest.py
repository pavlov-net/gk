"""Test fixtures: in-memory DB with mock embeddings."""

import hashlib
import importlib.resources
import struct
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock

import aiosqlite
import pytest

from src.config import Config


def _deterministic_embedding(text: str, dim: int = 32) -> list[float]:
    """Generate a deterministic fake embedding from text.

    Uses SHA-256 hash to produce consistent vectors — same text always
    gives the same vector. Dimension is small (32) for test speed.
    """
    h = hashlib.sha256(text.encode()).digest()
    # Extend hash bytes to fill dimension
    raw = h * ((dim * 4 // len(h)) + 1)
    values = struct.unpack(f"{dim}f", raw[: dim * 4])
    # Normalize to unit vector for cosine similarity
    magnitude = sum(v * v for v in values) ** 0.5
    if magnitude == 0:
        return [0.0] * dim
    return [v / magnitude for v in values]


TEST_DIM = 32


@pytest.fixture
def config() -> Config:
    """Test config with small embedding dimension and in-memory DB."""
    return Config(
        db_path=":memory:",
        embedding_model="test-model",
        embedding_dim=TEST_DIM,
        embedding_batch_size=10,
    )


@pytest.fixture
async def db(config: Config) -> AsyncIterator[aiosqlite.Connection]:
    """Initialize an in-memory database with schema applied."""
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row

    await conn.execute("PRAGMA journal_mode=WAL")
    await conn.execute("PRAGMA foreign_keys=ON")
    await conn.execute("PRAGMA busy_timeout=5000")
    await conn.execute("PRAGMA synchronous=NORMAL")
    await conn.execute("PRAGMA cache_size=-64000")

    # Apply core schema (tables, FTS5, triggers)
    schema_sql = importlib.resources.files("src").joinpath("schema.sql").read_text("utf-8")
    await conn.executescript(schema_sql)

    # Create regular tables that mimic vec0 interface (vec0 extension not available in tests)
    await conn.execute(
        """CREATE TABLE IF NOT EXISTS observation_embeddings (
            observation_id INTEGER PRIMARY KEY,
            embedding BLOB
        )"""
    )
    await conn.execute(
        """CREATE TABLE IF NOT EXISTS entity_embeddings (
            entity_id INTEGER PRIMARY KEY,
            embedding BLOB
        )"""
    )
    await conn.execute(
        """CREATE TABLE IF NOT EXISTS relationship_embeddings (
            relationship_id INTEGER PRIMARY KEY,
            embedding BLOB
        )"""
    )

    # Populate metadata
    await conn.execute(
        "INSERT INTO _metadata (key, value) VALUES ('embedding_model', ?)",
        (config.embedding_model,),
    )
    await conn.execute(
        "INSERT INTO _metadata (key, value) VALUES ('embedding_dim', ?)",
        (str(config.embedding_dim),),
    )
    await conn.commit()

    yield conn
    await conn.close()


async def _fake_embed_texts(texts: list[str], config: Config) -> list[list[float]]:
    """Mock for embed_texts — matches its signature exactly."""
    return [_deterministic_embedding(text, config.embedding_dim) for text in texts]


async def _fake_embed_text(text: str, config: Config) -> list[float]:
    """Mock for embed_text — matches its signature exactly."""
    return _deterministic_embedding(text, config.embedding_dim)


@pytest.fixture
def mock_embeddings() -> AsyncMock:
    """Mock that matches the embed_texts(texts, config) signature."""
    return AsyncMock(side_effect=_fake_embed_texts)


@pytest.fixture
def mock_embed_text() -> AsyncMock:
    """Mock that matches the embed_text(text, config) signature."""
    return AsyncMock(side_effect=_fake_embed_text)
