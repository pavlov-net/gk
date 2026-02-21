"""Environment variable configuration for gk."""

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Config:
    """Typed configuration loaded from environment variables.

    Environment variables:
        GK_DB_PATH: Path to the SQLite database file (default: "knowledge.db")
        GK_EMBEDDING_MODEL: LiteLLM model identifier for embeddings
            (default: "ollama/nomic-embed-text" — local Ollama)
        GK_EMBEDDING_DIM: Embedding vector dimension (default: 768 for nomic-embed-text)
        GK_EMBEDDING_BATCH_SIZE: Max items per embedding API call (default: 100)
    """

    db_path: str = field(default_factory=lambda: os.environ.get("GK_DB_PATH", "knowledge.db"))
    embedding_model: str = field(
        default_factory=lambda: os.environ.get("GK_EMBEDDING_MODEL", "ollama/nomic-embed-text")
    )
    embedding_dim: int = field(
        default_factory=lambda: int(os.environ.get("GK_EMBEDDING_DIM", "768"))
    )
    embedding_batch_size: int = field(
        default_factory=lambda: int(os.environ.get("GK_EMBEDDING_BATCH_SIZE", "100"))
    )


def load_config() -> Config:
    """Load configuration from environment variables."""
    return Config()
