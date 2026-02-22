"""gk -- Agentic Knowledge Graph MCP Server.

FastMCP server with 24 tools across 3 tiers:
  Tier 1: Graph Construction (add/update/delete/merge entities, relationships, observations)
  Tier 2: Retrieval (keyword, semantic, hybrid, entity, relationship search + observation read)
  Tier 3: Graph Traversal & Analysis (entity detail, paths, neighbors,
          subgraph, centrality, timeline, stats, validation)
"""

import importlib.resources
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import aiosqlite
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

import src.graph as graph
import src.search as search
from src.config import Config, load_config
from src.db import init_db
from src.models import (
    AddResult,
    CentralityResults,
    ChunkResult,
    DeleteResult,
    EntityDetail,
    EntityInput,
    EntitySearchResults,
    EntityUpdate,
    GraphStats,
    MergeResult,
    NeighborResults,
    ObservationDetail,
    ObservationInput,
    PathResults,
    RelationshipInput,
    RelationshipResults,
    RelationshipSearchResults,
    RelationshipUpdate,
    SearchResults,
    Subgraph,
    Timeline,
    TypeCounts,
    UpdateResult,
    ValidationResults,
)
from src.observations import add_chunked_observation as _add_chunked_observation
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
gk is an agentic knowledge graph server. You have 24 tools in 3 tiers:

**Tier 1 -- Build the graph (8 tools):**
- add_entities, add_relationships, add_observations (batch creation)
- add_chunked_observation (auto-split long text into linked chunks)
- update_entities, update_relationships (modify existing)
- delete_entities (remove with cascade)
- merge_entities (combine duplicate entities into one)

**Tier 2 -- Search (6 tools):**
- search_keyword (exact terms, names -- BM25)
- search_semantic (thematic/conceptual -- vector similarity)
- search_hybrid (combines both -- use when unsure)
- search_entities (find entities by semantic similarity)
- search_relationships (find relationships by semantic similarity)
- read_observation (full text by ID after finding via search)

