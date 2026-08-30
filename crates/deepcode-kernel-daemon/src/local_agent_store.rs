use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

const SESSION_STORE_SCHEMA: &str = include_str!("../../../contracts/agent-runtime/session.sql");
const SESSION_STORE_VERSION: u32 = 3;
const EVENT_VERSION: &str = "deepcode.session-event";
const COMMAND_VERSION: &str = "deepcode.command";
const REPLY_VERSION: &str = "deepcode.command-reply";

#[derive(Debug, Clone)]
pub(crate) struct LocalAgentStoreError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl LocalAgentStoreError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct LocalAgentJournal {
    connection: Arc<Mutex<Connection>>,
}

impl LocalAgentJournal {
    pub(crate) fn open(path: &Path) -> Result<Self, LocalAgentStoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                LocalAgentStoreError::new(
                    "session_store_directory_failed",
                    format!("创建 Session Store 目录失败：{error}"),
                )
            })?;
        }
        let existed = path.exists();
        let mut connection = Connection::open(path).map_err(sql_open_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(sql_error("session_store_busy_timeout_failed"))?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
            .map_err(sql_error("session_store_pragma_failed"))?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(sql_error("session_store_version_read_failed"))?;
        match version {
            0 if !existed || sqlite_is_empty(&connection)? => {
                connection
                    .execute_batch(SESSION_STORE_SCHEMA)
                    .map_err(sql_error("session_store_schema_create_failed"))?;
                verify_session_store(&connection)?;
                verify_session_store_version(&connection)?;
            }
            SESSION_STORE_VERSION => {
                verify_session_store(&connection)?;
                verify_session_store_version(&connection)?;
            }
            2 => {
                migrate_session_store_v2_to_v3(&mut connection)?;
                verify_session_store(&connection)?;
                verify_session_store_version(&connection)?;
            }
            other => {
                return Err(LocalAgentStoreError::new(
                    "session_store_version_unsupported",
                    format!("Session Store schema {other} 不受支持；当前只接受 schema {SESSION_STORE_VERSION}。"),
                ))
            }
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub(crate) fn create_session(
        &self,
        session_id: &str,
        display_title: &str,
        workspace_bindings: &Value,
        profile_id: Option<&str>,
    ) -> Result<Value, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_display_title(display_title)?;
        if let Some(profile_id) = profile_id {
            validate_id("profileId", profile_id)?;
        }
        let bindings = validate_workspace_bindings(workspace_bindings)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(sql_error("session_create_transaction_failed"))?;
        transaction
            .execute(
                "INSERT INTO sessions(session_id, display_title, initial_profile_id, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session_id, display_title, profile_id, crate::now_text()],
            )
            .map_err(sql_error("session_create_failed"))?;
        for (position, binding) in bindings.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO session_workspace_bindings(
                         session_id, position, workspace_id, display_name
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        session_id,
                        position as i64,
                        binding["workspaceId"].as_str(),
                        binding["displayName"].as_str(),
                    ],
                )
                .map_err(sql_error("session_binding_create_failed"))?;
        }
        let event = json!({
            "type": "session.created",
            "sessionId": session_id,
            "payload": {
                "displayTitle": display_title,
                "workspaceBindings": bindings,
                "profileId": profile_id,
            }
        });
        let event = strip_null_object_fields(event);
        let committed = insert_event(&transaction, &event, true)?;
        transaction
            .commit()
            .map_err(sql_error("session_create_commit_failed"))?;
        Ok(committed)
    }

    pub(crate) fn append(&self, event: &Value) -> Result<Value, LocalAgentStoreError> {
        let mut committed = self.append_batch(std::slice::from_ref(event))?;
        Ok(committed.remove(0))
    }

    pub(crate) fn append_batch(
        &self,
        events: &[Value],
    ) -> Result<Vec<Value>, LocalAgentStoreError> {
        if events.is_empty() {
            return Err(LocalAgentStoreError::new(
                "session_event_batch_empty",
                "Session Event batch 不能为空。",
            ));
        }
        for event in events {
            validate_new_event(event, false)?;
        }
        let session_id = required_string(&events[0], "sessionId")?;
        if events
            .iter()
            .any(|event| event.get("sessionId").and_then(Value::as_str) != Some(session_id))
        {
            return Err(LocalAgentStoreError::new(
                "session_event_batch_identity_mismatch",
                "同一原子 batch 的事件必须属于同一 Session。",
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(sql_error("session_event_transaction_failed"))?;
        let mut committed = Vec::with_capacity(events.len());
        for event in events {
            committed.push(insert_event(&transaction, event, false)?);
        }
        transaction
            .commit()
            .map_err(sql_error("session_event_commit_failed"))?;
        Ok(committed)
    }

    pub(crate) fn read_events(
        &self,
        session_id: &str,
        after: u64,
    ) -> Result<Vec<Value>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        let connection = self.lock()?;
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=?1)",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(sql_error("session_read_failed"))?;
        if !exists {
            return Err(LocalAgentStoreError::new(
                "session_not_found",
                "Session 不存在。",
            ));
        }
        let mut statement = connection
            .prepare(
                "SELECT sequence, event_id, event_type, occurred_at, run_id, call_id, payload_json
                 FROM session_events
                 WHERE session_id=?1 AND sequence>?2 ORDER BY sequence ASC",
            )
            .map_err(sql_error("session_event_read_prepare_failed"))?;
        let after = i64::try_from(after).unwrap_or(i64::MAX);
        let rows = statement
            .query_map(params![session_id, after], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(sql_error("session_event_read_failed"))?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, event_id, event_type, occurred_at, run_id, call_id, payload) =
                row.map_err(sql_error("session_event_read_failed"))?;
            let mut event = json!({
                "schemaVersion": EVENT_VERSION,
                "eventId": event_id,
                "sessionId": session_id,
                "sequence": sequence,
                "occurredAt": occurred_at,
                "type": event_type,
                "payload": decode_json(&payload, "session_event_corrupt")?,
            });
            if let Some(run_id) = run_id {
                event["runId"] = json!(run_id);
            }
            if let Some(call_id) = call_id {
                event["callId"] = json!(call_id);
            }
            events.push(event);
        }
        Ok(events)
    }

    pub(crate) fn read_command(
        &self,
        session_id: &str,
        command_id: &str,
    ) -> Result<Option<Value>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("commandId", command_id)?;
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT command_json, reply_json FROM session_commands
                 WHERE session_id=?1 AND command_id=?2",
                params![session_id, command_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(sql_error("session_command_read_failed"))?
            .map(|(command, reply)| {
                Ok(json!({
                    "command": decode_json(&command, "session_command_corrupt")?,
                    "reply": decode_json(&reply, "session_command_reply_corrupt")?,
                }))
            })
            .transpose()
    }

    pub(crate) fn commit_command(&self, input: &Value) -> Result<Value, LocalAgentStoreError> {
        let object = exact_object(input, &["command", "events", "reply"], &[])?;
        let command = object.get("command").expect("required command");
        let events = object
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                LocalAgentStoreError::new("session_command_invalid", "events 必须是数组。")
            })?;
        let reply = object.get("reply").expect("required reply");
        validate_command(command)?;
        validate_reply(reply)?;
        validate_command_event_batch(command, events)?;
        let session_id = required_string(command, "sessionId")?;
        let command_id = required_string(command, "commandId")?;
        if required_string(reply, "sessionId")? != session_id
            || required_string(reply, "commandId")? != command_id
            || events
                .iter()
                .any(|event| event.get("sessionId").and_then(Value::as_str) != Some(session_id))
        {
            return Err(LocalAgentStoreError::new(
                "session_command_identity_mismatch",
                "命令、事件与回复身份不一致。",
            ));
        }
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(sql_error("session_command_transaction_failed"))?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT command_json FROM session_commands WHERE session_id=?1 AND command_id=?2",
                params![session_id, command_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_error("session_command_read_failed"))?;
        if existing.is_some() {
            return Err(LocalAgentStoreError::new(
                "session_command_already_recorded",
                "commandId 已经提交。",
            ));
        }
        for event in events {
            insert_event(&transaction, event, false)?;
        }
        let revision: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM session_events WHERE session_id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(sql_error("session_command_revision_failed"))?;
        let mut admitted = reply.clone();
        admitted["revision"] = json!(revision);
        transaction
            .execute(
                "INSERT INTO session_commands(
                     session_id, command_id, command_json, reply_json,
                     committed_revision, committed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    session_id,
                    command_id,
                    encode_json(command, "session_command_encode_failed")?,
                    encode_json(&admitted, "session_command_reply_encode_failed")?,
                    revision,
                    crate::now_text(),
                ],
            )
            .map_err(sql_error("session_command_append_failed"))?;
        transaction
            .commit()
            .map_err(sql_error("session_command_commit_failed"))?;
        Ok(admitted)
    }

    pub(crate) fn run_workspace_binding_ids(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Vec<String>, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        let connection = self.lock()?;
        let encoded = connection
            .query_row(
                "SELECT payload_json FROM session_events
                 WHERE session_id=?1 AND run_id=?2 AND event_type='run.started'",
                params![session_id, run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sql_error("session_run_workspace_snapshot_read_failed"))?
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_run_workspace_snapshot_missing",
                    "run.started 缺少冻结的 workspace bindings。",
                )
            })?;
        let payload = decode_json(&encoded, "session_run_workspace_snapshot_corrupt")?;
        let bindings =
            validate_workspace_bindings(payload.get("workspaceBindings").ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_run_workspace_snapshot_corrupt",
                    "run.started 没有 workspaceBindings。",
                )
            })?)?;
        Ok(bindings
            .into_iter()
            .filter_map(|binding| binding["workspaceId"].as_str().map(str::to_string))
            .collect())
    }

    pub(crate) fn run_is_settled(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<bool, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM session_events
                     WHERE session_id=?1 AND run_id=?2 AND event_type='run.settled'
                 )",
                params![session_id, run_id],
                |row| row.get(0),
            )
            .map_err(sql_error("session_run_fact_read_failed"))
    }

    pub(crate) fn plan_authority_is_committed(
        &self,
        session_id: &str,
        authority: &Value,
    ) -> Result<bool, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT event_type, payload_json FROM session_events
                 WHERE session_id=?1 AND event_type IN (
                   'plan.confirmed', 'plan.revision.requested', 'plan.superseded',
                   'plan.cancelled', 'plan.completed', 'plan.invalidated'
                 ) ORDER BY sequence ASC",
            )
            .map_err(sql_error("plan_authority_fact_read_failed"))?;
        let rows = statement
            .query_map(params![session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sql_error("plan_authority_fact_read_failed"))?;
        let mut active_authorities: Option<Vec<Value>> = None;
        let mut active_plan: Option<(String, u64)> = None;
        for row in rows {
            let (event_type, encoded) =
                row.map_err(sql_error("plan_authority_fact_read_failed"))?;
            let payload = decode_json(&encoded, "plan_authority_fact_corrupt")?;
            let plan_id = required_string(&payload, "planId")?.to_string();
            let revision = required_u64(&payload, "revision")?;
            if event_type == "plan.confirmed" {
                active_plan = Some((plan_id, revision));
                active_authorities = Some(
                    payload
                        .get("authorities")
                        .and_then(Value::as_array)
                        .ok_or_else(|| {
                            LocalAgentStoreError::new(
                                "plan_authority_fact_corrupt",
                                "plan.confirmed 缺少 authorities。",
                            )
                        })?
                        .clone(),
                );
            } else if active_plan
                .as_ref()
                .is_some_and(|active| active.0 == plan_id && active.1 == revision)
            {
                active_plan = None;
                active_authorities = None;
            }
        }
        Ok(active_authorities
            .is_some_and(|authorities| authorities.iter().any(|candidate| candidate == authority)))
    }

    pub(crate) fn non_workspace_authority_is_committed(
        &self,
        session_id: &str,
        run_id: &str,
        call_id: &str,
        authority_id: &str,
        decision: &str,
    ) -> Result<bool, LocalAgentStoreError> {
        for (field, value) in [
            ("sessionId", session_id),
            ("runId", run_id),
            ("callId", call_id),
            ("authorityId", authority_id),
        ] {
            validate_id(field, value)?;
        }
        if !matches!(decision, "allow" | "deny") {
            return Ok(false);
        }
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT payload_json FROM session_events
                 WHERE session_id=?1 AND run_id=?2 AND call_id=?3
                   AND event_type='approval.resolved'
                 ORDER BY sequence DESC",
            )
            .map_err(sql_error("approval_authority_fact_read_failed"))?;
        let rows = statement
            .query_map(params![session_id, run_id, call_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(sql_error("approval_authority_fact_read_failed"))?;
        for row in rows {
            let payload = decode_json(
                &row.map_err(sql_error("approval_authority_fact_read_failed"))?,
                "approval_authority_fact_corrupt",
            )?;
            if payload.get("authorityId").and_then(Value::as_str) == Some(authority_id)
                && payload.get("decision").and_then(Value::as_str) == Some(decision)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, LocalAgentStoreError> {
        self.connection.lock().map_err(|_| {
            LocalAgentStoreError::new("session_store_lock_failed", "Session Store 锁已损坏。")
        })
    }
}

fn migrate_session_store_v2_to_v3(
    connection: &mut Connection,
) -> Result<(), LocalAgentStoreError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error("session_store_migration_transaction_failed"))?;
    transaction
        .execute_batch(
            r#"
            ALTER TABLE session_events RENAME TO session_events_v2;
            DROP INDEX one_run_settlement;
            DROP INDEX session_events_run_idx;
            DROP INDEX session_events_call_idx;

            CREATE TABLE session_events (
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
                    'message.feedback.updated',
                    'narrative.committed',
                    'interaction.requested',
                    'interaction.resolved',
                    'plan.published',
                    'plan.confirmed',
                    'plan.revision.requested',
                    'plan.superseded',
                    'plan.cancelled',
                    'plan.completed',
                    'plan.invalidated',
                    'todo.seeded',
                    'todo.reconciled',
                    'todo.progressed',
                    'tool.requested',
                    'approval.requested',
                    'approval.resolved',
                    'tool.completed',
                    'session.control.rejected',
                    'context.compaction.requested',
                    'context.compacted',
                    'context.composed',
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

            INSERT INTO session_events(
                session_id, sequence, event_id, event_type, run_id, call_id,
                payload_json, occurred_at
            )
            SELECT
                session_id, sequence, event_id, event_type, run_id, call_id,
                CASE
                    WHEN event_type='context.composed'
                         AND json_type(payload_json, '$.purpose') IS NULL
                    THEN json_set(payload_json, '$.purpose', 'agent')
                    ELSE payload_json
                END,
                occurred_at
            FROM session_events_v2
            ORDER BY session_id, sequence;

            DROP TABLE session_events_v2;

            CREATE UNIQUE INDEX one_run_settlement
                ON session_events(session_id, run_id)
                WHERE event_type = 'run.settled';
            CREATE INDEX session_events_run_idx
                ON session_events(session_id, run_id, sequence);
            CREATE INDEX session_events_call_idx
                ON session_events(session_id, call_id, sequence);
            PRAGMA user_version = 3;
            "#,
        )
        .map_err(sql_error("session_store_migration_failed"))?;
    transaction
        .commit()
        .map_err(sql_error("session_store_migration_commit_failed"))
}

/// Explicit Session deletion is the sole lifecycle operation that removes
/// retained Kernel records. Both databases use rollback journals, so the
/// Session archive and its ToolRecords are removed in one SQLite transaction
/// spanning the attached owner databases.
pub(crate) fn delete_session_archive(
    session_store_path: &Path,
    tool_record_store_path: &Path,
    session_id: &str,
) -> Result<usize, LocalAgentStoreError> {
    validate_id("sessionId", session_id)?;
    if session_store_path == tool_record_store_path {
        return Err(LocalAgentStoreError::new(
            "session_archive_store_identity_invalid",
            "Session Store 与 ToolRecord Store 不能使用同一路径。",
        ));
    }
    let tool_store_path = tool_record_store_path.to_str().ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_archive_store_path_invalid",
            "ToolRecord Store 路径不是有效 UTF-8。",
        )
    })?;
    let mut connection = Connection::open(session_store_path).map_err(sql_open_error)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(sql_error("session_archive_busy_timeout_failed"))?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
        .map_err(sql_error("session_archive_pragma_failed"))?;
    connection
        .execute(
            "ATTACH DATABASE ?1 AS tool_archive",
            params![tool_store_path],
        )
        .map_err(sql_error("session_archive_tool_store_attach_failed"))?;
    let tool_table_present: bool = connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM tool_archive.sqlite_schema
                 WHERE type='table' AND name='tool_records'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error("session_archive_tool_store_verify_failed"))?;
    if !tool_table_present {
        return Err(LocalAgentStoreError::new(
            "session_archive_tool_store_incomplete",
            "ToolRecord Store 缺少 tool_records 表。",
        ));
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error("session_archive_delete_transaction_failed"))?;
    let tool_record_count = transaction
        .execute(
            "DELETE FROM tool_archive.tool_records WHERE session_id=?1",
            params![session_id],
        )
        .map_err(sql_error("session_archive_tool_records_delete_failed"))?;
    let session_count = transaction
        .execute(
            "DELETE FROM main.sessions WHERE session_id=?1",
            params![session_id],
        )
        .map_err(sql_error("session_delete_failed"))?;
    if session_count == 0 {
        return Err(LocalAgentStoreError::new(
            "session_not_found",
            "Session 不存在。",
        ));
    }
    transaction
        .commit()
        .map_err(sql_error("session_archive_delete_commit_failed"))?;
    Ok(tool_record_count)
}

