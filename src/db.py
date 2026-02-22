"""Database initialization and connection management."""

import importlib.resources
import logging

import aiosqlite
import sqlite_vec  # type: ignore[import-untyped]

from src.config import Config

logger = logging.getLogger(__name__)


async def init_db(config: Config) -> aiosqlite.Connection:
    """Open (or create) the database, load extensions, apply schema, validate metadata.

    Returns an open connection for the lifetime of the server.
    """
    db = await aiosqlite.connect(config.db_path)
    db.row_factory = aiosqlite.Row

    # Enable WAL mode and foreign keys
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    await db.execute("PRAGMA busy_timeout=5000")
    await db.execute("PRAGMA synchronous=NORMAL")
    await db.execute("PRAGMA cache_size=-64000")

    # Load sqlite-vec extension
    await db.enable_load_extension(True)
    await db.load_extension(sqlite_vec.loadable_path())
    await db.enable_load_extension(False)

    # Apply core schema (tables, FTS5, triggers)
    schema_sql = importlib.resources.files("src").joinpath("schema.sql").read_text("utf-8")
    await db.executescript(schema_sql)

    # Create vec0 tables (dimension is dynamic)
    await _create_vec_tables(db, config.embedding_dim)

    # Validate or populate metadata
    await _validate_metadata(db, config)

    await db.commit()
    return db


async def _create_vec_tables(db: aiosqlite.Connection, dim: int) -> None:
    """Create sqlite-vec virtual tables if they don't exist."""
    await db.execute(
        f"CREATE VIRTUAL TABLE IF NOT EXISTS observation_embeddings USING vec0("
        f"observation_id INTEGER PRIMARY KEY, embedding float[{dim}])"
    )
    await db.execute(
        f"CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0("
        f"entity_id INTEGER PRIMARY KEY, embedding float[{dim}])"
    )
    await db.execute(
        f"CREATE VIRTUAL TABLE IF NOT EXISTS relationship_embeddings USING vec0("
        f"relationship_id INTEGER PRIMARY KEY, embedding float[{dim}])"
    )


async def _validate_metadata(db: aiosqlite.Connection, config: Config) -> None:
    """Check that stored embedding config matches current config.

    On first run, populates the metadata. On subsequent runs, raises if
    the model or dimension changed (which would corrupt vector search).
    """
    cursor = await db.execute("SELECT key, value FROM _metadata")
    rows = await cursor.fetchall()
    stored = {row["key"]: row["value"] for row in rows}

    if not stored:
        # First run — populate
        await db.executemany(
            "INSERT INTO _metadata (key, value) VALUES (?, ?)",
            [
                ("embedding_model", config.embedding_model),
                ("embedding_dim", str(config.embedding_dim)),
            ],
        )
        return

    stored_model = stored.get("embedding_model", "")
    stored_dim = stored.get("embedding_dim", "")

    if stored_model != config.embedding_model:
        raise ValueError(
            f"Embedding model mismatch: database has '{stored_model}', "
            f"config has '{config.embedding_model}'. "
            f"Cannot mix embeddings from different models."
        )

    if stored_dim != str(config.embedding_dim):
        raise ValueError(
            f"Embedding dimension mismatch: database has {stored_dim}, "
            f"config has {config.embedding_dim}. "
            f"Cannot mix embeddings with different dimensions."
        )