**Tier 3 -- Navigate & analyze the graph (10 tools):**
- get_entity (full profile with relationships and observation summaries)
- get_relationships (query edges by entity/type)
- list_entity_types (see what's in the graph)
- find_paths (shortest paths between entities)
- get_neighbors (multi-hop exploration)
- extract_subgraph (pull out a connected neighborhood)
- get_centrality (degree or PageRank importance scores)
- get_timeline (chronological observation history)
- get_stats (aggregate graph statistics)
- validate_graph (quality checks -- islands, orphans, duplicates)

**Workflow:** Build entities first, then relationships, then observations.
Search to find relevant observations, read for full text, traverse for structure.
Use validate_graph periodically to check quality. Use merge_entities to consolidate duplicates.
All observations and entities support optional confidence (0-1) and provenance tracking.

**Prompts:** Use `prompts/list` to discover extraction guides and review workflows.
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


@mcp.tool(annotations=ToolAnnotations(idempotentHint=True))
async def add_entities(entities: list[EntityInput]) -> AddResult:
    """Batch-add entities with auto-embedding. Upserts on name+type.

    Each entity has a name, type (you decide -- Person, Place, Theme, etc.),
    and optional properties dict. Creates embeddings automatically for search.
    Supports optional confidence (0-1) and provenance fields.
    """
    return await graph.add_entities(_get_db(), entities, _get_config())


@mcp.tool(annotations=ToolAnnotations(idempotentHint=True))
async def add_relationships(relationships: list[RelationshipInput]) -> AddResult:
    """Batch-add typed edges between entities (by name).

    Each relationship has source, target, type (you decide -- KNOWS, LOCATED_IN,
    THEME_OF, etc.), and optional properties dict. Entities must exist first.
    Supports optional confidence (0-1) and provenance fields.
    """
    return await graph.add_relationships(_get_db(), relationships, _get_config())


@mcp.tool(annotations=ToolAnnotations())
async def add_observations(observations: list[ObservationInput]) -> AddResult:
    """Batch-add text observations linked to entities. Auto-embeds for search.

    Each observation has content (the text), entity_names (which entities it
    relates to), and optional metadata dict. Use for quotes, summaries, notes.
    Supports optional confidence (0-1) and provenance fields.
    """
    return await _add_observations(_get_db(), observations, _get_config())


@mcp.tool(annotations=ToolAnnotations())
async def add_chunked_observation(
    content: str,
    entity_names: list[str] | None = None,
    metadata: dict[str, str] | None = None,
    confidence: float | None = None,
    provenance: str | None = None,
    chunk_size: int = 500,
    chunk_overlap: int = 50,
) -> ChunkResult:
    """Auto-split long text into linked observation chunks at sentence boundaries.

    Use for long documents, articles, or transcripts. Each chunk gets metadata
    with chunk_index, chunk_total, and parent_id linking them together.
    Short content (under chunk_size) becomes a single observation.
    """
    return await _add_chunked_observation(
        _get_db(),
        content,
        _get_config(),
        entity_names=entity_names,
        metadata=metadata,
        confidence=confidence,
        provenance=provenance,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )


@mcp.tool(annotations=ToolAnnotations())
async def update_entities(updates: list[EntityUpdate]) -> UpdateResult:
    """Update entity properties, type, or name. Re-embeds if content changes.

    Identify the entity by current name+type. Provide new_name, new_type,
    and/or new_properties for fields you want to change.
    """
    return await graph.update_entities(_get_db(), updates, _get_config())


@mcp.tool(annotations=ToolAnnotations())
async def update_relationships(updates: list[RelationshipUpdate]) -> UpdateResult:
    """Update relationship type or properties. Re-embeds if content changes.

    Identify the relationship by source+target+type. Provide new_type
    and/or new_properties for fields you want to change.
    """
    return await graph.update_relationships(_get_db(), updates, _get_config())


@mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
async def delete_entities(
    names: list[str], delete_orphan_observations: bool = False
) -> DeleteResult:
    """Remove entities by name. Cascades to relationships and observation links.

    If delete_orphan_observations is True, also deletes observations that
    become unlinked from all entities after deletion.
    """
    return await graph.delete_entities(_get_db(), names, delete_orphan_observations)


@mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
async def merge_entities(
    source_names: list[str],
    target_name: str,
    merge_properties: bool = True,
) -> MergeResult:
    """Merge duplicate entities into a single target entity.

    Moves all observations and relationships from source entities to the target.
    Source entities are deleted after merge. Target entity must already exist.
    If merge_properties is True, source properties are merged into target
    (target wins on conflicts).
    """
    return await graph.merge_entities(
        _get_db(), source_names, target_name, _get_config(), merge_properties
    )


# ---------------------------------------------------------------------------
# Tier 2 -- Retrieval
# ---------------------------------------------------------------------------


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def search_keyword(
    query: str,
    entity_types: list[str] | None = None,
    metadata_filters: dict[str, str] | None = None,
    limit: int = 20,
) -> SearchResults:
    """BM25 keyword search over observations via FTS5.

    Best for: exact terms, names, specific phrases, known vocabulary.
    Optionally filter by entity types (e.g., ["Person", "Place"]).
    Optionally filter by metadata fields (e.g., {"chapter": "1"}).
    Returns observation snippets with scores -- use read_observation for full text.
    """
    return await search.keyword_search(_get_db(), query, entity_types, metadata_filters, limit)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def search_semantic(
    query: str,
    entity_types: list[str] | None = None,
    metadata_filters: dict[str, str] | None = None,
    limit: int = 20,
) -> SearchResults:
    """Vector similarity search over observations.

    Best for: thematic queries, conceptual questions, finding related content
    even when exact words don't match. Optionally filter by entity types.
    Optionally filter by metadata fields (e.g., {"chapter": "1"}).
    Returns observation snippets with scores -- use read_observation for full text.
    """
    return await search.semantic_search(
        _get_db(), query, _get_config(), entity_types, metadata_filters, limit
    )


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def search_hybrid(
    query: str,
    entity_types: list[str] | None = None,
    metadata_filters: dict[str, str] | None = None,
    keyword_weight: float = 1.0,
    semantic_weight: float = 1.0,
    limit: int = 20,
) -> SearchResults:
    """Hybrid search combining keyword (BM25) and semantic (vector) via RRF.

    Use when unsure whether keyword or semantic search fits better.
    Adjust weights to favor one approach (e.g., keyword_weight=2.0 for
    more emphasis on exact matches). Default is equal weight.
    Optionally filter by metadata fields.
    """
    return await search.hybrid_search(
        _get_db(),
        query,
        _get_config(),
        entity_types,
        metadata_filters,
        keyword_weight,
        semantic_weight,
        limit,
    )


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def search_entities(
    query: str,
    entity_types: list[str] | None = None,
    limit: int = 20,
) -> EntitySearchResults:
    """Semantic search over entities by name and type.

    Use to find entities similar to a concept or description.
    Returns entities ranked by vector similarity with scores.
    """
    return await search.entity_search(_get_db(), query, _get_config(), entity_types, limit)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def search_relationships(
    query: str,
    relationship_types: list[str] | None = None,
    limit: int = 20,
) -> RelationshipSearchResults:
    """Semantic search over relationships.

    Use to find relationships similar to a concept or description.
    Returns relationships ranked by vector similarity with scores.
    """
    return await search.relationship_search(
        _get_db(), query, _get_config(), relationship_types, limit
    )


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def read_observation(observation_id: int) -> ObservationDetail | None:
    """Read full observation text by ID.

    Use after search to get the complete content. Returns the full text,
    metadata, linked entity names, and creation timestamp.
    """
    return await _read_observation(_get_db(), observation_id)


# ---------------------------------------------------------------------------
# Tier 3 -- Graph Traversal & Analysis
# ---------------------------------------------------------------------------


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def get_entity(name: str) -> EntityDetail | None:
    """Get full entity profile: properties, relationships, observation summaries.

    Returns all relationships (both directions) and truncated observation
    snippets. Use read_observation to get full observation text.
    """
    return await graph.get_entity(_get_db(), name)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
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


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def list_entity_types() -> TypeCounts:
    """List all entity types in the graph with their counts.

    Use this for introspection -- understanding what's in the graph
    before querying. Helps decide which entity_types to filter by.
    """
    return await graph.list_entity_types(_get_db())


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
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


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
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


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def extract_subgraph(
    seed_entities: list[str],
    depth: int = 2,
    max_entities: int = 50,
) -> Subgraph:
    """Extract a connected subgraph around seed entities.

    BFS traversal from seeds up to given depth, capped at max_entities.
    Returns entities with their properties and all relationships between them.
    Useful for understanding the neighborhood around key entities.
    """
    return await graph.extract_subgraph(_get_db(), seed_entities, depth, max_entities)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def get_centrality(
    metric: str = "degree",
    entity_names: list[str] | None = None,
    limit: int = 20,
) -> CentralityResults:
    """Compute entity importance scores.

    Metrics:
    - "degree": number of relationships (fast, SQL-based)
    - "pagerank": iterative importance based on graph structure

    Optionally filter to specific entities by name.
    """
    return await graph.get_centrality(_get_db(), metric, entity_names, limit)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def get_timeline(
    entity_names: list[str] | None = None,
    entity_types: list[str] | None = None,
    limit: int = 50,
) -> Timeline:
    """Get observations in chronological order.

    Returns observations oldest-first, optionally filtered by entity names
    or entity types. Useful for understanding the temporal flow of events.
    """
    return await graph.get_timeline(_get_db(), entity_names, entity_types, limit)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def get_stats() -> GraphStats:
    """Get aggregate statistics about the knowledge graph.

    Returns counts of entities, relationships, and observations, type
    distributions, averages, and counts of entities without observations
    or orphan observations.
    """
    return await graph.get_stats(_get_db())


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, idempotentHint=True))
async def validate_graph() -> ValidationResults:
    """Check the graph for quality issues.

    Detects: island entities (no relationships or observations), orphan
    observations (not linked to any entity), duplicate name candidates
    (same name with different types), and entities with relationships
    but no observations. Returns issues with severity and suggested fixes.
    """
    return await graph.validate_graph(_get_db())


# ---------------------------------------------------------------------------
# MCP Prompts — loaded from src/prompts/*.md
# ---------------------------------------------------------------------------


def _load_prompt(filename: str) -> str:
    """Load a prompt markdown file from the src/prompts package."""
    return importlib.resources.files("src.prompts").joinpath(filename).read_text("utf-8")


@mcp.prompt()
def extraction_guide() -> str:
    """Guide for extracting entities and relationships from text."""
    return _load_prompt("extraction_guide.md")


@mcp.prompt()
def pyramid_extraction() -> str:
    """Hierarchical observation pattern: detail, summary, overview levels."""
    return _load_prompt("pyramid_extraction.md")


@mcp.prompt()
def review_and_refine() -> str:
    """Guide for reviewing and improving graph quality."""
    return _load_prompt("review_and_refine.md")


@mcp.prompt()
def query_guide() -> str:
    """Guide for querying and exploring an existing knowledge graph."""
    return _load_prompt("query_guide.md")


def main() -> None:
    """Entry point for the gk server."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
