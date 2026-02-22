"""Search implementations: FTS5 keyword, vec0 semantic, RRF hybrid."""

import json
from collections.abc import Iterable

import aiosqlite

from src.config import Config
from src.embeddings import embed_text, serialize_embedding
from src.models import (
    SNIPPET_LENGTH,
    EntitySearchResult,
    EntitySearchResults,
    RelationshipSearchResult,
    RelationshipSearchResults,
    SearchFacets,
    SearchResult,
    SearchResults,
)


def _escape_fts5_query(query: str) -> str:
    """Escape special FTS5 characters for safe MATCH queries.

    FTS5 operators like AND, OR, NOT, NEAR, and special chars like *"()
    must be escaped by wrapping each term in double quotes.
    """
    # Split on whitespace, quote each term to escape operators/special chars
    terms = query.split()
    escaped = [f'"{term}"' for term in terms if term.strip()]
    return " ".join(escaped)


async def _get_entity_names_for_observation(
    db: aiosqlite.Connection, observation_id: int
) -> list[str]:
    """Fetch entity names linked to an observation."""
    cursor = await db.execute(
        """SELECT e.name FROM entities e
           JOIN observation_entities oe ON e.id = oe.entity_id
           WHERE oe.observation_id = ?""",
        (observation_id,),
    )
    rows = await cursor.fetchall()
    return [r["name"] for r in rows]


def _distance_to_score(distance: float) -> float:
    """Convert sqlite-vec distance to a similarity score in (0, 1]."""
    return 1.0 / (1.0 + distance)


def _build_in_clause(column: str, values: list[str] | None) -> tuple[str, list[str]]:
    """Build an AND column IN (?, ...) clause. Returns ("", []) when values is empty/None."""
    if not values:
        return "", []
    placeholders = ", ".join("?" for _ in values)
    return f"AND {column} IN ({placeholders})", list(values)


def _build_entity_type_filter(entity_types: list[str] | None) -> tuple[str, list[str]]:
    """Build a SQL clause filtering observations to those linked to entities of given types.

    Returns (sql_clause, params).
    """
    if not entity_types:
        return "", []

    placeholders = ", ".join("?" for _ in entity_types)
    clause = f"""AND o.id IN (
        SELECT oe.observation_id FROM observation_entities oe
        JOIN entities e ON oe.entity_id = e.id
        WHERE e.type IN ({placeholders})
    )"""
    return clause, list(entity_types)


def _build_metadata_filter(metadata_filters: dict[str, str] | None) -> tuple[str, list[str]]:
    """Build SQL clause for metadata JSON field filtering."""
    if not metadata_filters:
        return "", []
    clauses: list[str] = []
    params: list[str] = []
    for key, value in metadata_filters.items():
        clauses.append(f"json_extract(o.metadata, '$.{key}') = ?")
        params.append(value)
    return "AND " + " AND ".join(clauses), params


async def _compute_facets(
    db: aiosqlite.Connection,
    observation_ids: list[int],
) -> SearchFacets:
    """Compute entity type facets for a set of observation IDs."""
    if not observation_ids:
        return SearchFacets()

    placeholders = ", ".join("?" for _ in observation_ids)
    cursor = await db.execute(
        f"""SELECT e.type, COUNT(DISTINCT oe.observation_id) AS cnt
            FROM observation_entities oe
            JOIN entities e ON oe.entity_id = e.id
            WHERE oe.observation_id IN ({placeholders})
            GROUP BY e.type ORDER BY cnt DESC""",
        observation_ids,
    )
    rows = await cursor.fetchall()
    return SearchFacets(entity_types={r["type"]: r["cnt"] for r in rows})


async def _build_search_results(
    db: aiosqlite.Connection,
    rows: Iterable[aiosqlite.Row],
    score_fn: str,
) -> list[SearchResult]:
    """Build SearchResult list from rows, fetching entity names for each observation.

    score_fn controls how the score is derived:
      - "bm25": negates the score (bm25 returns negative, lower = better)
      - "distance": converts distance to similarity score in (0, 1]
    """
    results: list[SearchResult] = []
    for row in rows:
        entity_names = await _get_entity_names_for_observation(db, row["id"])
        if score_fn == "bm25":
            score = -float(row["score"])
        else:
            score = _distance_to_score(float(row["distance"]))
        results.append(
            SearchResult(
                observation_id=row["id"],
                entity_names=entity_names,
                content_snippet=row["content"][:SNIPPET_LENGTH],
                score=score,
            )
        )
    return results


async def keyword_search(
    db: aiosqlite.Connection,
    query: str,
    entity_types: list[str] | None = None,
    metadata_filters: dict[str, str] | None = None,
    limit: int = 20,
) -> SearchResults:
    """BM25 keyword search via FTS5."""
    escaped = _escape_fts5_query(query)
    if not escaped:
        return SearchResults()

    type_clause, type_params = _build_entity_type_filter(entity_types)
    meta_clause, meta_params = _build_metadata_filter(metadata_filters)

    cursor = await db.execute(
        f"""SELECT o.id, o.content, bm25(observations_fts) AS score
            FROM observations_fts fts
            JOIN observations o ON o.id = fts.rowid
            WHERE fts.content MATCH ?
            {type_clause}
            {meta_clause}
            ORDER BY score
            LIMIT ?""",
        [escaped, *type_params, *meta_params, limit],
    )
    rows = await cursor.fetchall()
    results = await _build_search_results(db, rows, "bm25")

    # Compute facets when no entity_type filter applied
    facets = None
    if not entity_types and results:
        obs_ids = [r.observation_id for r in results]
        facets = await _compute_facets(db, obs_ids)

    return SearchResults(results=results, total=len(results), facets=facets)


