PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;
PRAGMA user_version = 3;

CREATE TABLE IF NOT EXISTS tool_records (
    record_id TEXT PRIMARY KEY NOT NULL CHECK(length(record_id) > 0),
    session_id TEXT NOT NULL CHECK(length(session_id) > 0),
    run_id TEXT NOT NULL CHECK(length(run_id) > 0),
    call_id TEXT NOT NULL CHECK(length(call_id) > 0),
    attempt_id TEXT NOT NULL CHECK(length(attempt_id) > 0),
    tool_name TEXT NOT NULL CHECK(length(tool_name) > 0),
    workspace_id TEXT,
    operation TEXT,
    logical_targets_json TEXT NOT NULL CHECK(json_valid(logical_targets_json)),
    authority_id TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN (
        'completed', 'denied', 'failed', 'cancelled', 'indeterminate'
    )),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    started_at TEXT NOT NULL CHECK(length(started_at) > 0),
    completed_at TEXT NOT NULL CHECK(length(completed_at) > 0),
    UNIQUE(call_id, attempt_id)
) STRICT;

CREATE INDEX IF NOT EXISTS tool_records_call_idx
    ON tool_records(call_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS tool_records_run_idx
    ON tool_records(session_id, run_id, completed_at);

CREATE TRIGGER IF NOT EXISTS tool_records_are_not_updated
BEFORE UPDATE ON tool_records BEGIN
    SELECT RAISE(ABORT, 'tool records are immutable');
END;