fn insert_event(
    transaction: &Transaction<'_>,
    event: &Value,
    allow_creation: bool,
) -> Result<Value, LocalAgentStoreError> {
    validate_new_event(event, allow_creation)?;
    validate_event_facts(transaction, event)?;
    let session_id = required_string(event, "sessionId")?;
    let event_type = required_string(event, "type")?;
    let sequence: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_events WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(sql_error("session_event_sequence_failed"))?;
    let event_id = random_id("event")?;
    let occurred_at = crate::now_text();
    let payload = event.get("payload").expect("validated payload");
    transaction
        .execute(
            "INSERT INTO session_events(
                 session_id, sequence, event_id, event_type, run_id, call_id,
                 payload_json, occurred_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                session_id,
                sequence,
                event_id,
                event_type,
                event.get("runId").and_then(Value::as_str),
                event.get("callId").and_then(Value::as_str),
                encode_json(payload, "session_event_encode_failed")?,
                occurred_at,
            ],
        )
        .map_err(sql_error("session_event_append_failed"))?;
    let mut committed = event.clone();
    committed["schemaVersion"] = json!(EVENT_VERSION);
    committed["eventId"] = json!(event_id);
    committed["sequence"] = json!(sequence);
    committed["occurredAt"] = json!(occurred_at);
    Ok(committed)
}

