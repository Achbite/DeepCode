BEGIN IMMEDIATE;

CREATE TABLE session_events_v3 (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) > 0),
    event_type TEXT NOT NULL CHECK(event_type IN (
        'session.created',
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

INSERT INTO session_events_v3(
    session_id, sequence, event_id, event_type, run_id, call_id, payload_json, occurred_at
)
SELECT session_id, sequence, event_id, event_type, run_id, call_id, payload_json, occurred_at
FROM session_events;

DROP TABLE session_events;
ALTER TABLE session_events_v3 RENAME TO session_events;

CREATE UNIQUE INDEX one_run_settlement
    ON session_events(session_id, run_id)
    WHERE event_type = 'run.settled';

CREATE INDEX session_events_run_idx
    ON session_events(session_id, run_id, sequence);

CREATE INDEX session_events_call_idx
    ON session_events(session_id, call_id, sequence);

PRAGMA user_version = 3;
COMMIT;
