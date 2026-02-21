"""Embedding generation via LiteLLM with batching and binary serialization."""

import struct
from typing import Any

import litellm

from src.config import Config


def entity_embedding_text(name: str, entity_type: str, properties: dict[str, str]) -> str:
    """Format entity data into a string suitable for embedding.

    Example: "Jay Gatsby (Character) - wealth: immense, motivation: Daisy"
    """
    text = f"{name} ({entity_type})"
    if properties:
        props = ", ".join(f"{k}: {v}" for k, v in properties.items())
        text += f" - {props}"
    return text


async def embed_texts(texts: list[str], config: Config) -> list[list[float]]:
    """Embed a batch of texts using LiteLLM. Handles sub-batching for large inputs."""
    if not texts:
        return []

    all_embeddings: list[list[float]] = []
    for i in range(0, len(texts), config.embedding_batch_size):
        batch = texts[i : i + config.embedding_batch_size]
        response = await litellm.aembedding(  # type: ignore[reportUnknownMemberType]
            model=config.embedding_model, input=batch
        )
        data: list[Any] = response.data  # type: ignore[assignment]
        for item in data:
            embedding: list[float] = item["embedding"]
            all_embeddings.append(embedding)

    return all_embeddings


async def embed_text(text: str, config: Config) -> list[float]:
    """Embed a single text string."""
    results = await embed_texts([text], config)
    return results[0]


def serialize_embedding(embedding: list[float]) -> bytes:
    """Pack a float vector into bytes for sqlite-vec."""
    return struct.pack(f"{len(embedding)}f", *embedding)


def deserialize_embedding(data: bytes, dim: int) -> list[float]:
    """Unpack bytes from sqlite-vec into a float vector."""
    return list(struct.unpack(f"{dim}f", data))