fn validate_new_event(event: &Value, allow_creation: bool) -> Result<(), LocalAgentStoreError> {
    let object = exact_object(
        event,
        &["type", "sessionId", "payload"],
        &["runId", "callId"],
    )?;
    let session_id = required_string(event, "sessionId")?;
    let event_type = required_string(event, "type")?;
    validate_id("sessionId", session_id)?;
    if !object.get("payload").is_some_and(Value::is_object) {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Session Event payload 必须是对象。",
        ));
    }
    let allowed = [
        "session.created",
        "session.directory-index.attached",
        "session.directory-index.detached",
        "input.accepted",
        "run.started",
        "run.profile.selected",
        "message.committed",
        "message.feedback.updated",
        "narrative.committed",
        "interaction.requested",
        "interaction.resolved",
        "plan.published",
        "plan.confirmed",
        "plan.revision.requested",
        "plan.superseded",
        "plan.cancelled",
        "plan.completed",
        "plan.invalidated",
        "todo.seeded",
        "todo.reconciled",
        "todo.progressed",
        "tool.requested",
        "approval.requested",
        "approval.resolved",
        "tool.completed",
        "session.control.rejected",
        "context.compaction.requested",
        "context.compacted",
        "context.composed",
        "context.updated",
        "run.waiting",
        "run.settled",
    ];
    if !allowed.contains(&event_type) || event_type == "session.created" && !allow_creation {
        return Err(LocalAgentStoreError::new(
            "session_event_type_invalid",
            format!("当前 Session 合同不接受事件：{event_type}"),
        ));
    }
    let needs_run = !matches!(
        event_type,
        "session.created"
            | "session.directory-index.attached"
            | "session.directory-index.detached"
            | "input.accepted"
            | "message.committed"
            | "message.feedback.updated"
    );
    let needs_call = matches!(
        event_type,
        "plan.published"
            | "plan.confirmed"
            | "plan.revision.requested"
            | "plan.cancelled"
            | "todo.progressed"
            | "tool.requested"
            | "approval.requested"
            | "approval.resolved"
            | "tool.completed"
            | "session.control.rejected"
    );
    if needs_run {
        validate_id("runId", required_string(event, "runId")?)?;
    } else if let Some(run_id) = event.get("runId") {
        validate_id(
            "runId",
            run_id.as_str().ok_or_else(|| {
                LocalAgentStoreError::new("session_event_invalid", "runId 无效。")
            })?,
        )?;
    }
    if needs_call {
        validate_id("callId", required_string(event, "callId")?)?;
    }
    if matches!(
        event_type,
        "interaction.requested"
            | "plan.published"
            | "todo.progressed"
            | "tool.requested"
            | "session.control.rejected"
    ) {
        let payload = event.get("payload").expect("validated payload");
        let provider_call_id = required_string(payload, "providerCallId")?;
        validate_id("providerCallId", provider_call_id)?;
        let logical_call_id = match event_type {
            "interaction.requested" => required_string(payload, "interactionId")?,
            _ => required_string(event, "callId")?,
        };
        if provider_call_id == logical_call_id {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Session LogicalCallId 不能复用 providerCallId。",
            ));
        }
        if event_type == "plan.published" {
            let plan_id = required_string(payload, "planId")?;
            validate_id("planId", plan_id)?;
            if plan_id == logical_call_id || plan_id == provider_call_id {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "PlanId、LogicalCallId 与 providerCallId 必须互不复用。",
                ));
            }
        }
    }
    match event_type {
        "session.directory-index.attached" => {
            let payload = event.get("payload").expect("validated payload");
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_workspace_bindings(&Value::Array(vec![payload
                .get("workspaceBinding")
                .cloned()
                .ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "session_event_invalid",
                        "directory-index attached 缺少 workspaceBinding。",
                    )
                })?]))?;
        }
        "session.directory-index.detached" => {
            let payload = event.get("payload").expect("validated payload");
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("workspaceId", required_string(payload, "workspaceId")?)?;
        }
        "run.started" => {
            let payload = event.get("payload").expect("validated payload");
            validate_workspace_bindings(payload.get("workspaceBindings").ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "run.started 缺少 workspaceBindings。",
                )
            })?)?;
        }
        "message.committed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["messageId", "role", "content"],
                &["attachments", "directoryAttachments"],
            )?;
            validate_id("messageId", required_string(payload, "messageId")?)?;
            if !matches!(
                required_string(payload, "role")?,
                "user" | "assistant" | "tool" | "system"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "message.committed role 无效。",
                ));
            }
            if payload.get("content").and_then(Value::as_str).is_none() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "message.committed content 必须是字符串。",
                ));
            }
            if let Some(attachments) = payload.get("directoryAttachments") {
                let bindings = validate_workspace_bindings(attachments)?;
                if bindings.len() > 8 {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "单条消息最多包含八个目录附件。",
                    ));
                }
            }
        }
        "message.feedback.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["commandId", "messageId", "feedback"], &[])?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("messageId", required_string(payload, "messageId")?)?;
            validate_feedback(payload.get("feedback").expect("validated feedback"))?;
        }
        "plan.published" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "providerCallId",
                    "planId",
                    "revision",
                    "title",
                    "summary",
                    "steps",
                    "mutationManifest",
                ],
                &[],
            )?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_display_text(payload, "title", 240)?;
            required_string(payload, "summary")?;
            validate_plan_steps(payload.get("steps").expect("validated steps"))?;
            validate_plan_operations(
                payload
                    .get("mutationManifest")
                    .expect("validated mutation manifest"),
            )?;
        }
        "plan.confirmed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "planId",
                    "revision",
                    "commandId",
                    "decisionId",
                    "authorities",
                ],
                &[],
            )?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("decisionId", required_string(payload, "decisionId")?)?;
            validate_plan_authorities(payload)?;
        }
        "plan.revision.requested" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["planId", "revision", "commandId", "text"], &[])?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            required_string(payload, "text")?;
        }
        "plan.superseded" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "planId",
                    "revision",
                    "supersededByPlanId",
                    "supersededByRevision",
                ],
                &[],
            )?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_id(
                "supersededByPlanId",
                required_string(payload, "supersededByPlanId")?,
            )?;
            required_positive_revision(payload, "supersededByRevision")?;
        }
        "plan.cancelled" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["planId", "revision", "commandId"], &[])?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
        }
        "plan.completed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["planId", "revision"], &[])?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
        }
        "plan.invalidated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["planId", "revision", "reason", "sourceFactRef"],
                &[],
            )?;
            validate_id("planId", required_string(payload, "planId")?)?;
            required_positive_revision(payload, "revision")?;
            required_string(payload, "reason")?;
            validate_id("sourceFactRef", required_string(payload, "sourceFactRef")?)?;
        }
        "todo.seeded" | "todo.reconciled" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["sourcePlanId", "sourcePlanRevision", "items"],
                &[],
            )?;
            validate_id("sourcePlanId", required_string(payload, "sourcePlanId")?)?;
            required_positive_revision(payload, "sourcePlanRevision")?;
            validate_todo_items(payload.get("items").expect("validated todo items"))?;
        }
        "todo.progressed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "providerCallId",
                    "sourcePlanId",
                    "sourcePlanRevision",
                    "updates",
                ],
                &[],
            )?;
            validate_id("sourcePlanId", required_string(payload, "sourcePlanId")?)?;
            required_positive_revision(payload, "sourcePlanRevision")?;
            let updates = payload
                .get("updates")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "session_event_invalid",
                        "todo.progressed updates 必须是数组。",
                    )
                })?;
            if updates.is_empty() || updates.len() > 12 {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "todo.progressed 必须包含一至十二项更新。",
                ));
            }
            let mut todo_ids = std::collections::HashSet::with_capacity(updates.len());
            for item in updates {
                exact_object(item, &["todoId", "status"], &[])?;
                let todo_id = required_string(item, "todoId")?;
                validate_id("todoId", todo_id)?;
                if !todo_ids.insert(todo_id) {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "todo.progressed 包含重复 todoId。",
                    ));
                }
                if !matches!(
                    required_string(item, "status")?,
                    "pending" | "inProgress" | "completed"
                ) {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "todo.progressed status 无效。",
                    ));
                }
            }
        }
        "session.control.rejected" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["providerCallId", "toolName", "input", "error"],
                &[],
            )?;
            if !matches!(
                required_string(payload, "toolName")?,
                "interaction.request" | "plan.publish" | "todo.progress" | "context.focus"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "session.control.rejected toolName 不是 Session control。",
                ));
            }
            if !payload.get("input").is_some_and(Value::is_object) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "session.control.rejected input 必须是对象。",
                ));
            }
            let error = payload.get("error").expect("validated error");
            exact_object(error, &["code", "message"], &[])?;
            required_string(error, "code")?;
            required_string(error, "message")?;
        }
        "context.compaction.requested" => {
            let payload = event.get("payload").expect("validated payload");
            let trigger = required_string(payload, "trigger")?;
            match trigger {
                "pressure" => {
                    exact_object(
                        payload,
                        &["compactionId", "providerRequestId", "trigger", "coveredThroughSequence"],
                        &[],
                    )?;
                    if event.get("callId").is_some() {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "Pressure compaction 不能携带 callId。",
                        ));
                    }
                }
                "userFocus" => {
                    exact_object(
                        payload,
                        &[
                            "compactionId", "providerRequestId", "trigger",
                            "coveredThroughSequence", "focus", "commandId",
                        ],
                        &[],
                    )?;
                    validate_id("commandId", required_string(payload, "commandId")?)?;
                    validate_focus_text(required_string(payload, "focus")?)?;
                    if event.get("callId").is_some() {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "User focus compaction 不能携带 callId。",
                        ));
                    }
                }
                "agentFocus" => {
                    exact_object(
                        payload,
                        &[
                            "compactionId", "providerRequestId", "trigger",
                            "coveredThroughSequence", "focus", "providerCallId",
                        ],
                        &[],
                    )?;
                    let call_id = required_string(event, "callId")?;
                    validate_id("callId", call_id)?;
                    let provider_call_id = required_string(payload, "providerCallId")?;
                    validate_id("providerCallId", provider_call_id)?;
                    validate_focus_text(required_string(payload, "focus")?)?;
                    if call_id == provider_call_id {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "context.focus LogicalCallId 不能复用 providerCallId。",
                        ));
                    }
                }
                _ => {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "context.compaction.requested trigger 无效。",
                    ))
                }
            }
            validate_id("compactionId", required_string(payload, "compactionId")?)?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            required_u64(payload, "coveredThroughSequence")?;
        }
        "context.compacted" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "compactionId", "providerRequestId", "trigger",
                    "coveredThroughSequence", "summary",
                ],
                &[],
            )?;
            validate_id("compactionId", required_string(payload, "compactionId")?)?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            if !matches!(
                required_string(payload, "trigger")?,
                "pressure" | "userFocus" | "agentFocus"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.compacted trigger 无效。",
                ));
            }
            required_u64(payload, "coveredThroughSequence")?;
            let summary = required_string(payload, "summary")?;
            if summary.trim().is_empty() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.compacted summary 不能为空。",
                ));
            }
            if required_string(payload, "trigger")? == "agentFocus" {
                validate_id("callId", required_string(event, "callId")?)?;
            } else if event.get("callId").is_some() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "非 Agent focus 的 context.compacted 不能携带 callId。",
                ));
            }
        }
        "context.composed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "providerRequestId",
                    "purpose",
                    "responseConstraint",
                    "messages",
                    "workspaceBindings",
                    "tools",
                    "partitions",
                ],
                &[],
            )?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            if !matches!(
                required_string(payload, "purpose")?,
                "agent" | "contextCompaction"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.composed purpose 无效。",
                ));
            }
            if !matches!(
                required_string(payload, "responseConstraint")?,
                "normal" | "answerOnly"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.composed responseConstraint 无效。",
                ));
            }
            validate_context_messages(payload.get("messages").expect("validated messages"))?;
            validate_context_items(
                payload
                    .get("workspaceBindings")
                    .expect("validated workspace bindings"),
                "workspaceBindings",
            )?;
            validate_context_items(payload.get("tools").expect("validated tools"), "tools")?;
            validate_context_partitions(payload.get("partitions").expect("validated partitions"))?;
        }
        "context.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "providerRequestId",
                    "inputTokens",
                    "outputTokens",
                    "contextWindowTokens",
                ],
                &["cacheReadInputTokens", "cacheMissInputTokens"],
            )?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            let input_tokens = required_u64(payload, "inputTokens")?;
            let output_tokens = required_u64(payload, "outputTokens")?;
            let context_window_tokens = required_u64(payload, "contextWindowTokens")?;
            if context_window_tokens == 0
                || input_tokens
                    .checked_add(output_tokens)
                    .is_none_or(|total| total > context_window_tokens)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.updated token 用量超过上下文窗口。",
                ));
            }
            let cache_read = payload.get("cacheReadInputTokens");
            let cache_miss = payload.get("cacheMissInputTokens");
            if cache_read.is_some() != cache_miss.is_some() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.updated 缓存读取和未命中字段必须同时存在。",
                ));
            }
            if cache_read.is_some() {
                let read = required_u64(payload, "cacheReadInputTokens")?;
                let miss = required_u64(payload, "cacheMissInputTokens")?;
                if read
                    .checked_add(miss)
                    .is_none_or(|total| total > input_tokens)
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "context.updated 缓存 token 超过输入 token。",
                    ));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_event_facts(
    transaction: &Transaction<'_>,
    event: &Value,
) -> Result<(), LocalAgentStoreError> {
    let event_type = required_string(event, "type")?;
    if event_type == "session.created" {
        return Ok(());
    }
    let session_id = required_string(event, "sessionId")?;
    if matches!(
        event_type,
        "plan.published"
            | "plan.confirmed"
            | "plan.revision.requested"
            | "plan.superseded"
            | "plan.cancelled"
            | "plan.completed"
            | "todo.seeded"
            | "todo.reconciled"
            | "todo.progressed"
            | "session.control.rejected"
            | "context.compaction.requested"
            | "context.compacted"
            | "context.composed"
            | "context.updated"
    ) {
        let run_id = required_string(event, "runId")?;
        let run_started: bool = transaction
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM session_events
                     WHERE session_id=?1 AND run_id=?2 AND event_type='run.started'
                 )",
                params![session_id, run_id],
                |row| row.get(0),
            )
            .map_err(sql_error("session_event_fact_read_failed"))?;
        let run_settled: bool = transaction
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM session_events
                     WHERE session_id=?1 AND run_id=?2 AND event_type='run.settled'
                 )",
                params![session_id, run_id],
                |row| row.get(0),
            )
            .map_err(sql_error("session_event_fact_read_failed"))?;
        if !run_started || run_settled {
            return Err(LocalAgentStoreError::new(
                "session_event_run_not_active",
                format!("{event_type} 必须关联已开始且未 settled 的当前 run。"),
            ));
        }
    }
    match event_type {
        "plan.published" | "todo.progressed" => {
            let call_id = required_string(event, "callId")?;
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND call_id=?2
                           AND event_type IN ('plan.published', 'todo.progressed', 'tool.requested',
                                              'interaction.requested', 'session.control.rejected')
                     )",
                    params![session_id, call_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if duplicate {
                return Err(LocalAgentStoreError::new(
                    "session_root_call_duplicate",
                    "Provider-origin LogicalCallId 已经写入当前 Session。",
                ));
            }
            let payload = event.get("payload").expect("validated payload");
            if event_type == "plan.published" {
                let plan_id = required_string(payload, "planId")?;
                let revision = required_positive_revision(payload, "revision")?;
                let revision_sql = i64::try_from(revision).map_err(|_| {
                    LocalAgentStoreError::new(
                        "session_event_invalid",
                        "Plan revision 超出 SQLite 整数范围。",
                    )
                })?;
                let plan_duplicate: bool = transaction
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM session_events
                             WHERE session_id=?1 AND event_type='plan.published'
                               AND json_extract(payload_json, '$.planId')=?2
                               AND json_extract(payload_json, '$.revision')=?3
                         )",
                        params![session_id, plan_id, revision_sql],
                        |row| row.get(0),
                    )
                    .map_err(sql_error("session_event_fact_read_failed"))?;
                if plan_duplicate {
                    return Err(LocalAgentStoreError::new(
                        "plan_revision_duplicate",
                        "Plan revision 已经发布。",
                    ));
                }
            } else {
                let plan_id = required_string(payload, "sourcePlanId")?;
                let revision = required_positive_revision(payload, "sourcePlanRevision")?;
                if !plan_revision_is_active(transaction, session_id, plan_id, revision)? {
                    return Err(LocalAgentStoreError::new(
                        "todo_source_plan_inactive",
                        "todo.progressed 必须引用当前 active confirmed Plan revision。",
                    ));
                }
                let todo = todo_state_for_plan(transaction, session_id, plan_id, revision)?
                    .ok_or_else(|| {
                        LocalAgentStoreError::new(
                            "todo_source_missing",
                            "todo.progressed 缺少对应的 seeded/reconciled Todo。",
                        )
                    })?;
                for update in payload
                    .get("updates")
                    .and_then(Value::as_array)
                    .expect("validated updates")
                {
                    if !todo.contains_key(required_string(update, "todoId")?) {
                        return Err(LocalAgentStoreError::new(
                            "todo_item_missing",
                            "todo.progressed 引用了不存在的 todoId。",
                        ));
                    }
                }
            }
        }
        "plan.confirmed" | "plan.revision.requested" | "plan.cancelled" => {
            let payload = event.get("payload").expect("validated payload");
            let run_id = required_string(event, "runId")?;
            let call_id = required_string(event, "callId")?;
            let plan_id = required_string(payload, "planId")?;
            let revision = required_positive_revision(payload, "revision")?;
            let revision_sql = i64::try_from(revision).map_err(|_| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Plan revision 超出 SQLite 整数范围。",
                )
            })?;
            let publication_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2 AND call_id=?3
                           AND event_type='plan.published'
                           AND json_extract(payload_json, '$.planId')=?4
                           AND json_extract(payload_json, '$.revision')=?5
                     )",
                    params![session_id, run_id, call_id, plan_id, revision_sql],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let decision_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND call_id=?2
                           AND event_type IN ('plan.confirmed', 'plan.revision.requested', 'plan.cancelled')
                           AND json_extract(payload_json, '$.planId')=?3
                           AND json_extract(payload_json, '$.revision')=?4
                     )",
                    params![session_id, call_id, plan_id, revision_sql],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if !publication_exists || decision_exists {
                return Err(LocalAgentStoreError::new(
                    "plan_decision_fact_invalid",
                    "Plan decision 必须精确引用仍未裁决的 publication。",
                ));
            }
        }
        "todo.seeded" | "todo.reconciled" => {
            let payload = event.get("payload").expect("validated payload");
            let plan_id = required_string(payload, "sourcePlanId")?;
            let revision = required_positive_revision(payload, "sourcePlanRevision")?;
            if !plan_revision_is_active(transaction, session_id, plan_id, revision)? {
                return Err(LocalAgentStoreError::new(
                    "todo_source_plan_inactive",
                    "Todo seed/reconcile 必须引用刚确认且 active 的 Plan revision。",
                ));
            }
        }
        "plan.completed" => {
            let payload = event.get("payload").expect("validated payload");
            let plan_id = required_string(payload, "planId")?;
            let revision = required_positive_revision(payload, "revision")?;
            if !plan_revision_is_active(transaction, session_id, plan_id, revision)? {
                return Err(LocalAgentStoreError::new(
                    "plan_completion_inactive",
                    "只有 active confirmed Plan revision 可以完成。",
                ));
            }
            let todo = todo_state_for_plan(transaction, session_id, plan_id, revision)?
                .ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "plan_completion_todo_missing",
                        "Plan completion 缺少 Todo。",
                    )
                })?;
            if todo.is_empty() || todo.values().any(|status| status != "completed") {
                return Err(LocalAgentStoreError::new(
                    "plan_completion_todo_incomplete",
                    "Plan completion 要求对应 Todo 全部完成。",
                ));
            }
        }
        "plan.superseded" => {
            let payload = event.get("payload").expect("validated payload");
            let plan_id = required_string(payload, "planId")?;
            let revision = required_positive_revision(payload, "revision")?;
            let next_plan_id = required_string(payload, "supersededByPlanId")?;
            let next_revision = required_positive_revision(payload, "supersededByRevision")?;
            if plan_id == next_plan_id && revision == next_revision
                || !plan_revision_can_be_superseded(transaction, session_id, plan_id, revision)?
            {
                return Err(LocalAgentStoreError::new(
                    "plan_supersede_invalid",
                    "plan.superseded 必须引用不同的新 Plan revision 和当前 active revision。",
                ));
            }
        }
        "plan.invalidated" => {
            let payload = event.get("payload").expect("validated payload");
            if !plan_revision_is_active(
                transaction,
                session_id,
                required_string(payload, "planId")?,
                required_positive_revision(payload, "revision")?,
            )? {
                return Err(LocalAgentStoreError::new(
                    "plan_invalidation_inactive",
                    "plan.invalidated 只能作用于 active confirmed revision。",
                ));
            }
        }
        "session.control.rejected" => {
            let call_id = required_string(event, "callId")?;
            let run_id = required_string(event, "runId")?;
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND call_id=?2
                           AND event_type='session.control.rejected'
                     )",
                    params![session_id, call_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let prior_count: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM session_events
                     WHERE session_id=?1 AND run_id=?2
                       AND event_type='session.control.rejected'",
                    params![session_id, run_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if duplicate || prior_count >= 2 {
                return Err(LocalAgentStoreError::new(
                    "session_control_rejection_invalid",
                    "Session control 拒绝回执重复或超过同一 run 的一次纠正机会。",
                ));
            }
        }
        "context.compaction.requested" => {
            let payload = event.get("payload").expect("validated payload");
            let compaction_id = required_string(payload, "compactionId")?;
            let provider_request_id = required_string(payload, "providerRequestId")?;
            let covered = required_u64(payload, "coveredThroughSequence")?;
            let current_sequence: i64 = transaction
                .query_row(
                    "SELECT COALESCE(MAX(sequence), 0) FROM session_events WHERE session_id=?1",
                    params![session_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let current_sequence = u64::try_from(current_sequence).map_err(|_| {
                LocalAgentStoreError::new(
                    "session_event_fact_invalid",
                    "Session event sequence 不能为负数。",
                )
            })?;
            if covered > current_sequence {
                return Err(LocalAgentStoreError::new(
                    "context_compaction_cutoff_invalid",
                    "上下文压缩 cutoff 超出当前 Session revision。",
                ));
            }
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND event_type='context.compaction.requested'
                           AND (
                             json_extract(payload_json, '$.compactionId')=?2
                             OR json_extract(payload_json, '$.providerRequestId')=?3
                           )
                     )",
                    params![session_id, compaction_id, provider_request_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if duplicate {
                return Err(LocalAgentStoreError::new(
                    "context_compaction_identity_duplicate",
                    "上下文压缩身份或 Provider request 身份重复。",
                ));
            }
            if required_string(payload, "trigger")? == "agentFocus" {
                let call_id = required_string(event, "callId")?;
                let call_duplicate: bool = transaction
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM session_events
                             WHERE session_id=?1 AND call_id=?2
                               AND event_type IN (
                                 'plan.published', 'todo.progressed', 'tool.requested',
                                 'interaction.requested', 'session.control.rejected',
                                 'context.compaction.requested'
                               )
                         )",
                        params![session_id, call_id],
                        |row| row.get(0),
                    )
                    .map_err(sql_error("session_event_fact_read_failed"))?;
                if call_duplicate {
                    return Err(LocalAgentStoreError::new(
                        "session_root_call_duplicate",
                        "Provider-origin LogicalCallId 已经写入当前 Session。",
                    ));
                }
            }
        }
        "context.compacted" => {
            let payload = event.get("payload").expect("validated payload");
            let compaction_id = required_string(payload, "compactionId")?;
            let run_id = required_string(event, "runId")?;
            let requested: Option<(String, Option<String>)> = transaction
                .query_row(
                    "SELECT payload_json, call_id FROM session_events
                     WHERE session_id=?1 AND run_id=?2
                       AND event_type='context.compaction.requested'
                       AND json_extract(payload_json, '$.compactionId')=?3",
                    params![session_id, run_id, compaction_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let Some((requested_json, requested_call_id)) = requested else {
                return Err(LocalAgentStoreError::new(
                    "context_compaction_request_missing",
                    "context.compacted 缺少对应的 requested 事实。",
                ));
            };
            let requested_payload: Value = serde_json::from_str(&requested_json).map_err(|_| {
                LocalAgentStoreError::new(
                    "session_event_fact_invalid",
                    "已持久化的上下文压缩请求不是有效 JSON。",
                )
            })?;
            if required_string(&requested_payload, "providerRequestId")?
                != required_string(payload, "providerRequestId")?
                || required_string(&requested_payload, "trigger")?
                    != required_string(payload, "trigger")?
                || required_u64(&requested_payload, "coveredThroughSequence")?
                    != required_u64(payload, "coveredThroughSequence")?
                || requested_call_id.as_deref()
                    != event.get("callId").and_then(Value::as_str)
            {
                return Err(LocalAgentStoreError::new(
                    "context_compaction_completion_mismatch",
                    "context.compacted 与 requested 身份或 cutoff 不一致。",
                ));
            }
            let provider_request_id = required_string(payload, "providerRequestId")?;
            let receipt_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2 AND event_type='context.composed'
                           AND json_extract(payload_json, '$.providerRequestId')=?3
                           AND json_extract(payload_json, '$.purpose')='contextCompaction'
                     )",
                    params![session_id, run_id, provider_request_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND event_type='context.compacted'
                           AND json_extract(payload_json, '$.compactionId')=?2
                     )",
                    params![session_id, compaction_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if !receipt_exists || duplicate {
                return Err(LocalAgentStoreError::new(
                    "context_compaction_completion_invalid",
                    "context.compacted 缺少压缩专用 composition receipt 或已经完成。",
                ));
            }
        }
        "context.composed" => {
            let provider_request_id = required_string(
                event.get("payload").expect("validated payload"),
                "providerRequestId",
            )?;
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND event_type='context.composed'
                           AND json_extract(payload_json, '$.providerRequestId')=?2
                     )",
                    params![session_id, provider_request_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if duplicate {
                return Err(LocalAgentStoreError::new(
                    "provider_request_receipt_duplicate",
                    "providerRequestId 已经存在 composition receipt。",
                ));
            }
            let purpose = required_string(
                event.get("payload").expect("validated payload"),
                "purpose",
            )?;
            let compaction_request_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2
                           AND event_type='context.compaction.requested'
                           AND json_extract(payload_json, '$.providerRequestId')=?3
                     )",
                    params![
                        session_id,
                        required_string(event, "runId")?,
                        provider_request_id,
                    ],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if (purpose == "contextCompaction") != compaction_request_exists {
                return Err(LocalAgentStoreError::new(
                    "context_composition_purpose_mismatch",
                    "context.composed purpose 与压缩请求事实不一致。",
                ));
            }
        }
        "context.updated" => {
            let run_id = required_string(event, "runId")?;
            let provider_request_id = required_string(
                event.get("payload").expect("validated payload"),
                "providerRequestId",
            )?;
            let receipt_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2 AND event_type='context.composed'
                           AND json_extract(payload_json, '$.providerRequestId')=?3
                     )",
                    params![session_id, run_id, provider_request_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let duplicate_usage: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND event_type='context.updated'
                           AND json_extract(payload_json, '$.providerRequestId')=?2
                     )",
                    params![session_id, provider_request_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if !receipt_exists {
                return Err(LocalAgentStoreError::new(
                    "provider_request_receipt_missing",
                    "context.updated 缺少同 run 的 context.composed receipt。",
                ));
            }
            if duplicate_usage {
                return Err(LocalAgentStoreError::new(
                    "provider_usage_duplicate",
                    "providerRequestId 已经写入 token usage。",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn plan_revision_is_active(
    transaction: &Transaction<'_>,
    session_id: &str,
    plan_id: &str,
    revision: u64,
) -> Result<bool, LocalAgentStoreError> {
    let mut statement = transaction
        .prepare(
            "SELECT event_type, payload_json FROM session_events
             WHERE session_id=?1 AND event_type IN (
               'plan.confirmed', 'plan.revision.requested', 'plan.superseded',
               'plan.cancelled', 'plan.completed', 'plan.invalidated'
             ) ORDER BY sequence ASC",
        )
        .map_err(sql_error("session_event_fact_read_failed"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql_error("session_event_fact_read_failed"))?;
    let mut active = false;
    for row in rows {
        let (event_type, encoded) = row.map_err(sql_error("session_event_fact_read_failed"))?;
        let payload = decode_json(&encoded, "session_event_fact_corrupt")?;
        let same = payload.get("planId").and_then(Value::as_str) == Some(plan_id)
            && payload.get("revision").and_then(Value::as_u64) == Some(revision);
        if event_type == "plan.confirmed" {
            active = same;
        } else if same {
            active = false;
        }
    }
    Ok(active)
}

fn plan_revision_can_be_superseded(
    transaction: &Transaction<'_>,
    session_id: &str,
    plan_id: &str,
    revision: u64,
) -> Result<bool, LocalAgentStoreError> {
    let mut statement = transaction
        .prepare(
            "SELECT event_type, payload_json FROM session_events
             WHERE session_id=?1 AND event_type IN (
               'plan.confirmed', 'plan.revision.requested', 'plan.superseded',
               'plan.cancelled', 'plan.completed', 'plan.invalidated'
             ) ORDER BY sequence ASC",
        )
        .map_err(sql_error("session_event_fact_read_failed"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql_error("session_event_fact_read_failed"))?;
    let mut state: Option<String> = None;
    for row in rows {
        let (event_type, encoded) = row.map_err(sql_error("session_event_fact_read_failed"))?;
        let payload = decode_json(&encoded, "session_event_fact_corrupt")?;
        if payload.get("planId").and_then(Value::as_str) == Some(plan_id)
            && payload.get("revision").and_then(Value::as_u64) == Some(revision)
        {
            state = Some(event_type);
        }
    }
    Ok(matches!(
        state.as_deref(),
        Some("plan.confirmed" | "plan.revision.requested")
    ))
}

fn todo_state_for_plan(
    transaction: &Transaction<'_>,
    session_id: &str,
    plan_id: &str,
    revision: u64,
) -> Result<Option<std::collections::HashMap<String, String>>, LocalAgentStoreError> {
    let mut statement = transaction
        .prepare(
            "SELECT event_type, payload_json FROM session_events
             WHERE session_id=?1 AND event_type IN (
               'todo.seeded', 'todo.reconciled', 'todo.progressed'
             ) ORDER BY sequence ASC",
        )
        .map_err(sql_error("session_event_fact_read_failed"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql_error("session_event_fact_read_failed"))?;
    let mut state: Option<std::collections::HashMap<String, String>> = None;
    for row in rows {
        let (event_type, encoded) = row.map_err(sql_error("session_event_fact_read_failed"))?;
        let payload = decode_json(&encoded, "session_event_fact_corrupt")?;
        let source_plan_id = payload.get("sourcePlanId").and_then(Value::as_str);
        let source_revision = payload.get("sourcePlanRevision").and_then(Value::as_u64);
        if source_plan_id != Some(plan_id) || source_revision != Some(revision) {
            continue;
        }
        if matches!(event_type.as_str(), "todo.seeded" | "todo.reconciled") {
            state = Some(
                payload
                    .get("items")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        LocalAgentStoreError::new(
                            "session_event_fact_corrupt",
                            "Todo seed/reconcile items 缺失。",
                        )
                    })?
                    .iter()
                    .map(|item| {
                        Ok((
                            required_string(item, "todoId")?.to_string(),
                            required_string(item, "status")?.to_string(),
                        ))
                    })
                    .collect::<Result<_, LocalAgentStoreError>>()?,
            );
        } else if let Some(current) = state.as_mut() {
            for update in payload
                .get("updates")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "session_event_fact_corrupt",
                        "Todo progress updates 缺失。",
                    )
                })?
            {
                let todo_id = required_string(update, "todoId")?;
                if let Some(status) = current.get_mut(todo_id) {
                    *status = required_string(update, "status")?.to_string();
                }
            }
        }
    }
    Ok(state)
}

fn validate_command_event_batch(
    command: &Value,
    events: &[Value],
) -> Result<(), LocalAgentStoreError> {
    if command.get("type").and_then(Value::as_str) != Some("plan.respond") {
        return Ok(());
    }
    let plan_id = required_string(command, "planId")?;
    let revision = required_positive_revision(command, "revision")?;
    let command_id = required_string(command, "commandId")?;
    let response_kind = command
        .pointer("/response/kind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_command_invalid",
                "plan.respond response kind 缺失。",
            )
        })?;
    let matching = |event: &&Value, event_type: &str| {
        event.get("type").and_then(Value::as_str) == Some(event_type)
            && event.pointer("/payload/planId").and_then(Value::as_str) == Some(plan_id)
            && event.pointer("/payload/revision").and_then(Value::as_u64) == Some(revision)
            && event.pointer("/payload/commandId").and_then(Value::as_str) == Some(command_id)
    };
    let count = |event_type: &str| {
        events
            .iter()
            .filter(|event| matching(event, event_type))
            .count()
    };
    let todo_count = events
        .iter()
        .filter(|event| {
            matches!(
                event.get("type").and_then(Value::as_str),
                Some("todo.seeded" | "todo.reconciled")
            ) && event
                .pointer("/payload/sourcePlanId")
                .and_then(Value::as_str)
                == Some(plan_id)
                && event
                    .pointer("/payload/sourcePlanRevision")
                    .and_then(Value::as_u64)
                    == Some(revision)
        })
        .count();
    let valid = match response_kind {
        "confirm" => {
            count("plan.confirmed") == 1
                && todo_count == 1
                && count("plan.revision.requested") == 0
                && count("plan.cancelled") == 0
        }
        "requestRevision" => {
            count("plan.revision.requested") == 1
                && count("plan.confirmed") == 0
                && count("plan.cancelled") == 0
                && todo_count == 0
        }
        "cancel" => {
            count("plan.cancelled") == 1
                && count("plan.confirmed") == 0
                && count("plan.revision.requested") == 0
                && todo_count == 0
        }
        _ => false,
    };
    if !valid {
        return Err(LocalAgentStoreError::new(
            "plan_command_event_batch_invalid",
            "plan.respond 必须与对应 Plan lifecycle 和 Todo 事实原子提交。",
        ));
    }
    Ok(())
}

fn validate_command(command: &Value) -> Result<(), LocalAgentStoreError> {
    let object = command.as_object().ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_command_invalid",
            "Conversation command 必须是对象。",
        )
    })?;
    if object.get("schemaVersion").and_then(Value::as_str) != Some(COMMAND_VERSION) {
        return Err(LocalAgentStoreError::new(
            "session_command_version_invalid",
            "只接受 deepcode.command。",
        ));
    }
    validate_id("sessionId", required_string(command, "sessionId")?)?;
    validate_id("commandId", required_string(command, "commandId")?)?;
    let command_type = required_string(command, "type")?;
    if ![
        "session.directory-index.attach",
        "session.directory-index.detach",
        "message.submit",
        "message.feedback.set",
        "run.profile.select",
        "run.cancel",
        "interaction.respond",
        "approval.respond",
        "plan.respond",
    ]
    .contains(&command_type)
    {
        return Err(LocalAgentStoreError::new(
            "session_command_type_invalid",
            format!("当前 Session 合同不接受命令：{command_type}"),
        ));
    }
    if command_type == "message.feedback.set" {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "messageId",
                "feedback",
            ],
            &[],
        )?;
        validate_id("messageId", required_string(command, "messageId")?)?;
        validate_feedback(command.get("feedback").expect("validated feedback"))?;
    }
    if command_type == "message.submit" {
        exact_object(
            command,
            &["schemaVersion", "type", "commandId", "sessionId", "text"],
            &["attachments", "directoryAttachments", "profileId"],
        )?;
        if required_string(command, "text")?.trim().is_empty() {
            return Err(LocalAgentStoreError::new(
                "session_command_invalid",
                "message.submit text 不能为空。",
            ));
        }
        if let Some(profile_id) = command.get("profileId") {
            validate_id(
                "profileId",
                profile_id.as_str().ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "session_command_invalid",
                        "message.submit profileId 无效。",
                    )
                })?,
            )?;
        }
        if let Some(attachments) = command.get("directoryAttachments") {
            let bindings = validate_workspace_bindings(attachments)?;
            if bindings.len() > 8 {
                return Err(LocalAgentStoreError::new(
                    "session_command_invalid",
                    "单次消息最多附加八个目录。",
                ));
            }
        }
    }
    if command_type == "plan.respond" {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "runId",
                "planId",
                "revision",
                "response",
            ],
            &[],
        )?;
        validate_id("runId", required_string(command, "runId")?)?;
        validate_id("planId", required_string(command, "planId")?)?;
        required_positive_revision(command, "revision")?;
        let response = command.get("response").ok_or_else(|| {
            LocalAgentStoreError::new("session_command_invalid", "plan.respond 缺少 response。")
        })?;
        match required_string(response, "kind")? {
            "confirm" | "cancel" => {
                exact_object(response, &["kind"], &[])?;
            }
            "requestRevision" => {
                exact_object(response, &["kind", "text"], &[])?;
                if required_string(response, "text")?.trim().is_empty() {
                    return Err(LocalAgentStoreError::new(
                        "session_command_invalid",
                        "Plan revision text 不能为空。",
                    ));
                }
            }
            _ => {
                return Err(LocalAgentStoreError::new(
                    "session_command_invalid",
                    "plan.respond response kind 无效。",
                ))
            }
        }
    }
    Ok(())
}

