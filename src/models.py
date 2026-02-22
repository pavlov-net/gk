"""Pydantic models for MCP tool inputs and outputs."""

from datetime import UTC, datetime

from pydantic import BaseModel

SNIPPET_LENGTH = 200


def utcnow() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(UTC).isoformat()


# ---------------------------------------------------------------------------
# Tool inputs
# ---------------------------------------------------------------------------


class EntityInput(BaseModel):
    """Input for adding a single entity."""

    name: str
    type: str
    properties: dict[str, str] = {}
    confidence: float | None = None
    provenance: str | None = None


class EntityUpdate(BaseModel):
    """Input for updating an entity. Identifies by current name+type."""

    name: str
    type: str
    new_name: str | None = None
    new_type: str | None = None
    new_properties: dict[str, str] | None = None
    new_confidence: float | None = None
    new_provenance: str | None = None


class RelationshipInput(BaseModel):
    """Input for adding a relationship between two entities (by name)."""

    source: str
    target: str
    type: str
    properties: dict[str, str] = {}
    confidence: float | None = None
    provenance: str | None = None


class RelationshipUpdate(BaseModel):
    """Input for updating a relationship. Identifies by source+target+type."""

    source: str
    target: str
    type: str
    new_type: str | None = None
    new_properties: dict[str, str] | None = None
    new_confidence: float | None = None
    new_provenance: str | None = None


class ObservationInput(BaseModel):
    """Input for adding an observation linked to entities."""

    content: str
    entity_names: list[str] = []
    metadata: dict[str, str] = {}
    confidence: float | None = None
    provenance: str | None = None


# ---------------------------------------------------------------------------
# Tool outputs — mutations
# ---------------------------------------------------------------------------


class AddResult(BaseModel):
    """Result of a batch add operation."""

    added: int = 0
    errors: list[str] = []


class UpdateResult(BaseModel):
    """Result of a batch update operation."""

    updated: int = 0
    errors: list[str] = []


class DeleteResult(BaseModel):
    """Result of a delete operation."""

    deleted: int = 0
    errors: list[str] = []


class MergeResult(BaseModel):
    """Result of an entity merge operation."""

    merged: int = 0
    relationships_transferred: int = 0
    observations_transferred: int = 0
    errors: list[str] = []


class ChunkResult(BaseModel):
    """Result of a chunked observation add."""

    observation_ids: list[int] = []
    chunk_count: int = 0
    errors: list[str] = []


# ---------------------------------------------------------------------------
# Tool outputs — search
# ---------------------------------------------------------------------------


class SearchResult(BaseModel):
    """A single search hit."""

    observation_id: int
    entity_names: list[str]
    content_snippet: str
    score: float


class SearchFacets(BaseModel):
    """Aggregation counts for search results."""

    entity_types: dict[str, int] = {}
    relationship_types: dict[str, int] = {}


class SearchResults(BaseModel):
    """Collection of search results."""

    results: list[SearchResult] = []
    total: int = 0
    facets: SearchFacets | None = None


class EntitySearchResult(BaseModel):
    """A single entity search hit."""

    name: str
    type: str
    properties: dict[str, str] = {}
    score: float


class EntitySearchResults(BaseModel):
    """Collection of entity search results."""

    results: list[EntitySearchResult] = []
    total: int = 0


class RelationshipSearchResult(BaseModel):
    """A single relationship search hit."""

    source: str
    target: str
    type: str
    properties: dict[str, str] = {}
    score: float


class RelationshipSearchResults(BaseModel):
    """Collection of relationship search results."""

    results: list[RelationshipSearchResult] = []
    total: int = 0


# ---------------------------------------------------------------------------
# Tool outputs — entity / relationship detail
# ---------------------------------------------------------------------------


class RelationshipDetail(BaseModel):
    """A relationship between two entities."""

    source: str
    target: str
    type: str
    properties: dict[str, str] = {}


class ObservationSummary(BaseModel):
    """Truncated observation for entity profiles."""

    id: int
    content_snippet: str
    created_at: str


class EntityDetail(BaseModel):
    """Full entity profile."""

    name: str
    type: str
    properties: dict[str, str] = {}
    relationships: list[RelationshipDetail] = []
    observations: list[ObservationSummary] = []


class RelationshipResults(BaseModel):
    """Collection of relationships."""

    relationships: list[RelationshipDetail] = []


class ObservationDetail(BaseModel):
    """Full observation with metadata."""

    id: int
    content: str
    metadata: dict[str, str] = {}
    entity_names: list[str] = []
    created_at: str


# ---------------------------------------------------------------------------
# Tool outputs — graph traversal
# ---------------------------------------------------------------------------


class PathStep(BaseModel):
    """A single step in a path between entities."""

    entity_name: str
    entity_type: str
    relationship_type: str | None = None


class PathResult(BaseModel):
    """A single path between two entities."""

    steps: list[PathStep] = []


class PathResults(BaseModel):
    """Collection of paths found."""

    paths: list[PathResult] = []


class NeighborEntity(BaseModel):
    """An entity discovered via graph traversal."""

    name: str
    type: str
    depth: int
    relationship_type: str
    relationship_direction: str  # "outgoing" or "incoming"


class NeighborResults(BaseModel):
    """Collection of neighbors from traversal."""

    neighbors: list[NeighborEntity] = []


class TypeCount(BaseModel):
    """Count of entities for a given type."""

    type: str
    count: int


class TypeCounts(BaseModel):
    """All entity types and their counts."""

    types: list[TypeCount] = []


# ---------------------------------------------------------------------------
# Tool outputs — graph intelligence
# ---------------------------------------------------------------------------


class SubgraphEntity(BaseModel):
    """An entity in an extracted subgraph."""

    name: str
    type: str
    properties: dict[str, str] = {}
    depth: int


class Subgraph(BaseModel):
    """Extracted subgraph with entities and relationships."""

    entities: list[SubgraphEntity] = []
    relationships: list[RelationshipDetail] = []
    seed_entities: list[str] = []


class CentralityResult(BaseModel):
    """Centrality score for a single entity."""

    name: str
    type: str
    score: float


class CentralityResults(BaseModel):
    """Collection of centrality scores."""

    metric: str
    results: list[CentralityResult] = []


class TimelineEntry(BaseModel):
    """A single entry in a chronological timeline."""

    observation_id: int
    content_snippet: str
    entity_names: list[str]
    created_at: str


class Timeline(BaseModel):
    """Chronologically ordered observations."""

    entries: list[TimelineEntry] = []


# ---------------------------------------------------------------------------
# Tool outputs — agent experience
# ---------------------------------------------------------------------------


class PyramidStats(BaseModel):
    """Pyramid observation level distribution and staleness."""

    detail_count: int = 0
    summary_count: int = 0
    overview_count: int = 0
    unlabeled_count: int = 0
    stale_summary_entities: list[str] = []
    stale_overview_entities: list[str] = []


class GraphStats(BaseModel):
    """Aggregate statistics about the knowledge graph."""

    entity_count: int
    relationship_count: int
    observation_count: int
    entity_types: dict[str, int]
    relationship_types: dict[str, int]
    avg_relationships_per_entity: float
    avg_observations_per_entity: float
    entities_without_observations: int
    orphan_observations: int
    pyramid: PyramidStats | None = None


class ValidationIssue(BaseModel):
    """A single validation finding."""

    severity: str  # "warning" | "error"
    category: str
    message: str
    entity_names: list[str] = []


class ValidationResults(BaseModel):
    """Results of graph validation checks."""

    issues: list[ValidationIssue] = []
    summary: str
