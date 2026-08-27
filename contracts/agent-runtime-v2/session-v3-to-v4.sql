BEGIN IMMEDIATE;

CREATE TABLE session_events_v4 (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) > 0),
    event_type TEXT NOT NULL CHECK(event_type IN (
        'session.created',
        'session.directory-index.attached',
        'session.directory-index.detached',
        'input.accepted',
        'run.started',
        'run.profile.selected',
        'message.committed',
        'narrative.committed',
        'interaction.requested',
        'interaction.resolved',
        'plan.intent.requested',
        'plan.intent.resolved',
        'todo.updated',
        'tool.requested',
        'approval.requested',
        'approval.resolved',
        'tool.completed',
        'context.updated',
        'run.waiting',
        'run.settled'
    )),
    run_id TEXT,
    call_id TEXT,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    occurred_at TEXT NOT NULL CHECK(length(occurred_at) > 0),
    PRIMARY KEY(session_id, sequence)
) STRICT;

INSERT INTO session_events_v4(
    session_id, sequence, event_id, event_type, run_id, call_id, payload_json, occurred_at
)
SELECT
    event.session_id,
    event.sequence,
    event.event_id,
    event.event_type,
    event.run_id,
    event.call_id,
    CASE
        WHEN event.event_type = 'run.started'
             AND json_type(event.payload_json, '$.workspaceBindings') IS NULL
        THEN json_set(
            event.payload_json,
            '$.workspaceBindings',
            json(COALESCE((
                SELECT json_group_array(json(binding.value))
                FROM (
                    SELECT json_object(
                        'workspaceId', workspace.workspace_id,
                        'displayName', workspace.display_name
                    ) AS value
                    FROM session_workspace_bindings AS workspace
                    WHERE workspace.session_id = event.session_id
                    ORDER BY workspace.position
                ) AS binding
            ), '[]'))
        )
        ELSE event.payload_json
    END,
    event.occurred_at
FROM session_events AS event;

DROP TABLE session_events;
ALTER TABLE session_events_v4 RENAME TO session_events;

CREATE UNIQUE INDEX one_run_settlement
    ON session_events(session_id, run_id)
    WHERE event_type = 'run.settled';

CREATE INDEX session_events_run_idx
    ON session_events(session_id, run_id, sequence);

CREATE INDEX session_events_call_idx
    ON session_events(session_id, call_id, sequence);

PRAGMA user_version = 4;
COMMIT;