fn validate_feedback(value: &Value) -> Result<(), LocalAgentStoreError> {
    if value.is_null() || matches!(value.as_str(), Some("up" | "down")) {
        return Ok(());
    }
    Err(LocalAgentStoreError::new(
        "local_agent_message_invalid",
        "feedback 必须是 up、down 或 null。",
    ))
}

fn required_positive_revision(value: &Value, field: &str) -> Result<u64, LocalAgentStoreError> {
    let revision = required_u64(value, field)?;
    if revision == 0 {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            format!("{field} 必须是正整数。"),
        ));
    }
    Ok(revision)
}

fn validate_display_text(
    value: &Value,
    field: &str,
    max_chars: usize,
) -> Result<(), LocalAgentStoreError> {
    let text = required_string(value, field)?;
    if text.trim() != text || text.chars().count() > max_chars || text.chars().any(char::is_control)
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            format!("{field} 不是有效的可显示文本。"),
        ));
    }
    Ok(())
}

fn validate_focus_text(text: &str) -> Result<(), LocalAgentStoreError> {
    if text.trim() != text || text.chars().count() > 16_384 || text.contains('\0') {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "context focus 不是有效任务文本。",
        ));
    }
    Ok(())
}

fn validate_plan_steps(value: &Value) -> Result<(), LocalAgentStoreError> {
    let steps = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "Plan steps 必须是数组。")
    })?;
    if steps.is_empty() || steps.len() > 12 {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Plan 必须包含一至十二个步骤。",
        ));
    }
    let mut step_ids = std::collections::HashSet::with_capacity(steps.len());
    for step in steps {
        exact_object(step, &["stepId", "title", "details"], &["verification"])?;
        let step_id = required_string(step, "stepId")?;
        validate_id("stepId", step_id)?;
        if !step_ids.insert(step_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Plan stepId 不能重复。",
            ));
        }
        validate_display_text(step, "title", 240)?;
        required_string(step, "details")?;
        if let Some(verification) = step.get("verification") {
            let items = verification.as_array().ok_or_else(|| {
                LocalAgentStoreError::new("session_event_invalid", "Plan verification 必须是数组。")
            })?;
            if items.len() > 8
                || items
                    .iter()
                    .any(|item| item.as_str().is_none_or(|text| text.trim().is_empty()))
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Plan verification 无效。",
                ));
            }
        }
    }
    Ok(())
}

