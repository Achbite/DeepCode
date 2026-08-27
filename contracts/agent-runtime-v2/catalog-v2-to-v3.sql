PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;

BEGIN IMMEDIATE;

CREATE TABLE session_catalog_v3 (
    session_id TEXT PRIMARY KEY NOT NULL CHECK(length(session_id) > 0),
    title TEXT NOT NULL CHECK(length(title) > 0),
    project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
    entry_kind TEXT NOT NULL CHECK(entry_kind = 'activeV2'),
    workspace_bindings_json TEXT NOT NULL CHECK(json_valid(workspace_bindings_json)),
    profile_id TEXT,
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK(length(updated_at) > 0)
) STRICT;

INSERT INTO session_catalog_v3(
    session_id,
    title,
    project_id,
    entry_kind,
    workspace_bindings_json,
    profile_id,
    created_at,
    updated_at
)
SELECT
    session_id,
    title,
    project_id,
    entry_kind,
    workspace_bindings_json,
    profile_id,
    created_at,
    updated_at
FROM session_catalog;

DROP TABLE session_catalog;
ALTER TABLE session_catalog_v3 RENAME TO session_catalog;

CREATE INDEX session_catalog_project_idx
    ON session_catalog(project_id, updated_at DESC);

PRAGMA user_version = 3;

COMMIT;
