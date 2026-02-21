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


class EntityUpdate(BaseModel):
    """Input for updating an entity. Identifies by current name+type."""

    name: str
    type: str
    new_name: str | None = None
    new_type: str | None = None
    new_properties: dict[str, str] | None = None


class RelationshipInput(BaseModel):
    """Input for adding a relationship between two entities (by name)."""

    source: str
    target: str
    type: str
    properties: dict[str, str] = {}


class RelationshipUpdate(BaseModel):
    """Input for updating a relationship. Identifies by source+target+type."""

    source: str
    target: str
    type: str
    new_type: str | None = None
    new_properties: dict[str, str] | None = None


class ObservationInput(BaseModel):
    """Input for adding an observation linked to entities."""

    content: str
    entity_names: list[str] = []
    metadata: dict[str, str] = {}


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


# ---------------------------------------------------------------------------
# Tool outputs — search
# ---------------------------------------------------------------------------


class SearchResult(BaseModel):
    """A single search hit."""

    observation_id: int
    entity_names: list[str]
    content_snippet: str
    score: float


class SearchResults(BaseModel):
    """Collection of search results."""

    results: list[SearchResult] = []
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