fn validate_plan_operations(value: &Value) -> Result<(), LocalAgentStoreError> {
    let operations = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            "Plan mutationManifest 必须是数组。",
        )
    })?;
    if operations.len() > 128 {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Plan mutationManifest 最多包含 128 项。",
        ));
    }
    for operation in operations {
        let name = required_string(operation, "operation")?;
        if name == "fs.delete" {
            exact_object(
                operation,
                &["workspaceId", "operation", "target", "targetKind"],
                &[],
            )?;
            if !matches!(
                required_string(operation, "targetKind")?,
                "file" | "directoryTree"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "fs.delete Plan operation 的 targetKind 无效。",
                ));
            }
        } else {
            exact_object(operation, &["workspaceId", "operation", "target"], &[])?;
            if !matches!(
                name,
                "fs.create" | "fs.write" | "fs.edit" | "fs.ensure_directory"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Plan operation 不属于闭合 mutation 集合。",
                ));
            }
        }
        validate_id("workspaceId", required_string(operation, "workspaceId")?)?;
        let target = required_string(operation, "target")?;
        if target.trim() != target
            || target.starts_with('/')
            || target.contains('\\')
            || target.contains('\0')
            || target
                .split('/')
                .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Plan target 必须是 normalized workspace-relative path。",
            ));
        }
    }
    Ok(())
}