async def semantic_search(
    db: aiosqlite.Connection,
    query: str,
    config: Config,
    entity_types: list[str] | None = None,
    metadata_filters: dict[str, str] | None = None,
    limit: int = 20,
) -> SearchResults:
    """Vector similarity search via sqlite-vec."""
    query_embedding = await embed_text(query, config)
    query_blob = serialize_embedding(query_embedding)

    type_clause, type_params = _build_entity_type_filter(entity_types)
    meta_clause, meta_params = _build_metadata_filter(metadata_filters)

    # sqlite-vec KNN query: MATCH returns closest vectors by distance
    cursor = await db.execute(
        f"""SELECT oe.observation_id AS id, o.content, oe.distance
            FROM observation_embeddings oe
            JOIN observations o ON o.id = oe.observation_id
            WHERE oe.embedding MATCH ?
            AND oe.k = ?
            {type_clause}
            {meta_clause}
            ORDER BY oe.distance""",
        [query_blob, limit, *type_params, *meta_params],
    )
    rows = await cursor.fetchall()
    results = await _build_search_results(db, rows, "distance")

    return SearchResults(results=results, total=len(results))


async def hybrid_search(
    db: aiosqlite.Connection,
    query: str,
    config: Config,
    entity_types: list[str] | None = None,
    metadata_filters: dict[str, str] | None = None,
    keyword_weight: float = 1.0,
    semantic_weight: float = 1.0,
    limit: int = 20,
) -> SearchResults:
    """Reciprocal Rank Fusion combining keyword + semantic search."""
    k = 60  # RRF constant

    # Fetch more candidates from each source for better fusion
    candidate_limit = limit * 3

    kw_results = await keyword_search(db, query, entity_types, metadata_filters, candidate_limit)
    sem_results = await semantic_search(
        db, query, config, entity_types, metadata_filters, candidate_limit
    )

    # Build RRF score maps
    scores: dict[int, float] = {}
    snippets: dict[int, str] = {}
    entities: dict[int, list[str]] = {}

    for rank, result in enumerate(kw_results.results):
        obs_id = result.observation_id
        scores[obs_id] = scores.get(obs_id, 0.0) + keyword_weight / (k + rank)
        snippets[obs_id] = result.content_snippet
        entities[obs_id] = result.entity_names

    for rank, result in enumerate(sem_results.results):
        obs_id = result.observation_id
        scores[obs_id] = scores.get(obs_id, 0.0) + semantic_weight / (k + rank)
        if obs_id not in snippets:
            snippets[obs_id] = result.content_snippet
            entities[obs_id] = result.entity_names

    # Sort by combined score, take top N
    sorted_ids = sorted(scores, key=lambda x: scores[x], reverse=True)[:limit]

    results = [
        SearchResult(
            observation_id=obs_id,
            entity_names=entities.get(obs_id, []),
            content_snippet=snippets.get(obs_id, ""),
            score=scores[obs_id],
        )
        for obs_id in sorted_ids
    ]

    return SearchResults(results=results, total=len(results))


# ---------------------------------------------------------------------------
# Entity & relationship semantic search
# ---------------------------------------------------------------------------


async def entity_search(
    db: aiosqlite.Connection,
    query: str,
    config: Config,
    entity_types: list[str] | None = None,
    limit: int = 20,
) -> EntitySearchResults:
    """Vector similarity search over entities."""
    query_embedding = await embed_text(query, config)
    query_blob = serialize_embedding(query_embedding)
    type_clause, type_params = _build_in_clause("e.type", entity_types)

    cursor = await db.execute(
        f"""SELECT ee.entity_id, ee.distance, e.name, e.type, e.properties
            FROM entity_embeddings ee
            JOIN entities e ON e.id = ee.entity_id
            WHERE ee.embedding MATCH ?
            AND ee.k = ?
            {type_clause}
            ORDER BY ee.distance""",
        [query_blob, limit, *type_params],
    )
    rows = await cursor.fetchall()

    results = [
        EntitySearchResult(
            name=row["name"],
            type=row["type"],
            properties=json.loads(row["properties"]),
            score=_distance_to_score(float(row["distance"])),
        )
        for row in rows
    ]
    return EntitySearchResults(results=results, total=len(results))


async def relationship_search(
    db: aiosqlite.Connection,
    query: str,
    config: Config,
    relationship_types: list[str] | None = None,
    limit: int = 20,
) -> RelationshipSearchResults:
    """Vector similarity search over relationships."""
    query_embedding = await embed_text(query, config)
    query_blob = serialize_embedding(query_embedding)
    type_clause, type_params = _build_in_clause("r.type", relationship_types)

    cursor = await db.execute(
        f"""SELECT re.relationship_id, re.distance, r.type, r.properties,
                   src.name AS source_name, tgt.name AS target_name
            FROM relationship_embeddings re
            JOIN relationships r ON r.id = re.relationship_id
            JOIN entities src ON r.source_id = src.id
            JOIN entities tgt ON r.target_id = tgt.id
            WHERE re.embedding MATCH ?
            AND re.k = ?
            {type_clause}
            ORDER BY re.distance""",
        [query_blob, limit, *type_params],
    )
    rows = await cursor.fetchall()

    results = [
        RelationshipSearchResult(
            source=row["source_name"],
            target=row["target_name"],
            type=row["type"],
            properties=json.loads(row["properties"]),
            score=_distance_to_score(float(row["distance"])),
        )
        for row in rows
    ]
    return RelationshipSearchResults(results=results, total=len(results))
