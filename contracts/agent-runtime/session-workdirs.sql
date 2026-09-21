-- Optional Host-owned session working-directory feature. Input snapshots remain
-- ordinary owned workspace rows; only these explicitly registered roots are writable.
CREATE TABLE IF NOT EXISTS session_workdirs (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE
) STRICT;