fn validate_plan_authorities(payload: &Value) -> Result<(), LocalAgentStoreError> {
    let plan_id = required_string(payload, "planId")?;
    let revision = required_positive_revision(payload, "revision")?;
    let decision_id = required_string(payload, "decisionId")?;
    let authorities = payload
        .get("authorities")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "plan.confirmed authorities 必须是数组。",
            )
        })?;
    let mut workspace_ids = std::collections::HashSet::with_capacity(authorities.len());
    for authority in authorities {
        exact_object(
            authority,
            &[
                "authorityId",
                "planId",
                "revision",
                "decisionId",
                "sessionId",
                "workspaceId",
                "coveredOperations",
            ],
            &[],
        )?;
        for field in ["authorityId", "sessionId", "workspaceId"] {
            validate_id(field, required_string(authority, field)?)?;
        }
        if required_string(authority, "planId")? != plan_id
            || required_positive_revision(authority, "revision")? != revision
            || required_string(authority, "decisionId")? != decision_id
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Plan authority identity 与 confirmation 不一致。",
            ));
        }
        let workspace_id = required_string(authority, "workspaceId")?;
        if !workspace_ids.insert(workspace_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "每个 workspace 只能有一个 Plan authority。",
            ));
        }
        let operations = authority.get("coveredOperations").ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "Plan authority 缺少 coveredOperations。",
            )
        })?;
        validate_plan_operations(operations)?;
        if operations.as_array().is_some_and(|items| {
            items.iter().any(|operation| {
                operation.get("workspaceId").and_then(Value::as_str) != Some(workspace_id)
            })
        }) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Plan authority 只能覆盖自己的 workspace。",
            ));
        }
    }
    Ok(())
}

fn validate_todo_items(value: &Value) -> Result<(), LocalAgentStoreError> {
    let items = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "Todo items 必须是数组。")
    })?;
    if items.is_empty() || items.len() > 12 {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Todo 必须包含一至十二项。",
        ));
    }
    let mut todo_ids = std::collections::HashSet::with_capacity(items.len());
    let mut step_ids = std::collections::HashSet::with_capacity(items.len());
    for item in items {
        exact_object(item, &["todoId", "sourceStepId", "label", "status"], &[])?;
        let todo_id = required_string(item, "todoId")?;
        let step_id = required_string(item, "sourceStepId")?;
        validate_id("todoId", todo_id)?;
        validate_id("sourceStepId", step_id)?;
        if !todo_ids.insert(todo_id) || !step_ids.insert(step_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Todo todoId/sourceStepId 不能重复。",
            ));
        }
        validate_display_text(item, "label", 240)?;
        if !matches!(
            required_string(item, "status")?,
            "pending" | "inProgress" | "completed"
        ) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Todo status 无效。",
            ));
        }
    }
    Ok(())
}

fn validate_context_messages(value: &Value) -> Result<(), LocalAgentStoreError> {
    let messages = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "context messages 必须是数组。")
    })?;
    let mut contribution_ids = std::collections::HashSet::new();
    let mut call_ids = std::collections::HashSet::new();
    for (message_index, message) in messages.iter().enumerate() {
        exact_object(
            message,
            &[
                "messageIndex",
                "contributionId",
                "contributionKind",
                "label",
                "role",
                "blocks",
                "attachments",
            ],
            &[],
        )?;
        if required_u64(message, "messageIndex")? != message_index as u64 {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context messageIndex 必须与 Provider request 消息顺序一致。",
            ));
        }
        let contribution_id = required_string(message, "contributionId")?;
        validate_id("contributionId", contribution_id)?;
        if !contribution_ids.insert(contribution_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context contributionId 不能重复。",
            ));
        }
        if ![
            "instructions",
            "workspaceBindings",
            "sessionControls",
            "journalMessages",
            "contextProviders",
        ]
        .contains(&required_string(message, "contributionKind")?)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context contributionKind 无效。",
            ));
        }
        required_string(message, "label")?;
        let role = required_string(message, "role")?;
        if !["system", "user", "assistant", "tool"].contains(&role) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context message role 无效。",
            ));
        }
        let blocks = message
            .get("blocks")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context message blocks 必须是数组。",
                )
            })?;
        let mut result_count = 0usize;
        for (block_index, block) in blocks.iter().enumerate() {
            if required_u64(block, "blockIndex")? != block_index as u64 {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context blockIndex 必须连续并保持消息内顺序。",
                ));
            }
            match required_string(block, "kind")? {
                "text" => {
                    exact_object(block, &["blockIndex", "kind"], &[])?;
                    if role == "tool" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "tool message 只能投影 toolResult block。",
                        ));
                    }
                }
                "reasoning" => {
                    exact_object(block, &["blockIndex", "kind"], &[])?;
                    if role != "assistant" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "reasoning block 只能属于 assistant message。",
                        ));
                    }
                }
                "toolCall" => {
                    exact_object(block, &["blockIndex", "kind", "callId", "toolName"], &[])?;
                    if role != "assistant" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "toolCall block 只能属于 assistant message。",
                        ));
                    }
                    let call_id = required_string(block, "callId")?;
                    validate_id("callId", call_id)?;
                    if !call_ids.insert(call_id) {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "context tool callId 不能重复。",
                        ));
                    }
                    required_string(block, "toolName")?;
                }
                "toolResult" => {
                    exact_object(block, &["blockIndex", "kind", "resultForCallId"], &[])?;
                    if role != "tool" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "toolResult block 只能属于 tool message。",
                        ));
                    }
                    let result_for_call_id = required_string(block, "resultForCallId")?;
                    validate_id("resultForCallId", result_for_call_id)?;
                    if !call_ids.contains(result_for_call_id) {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "context toolResult 缺少此前同请求中的 toolCall。",
                        ));
                    }
                    result_count += 1;
                }
                _ => {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "context message block kind 无效。",
                    ))
                }
            }
        }
        if role == "tool" && (blocks.len() != 1 || result_count != 1) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "tool message 必须且只能包含一个 toolResult block。",
            ));
        }
        validate_context_items(
            message.get("attachments").expect("validated attachments"),
            "attachments",
        )?;
        if role != "user"
            && message
                .get("attachments")
                .and_then(Value::as_array)
                .is_some_and(|attachments| !attachments.is_empty())
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context attachments 只能属于 user message。",
            ));
        }
    }
    Ok(())
}

fn validate_context_items(value: &Value, field: &str) -> Result<(), LocalAgentStoreError> {
    let items = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            format!("context {field} 必须是数组。"),
        )
    })?;
    let mut item_ids = std::collections::HashSet::new();
    for item in items {
        exact_object(item, &["itemId", "label"], &[])?;
        let item_id = required_string(item, "itemId")?;
        validate_id("itemId", item_id)?;
        if !item_ids.insert(item_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                format!("context {field} itemId 不能重复。"),
            ));
        }
        required_string(item, "label")?;
    }
    Ok(())
}

fn validate_context_partitions(value: &Value) -> Result<(), LocalAgentStoreError> {
    const ORDER: [&str; 7] = [
        "instructions",
        "sessionControls",
        "tools",
        "workspaceBindings",
        "contextProviders",
        "journalMessages",
        "messageAttachments",
    ];
    let partitions = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "context partitions 必须是数组。")
    })?;
    if partitions.len() != ORDER.len() {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "context partitions 必须包含七个固定顺序分区。",
        ));
    }
    let mut total_shape_units = 0_u64;
    for (index, partition) in partitions.iter().enumerate() {
        exact_object(partition, &["kind", "itemCount", "requestShapeUnits"], &[])?;
        if required_string(partition, "kind")? != ORDER[index] {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context partitions 顺序或 kind 无效。",
            ));
        }
        required_u64(partition, "itemCount")?;
        total_shape_units = total_shape_units
            .checked_add(required_u64(partition, "requestShapeUnits")?)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context partition requestShapeUnits 溢出。",
                )
            })?;
    }
    if total_shape_units == 0 {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "context partition requestShapeUnits 不能全部为零。",
        ));
    }
    Ok(())
}

fn validate_reply(reply: &Value) -> Result<(), LocalAgentStoreError> {
    if reply.get("schemaVersion").and_then(Value::as_str) != Some(REPLY_VERSION) {
        return Err(LocalAgentStoreError::new(
            "session_reply_version_invalid",
            "只接受 deepcode.command-reply。",
        ));
    }
    let status = required_string(reply, "status")?;
    if !["accepted", "rejected"].contains(&status) {
        return Err(LocalAgentStoreError::new(
            "session_reply_status_invalid",
            "持久化回复必须是 accepted 或 rejected。",
        ));
    }
    Ok(())
}

fn validate_workspace_bindings(value: &Value) -> Result<Vec<Value>, LocalAgentStoreError> {
    let values = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_binding_invalid", "workspaceBindings 必须是数组。")
    })?;
    let mut seen = std::collections::HashSet::new();
    let mut bindings = Vec::with_capacity(values.len());
    for value in values {
        let object = exact_object(value, &["workspaceId", "displayName"], &[])?;
        let workspace_id = required_string(value, "workspaceId")?;
        validate_id("workspaceId", workspace_id)?;
        validate_display_title(required_string(value, "displayName")?)?;
        if !seen.insert(workspace_id) {
            return Err(LocalAgentStoreError::new(
                "session_binding_duplicate",
                "workspaceBindings 不能重复。",
            ));
        }
        bindings.push(Value::Object(object.clone()));
    }
    Ok(bindings)
}

fn exact_object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, LocalAgentStoreError> {
    let object = value.as_object().ok_or_else(|| {
        LocalAgentStoreError::new("local_agent_message_invalid", "消息必须是 JSON 对象。")
    })?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(LocalAgentStoreError::new(
            "local_agent_message_shape_invalid",
            "消息包含缺失或未声明字段。",
        ));
    }
    Ok(object)
}

fn strip_null_object_fields(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
        if let Some(payload) = object.get_mut("payload").and_then(Value::as_object_mut) {
            payload.retain(|_, value| !value.is_null());
        }
    }
    value
}

fn verify_session_store(connection: &Connection) -> Result<(), LocalAgentStoreError> {
    for name in [
        "sessions",
        "session_workspace_bindings",
        "session_events",
        "session_commands",
    ] {
        let present: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                params![name],
                |row| row.get(0),
            )
            .map_err(sql_error("session_store_verify_failed"))?;
        if !present {
            return Err(LocalAgentStoreError::new(
                "session_store_schema_incomplete",
                format!("Session Store 缺少 {name} 表。"),
            ));
        }
    }
    Ok(())
}

