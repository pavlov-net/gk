"""Search implementations: FTS5 keyword, vec0 semantic, RRF hybrid."""

import aiosqlite

from src.config import Config
from src.embeddings import embed_text, serialize_embedding
from src.models import SNIPPET_LENGTH, SearchResult, SearchResults


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


async def keyword_search(
    db: aiosqlite.Connection,
    query: str,
    entity_types: list[str] | None = None,
    limit: int = 20,
) -> SearchResults:
    """BM25 keyword search via FTS5."""
    escaped = _escape_fts5_query(query)
    if not escaped:
        return SearchResults()

    type_clause, type_params = _build_entity_type_filter(entity_types)

    cursor = await db.execute(
        f"""SELECT o.id, o.content, bm25(observations_fts) AS score
            FROM observations_fts fts
            JOIN observations o ON o.id = fts.rowid
            WHERE fts.content MATCH ?
            {type_clause}
            ORDER BY score
            LIMIT ?""",
        [escaped, *type_params, limit],
    )
    rows = await cursor.fetchall()

    results: list[SearchResult] = []
    for row in rows:
        entity_names = await _get_entity_names_for_observation(db, row["id"])
        results.append(
            SearchResult(
                observation_id=row["id"],
                entity_names=entity_names,
                content_snippet=row["content"][:SNIPPET_LENGTH],
                # bm25() returns negative values (lower = better), negate for intuitive scoring
                score=-float(row["score"]),
            )
        )

    return SearchResults(results=results, total=len(results))


async def semantic_search(
    db: aiosqlite.Connection,
    query: str,
    config: Config,
    entity_types: list[str] | None = None,
    limit: int = 20,
) -> SearchResults:
    """Vector similarity search via sqlite-vec."""
    query_embedding = await embed_text(query, config)
    query_blob = serialize_embedding(query_embedding)

    type_clause, type_params = _build_entity_type_filter(entity_types)

    # sqlite-vec KNN query: MATCH returns closest vectors by distance
    cursor = await db.execute(
        f"""SELECT oe.observation_id AS id, o.content, oe.distance
            FROM observation_embeddings oe
            JOIN observations o ON o.id = oe.observation_id
            WHERE oe.embedding MATCH ?
            AND oe.k = ?
            {type_clause}
            ORDER BY oe.distance""",
        [query_blob, limit, *type_params],
    )
    rows = await cursor.fetchall()

    results: list[SearchResult] = []
    for row in rows:
        entity_names = await _get_entity_names_for_observation(db, row["id"])
        # Convert distance to similarity score (1 / (1 + distance))
        distance = float(row["distance"])
        score = 1.0 / (1.0 + distance)
        results.append(
            SearchResult(
                observation_id=row["id"],
                entity_names=entity_names,
                content_snippet=row["content"][:SNIPPET_LENGTH],
                score=score,
            )
        )

    return SearchResults(results=results, total=len(results))


async def hybrid_search(
    db: aiosqlite.Connection,
    query: str,
    config: Config,
    entity_types: list[str] | None = None,
    keyword_weight: float = 1.0,
    semantic_weight: float = 1.0,
    limit: int = 20,
) -> SearchResults:
    """Reciprocal Rank Fusion combining keyword + semantic search."""
    k = 60  # RRF constant

    # Fetch more candidates from each source for better fusion
    candidate_limit = limit * 3

    kw_results = await keyword_search(db, query, entity_types, candidate_limit)
    sem_results = await semantic_search(db, query, config, entity_types, candidate_limit)

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
