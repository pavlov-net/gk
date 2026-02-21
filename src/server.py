"""gk -- Agentic Knowledge Graph MCP Server.

FastMCP server with 15 tools across 3 tiers:
  Tier 1: Graph Construction (add/update/delete entities, relationships, observations)
  Tier 2: Retrieval (keyword, semantic, hybrid search + observation read)
  Tier 3: Graph Traversal (entity detail, relationships, types, paths, neighbors)
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import aiosqlite
from mcp.server.fastmcp import FastMCP

import src.graph as graph
import src.search as search
from src.config import Config, load_config
from src.db import init_db
from src.models import (
    AddResult,
    DeleteResult,
    EntityDetail,
    EntityInput,
    EntityUpdate,
    NeighborResults,
    ObservationDetail,
    ObservationInput,
    PathResults,
    RelationshipInput,
    RelationshipResults,
    RelationshipUpdate,
    SearchResults,
    TypeCounts,
    UpdateResult,
)
from src.observations import add_observations as _add_observations
from src.observations import read_observation as _read_observation

# Module-level state set by lifespan context manager
_db: aiosqlite.Connection | None = None
_config: Config | None = None


@asynccontextmanager
async def _lifespan(_server: FastMCP[None]) -> AsyncIterator[None]:
    """Initialize database on startup, close on shutdown."""
    global _db, _config
    _config = load_config()
    _db = await init_db(_config)
    try:
        yield
    finally:
        await _db.close()
        _db = None


mcp = FastMCP(
    "gk",
    lifespan=_lifespan,
    instructions="""
gk is an agentic knowledge graph server. You have 15 tools in 3 tiers:

**Tier 1 -- Build the graph:**
- add_entities, add_relationships, add_observations (batch creation)
- update_entities, update_relationships (modify existing)
- delete_entities (remove with cascade)

**Tier 2 -- Search observations:**
- search_keyword (exact terms, names -- BM25)
- search_semantic (thematic/conceptual -- vector similarity)
- search_hybrid (combines both -- use when unsure)
- read_observation (full text by ID after finding via search)