fn verify_session_store_version(connection: &Connection) -> Result<(), LocalAgentStoreError> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error("session_store_version_read_failed"))?;
    if version != SESSION_STORE_VERSION {
        return Err(LocalAgentStoreError::new(
            "session_store_version_mismatch",
            format!("Session Store schema {version} 不是当前 schema {SESSION_STORE_VERSION}。"),
        ));
    }
    Ok(())
}

fn sqlite_is_empty(connection: &Connection) -> Result<bool, LocalAgentStoreError> {
    connection
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error("session_store_empty_check_failed"))
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, LocalAgentStoreError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "local_agent_message_invalid",
                format!("{field} 必须是非空字符串。"),
            )
        })
}

fn required_u64(value: &Value, field: &str) -> Result<u64, LocalAgentStoreError> {
    value.get(field).and_then(Value::as_u64).ok_or_else(|| {
        LocalAgentStoreError::new(
            "local_agent_message_invalid",
            format!("{field} 必须是非负整数。"),
        )
    })
}

fn validate_display_title(value: &str) -> Result<(), LocalAgentStoreError> {
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        return Err(LocalAgentStoreError::new(
            "local_agent_display_invalid",
            "显示名称必须是 1 到 120 个可显示字符。",
        ));
    }
    Ok(())
}

fn validate_id(field: &str, value: &str) -> Result<(), LocalAgentStoreError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(LocalAgentStoreError::new(
            "local_agent_identity_invalid",
            format!("{field} 不是有效标识。"),
        ));
    }
    Ok(())
}

fn random_id(prefix: &str) -> Result<String, LocalAgentStoreError> {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| {
        LocalAgentStoreError::new("local_agent_entropy_failed", "无法生成本地事件标识。")
    })?;
    let mut value = String::with_capacity(prefix.len() + 1 + entropy.len() * 2);
    value.push_str(prefix);
    value.push(':');
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(value)
}

fn encode_json(value: &Value, code: &'static str) -> Result<String, LocalAgentStoreError> {
    serde_json::to_string(value)
        .map_err(|error| LocalAgentStoreError::new(code, format!("JSON 编码失败：{error}")))
}

fn decode_json(encoded: &str, code: &'static str) -> Result<Value, LocalAgentStoreError> {
    serde_json::from_str(encoded)
        .map_err(|error| LocalAgentStoreError::new(code, format!("JSON 解码失败：{error}")))
}

fn sql_open_error(error: rusqlite::Error) -> LocalAgentStoreError {
    LocalAgentStoreError::new(
        "session_store_open_failed",
        format!("打开 Session Store 失败：{error}"),
    )
}

