PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA user_version = 3;

CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT PRIMARY KEY NOT NULL CHECK(length(workspace_id) > 0),
    display_name TEXT NOT NULL CHECK(length(display_name) > 0),
    canonical_root TEXT NOT NULL UNIQUE CHECK(length(canonical_root) > 0),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0)
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL CHECK(length(project_id) > 0),
    title TEXT NOT NULL CHECK(length(title) > 0),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK(length(updated_at) > 0)
) STRICT;

CREATE TABLE IF NOT EXISTS project_workspace_bindings (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
    PRIMARY KEY(project_id, position),
    UNIQUE(project_id, workspace_id)
) STRICT;

CREATE TABLE IF NOT EXISTS session_catalog (
    session_id TEXT PRIMARY KEY NOT NULL CHECK(length(session_id) > 0),
    title TEXT NOT NULL CHECK(length(title) > 0),
    project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
    entry_kind TEXT NOT NULL CHECK(entry_kind = 'activeV2'),
    workspace_bindings_json TEXT NOT NULL CHECK(json_valid(workspace_bindings_json)),
    profile_id TEXT,
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    updated_at TEXT NOT NULL CHECK(length(updated_at) > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS session_catalog_project_idx
    ON session_catalog(project_id, updated_at DESC);