**Tier 3 -- Navigate the graph:**
- get_entity (full profile with relationships and observation summaries)
- get_relationships (query edges by entity/type)
- list_entity_types (see what's in the graph)
- find_paths (shortest paths between entities)
- get_neighbors (multi-hop exploration)

**Workflow:** Build entities first, then relationships, then observations.
Search to find relevant observations, read for full text, traverse for structure.
""",
)


def _get_db() -> aiosqlite.Connection:
    if _db is None:
        raise RuntimeError("Database not initialized")
    return _db


def _get_config() -> Config:
    if _config is None:
        raise RuntimeError("Config not initialized")
    return _config


# ---------------------------------------------------------------------------
# Tier 1 -- Graph Construction
# ---------------------------------------------------------------------------


@mcp.tool()
async def add_entities(entities: list[EntityInput]) -> AddResult:
    """Batch-add entities with auto-embedding. Upserts on name+type.

    Each entity has a name, type (you decide -- Person, Place, Theme, etc.),
    and optional properties dict. Creates embeddings automatically for search.
    """
    return await graph.add_entities(_get_db(), entities, _get_config())


@mcp.tool()
async def add_relationships(relationships: list[RelationshipInput]) -> AddResult:
    """Batch-add typed edges between entities (by name).

    Each relationship has source, target, type (you decide -- KNOWS, LOCATED_IN,
    THEME_OF, etc.), and optional properties dict. Entities must exist first.
    """
    return await graph.add_relationships(_get_db(), relationships)


@mcp.tool()
async def add_observations(observations: list[ObservationInput]) -> AddResult:
    """Batch-add text observations linked to entities. Auto-embeds for search.

    Each observation has content (the text), entity_names (which entities it
    relates to), and optional metadata dict. Use for quotes, summaries, notes.
    """
    return await _add_observations(_get_db(), observations, _get_config())


@mcp.tool()
async def update_entities(updates: list[EntityUpdate]) -> UpdateResult:
    """Update entity properties, type, or name. Re-embeds if content changes.

    Identify the entity by current name+type. Provide new_name, new_type,
    and/or new_properties for fields you want to change.
    """
    return await graph.update_entities(_get_db(), updates, _get_config())


@mcp.tool()
async def update_relationships(updates: list[RelationshipUpdate]) -> UpdateResult:
    """Update relationship type or properties.

    Identify the relationship by source+target+type. Provide new_type
    and/or new_properties for fields you want to change.
    """
    return await graph.update_relationships(_get_db(), updates)


@mcp.tool()
async def delete_entities(
    names: list[str], delete_orphan_observations: bool = False
) -> DeleteResult:
    """Remove entities by name. Cascades to relationships and observation links.

    If delete_orphan_observations is True, also deletes observations that
    become unlinked from all entities after deletion.
    """
    return await graph.delete_entities(_get_db(), names, delete_orphan_observations)


# ---------------------------------------------------------------------------
# Tier 2 -- Retrieval
# ---------------------------------------------------------------------------


@mcp.tool()
async def search_keyword(
    query: str,
    entity_types: list[str] | None = None,
    limit: int = 20,
) -> SearchResults:
    """BM25 keyword search over observations via FTS5.

    Best for: exact terms, names, specific phrases, known vocabulary.
    Optionally filter by entity types (e.g., ["Person", "Place"]).
    Returns observation snippets with scores -- use read_observation for full text.
    """
    return await search.keyword_search(_get_db(), query, entity_types, limit)


@mcp.tool()
async def search_semantic(
    query: str,
    entity_types: list[str] | None = None,
    limit: int = 20,
) -> SearchResults:
    """Vector similarity search over observations.

    Best for: thematic queries, conceptual questions, finding related content
    even when exact words don't match. Optionally filter by entity types.
    Returns observation snippets with scores -- use read_observation for full text.
    """
    return await search.semantic_search(_get_db(), query, _get_config(), entity_types, limit)


@mcp.tool()
async def search_hybrid(
    query: str,
    entity_types: list[str] | None = None,
    keyword_weight: float = 1.0,
    semantic_weight: float = 1.0,
    limit: int = 20,
) -> SearchResults:
    """Hybrid search combining keyword (BM25) and semantic (vector) via RRF.

    Use when unsure whether keyword or semantic search fits better.
    Adjust weights to favor one approach (e.g., keyword_weight=2.0 for
    more emphasis on exact matches). Default is equal weight.
    """
    return await search.hybrid_search(
        _get_db(), query, _get_config(), entity_types, keyword_weight, semantic_weight, limit
    )


@mcp.tool()
async def read_observation(observation_id: int) -> ObservationDetail | None:
    """Read full observation text by ID.

    Use after search to get the complete content. Returns the full text,
    metadata, linked entity names, and creation timestamp.
    """
    return await _read_observation(_get_db(), observation_id)


# ---------------------------------------------------------------------------
# Tier 3 -- Graph Traversal
# ---------------------------------------------------------------------------


@mcp.tool()
async def get_entity(name: str) -> EntityDetail | None:
    """Get full entity profile: properties, relationships, observation summaries.

    Returns all relationships (both directions) and truncated observation
    snippets. Use read_observation to get full observation text.
    """
    return await graph.get_entity(_get_db(), name)


@mcp.tool()
async def get_relationships(
    entity_name: str | None = None,
    relationship_type: str | None = None,
    limit: int = 50,
) -> RelationshipResults:
    """Query relationships by entity name and/or type.

    Provide entity_name to get all relationships for that entity,
    relationship_type to filter by edge type, or both. At least one
    filter should be provided.
    """
    return await graph.get_relationships(_get_db(), entity_name, relationship_type, limit)


@mcp.tool()
async def list_entity_types() -> TypeCounts:
    """List all entity types in the graph with their counts.

    Use this for introspection -- understanding what's in the graph
    before querying. Helps decide which entity_types to filter by.
    """
    return await graph.list_entity_types(_get_db())


@mcp.tool()
async def find_paths(
    source: str,
    target: str,
    max_depth: int = 5,
) -> PathResults:
    """Find shortest paths between two entities.

    Uses recursive graph traversal. Returns up to 10 paths, shortest first.
    Each path shows the entities and relationship types along the way.
    """
    return await graph.find_paths(_get_db(), source, target, max_depth)


@mcp.tool()
async def get_neighbors(
    entity_name: str,
    depth: int = 2,
    relationship_types: list[str] | None = None,
) -> NeighborResults:
    """Multi-hop graph traversal from an entity.

    Explores outward from the named entity up to the given depth.
    Optionally filter by relationship types. Returns all discovered
    entities with their depth and how they connect.
    """
    return await graph.get_neighbors(_get_db(), entity_name, depth, relationship_types)


def main() -> None:
    """Entry point for the gk server."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