fn sql_error(code: &'static str) -> impl FnOnce(rusqlite::Error) -> LocalAgentStoreError {
    move |error| LocalAgentStoreError::new(code, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_journal_has_immutable_binding_snapshot_and_plan_events() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-current-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).expect("open current journal");
        let created = journal
            .create_session(
                "session:test",
                "新对话",
                &json!([{"workspaceId":"workspace:test","displayName":"Test"}]),
                Some("profile:test"),
            )
            .expect("create session");
        assert_eq!(created["schemaVersion"], EVENT_VERSION);
        journal
            .append(&json!({
                "type":"run.started",
                "sessionId":"session:test",
                "runId":"run:test",
                "payload":{
                    "inputMessageId":"message:test",
                    "workspaceBindings":[{"workspaceId":"workspace:test","displayName":"Test"}]
                }
            }))
            .expect("start plan run");
        let plan = journal
            .append(&json!({
                "type":"plan.published",
                "sessionId":"session:test",
                "runId":"run:test",
                "callId":"call:plan-test",
                "payload":{
                    "providerCallId":"provider-call:plan-test",
                    "planId":"plan:test",
                    "revision":1,
                    "title":"写入说明",
                    "summary":"更新项目说明。",
                    "steps":[{"stepId":"step:write","title":"写入","details":"更新 README。"}],
                    "mutationManifest":[{
                        "workspaceId":"workspace:test","operation":"fs.write","target":"README.md"
                    }]
                }
            }))
            .expect("append plan");
        assert_eq!(plan["type"], "plan.published");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn noncurrent_session_store_is_rejected() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-outdated-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let outdated_schema =
            SESSION_STORE_SCHEMA.replace("PRAGMA user_version = 3;", "PRAGMA user_version = 1;");
        Connection::open(&path)
            .expect("open outdated store")
            .execute_batch(&outdated_schema)
            .expect("create outdated store");

        let error = match LocalAgentJournal::open(&path) {
            Ok(_) => panic!("noncurrent store must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.code, "session_store_version_unsupported");
        assert!(error.message.contains("schema 1"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn schema_two_store_migrates_composition_purpose_without_rewriting_history() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-v2-migration-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let version_two_schema = SESSION_STORE_SCHEMA
            .replace("PRAGMA user_version = 3;", "PRAGMA user_version = 2;")
            .replace(
                "        'context.compaction.requested',\n        'context.compacted',\n",
                "",
            );
        let connection = Connection::open(&path).expect("open v2 store");
        connection
            .execute_batch(&version_two_schema)
            .expect("create v2 store");
        connection
            .execute(
                "INSERT INTO sessions(session_id, display_title, created_at)
                 VALUES (?1, ?2, ?3)",
                params!["session:migrate", "Migration", "2026-08-30T00:00:00.000Z"],
            )
            .expect("insert v2 session");
        let old_payload = json!({
            "providerRequestId": "provider-request:old",
            "responseConstraint": "normal",
            "messages": [],
            "workspaceBindings": [],
            "tools": [],
            "partitions": [
                {"kind":"instructions","itemCount":1,"requestShapeUnits":10},
                {"kind":"sessionControls","itemCount":0,"requestShapeUnits":0},
                {"kind":"tools","itemCount":0,"requestShapeUnits":0},
                {"kind":"workspaceBindings","itemCount":0,"requestShapeUnits":0},
                {"kind":"contextProviders","itemCount":0,"requestShapeUnits":0},
                {"kind":"journalMessages","itemCount":0,"requestShapeUnits":0},
                {"kind":"messageAttachments","itemCount":0,"requestShapeUnits":0}
            ]
        });
        connection
            .execute(
                "INSERT INTO session_events(
                     session_id, sequence, event_id, event_type, run_id,
                     payload_json, occurred_at
                 ) VALUES (?1, 1, ?2, 'context.composed', ?3, ?4, ?5)",
                params![
                    "session:migrate",
                    "event:old-receipt",
                    "run:old",
                    old_payload.to_string(),
                    "2026-08-30T00:00:01.000Z",
                ],
            )
            .expect("insert v2 receipt");
        drop(connection);

        let journal = LocalAgentJournal::open(&path).expect("migrate v2 store");
        let events = journal
            .read_events("session:migrate", 0)
            .expect("read migrated events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["eventId"], "event:old-receipt");
        assert_eq!(events[0]["sequence"], 1);
        assert_eq!(events[0]["payload"]["purpose"], "agent");
        assert_eq!(
            journal
                .lock()
                .expect("lock migrated store")
                .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                .expect("read migrated version"),
            3
        );

        drop(journal);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn durable_todo_and_provider_usage_require_active_run_receipts() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-facts-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).expect("open fact journal");
        journal
            .create_session("session:facts", "Facts", &json!([]), None)
            .expect("create fact session");

        let todo_without_run = journal
            .append(&json!({
                "type":"todo.progressed",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:todo-before-run",
                "payload":{
                    "providerCallId":"provider-call:todo-before-run",
                    "sourcePlanId":"plan:facts",
                    "sourcePlanRevision":1,
                    "updates":[{
                    "todoId":"todo:one",
                    "status":"pending"
                }]}
            }))
            .expect_err("todo cannot precede run.started");
        assert_eq!(todo_without_run.code, "session_event_run_not_active");
        assert_eq!(
            journal
                .read_events("session:facts", 0)
                .expect("read rejected todo archive")
                .len(),
            1,
            "rejected Todo must not enter the durable journal"
        );

        journal
            .append(&json!({
                "type":"run.started",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "inputMessageId":"message:facts",
                    "workspaceBindings":[]
                }
            }))
            .expect("start fact run");
        journal
            .append(&json!({
                "type":"plan.published",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:plan",
                "payload":{
                    "providerCallId":"provider-call:plan",
                    "planId":"plan:facts",
                    "revision":1,
                    "title":"Inspect",
                    "summary":"Inspect the workspace.",
                    "steps":[{"stepId":"step:one","title":"Inspect","details":"Inspect files."}],
                    "mutationManifest":[]
                }
            }))
            .expect("publish fact plan");
        journal
            .append(&json!({
                "type":"plan.confirmed",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:plan",
                "payload":{
                    "planId":"plan:facts",
                    "revision":1,
                    "commandId":"command:confirm-plan",
                    "decisionId":"decision:plan",
                    "authorities":[]
                }
            }))
            .expect("confirm fact plan");
        journal
            .append(&json!({
                "type":"todo.seeded",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "sourcePlanId":"plan:facts",
                    "sourcePlanRevision":1,
                    "items":[{
                        "todoId":"todo:one",
                        "sourceStepId":"step:one",
                        "label":"Inspect",
                        "status":"pending"
                    }]
                }
            }))
            .expect("seed fact todo");
        journal
            .append(&json!({
                "type":"todo.progressed",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:todo",
                "payload":{
                    "providerCallId":"provider-call:todo",
                    "sourcePlanId":"plan:facts",
                    "sourcePlanRevision":1,
                    "updates":[{"todoId":"todo:one","status":"inProgress"}]
                }
            }))
            .expect("record active-run todo progress");
        let duplicate_todo = journal
            .append(&json!({
                "type":"todo.progressed",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:todo",
                "payload":{
                    "providerCallId":"provider-call:todo-duplicate",
                    "sourcePlanId":"plan:facts",
                    "sourcePlanRevision":1,
                    "updates":[{"todoId":"todo:one","status":"completed"}]
                }
            }))
            .expect_err("todo call identity is immutable");
        assert_eq!(duplicate_todo.code, "session_root_call_duplicate");

        let usage_without_receipt = journal
            .append(&json!({
                "type":"context.updated",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "providerRequestId":"provider-request:facts",
                    "inputTokens":20,
                    "outputTokens":5,
                    "contextWindowTokens":100
                }
            }))
            .expect_err("usage requires a same-run composition receipt");
        assert_eq!(
            usage_without_receipt.code,
            "provider_request_receipt_missing"
        );

        journal
            .append(&json!({
                "type":"context.composed",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "providerRequestId":"provider-request:facts",
                    "purpose":"agent",
                    "responseConstraint":"normal",
                    "messages":[],
                    "workspaceBindings":[],
                    "tools":[],
                    "partitions":[
                        {"kind":"instructions","itemCount":0,"requestShapeUnits":1},
                        {"kind":"sessionControls","itemCount":0,"requestShapeUnits":0},
                        {"kind":"tools","itemCount":0,"requestShapeUnits":0},
                        {"kind":"workspaceBindings","itemCount":0,"requestShapeUnits":0},
                        {"kind":"contextProviders","itemCount":0,"requestShapeUnits":0},
                        {"kind":"journalMessages","itemCount":0,"requestShapeUnits":0},
                        {"kind":"messageAttachments","itemCount":0,"requestShapeUnits":0}
                    ]
                }
            }))
            .expect("record provider request receipt");
        journal
            .append(&json!({
                "type":"context.updated",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "providerRequestId":"provider-request:facts",
                    "inputTokens":20,
                    "outputTokens":5,
                    "contextWindowTokens":100
                }
            }))
            .expect("record receipt-linked usage");
        let duplicate_usage = journal
            .append(&json!({
                "type":"context.updated",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "providerRequestId":"provider-request:facts",
                    "inputTokens":20,
                    "outputTokens":5,
                    "contextWindowTokens":100
                }
            }))
            .expect_err("usage receipt is single-consumer");
        assert_eq!(duplicate_usage.code, "provider_usage_duplicate");

        journal
            .append(&json!({
                "type":"run.settled",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{"outcome":"completed"}
            }))
            .expect("settle fact run");
        let todo_after_settlement = journal
            .append(&json!({
                "type":"todo.progressed",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:todo-after-settlement",
                "payload":{
                    "providerCallId":"provider-call:todo-after-settlement",
                    "sourcePlanId":"plan:facts",
                    "sourcePlanRevision":1,
                    "updates":[{"todoId":"todo:one","status":"completed"}]
                }
            }))
            .expect_err("settled runs reject Todo updates");
        assert_eq!(todo_after_settlement.code, "session_event_run_not_active");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn deleting_session_cascades_archive_and_private_directory_index_facts() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-delete-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let tool_path = path.with_extension("tool-record.sqlite3");
        let journal = LocalAgentJournal::open(&path).expect("open journal");
        journal
            .create_session(
                "session:delete",
                "删除测试",
                &json!([{"workspaceId":"workspace:creation","displayName":"Creation"}]),
                None,
            )
            .expect("create session");
        journal
            .commit_command(&json!({
                "command": {
                    "schemaVersion": COMMAND_VERSION,
                    "type": "session.directory-index.attach",
                    "commandId": "command:attach",
                    "sessionId": "session:delete",
                    "workspaceBinding": {
                        "workspaceId": "workspace:private",
                        "displayName": "Private"
                    }
                },
                "events": [{
                    "type": "session.directory-index.attached",
                    "sessionId": "session:delete",
                    "payload": {
                        "commandId": "command:attach",
                        "workspaceBinding": {
                            "workspaceId": "workspace:private",
                            "displayName": "Private"
                        }
                    }
                }],
                "reply": {
                    "schemaVersion": REPLY_VERSION,
                    "commandId": "command:attach",
                    "sessionId": "session:delete",
                    "status": "accepted",
                    "revision": 0
                }
            }))
            .expect("record private directory index");
        {
            let connection = Connection::open(&tool_path).expect("open tool store");
            connection
                .execute_batch(include_str!(
                    "../../../contracts/agent-runtime/tool-record.sql"
                ))
                .expect("create tool store");
            connection
                .execute(
                    "INSERT INTO tool_records(
                         record_id, session_id, run_id, call_id, attempt_id, tool_name,
                         logical_targets_json, outcome, record_json, started_at, completed_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', 'completed', '{}', ?7, ?8)",
                    params![
                        "record:delete",
                        "session:delete",
                        "run:delete",
                        "call:delete",
                        "attempt:delete",
                        "fs.read",
                        "2026-08-25T00:00:00Z",
                        "2026-08-25T00:00:01Z",
                    ],
                )
                .expect("insert tool record");
        }

        assert_eq!(
            delete_session_archive(&path, &tool_path, "session:delete")
                .expect("delete complete Session archive"),
            1
        );
        let connection = journal.lock().expect("lock journal");
        for table in [
            "sessions",
            "session_workspace_bindings",
            "session_events",
            "session_commands",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count archive rows");
            assert_eq!(count, 0, "{table} retained deleted Session data");
        }
        drop(connection);
        let tool_connection = Connection::open(&tool_path).expect("reopen tool store");
        let tool_count: i64 = tool_connection
            .query_row("SELECT COUNT(*) FROM tool_records", [], |row| row.get(0))
            .expect("count tool records");
        assert_eq!(tool_count, 0);
        drop(tool_connection);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(tool_path);
    }

    #[test]
    fn session_archive_delete_rolls_back_when_tool_record_delete_fails() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-delete-rollback-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let tool_path = path.with_extension("tool-record.sqlite3");
        let journal = LocalAgentJournal::open(&path).expect("open journal");
        journal
            .create_session("session:rollback", "回滚测试", &json!([]), None)
            .expect("create session");
        {
            let connection = Connection::open(&tool_path).expect("open tool store");
            connection
                .execute_batch(include_str!(
                    "../../../contracts/agent-runtime/tool-record.sql"
                ))
                .expect("create tool store");
            connection
                .execute_batch(
                    "CREATE TRIGGER block_test_delete BEFORE DELETE ON tool_records BEGIN
                         SELECT RAISE(ABORT, 'blocked for rollback test');
                     END;",
                )
                .expect("install failure trigger");
            connection
                .execute(
                    "INSERT INTO tool_records(
                         record_id, session_id, run_id, call_id, attempt_id, tool_name,
                         logical_targets_json, outcome, record_json, started_at, completed_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', 'completed', '{}', ?7, ?8)",
                    params![
                        "record:rollback",
                        "session:rollback",
                        "run:rollback",
                        "call:rollback",
                        "attempt:rollback",
                        "fs.read",
                        "2026-08-25T00:00:00Z",
                        "2026-08-25T00:00:01Z",
                    ],
                )
                .expect("insert tool record");
        }

        let error = delete_session_archive(&path, &tool_path, "session:rollback")
            .expect_err("delete must fail atomically");
        assert_eq!(error.code, "session_archive_tool_records_delete_failed");
        assert_eq!(
            journal
                .read_events("session:rollback", 0)
                .expect("Session archive remains")
                .len(),
            1
        );
        let tool_connection = Connection::open(&tool_path).expect("reopen tool store");
        let tool_count: i64 = tool_connection
            .query_row("SELECT COUNT(*) FROM tool_records", [], |row| row.get(0))
            .expect("count tool records");
        assert_eq!(tool_count, 1);
        drop(tool_connection);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(tool_path);
    }

    #[test]
    fn feedback_command_and_event_have_closed_durable_shapes() {
        validate_command(&json!({
            "schemaVersion": COMMAND_VERSION,
            "type": "message.feedback.set",
            "commandId": "command:feedback",
            "sessionId": "session:feedback",
            "messageId": "message:answer",
            "feedback": "up"
        }))
        .expect("accept closed feedback command");
        validate_new_event(
            &json!({
                "type": "message.feedback.updated",
                "sessionId": "session:feedback",
                "payload": {
                    "commandId": "command:feedback",
                    "messageId": "message:answer",
                    "feedback": null
                }
            }),
            false,
        )
        .expect("accept durable feedback event");

        assert!(validate_command(&json!({
            "schemaVersion": COMMAND_VERSION,
            "type": "message.feedback.set",
            "commandId": "command:feedback-bad",
            "sessionId": "session:feedback",
            "messageId": "message:answer",
            "feedback": "helpful"
        }))
        .is_err());
        assert!(validate_command(&json!({
            "schemaVersion": COMMAND_VERSION,
            "type": "message.feedback.set",
            "commandId": "command:feedback-extra",
            "sessionId": "session:feedback",
            "messageId": "message:answer",
            "feedback": "down",
            "source": "gui"
        }))
        .is_err());
    }

    #[test]
    fn provider_call_identity_is_required_and_distinct_from_logical_call_identity() {
        let event = json!({
            "type": "tool.requested",
            "sessionId": "session:identity",
            "runId": "run:identity",
            "callId": "call:logical",
            "payload": {
                "providerCallId": "provider-call:native",
                "attemptId": "attempt:one",
                "toolName": "fs.read",
                "input": {"workspaceId": "workspace:one", "path": "README.md"}
            }
        });
        validate_new_event(&event, false).expect("accept separated call identities");

        let mut missing = event.clone();
        missing["payload"]
            .as_object_mut()
            .expect("payload object")
            .remove("providerCallId");
        assert!(validate_new_event(&missing, false).is_err());

        let mut reused = event;
        reused["payload"]["providerCallId"] = json!("call:logical");
        let error = validate_new_event(&reused, false).expect_err("identity reuse must fail");
        assert_eq!(error.code, "session_event_invalid");
        assert!(error.message.contains("不能复用"));
    }

    #[test]
    fn provider_request_receipt_and_usage_share_closed_identity_shapes() {
        validate_new_event(
            &json!({
                "type": "context.composed",
                "sessionId": "session:receipt",
                "runId": "run:receipt",
                "payload": {
                    "providerRequestId": "provider-request:one",
                    "purpose": "agent",
                    "responseConstraint": "normal",
                    "messages": [{
                        "messageIndex": 0,
                        "contributionId": "message:one",
                        "contributionKind": "journalMessages",
                        "label": "用户消息",
                        "role": "user",
                        "blocks": [{"blockIndex": 0, "kind": "text"}],
                        "attachments": []
                    }],
                    "workspaceBindings": [],
                    "tools": [],
                    "partitions": [
                        {"kind":"instructions","itemCount":0,"requestShapeUnits":1},
                        {"kind":"sessionControls","itemCount":0,"requestShapeUnits":1},
                        {"kind":"tools","itemCount":0,"requestShapeUnits":0},
                        {"kind":"workspaceBindings","itemCount":0,"requestShapeUnits":0},
                        {"kind":"contextProviders","itemCount":0,"requestShapeUnits":0},
                        {"kind":"journalMessages","itemCount":1,"requestShapeUnits":1},
                        {"kind":"messageAttachments","itemCount":0,"requestShapeUnits":0}
                    ]
                }
            }),
            false,
        )
        .expect("accept request receipt");
        assert!(validate_new_event(
            &json!({
                "type": "context.composed",
                "sessionId": "session:receipt",
                "runId": "run:receipt",
                "payload": {
                    "providerRequestId": "provider-request:bad-partitions",
                    "purpose": "agent",
                    "responseConstraint": "normal",
                    "messages": [],
                    "workspaceBindings": [],
                    "tools": [],
                    "partitions": [
                        {"kind":"tools","itemCount":0,"requestShapeUnits":1},
                        {"kind":"sessionControls","itemCount":0,"requestShapeUnits":1},
                        {"kind":"instructions","itemCount":0,"requestShapeUnits":1},
                        {"kind":"workspaceBindings","itemCount":0,"requestShapeUnits":0},
                        {"kind":"contextProviders","itemCount":0,"requestShapeUnits":0},
                        {"kind":"journalMessages","itemCount":0,"requestShapeUnits":0},
                        {"kind":"messageAttachments","itemCount":0,"requestShapeUnits":0}
                    ]
                }
            }),
            false,
        )
        .is_err());
        assert!(validate_new_event(
            &json!({
                "type": "context.composed",
                "sessionId": "session:receipt",
                "runId": "run:receipt",
                "payload": {
                    "providerRequestId": "provider-request:unknown-field",
                    "purpose": "agent",
                    "responseConstraint": "normal",
                    "unknownField": []
                }
            }),
            false,
        )
        .is_err());
        validate_new_event(
            &json!({
                "type": "context.updated",
                "sessionId": "session:receipt",
                "runId": "run:receipt",
                "payload": {
                    "providerRequestId": "provider-request:one",
                    "inputTokens": 20,
                    "outputTokens": 5,
                    "contextWindowTokens": 100,
                    "cacheReadInputTokens": 8,
                    "cacheMissInputTokens": 12
                }
            }),
            false,
        )
        .expect("accept usage linked to request receipt");

        assert!(validate_new_event(
            &json!({
                "type": "context.composed",
                "sessionId": "session:receipt",
                "runId": "run:receipt",
                "payload": {
                    "providerRequestId": "provider-request:bad-count",
                    "purpose": "agent",
                    "responseConstraint": "normal",
                    "messages": [],
                    "workspaceBindings": [],
                    "tools": [
                        {"itemId": "fs.list", "label": "fs.list"},
                        {"itemId": "fs.list", "label": "fs.list again"}
                    ]
                }
            }),
            false,
        )
        .is_err());
        assert!(validate_new_event(
            &json!({
                "type": "context.updated",
                "sessionId": "session:receipt",
                "runId": "run:receipt",
                "payload": {
                    "inputTokens": 20,
                    "outputTokens": 5,
                    "contextWindowTokens": 100
                }
            }),
            false,
        )
        .is_err());
    }
}
