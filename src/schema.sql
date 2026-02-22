-- gk knowledge graph schema

CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    properties TEXT NOT NULL DEFAULT '{}',
    confidence REAL DEFAULT NULL,
    provenance TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE(name, type)
);

CREATE TABLE IF NOT EXISTS relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    properties TEXT NOT NULL DEFAULT '{}',
    confidence REAL DEFAULT NULL,
    provenance TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(source_id, target_id, type)
);

CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    confidence REAL DEFAULT NULL,
    provenance TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS observation_entities (
    observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY (observation_id, entity_id)
);

-- FTS5 external content table (no text duplication — reads from observations)
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    content,
    content='observations',
    content_rowid='id'
);

-- Triggers to keep FTS5 in sync with observations table
CREATE TRIGGER IF NOT EXISTS observations_fts_insert AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_fts_delete AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_fts_update AFTER UPDATE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
    INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Vector tables are created in Python (dimension is dynamic)
-- See db.py: _create_vec_tables()

-- Metadata table for tracking embedding config
CREATE TABLE IF NOT EXISTS _metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
