use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

const SESSION_STORE_SCHEMA: &str = include_str!("../../../contracts/agent-runtime/session.sql");
const SESSION_STORE_VERSION: u32 = 7;
const EVENT_VERSION: &str = "deepcode.session-event.v4";
const COMMAND_VERSION: &str = "deepcode.command.v3";
const REPLY_VERSION: &str = "deepcode.command-reply.v3";

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

#[derive(Debug)]
struct ValidatedNewEvent<'a>(&'a Value);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunProviderRuntime {
    pub(crate) provider_runtime_ref: String,
    pub(crate) profile_id: String,
    pub(crate) reasoning_effort_override: Option<String>,
    pub(crate) context_window_tokens: u64,
    pub(crate) max_output_tokens: u32,
    pub(crate) api_surface: String,
    pub(crate) hosted_web_search: String,
    pub(crate) web_search_owner: String,
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
        let connection = Connection::open(path).map_err(sql_open_error)?;
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
                verify_current_event_constraint(&connection)?;
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
        let committed = insert_event(&transaction, validate_new_event(&event, true)?)?;
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
        let validated_events = events
            .iter()
            .map(|event| validate_new_event(event, false))
            .collect::<Result<Vec<_>, _>>()?;
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
        for event in validated_events {
            committed.push(insert_event(&transaction, event)?);
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
        validate_command_event_batch(command, events, reply)?;
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
            insert_event(&transaction, validate_new_event(event, false)?)?;
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

    pub(crate) fn run_runtime_snapshot(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Value, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        let connection = self.lock()?;
        run_runtime_snapshot_fact(&connection, session_id, run_id)
    }

    pub(crate) fn run_provider_runtime(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<RunProviderRuntime, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        let connection = self.lock()?;
        run_provider_runtime_from_connection(&connection, session_id, run_id)
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
    event: ValidatedNewEvent<'_>,
) -> Result<Value, LocalAgentStoreError> {
    let ValidatedNewEvent(event) = event;
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

fn validate_new_event(
    event: &Value,
    allow_creation: bool,
) -> Result<ValidatedNewEvent<'_>, LocalAgentStoreError> {
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
        "session.model-settings.updated",
        "session.directory-index.attached",
        "session.directory-index.detached",
        "input.accepted",
        "run.started",
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
        "tool.input-rejected",
        "tool.interrupted",
        "session.control.rejected",
        "context.compaction.requested",
        "context.compacted",
        "context.composed",
        "provider.turn.settled",
        "context.updated",
        "run.waiting",
        "run.finishing",
        "run.runtime.released",
        "run.runtime.release_failed",
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
            | "session.model-settings.updated"
            | "session.directory-index.attached"
            | "session.directory-index.detached"
            | "input.accepted"
            | "message.committed"
            | "message.feedback.updated"
    );
    let needs_call = matches!(
        event_type,
        "interaction.requested"
            | "plan.published"
            | "plan.confirmed"
            | "plan.revision.requested"
            | "plan.cancelled"
            | "tool.requested"
            | "approval.requested"
            | "approval.resolved"
            | "tool.completed"
            | "tool.input-rejected"
            | "tool.interrupted"
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
    let progress_call = event_type == "todo.progressed"
        && event
            .get("payload")
            .and_then(|payload| payload.get("providerCallId"))
            .is_some();
    if event_type == "todo.progressed" && event.get("callId").is_some() != progress_call {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Todo control 调用必须同时携带 callId 和 providerCallId。",
        ));
    }
    if needs_call || progress_call {
        validate_id("callId", required_string(event, "callId")?)?;
    }
    if matches!(
        event_type,
        "interaction.requested" | "plan.published" | "tool.requested" | "session.control.rejected"
    ) || progress_call
    {
        let payload = event.get("payload").expect("validated payload");
        let provider_call_id = required_string(payload, "providerCallId")?;
        validate_id("providerCallId", provider_call_id)?;
        let logical_call_id = required_string(event, "callId")?;
        if provider_call_id == logical_call_id {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Session LogicalCallId 不能复用 providerCallId。",
            ));
        }
        if event_type == "interaction.requested" {
            let interaction_id = required_string(payload, "interactionId")?;
            validate_id("interactionId", interaction_id)?;
            if interaction_id == logical_call_id || interaction_id == provider_call_id {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "InteractionId、LogicalCallId 与 providerCallId 必须互不复用。",
                ));
            }
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
        "tool.interrupted" => {
            let payload = &event["payload"];
            exact_object(payload, &["attemptId", "error"], &[])?;
            validate_id("attemptId", required_string(payload, "attemptId")?)?;
            exact_object(&payload["error"], &["code", "message"], &[])?;
            required_string(&payload["error"], "code")?;
            required_string(&payload["error"], "message")?;
        }
        "session.model-settings.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["commandId", "settings"], &[])?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_model_settings(&payload["settings"])?;
        }
        "tool.input-rejected" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["rejection"], &[])?;
            let rejection = &payload["rejection"];
            exact_object(
                rejection,
                &[
                    "sessionId",
                    "runId",
                    "extensionGenerationRef",
                    "kernelCatalogSnapshotRef",
                    "toolBindingRef",
                    "callId",
                    "attemptId",
                    "toolName",
                    "input",
                    "rejectedAt",
                    "error",
                ],
                &[],
            )?;
            for field in ["sessionId", "runId", "callId"] {
                if required_string(rejection, field)? != required_string(event, field)? {
                    return Err(LocalAgentStoreError::new(
                        "tool_rejection_identity_mismatch",
                        "工具参数拒绝身份与 Session 事件不一致。",
                    ));
                }
            }
            for field in [
                "extensionGenerationRef",
                "kernelCatalogSnapshotRef",
                "toolBindingRef",
                "attemptId",
                "toolName",
                "rejectedAt",
            ] {
                required_string(rejection, field)?;
            }
            validate_input_rejection_error(&rejection["error"])?;
            if !rejection["input"].is_object() {
                return Err(LocalAgentStoreError::new(
                    "tool_rejection_invalid",
                    "工具参数拒绝必须保留原始输入对象。",
                ));
            }
        }
        "input.accepted" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["commandId", "messageId", "text"],
                &["pluginSelections"],
            )?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("messageId", required_string(payload, "messageId")?)?;
            if !payload.get("text").is_some_and(Value::is_string) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "input.accepted text 必须是字符串；附件消息正文可以为空。",
                ));
            }
            if let Some(selections) = payload.get("pluginSelections") {
                validate_plugin_selection_list(selections)?;
            }
        }
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
            exact_object(
                payload,
                &["inputMessageId", "workspaceBindings", "runtimeSnapshot"],
                &[],
            )?;
            validate_id(
                "inputMessageId",
                required_string(payload, "inputMessageId")?,
            )?;
            validate_workspace_bindings(payload.get("workspaceBindings").ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "run.started 缺少 workspaceBindings。",
                )
            })?)?;
            validate_run_runtime_snapshot(
                payload
                    .get("runtimeSnapshot")
                    .expect("validated runtime snapshot"),
            )?;
        }
        "message.committed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["messageId", "role", "content"],
                &[
                    "filesystemReferences",
                    "pluginSelections",
                    "providerRequestId",
                ],
            )?;
            validate_id("messageId", required_string(payload, "messageId")?)?;
            let role = required_string(payload, "role")?;
            if !matches!(role, "user" | "assistant" | "tool" | "system") {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "message.committed role 无效。",
                ));
            }
            if role == "assistant" {
                validate_id("runId", required_string(event, "runId")?)?;
                validate_runtime_identity(
                    "providerRequestId",
                    required_string(payload, "providerRequestId")?,
                )?;
            } else if payload.get("providerRequestId").is_some() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "只有 Provider 生成的 assistant message 可以携带 providerRequestId。",
                ));
            }
            if payload.get("content").and_then(Value::as_str).is_none() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "message.committed content 必须是字符串。",
                ));
            }
            if let Some(references) = payload.get("filesystemReferences") {
                validate_filesystem_references(references, "session_event_invalid")?;
            }
            if let Some(selections) = payload.get("pluginSelections") {
                validate_plugin_selection_list(selections)?;
            }
        }
        "narrative.committed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &["narrativeId", "content", "providerRequestId"],
                &[],
            )?;
            validate_id("narrativeId", required_string(payload, "narrativeId")?)?;
            validate_runtime_identity(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            if payload.get("content").and_then(Value::as_str).is_none() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "narrative.committed content 必须是字符串。",
                ));
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
            validate_plan_authorities(payload, required_string(event, "runId")?)?;
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
                    "sourcePlanId",
                    "sourcePlanRevision",
                    "sourceFactRef",
                    "updates",
                ],
                &["providerCallId"],
            )?;
            validate_id("sourcePlanId", required_string(payload, "sourcePlanId")?)?;
            required_positive_revision(payload, "sourcePlanRevision")?;
            validate_id("sourceFactRef", required_string(payload, "sourceFactRef")?)?;
            let updates = payload
                .get("updates")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "session_event_invalid",
                        "todo.progressed updates 必须是数组。",
                    )
                })?;
            if updates.is_empty() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "todo.progressed 必须包含至少一项更新。",
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
                "interaction.request" | "plan.publish" | "plan.progress"
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
                        &[
                            "compactionId",
                            "providerRequestId",
                            "trigger",
                            "coveredThroughSequence",
                        ],
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
                            "compactionId",
                            "providerRequestId",
                            "trigger",
                            "coveredThroughSequence",
                            "focus",
                            "commandId",
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
                    "compactionId",
                    "providerRequestId",
                    "trigger",
                    "coveredThroughSequence",
                    "summary",
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
                "pressure" | "userFocus"
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
            if event.get("callId").is_some() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.compacted 不能携带 callId。",
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
                    "stableCoreHash",
                    "baseToolSchemaHash",
                    "selectedPluginSnapshotHash",
                    "dynamicInstructionBytes",
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
                "normal" | "toolRequired" | "answerOnly"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "context.composed responseConstraint 无效。",
                ));
            }
            for field in [
                "stableCoreHash",
                "baseToolSchemaHash",
                "selectedPluginSnapshotHash",
            ] {
                let value = required_string(payload, field)?;
                if value.len() != "context-hash-v1:".len() + 16
                    || !value.starts_with("context-hash-v1:")
                    || !value["context-hash-v1:".len()..]
                        .chars()
                        .all(|character| character.is_ascii_hexdigit())
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        format!("context.composed {field} 无效。"),
                    ));
                }
            }
            required_u64(payload, "dynamicInstructionBytes")?;
            validate_context_messages(payload.get("messages").expect("validated messages"))?;
            validate_context_items(
                payload
                    .get("workspaceBindings")
                    .expect("validated workspace bindings"),
                "workspaceBindings",
            )?;
            validate_context_tools(payload.get("tools").expect("validated tools"))?;
            validate_context_partitions(payload.get("partitions").expect("validated partitions"))?;
        }
        "provider.turn.settled" => {
            let payload = event.get("payload").expect("validated payload");
            validate_runtime_identity(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
            if !matches!(
                required_string(payload, "purpose")?,
                "agent" | "contextCompaction"
            ) {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "provider.turn.settled purpose 无效。",
                ));
            }
            validate_runtime_identity(
                "providerRuntimeRef",
                required_string(payload, "providerRuntimeRef")?,
            )?;
            match required_string(payload, "outcome")? {
                "completed" => {
                    exact_object(
                        payload,
                        &[
                            "providerRequestId",
                            "purpose",
                            "providerRuntimeRef",
                            "outcome",
                            "orderedCallIds",
                        ],
                        &[
                            "reasoningContent",
                            "reasoningSignature",
                            "hostedWebSearchCalls",
                            "orderedOutputBlocks",
                            "toolCallInputs",
                        ],
                    )?;
                    let ordered_call_ids = payload
                        .get("orderedCallIds")
                        .and_then(Value::as_array)
                        .ok_or_else(|| {
                            LocalAgentStoreError::new(
                                "session_event_invalid",
                                "provider.turn.settled orderedCallIds 必须是数组。",
                            )
                        })?;
                    let mut seen = std::collections::HashSet::with_capacity(ordered_call_ids.len());
                    for value in ordered_call_ids {
                        let call_id = value.as_str().ok_or_else(|| {
                            LocalAgentStoreError::new(
                                "session_event_invalid",
                                "provider.turn.settled orderedCallIds 必须只包含标识。",
                            )
                        })?;
                        validate_runtime_identity("orderedCallId", call_id)?;
                        if !seen.insert(call_id) {
                            return Err(LocalAgentStoreError::new(
                                "session_event_invalid",
                                "provider.turn.settled orderedCallIds 不能重复。",
                            ));
                        }
                    }
                    for field in ["reasoningContent", "reasoningSignature"] {
                        if let Some(value) = payload.get(field) {
                            let text = value
                                .as_str()
                                .filter(|text| !text.trim().is_empty())
                                .ok_or_else(|| {
                                    LocalAgentStoreError::new(
                                        "session_event_invalid",
                                        format!("provider.turn.settled {field} 必须是非空字符串。"),
                                    )
                                })?;
                            if text.contains('\0') {
                                return Err(LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    format!("provider.turn.settled {field} 包含无效字符。"),
                                ));
                            }
                        }
                    }
                    if payload.get("reasoningSignature").is_some()
                        && payload.get("reasoningContent").is_none()
                    {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "provider.turn.settled reasoningSignature 缺少 reasoningContent。",
                        ));
                    }
                    if let Some(calls) = payload.get("hostedWebSearchCalls") {
                        if required_string(payload, "purpose")? != "agent" {
                            return Err(LocalAgentStoreError::new(
                                "session_event_invalid",
                                "只有普通 Agent turn 可以记录 Provider hosted search。",
                            ));
                        }
                        let calls = calls
                            .as_array()
                            .filter(|calls| !calls.is_empty())
                            .ok_or_else(|| {
                                LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "provider.turn.settled hostedWebSearchCalls 必须是非空数组。",
                                )
                            })?;
                        let mut seen = std::collections::HashSet::with_capacity(calls.len());
                        for call in calls {
                            if !crate::llm_transport::valid_responses_hosted_search_item(call) {
                                return Err(LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "Provider hosted search item 结构无效。",
                                ));
                            }
                            let call_id = required_string(call, "id")?;
                            validate_runtime_identity("providerHostedSearchCallId", call_id)?;
                            if !seen.insert(call_id) {
                                return Err(LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "Provider hosted search call id 不能重复。",
                                ));
                            }
                        }
                    }
                    if let Some(calls) = payload.get("toolCallInputs") {
                        if required_string(payload, "purpose")? != "agent"
                            || payload.get("orderedOutputBlocks").is_some()
                        {
                            return Err(LocalAgentStoreError::new(
                                "session_event_invalid",
                                "聚合工具输入只能属于普通 Agent turn，不能与有序原生项混用。",
                            ));
                        }
                        let calls = calls
                            .as_array()
                            .filter(|calls| !calls.is_empty())
                            .ok_or_else(|| {
                                LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "toolCallInputs 必须是非空数组。",
                                )
                            })?;
                        let mut ids = std::collections::HashSet::new();
                        let mut provider_ids = std::collections::HashSet::new();
                        let mut accepted = Vec::new();
                        for call in calls {
                            exact_object(
                                call,
                                &["callId", "providerCallId", "toolName", "arguments"],
                                &["error"],
                            )?;
                            let id = required_string(call, "callId")?;
                            let provider_id = required_string(call, "providerCallId")?;
                            validate_id("callId", id)?;
                            validate_runtime_identity("providerCallId", provider_id)?;
                            required_string(call, "toolName")?;
                            if !call["arguments"].is_string()
                                || !ids.insert(id)
                                || !provider_ids.insert(provider_id)
                            {
                                return Err(LocalAgentStoreError::new(
                                    "session_event_invalid",
                                    "toolCallInputs 参数类型或调用身份无效。",
                                ));
                            }
                            if let Some(error) = call.get("error") {
                                validate_input_rejection_error(error)?;
                            } else {
                                accepted.push(json!(id));
                            }
                        }
                        if accepted != *ordered_call_ids {
                            return Err(LocalAgentStoreError::new(
                                "provider_turn_call_order_mismatch",
                                "通过校验的输入必须与调用事实同序一致。",
                            ));
                        }
                    }
                    if let Some(blocks) = payload.get("orderedOutputBlocks") {
                        if required_string(payload, "purpose")? != "agent" {
                            return Err(LocalAgentStoreError::new(
                                "session_event_invalid",
                                "只有普通 Agent turn 可以记录 orderedOutputBlocks。",
                            ));
                        }
                        validate_provider_turn_output_blocks(
                            blocks,
                            payload
                                .get("orderedCallIds")
                                .expect("validated orderedCallIds"),
                        )?;
                    }
                }
                "failed" | "indeterminate" => {
                    exact_object(
                        payload,
                        &[
                            "providerRequestId",
                            "purpose",
                            "providerRuntimeRef",
                            "outcome",
                            "error",
                        ],
                        &[],
                    )?;
                    validate_local_agent_error(payload.get("error").expect("validated error"))?;
                }
                _ => {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "provider.turn.settled outcome 无效。",
                    ))
                }
            }
        }
        "context.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "providerRequestId",
                    "providerRuntimeRef",
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
            validate_runtime_identity(
                "providerRuntimeRef",
                required_string(payload, "providerRuntimeRef")?,
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
                    .is_none_or(|total| total != input_tokens)
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "context.updated 缓存 token 必须完整划分输入 token。",
                    ));
                }
            }
        }
        "run.finishing" | "run.settled" => {
            validate_run_settlement(event.get("payload").expect("validated payload"))?;
        }
        "run.runtime.released" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "runRuntimeSnapshotRef",
                    "extensionGenerationRef",
                    "kernelCatalogSnapshotRef",
                    "providerRuntimeRef",
                    "pluginInstanceRefs",
                    "alreadyReleased",
                ],
                &[],
            )?;
            for field in [
                "runRuntimeSnapshotRef",
                "extensionGenerationRef",
                "kernelCatalogSnapshotRef",
                "providerRuntimeRef",
            ] {
                validate_runtime_identity(field, required_string(payload, field)?)?;
            }
            validate_unique_ids(payload, "pluginInstanceRefs")?;
            if !payload
                .get("alreadyReleased")
                .is_some_and(Value::is_boolean)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "run.runtime.released alreadyReleased 必须是布尔值。",
                ));
            }
        }
        "run.runtime.release_failed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "runRuntimeSnapshotRef",
                    "extensionGenerationRef",
                    "kernelCatalogSnapshotRef",
                    "providerRuntimeRef",
                    "error",
                ],
                &[],
            )?;
            for field in [
                "runRuntimeSnapshotRef",
                "extensionGenerationRef",
                "kernelCatalogSnapshotRef",
                "providerRuntimeRef",
            ] {
                validate_runtime_identity(field, required_string(payload, field)?)?;
            }
            validate_local_agent_error(payload.get("error").expect("validated error"))?;
        }
        _ => {}
    }
    Ok(ValidatedNewEvent(event))
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
    let provider_message = event_type == "message.committed"
        && event
            .get("payload")
            .and_then(|payload| payload.get("role"))
            .and_then(Value::as_str)
            == Some("assistant");
    if provider_message
        || matches!(
            event_type,
            "narrative.committed"
                | "plan.published"
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
                | "provider.turn.settled"
                | "context.updated"
                | "run.finishing"
                | "run.runtime.released"
                | "run.runtime.release_failed"
                | "run.settled"
        )
    {
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
        "message.committed" if provider_message => {
            validate_provider_output_identity(transaction, event, true)?;
        }
        "narrative.committed" => {
            validate_provider_output_identity(transaction, event, true)?;
        }
        "interaction.requested" | "plan.published" | "tool.requested" => {
            let run_id = required_string(event, "runId")?;
            if !pending_provider_composition_exists(transaction, session_id, run_id)? {
                return Err(LocalAgentStoreError::new(
                    "provider_turn_composition_missing",
                    "Provider-origin call fact 必须属于当前未完成的 composition。",
                ));
            }
            let call_id = required_string(event, "callId")?;
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND call_id=?2
                           AND event_type IN ('plan.published', 'tool.requested',
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
            } else if event_type == "interaction.requested" {
                let interaction_id = required_string(payload, "interactionId")?;
                let duplicate_interaction: bool = transaction
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM session_events
                             WHERE session_id=?1 AND event_type='interaction.requested'
                               AND json_extract(payload_json, '$.interactionId')=?2
                         )",
                        params![session_id, interaction_id],
                        |row| row.get(0),
                    )
                    .map_err(sql_error("session_event_fact_read_failed"))?;
                if duplicate_interaction {
                    return Err(LocalAgentStoreError::new(
                        "interaction_identity_duplicate",
                        "InteractionId 已经存在。",
                    ));
                }
            }
        }
        "todo.progressed" => {
            let run_id = required_string(event, "runId")?;
            if let Some(call_id) = event.get("callId").and_then(Value::as_str) {
                if !pending_provider_composition_exists(transaction, session_id, run_id)? {
                    return Err(LocalAgentStoreError::new(
                        "provider_turn_composition_missing",
                        "Plan progress 必须属于当前未完成的 composition。",
                    ));
                }
                let duplicate: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM session_events WHERE session_id=?1 AND call_id=?2)",
                    params![session_id, call_id], |row| row.get(0),
                ).map_err(sql_error("session_event_fact_read_failed"))?;
                if duplicate {
                    return Err(LocalAgentStoreError::new(
                        "provider_call_identity_duplicate",
                        "Plan progress 复用了已有 LogicalCallId。",
                    ));
                }
            }
            let payload = event.get("payload").expect("validated payload");
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
            let source_fact_ref = required_string(payload, "sourceFactRef")?;
            let needs_success = payload["updates"]
                .as_array()
                .expect("validated updates")
                .iter()
                .any(|update| update["status"] == "completed");
            let source_record_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2 AND event_type='tool.completed'
                           AND json_extract(payload_json, '$.record.recordId')=?3
                           AND (?4=0 OR json_extract(payload_json, '$.record.outcome')='completed')
                     )",
                    params![session_id, run_id, source_fact_ref, needs_success],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if !source_record_exists {
                return Err(LocalAgentStoreError::new(
                    "todo_source_fact_missing",
                    "todo.progressed 必须引用本 run 的 ToolRecord（可早于 Plan 确认）；完成步骤需要成功结果。",
                ));
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
            let run_id = required_string(event, "runId")?;
            if !pending_provider_composition_exists(transaction, session_id, run_id)? {
                return Err(LocalAgentStoreError::new(
                    "provider_turn_composition_missing",
                    "Session control 拒绝事实必须属于当前未完成的 composition。",
                ));
            }
            let call_id = required_string(event, "callId")?;
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND call_id=?2
                           AND event_type IN (
                             'interaction.requested', 'plan.published',
                             'tool.requested', 'session.control.rejected', 'todo.progressed'
                           )
                     )",
                    params![session_id, call_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if duplicate {
                return Err(LocalAgentStoreError::new(
                    "session_control_rejection_invalid",
                    "Session control 拒绝回执复用了已有 LogicalCallId。",
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
        }
        "context.compacted" => {
            let payload = event.get("payload").expect("validated payload");
            let compaction_id = required_string(payload, "compactionId")?;
            let run_id = required_string(event, "runId")?;
            let requested: Option<String> = transaction
                .query_row(
                    "SELECT payload_json FROM session_events
                     WHERE session_id=?1 AND run_id=?2
                       AND event_type='context.compaction.requested'
                       AND json_extract(payload_json, '$.compactionId')=?3",
                    params![session_id, run_id, compaction_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let Some(requested_json) = requested else {
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
            let completion_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2
                           AND event_type='provider.turn.settled'
                           AND json_extract(payload_json, '$.providerRequestId')=?3
                           AND json_extract(payload_json, '$.purpose')='contextCompaction'
                           AND json_extract(payload_json, '$.outcome')='completed'
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
            if !receipt_exists || !completion_exists || duplicate {
                return Err(LocalAgentStoreError::new(
                    "context_compaction_completion_invalid",
                    "context.compacted 缺少压缩专用 composition/completion receipt 或已经完成。",
                ));
            }
        }
        "context.composed" => {
            let run_id = required_string(event, "runId")?;
            let payload = event.get("payload").expect("validated payload");
            let provider_request_id = required_string(payload, "providerRequestId")?;
            let pending_composition: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events AS composed
                         WHERE composed.session_id=?1 AND composed.run_id=?2
                           AND composed.event_type='context.composed'
                           AND NOT EXISTS(
                             SELECT 1 FROM session_events AS completed
                             WHERE completed.session_id=composed.session_id
                               AND completed.run_id=composed.run_id
                               AND completed.event_type='provider.turn.settled'
                               AND json_extract(completed.payload_json, '$.providerRequestId')
                                   = json_extract(composed.payload_json, '$.providerRequestId')
                           )
                     )",
                    params![session_id, run_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if pending_composition {
                return Err(LocalAgentStoreError::new(
                    "provider_turn_still_active",
                    "同一 run 的前一个 Provider turn 尚未完成。",
                ));
            }
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
            let purpose = required_string(payload, "purpose")?;
            let compaction_request_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2
                           AND event_type='context.compaction.requested'
                           AND json_extract(payload_json, '$.providerRequestId')=?3
                     )",
                    params![session_id, run_id, provider_request_id,],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if (purpose == "contextCompaction") != compaction_request_exists {
                return Err(LocalAgentStoreError::new(
                    "context_composition_purpose_mismatch",
                    "context.composed purpose 与压缩请求事实不一致。",
                ));
            }
            let runtime = run_provider_runtime_from_connection(transaction, session_id, run_id)?;
            let hosted_search_tool_count = payload
                .get("tools")
                .and_then(Value::as_array)
                .expect("validated context tools")
                .iter()
                .filter(|tool| tool.get("origin").and_then(Value::as_str) == Some("providerHosted"))
                .count();
            let expected_hosted_search_tool =
                purpose == "agent" && runtime.web_search_owner == "providerHosted";
            if hosted_search_tool_count != usize::from(expected_hosted_search_tool) {
                return Err(LocalAgentStoreError::new(
                    "context_composition_search_owner_mismatch",
                    "context.composed 搜索工具与 run.started 固定的执行 owner 不一致。",
                ));
            }
        }
        "provider.turn.settled" => {
            let run_id = required_string(event, "runId")?;
            let payload = event.get("payload").expect("validated payload");
            let provider_request_id = required_string(payload, "providerRequestId")?;
            let composition: Option<(i64, String)> = transaction
                .query_row(
                    "SELECT sequence, payload_json FROM session_events
                     WHERE session_id=?1 AND run_id=?2 AND event_type='context.composed'
                       AND json_extract(payload_json, '$.providerRequestId')=?3",
                    params![session_id, run_id, provider_request_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let (composition_sequence, composition) = composition.ok_or_else(|| {
                LocalAgentStoreError::new(
                    "provider_turn_composition_missing",
                    "provider.turn.settled 缺少同 run 的 context.composed request。",
                )
            })?;
            let composition = decode_json(&composition, "session_event_fact_corrupt")?;
            if required_string(&composition, "purpose")? != required_string(payload, "purpose")? {
                return Err(LocalAgentStoreError::new(
                    "provider_turn_purpose_mismatch",
                    "provider.turn.settled purpose 与 context.composed request 不一致。",
                ));
            }
            let runtime = run_provider_runtime_from_connection(transaction, session_id, run_id)?;
            if runtime.provider_runtime_ref != required_string(payload, "providerRuntimeRef")? {
                return Err(LocalAgentStoreError::new(
                    "provider_turn_runtime_mismatch",
                    "provider.turn.settled runtime 与 run.started snapshot 不一致。",
                ));
            }
            let has_ordered_hosted_search = payload
                .get("orderedOutputBlocks")
                .and_then(Value::as_array)
                .is_some_and(|blocks| {
                    blocks.iter().any(|block| {
                        block.get("kind").and_then(Value::as_str) == Some("providerHosted")
                    })
                });
            if (payload.get("hostedWebSearchCalls").is_some() || has_ordered_hosted_search)
                && runtime.web_search_owner != "providerHosted"
            {
                return Err(LocalAgentStoreError::new(
                    "provider_hosted_search_owner_mismatch",
                    "Provider hosted search 事实与 run.started 固定的执行 owner 不一致。",
                ));
            }
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND event_type='provider.turn.settled'
                           AND json_extract(payload_json, '$.providerRequestId')=?2
                     )",
                    params![session_id, provider_request_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if duplicate {
                return Err(LocalAgentStoreError::new(
                    "provider_turn_settlement_duplicate",
                    "providerRequestId 已经写入 Provider settlement。",
                ));
            }
            let mut statement = transaction
                .prepare(
                    "SELECT call_id,
                            json_extract(payload_json, '$.providerCallId'),
                            CASE event_type
                              WHEN 'interaction.requested' THEN 'interaction.request'
                              WHEN 'plan.published' THEN 'plan.publish'
                              WHEN 'todo.progressed' THEN 'plan.progress'
                              ELSE json_extract(payload_json, '$.toolName')
                            END
                     FROM session_events
                     WHERE session_id=?1 AND run_id=?2 AND sequence>?3
                       AND call_id IS NOT NULL AND event_type IN (
                         'interaction.requested', 'plan.published',
                         'tool.requested', 'session.control.rejected', 'todo.progressed'
                       )
                     ORDER BY sequence ASC",
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let actual_call_facts = statement
                .query_map(params![session_id, run_id, composition_sequence], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(sql_error("session_event_fact_read_failed"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let actual_call_ids = actual_call_facts
                .iter()
                .map(|(call_id, _, _)| call_id.clone())
                .collect::<Vec<_>>();
            if required_string(payload, "outcome")? == "completed" {
                let ordered_call_ids = payload
                    .get("orderedCallIds")
                    .and_then(Value::as_array)
                    .expect("validated orderedCallIds")
                    .iter()
                    .map(|call_id| {
                        call_id
                            .as_str()
                            .expect("validated orderedCallId")
                            .to_string()
                    })
                    .collect::<Vec<_>>();
                if actual_call_ids != ordered_call_ids {
                    return Err(LocalAgentStoreError::new(
                        "provider_turn_call_fact_invalid",
                        "provider.turn.settled orderedCallIds 必须与本次 composition 后写入的 call facts 完整同序一致。",
                    ));
                }
                if let Some(calls) = payload.get("toolCallInputs").and_then(Value::as_array) {
                    let accepted = calls.iter().filter(|call| call.get("error").is_none());
                    if !accepted.zip(actual_call_facts.iter()).all(
                        |(call, (id, provider_id, name))| {
                            call["callId"] == *id
                                && call["providerCallId"] == *provider_id
                                && call["toolName"] == *name
                        },
                    ) {
                        return Err(LocalAgentStoreError::new(
                            "provider_turn_call_identity_mismatch",
                            "聚合输入与已写入的调用身份不一致。",
                        ));
                    }
                }
                if let Some(blocks) = payload.get("orderedOutputBlocks").and_then(Value::as_array) {
                    let ordered_tool_calls = blocks
                        .iter()
                        .filter(|block| {
                            block.get("kind").and_then(Value::as_str) == Some("toolCall")
                        })
                        .collect::<Vec<_>>();
                    let identities_match = ordered_tool_calls.len() == actual_call_facts.len()
                        && ordered_tool_calls.iter().zip(actual_call_facts.iter()).all(
                            |(block, (call_id, provider_call_id, tool_name))| {
                                block.get("callId").and_then(Value::as_str)
                                    == Some(call_id.as_str())
                                    && block.get("providerCallId").and_then(Value::as_str)
                                        == Some(provider_call_id.as_str())
                                    && block.get("toolName").and_then(Value::as_str)
                                        == Some(tool_name.as_str())
                            },
                        );
                    if !identities_match {
                        return Err(LocalAgentStoreError::new(
                            "provider_turn_call_identity_mismatch",
                            "provider.turn.settled toolCall blocks 必须与已写入的 LogicalCallId、ProviderCallId 和 canonical toolName 完整同序一致。",
                        ));
                    }
                }
            } else if !actual_call_ids.is_empty() {
                return Err(LocalAgentStoreError::new(
                    "provider_turn_terminal_call_fact_invalid",
                    "失败或结果未知的 Provider turn 不能提交调用事实。",
                ));
            }
        }
        "context.updated" => {
            let run_id = required_string(event, "runId")?;
            let payload = event.get("payload").expect("validated payload");
            let provider_request_id = required_string(payload, "providerRequestId")?;
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
            let completion_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2
                           AND event_type='provider.turn.settled'
                           AND json_extract(payload_json, '$.providerRequestId')=?3
                           AND json_extract(payload_json, '$.outcome')='completed'
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
            if !receipt_exists || !completion_exists {
                return Err(LocalAgentStoreError::new(
                    "provider_request_receipt_missing",
                    "context.updated 缺少同 run 的 composition/completion receipt。",
                ));
            }
            if duplicate_usage {
                return Err(LocalAgentStoreError::new(
                    "provider_usage_duplicate",
                    "providerRequestId 已经写入 token usage。",
                ));
            }
            let runtime = run_provider_runtime_from_connection(transaction, session_id, run_id)?;
            if runtime.provider_runtime_ref != required_string(payload, "providerRuntimeRef")?
                || runtime.context_window_tokens != required_u64(payload, "contextWindowTokens")?
            {
                return Err(LocalAgentStoreError::new(
                    "provider_usage_runtime_mismatch",
                    "context.updated runtime 或 context window 与 run.started snapshot 不一致。",
                ));
            }
        }
        "run.finishing" => {
            let run_id = required_string(event, "runId")?;
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2
                           AND event_type IN ('run.finishing', 'run.settled')
                     )",
                    params![session_id, run_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if duplicate || pending_provider_composition_exists(transaction, session_id, run_id)? {
                return Err(LocalAgentStoreError::new(
                    "run_finishing_state_invalid",
                    "run.finishing 要求 Provider turn 已完成且此前没有 finishing/settled。",
                ));
            }
            if let Some(final_message_id) = event
                .get("payload")
                .and_then(|payload| payload.get("finalMessageId"))
                .and_then(Value::as_str)
            {
                let final_message_exists: bool = transaction
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM session_events
                             WHERE session_id=?1 AND run_id=?2 AND event_type='message.committed'
                               AND json_extract(payload_json, '$.messageId')=?3
                               AND json_extract(payload_json, '$.role')='assistant'
                         )",
                        params![session_id, run_id, final_message_id],
                        |row| row.get(0),
                    )
                    .map_err(sql_error("session_event_fact_read_failed"))?;
                if !final_message_exists {
                    return Err(LocalAgentStoreError::new(
                        "run_final_message_missing",
                        "completed run.finishing 必须引用已提交的 Assistant message。",
                    ));
                }
            }
        }
        "run.runtime.released" | "run.runtime.release_failed" => {
            let run_id = required_string(event, "runId")?;
            let payload = event.get("payload").expect("validated payload");
            let finishing_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2 AND event_type='run.finishing'
                     )",
                    params![session_id, run_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let released_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2 AND event_type='run.runtime.released'
                     )",
                    params![session_id, run_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if !finishing_exists || released_exists {
                return Err(LocalAgentStoreError::new(
                    "run_runtime_release_state_invalid",
                    "Run runtime 释放回执必须位于 finishing 之后且成功回执只能写入一次。",
                ));
            }
            let runtime = run_runtime_snapshot_fact(transaction, session_id, run_id)?;
            for (field, pointer) in [
                ("runRuntimeSnapshotRef", "/runRuntimeSnapshotRef"),
                ("extensionGenerationRef", "/extensionGenerationRef"),
                ("kernelCatalogSnapshotRef", "/kernelCatalogSnapshotRef"),
                ("providerRuntimeRef", "/provider/providerRuntimeRef"),
            ] {
                if payload.get(field).and_then(Value::as_str)
                    != runtime.pointer(pointer).and_then(Value::as_str)
                {
                    return Err(LocalAgentStoreError::new(
                        "run_runtime_release_identity_mismatch",
                        format!("Run runtime 释放回执的 {field} 与 run.started 不一致。"),
                    ));
                }
            }
            if event_type == "run.runtime.released" {
                let expected = runtime
                    .pointer("/selectedPlugins/plugins")
                    .and_then(Value::as_array)
                    .expect("validated selected plugins")
                    .iter()
                    .map(|plugin| required_string(plugin, "pluginInstanceRef"))
                    .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
                let actual = payload
                    .get("pluginInstanceRefs")
                    .and_then(Value::as_array)
                    .expect("validated plugin refs")
                    .iter()
                    .map(|identity| {
                        identity.as_str().ok_or_else(|| {
                            LocalAgentStoreError::new(
                                "session_event_invalid",
                                "pluginInstanceRefs 必须只包含标识。",
                            )
                        })
                    })
                    .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
                if actual != expected {
                    return Err(LocalAgentStoreError::new(
                        "run_runtime_release_plugin_mismatch",
                        "Run runtime 释放回执必须覆盖全部且仅覆盖本 run 选择的插件实例。",
                    ));
                }
            }
        }
        "tool.interrupted" => {
            let run_id = required_string(event, "runId")?;
            let call_id = required_string(event, "callId")?;
            let valid: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM session_events WHERE session_id=?1 AND run_id=?2
                    AND call_id=?3 AND event_type='tool.requested' AND json_extract(payload_json, '$.attemptId')=?4)
                 AND EXISTS(SELECT 1 FROM session_events WHERE session_id=?1 AND run_id=?2 AND event_type='run.runtime.released')
                 AND NOT EXISTS(SELECT 1 FROM session_events WHERE session_id=?1 AND run_id=?2 AND call_id=?3
                    AND event_type IN ('tool.completed','tool.input-rejected','tool.interrupted'))
                 AND NOT EXISTS(SELECT 1 FROM session_events WHERE session_id=?1 AND run_id=?2 AND event_type='run.settled')",
                params![session_id, run_id, call_id, required_string(&event["payload"], "attemptId")?],
                |row| row.get(0),
            ).map_err(sql_error("session_event_fact_read_failed"))?;
            if !valid {
                return Err(LocalAgentStoreError::new(
                    "tool_interruption_state_invalid",
                    "工具中断必须关联释放后的未完成调用。",
                ));
            }
        }
        "run.settled" => {
            let run_id = required_string(event, "runId")?;
            let pending: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM session_events r WHERE r.session_id=?1 AND r.run_id=?2 AND r.event_type='tool.requested'
                 AND NOT EXISTS(SELECT 1 FROM session_events t WHERE t.session_id=r.session_id AND t.run_id=r.run_id AND t.call_id=r.call_id
                    AND t.event_type IN ('tool.completed','tool.input-rejected','tool.interrupted')))",
                params![session_id, run_id], |row| row.get(0),
            ).map_err(sql_error("session_event_fact_read_failed"))?;
            if pending {
                return Err(LocalAgentStoreError::new(
                    "run_tool_result_missing",
                    "Run 结算前必须关闭全部工具调用。",
                ));
            }
            let finishing_payload: Option<String> = transaction
                .query_row(
                    "SELECT payload_json FROM session_events
                     WHERE session_id=?1 AND run_id=?2 AND event_type='run.finishing'
                     ORDER BY sequence DESC LIMIT 1",
                    params![session_id, run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let release_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND run_id=?2 AND event_type='run.runtime.released'
                     )",
                    params![session_id, run_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            let finishing_payload = finishing_payload
                .map(|encoded| decode_json(&encoded, "session_event_fact_corrupt"))
                .transpose()?;
            if !release_exists || finishing_payload.as_ref() != event.get("payload") {
                return Err(LocalAgentStoreError::new(
                    "run_settlement_release_receipt_missing",
                    "run.settled 必须严格复用 finishing 结果并位于成功释放回执之后。",
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
    reply: &Value,
) -> Result<(), LocalAgentStoreError> {
    if reply.get("status").and_then(Value::as_str) == Some("rejected") {
        if !events.is_empty() {
            return Err(LocalAgentStoreError::new(
                "rejected_command_event_batch_invalid",
                "rejected 命令不能提交 Session 状态事件。",
            ));
        }
        return Ok(());
    }
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
            "只接受 deepcode.command.v3。",
        ));
    }
    validate_id("sessionId", required_string(command, "sessionId")?)?;
    validate_id("commandId", required_string(command, "commandId")?)?;
    let command_type = required_string(command, "type")?;
    if ![
        "session.model-settings.set",
        "session.directory-index.attach",
        "session.directory-index.detach",
        "message.submit",
        "context.focus",
        "message.feedback.set",
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
    if command_type == "session.model-settings.set" {
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                "settings",
            ],
            &[],
        )?;
        validate_model_settings(&command["settings"])?;
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
    if matches!(command_type, "message.submit" | "context.focus") {
        let text_field = if command_type == "message.submit" {
            "text"
        } else {
            "task"
        };
        exact_object(
            command,
            &[
                "schemaVersion",
                "type",
                "commandId",
                "sessionId",
                text_field,
            ],
            &[
                "filesystemReferences",
                "profileId",
                "reasoningEffortOverride",
                "pluginCatalogRevision",
                "pluginSelections",
            ],
        )?;
        let text = command
            .get(text_field)
            .and_then(Value::as_str)
            .ok_or_else(|| {
                LocalAgentStoreError::new("session_command_invalid", "消息正文必须是字符串。")
            })?;
        let has_references = command
            .get("filesystemReferences")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
        if text.trim().is_empty() && (command_type == "context.focus" || !has_references) {
            return Err(LocalAgentStoreError::new(
                "session_command_invalid",
                format!("{command_type} {text_field} 不能为空。"),
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
        if let Some(references) = command.get("filesystemReferences") {
            validate_filesystem_references(references, "session_command_invalid")?;
        }
        if let Some(effort) = command.get("reasoningEffortOverride") {
            validate_reasoning_override(effort)?;
        }
        validate_plugin_selections(
            command.get("pluginCatalogRevision"),
            command.get("pluginSelections"),
        )?;
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

fn validate_reasoning_override(value: &Value) -> Result<(), LocalAgentStoreError> {
    if value.is_null() || matches!(value.as_str(), Some("low" | "medium" | "high" | "max")) {
        return Ok(());
    }
    Err(LocalAgentStoreError::new(
        "session_model_settings_invalid",
        "推理强度必须是 low、medium、high、max 或 null。",
    ))
}

fn validate_model_settings(value: &Value) -> Result<(), LocalAgentStoreError> {
    exact_object(value, &["profileId", "reasoningEffortOverride"], &[])?;
    validate_id("profileId", required_string(value, "profileId")?)?;
    validate_reasoning_override(&value["reasoningEffortOverride"])
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
    if steps.is_empty() {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Plan 必须包含至少一个阶段。",
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
            if items
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
    for operation in operations {
        let name = required_string(operation, "operation")?;
        if name == "bash" {
            exact_object(
                operation,
                &[
                    "workspaceId",
                    "operation",
                    "workspaceMode",
                    "executionScope",
                ],
                &["command", "terminal", "writablePaths"],
            )?;
            let execution_scope = required_string(operation, "executionScope")?;
            if execution_scope == "workspace" || operation.get("writablePaths").is_some() {
                let paths = operation
                    .get("writablePaths")
                    .and_then(Value::as_array)
                    .filter(|paths| !paths.is_empty())
                    .ok_or_else(|| {
                        LocalAgentStoreError::new(
                            "session_event_invalid",
                            "workspace Bash 必须声明 writablePaths。",
                        )
                    })?;
                for target in paths {
                    exact_object(target, &["path", "kind"], &[])?;
                    let path = required_string(target, "path")?;
                    if !valid_logical_path(path)
                        || path == "."
                        || !matches!(required_string(target, "kind")?, "file" | "directory")
                    {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "Bash 可写范围必须是工作区内的文件或目录。",
                        ));
                    }
                }
            }
            let valid_command = operation.get("command").is_none_or(|value| {
                value.as_str().is_some_and(|command| {
                    !command.is_empty() && command.len() <= 16_384 && !command.contains('\0')
                })
            });
            if !valid_command
                || required_string(operation, "workspaceMode")? != "write"
                || !matches!(execution_scope, "workspace" | "host")
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "bash Plan operation 必须声明 workspaceMode=write 和 executionScope；command 可选且有界。",
                ));
            }
            if let Some(terminal) = operation.get("terminal") {
                exact_object(terminal, &["stdin"], &[])?;
                let stdin = terminal
                    .get("stdin")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        LocalAgentStoreError::new(
                            "session_event_invalid",
                            "bash Plan operation terminal.stdin 必须是字符串。",
                        )
                    })?;
                if stdin.len() > 65_536 {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "bash Plan operation terminal.stdin 超过 65536 bytes。",
                    ));
                }
            }
        } else if name == "fs.delete" {
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
            exact_object(
                operation,
                &["workspaceId", "operation", "target"],
                &["targetKind"],
            )?;
            if operation
                .get("targetKind")
                .is_some_and(|value| !matches!(value.as_str(), Some("file" | "directoryTree")))
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "文件写入范围的 targetKind 必须是 file 或 directoryTree。",
                ));
            }
            if !matches!(name, "fs.write" | "fs.edit") {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Plan operation 不属于闭合 mutation 集合。",
                ));
            }
        }
        validate_id("workspaceId", required_string(operation, "workspaceId")?)?;
        if name != "bash" {
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
    }
    Ok(())
}

fn validate_plan_authorities(payload: &Value, run_id: &str) -> Result<(), LocalAgentStoreError> {
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
                "runId",
                "workspaceId",
                "coveredOperations",
            ],
            &[],
        )?;
        for field in ["authorityId", "sessionId", "runId", "workspaceId"] {
            validate_id(field, required_string(authority, field)?)?;
        }
        if required_string(authority, "planId")? != plan_id
            || required_positive_revision(authority, "revision")? != revision
            || required_string(authority, "decisionId")? != decision_id
            || required_string(authority, "runId")? != run_id
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
    if items.is_empty() {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Todo 必须包含至少一个阶段。",
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
                "filesystemReferences",
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
        let mut hosted_search_ids = std::collections::HashSet::new();
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
                "hostedWebSearch" => {
                    exact_object(block, &["blockIndex", "kind", "providerCallId"], &[])?;
                    if role != "assistant" {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "hostedWebSearch block 只能属于 assistant message。",
                        ));
                    }
                    let call_id = required_string(block, "providerCallId")?;
                    validate_runtime_identity("providerHostedSearchCallId", call_id)?;
                    if !hosted_search_ids.insert(call_id) {
                        return Err(LocalAgentStoreError::new(
                            "session_event_invalid",
                            "context hosted search call id 不能重复。",
                        ));
                    }
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
            message
                .get("filesystemReferences")
                .expect("validated filesystem references"),
            "filesystemReferences",
        )?;
        if role != "user"
            && message
                .get("filesystemReferences")
                .and_then(Value::as_array)
                .is_some_and(|references| !references.is_empty())
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context filesystemReferences 只能属于 user message。",
            ));
        }
    }
    Ok(())
}

fn validate_provider_turn_output_blocks(
    value: &Value,
    ordered_call_ids: &Value,
) -> Result<(), LocalAgentStoreError> {
    let blocks = value
        .as_array()
        .filter(|blocks| !blocks.is_empty())
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "provider.turn.settled orderedOutputBlocks 必须是非空数组。",
            )
        })?;
    let expected_call_ids = ordered_call_ids
        .as_array()
        .expect("validated orderedCallIds")
        .iter()
        .map(|value| value.as_str().expect("validated orderedCallId"))
        .collect::<Vec<_>>();
    let mut previous_output_index = None;
    let mut call_ids = Vec::new();
    let mut all_call_ids = std::collections::HashSet::new();
    let mut provider_call_ids = std::collections::HashSet::new();
    let mut projection_refs = std::collections::HashSet::new();
    let mut final_message_count = 0usize;
    for block in blocks {
        let output_index = block
            .get("outputIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "provider output block 缺少非负整数 outputIndex。",
                )
            })?;
        if previous_output_index.is_some_and(|previous| output_index <= previous) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "provider output blocks 没有按 outputIndex 递增。",
            ));
        }
        previous_output_index = Some(output_index);
        let kind = required_string(block, "kind")?;
        let item = block
            .get("item")
            .filter(|item| item.is_object())
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "provider output block 缺少原生 item。",
                )
            })?;
        match kind {
            "reasoning" => {
                exact_object(block, &["outputIndex", "kind", "item"], &[])?;
                if item.get("type").and_then(Value::as_str) != Some("reasoning") {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "reasoning block 与原生 item 类型不一致。",
                    ));
                }
            }
            "narrative" => {
                exact_object(block, &["outputIndex", "kind", "narrativeId", "item"], &[])?;
                let id = required_string(block, "narrativeId")?;
                validate_id("narrativeId", id)?;
                if item.get("type").and_then(Value::as_str) != Some("message")
                    || !projection_refs.insert(("narrative", id))
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "narrative block 无效或重复。",
                    ));
                }
            }
            "finalMessage" => {
                exact_object(block, &["outputIndex", "kind", "messageId", "item"], &[])?;
                let id = required_string(block, "messageId")?;
                validate_id("messageId", id)?;
                final_message_count += 1;
                if item.get("type").and_then(Value::as_str) != Some("message")
                    || !projection_refs.insert(("message", id))
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "finalMessage block 无效或重复。",
                    ));
                }
            }
            "toolCall" | "toolCallRejected" => {
                let mut fields = vec![
                    "outputIndex",
                    "kind",
                    "callId",
                    "providerCallId",
                    "toolName",
                    "item",
                ];
                if kind == "toolCallRejected" {
                    fields.push("error");
                    validate_input_rejection_error(&block["error"])?;
                }
                exact_object(block, &fields, &[])?;
                let call_id = required_string(block, "callId")?;
                let provider_call_id = required_string(block, "providerCallId")?;
                validate_id("callId", call_id)?;
                validate_runtime_identity("providerCallId", provider_call_id)?;
                required_string(block, "toolName")?;
                required_string(item, "name")?;
                if item.get("type").and_then(Value::as_str) != Some("function_call")
                    || item.get("call_id").and_then(Value::as_str) != Some(provider_call_id)
                    || !item.get("arguments").is_some_and(Value::is_string)
                    || !all_call_ids.insert(call_id)
                    || !provider_call_ids.insert(provider_call_id)
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "toolCall block 与原生 item 不一致。",
                    ));
                }
                if kind == "toolCall" {
                    call_ids.push(call_id);
                }
            }
            "providerHosted" => {
                exact_object(
                    block,
                    &[
                        "outputIndex",
                        "kind",
                        "activityId",
                        "providerCallId",
                        "providerToolType",
                        "item",
                    ],
                    &[],
                )?;
                let activity_id = required_string(block, "activityId")?;
                let provider_call_id = required_string(block, "providerCallId")?;
                validate_id("activityId", activity_id)?;
                validate_runtime_identity("providerCallId", provider_call_id)?;
                if required_string(block, "providerToolType")? != "web_search"
                    || item.get("id").and_then(Value::as_str) != Some(provider_call_id)
                    || !crate::llm_transport::valid_responses_hosted_search_item(item)
                    || !provider_call_ids.insert(provider_call_id)
                    || !projection_refs.insert(("activity", activity_id))
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "providerHosted block 与原生 item 不一致。",
                    ));
                }
            }
            _ => {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "provider output block kind 无效。",
                ));
            }
        }
    }
    let narratives = blocks
        .iter()
        .filter(|block| block.get("kind").and_then(Value::as_str) == Some("narrative"))
        .collect::<Vec<_>>();
    let commentary_only = !narratives.is_empty()
        && narratives.iter().all(|block| {
            block
                .get("item")
                .and_then(|item| item.get("phase"))
                .and_then(Value::as_str)
                == Some("commentary")
        });
    if call_ids != expected_call_ids
        || final_message_count > 1
        || all_call_ids.is_empty() && final_message_count != 1 && !commentary_only
        || !all_call_ids.is_empty() && final_message_count != 0
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "provider output blocks 与完成事实不一致。",
        ));
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

fn validate_context_tools(value: &Value) -> Result<(), LocalAgentStoreError> {
    let tools = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "context tools 必须是数组。")
    })?;
    let mut canonical_names = std::collections::HashSet::new();
    let mut wire_names = std::collections::HashSet::new();
    for tool in tools {
        let has_plugin_uri = tool.get("pluginUri").is_some();
        exact_object(
            tool,
            &[
                "itemId",
                "label",
                "canonicalName",
                "wireName",
                "origin",
                "availability",
            ],
            if has_plugin_uri { &["pluginUri"] } else { &[] },
        )?;
        let item_id = required_string(tool, "itemId")?;
        let label = required_string(tool, "label")?;
        let canonical_name = required_string(tool, "canonicalName")?;
        let wire_name = required_string(tool, "wireName")?;
        validate_id("canonicalName", canonical_name)?;
        validate_id("wireName", wire_name)?;
        if item_id != canonical_name || label != wire_name {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context tool itemId/label 必须精确映射 canonicalName/wireName。",
            ));
        }
        if !canonical_names.insert(canonical_name) || !wire_names.insert(wire_name) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context tool canonicalName 和 wireName 不能重复。",
            ));
        }
        let origin = required_string(tool, "origin")?;
        if !matches!(
            origin,
            "coreBuiltin" | "extension" | "sessionControl" | "providerHosted"
        ) || required_string(tool, "availability")? != "callable"
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "context tool origin 或 availability 无效。",
            ));
        }
        if origin == "providerHosted"
            && (canonical_name != "web.search" || wire_name != "web_search" || has_plugin_uri)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Provider hosted context tool 必须是 web_search。",
            ));
        } else if origin == "extension" {
            let plugin_uri = required_string(tool, "pluginUri")?;
            if !plugin_uri.starts_with("plugin://")
                || plugin_uri.split('@').count() != 2
                || plugin_uri.chars().any(char::is_whitespace)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "extension context tool 缺少合法 pluginUri。",
                ));
            }
        } else if has_plugin_uri {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "core/session control context tool 不能携带 pluginUri。",
            ));
        }
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
        "filesystemReferences",
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
            "只接受 deepcode.command-reply.v3。",
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

fn validate_filesystem_references(
    value: &Value,
    error_code: &'static str,
) -> Result<(), LocalAgentStoreError> {
    let references = value.as_array().ok_or_else(|| {
        LocalAgentStoreError::new(error_code, "filesystemReferences 必须是数组。")
    })?;
    if references.len() > 8 {
        return Err(LocalAgentStoreError::new(
            error_code,
            "单条消息最多包含八个文件系统引用。",
        ));
    }
    let mut reference_ids = std::collections::HashSet::new();
    let mut targets = std::collections::HashSet::new();
    for reference in references {
        let kind = required_string(reference, "kind")?;
        let required = [
            "referenceId",
            "workspaceId",
            "logicalPath",
            "displayName",
            "kind",
        ];
        match kind {
            "file" => {
                exact_object(reference, &required, &["mediaType", "byteLength", "source"])?;
                if reference
                    .get("source")
                    .is_some_and(|source| source != "pastedText")
                {
                    return Err(LocalAgentStoreError::new(
                        error_code,
                        "文件引用 source 无效。",
                    ));
                }
                let media_type = required_string(reference, "mediaType")?;
                if !valid_media_type(media_type) {
                    return Err(LocalAgentStoreError::new(
                        error_code,
                        "文件引用 mediaType 无效。",
                    ));
                }
                required_u64(reference, "byteLength")?;
            }
            "directory" => {
                exact_object(reference, &required, &[])?;
            }
            _ => {
                return Err(LocalAgentStoreError::new(
                    error_code,
                    "文件系统引用 kind 无效。",
                ))
            }
        }
        let reference_id = required_string(reference, "referenceId")?;
        let workspace_id = required_string(reference, "workspaceId")?;
        let logical_path = required_string(reference, "logicalPath")?;
        validate_id("referenceId", reference_id)?;
        validate_id("workspaceId", workspace_id)?;
        validate_display_title(required_string(reference, "displayName")?)?;
        if !valid_logical_path(logical_path)
            || (kind == "directory" && logical_path != ".")
            || (kind == "file" && logical_path == ".")
        {
            return Err(LocalAgentStoreError::new(
                error_code,
                "文件系统引用 logicalPath 无效。",
            ));
        }
        if !reference_ids.insert(reference_id) || !targets.insert((workspace_id, logical_path)) {
            return Err(LocalAgentStoreError::new(
                error_code,
                "文件系统引用 identity 或 target 不能重复。",
            ));
        }
    }
    Ok(())
}

fn valid_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') || value.contains('\\') {
        return false;
    }
    value == "."
        || !value.starts_with('/')
            && !value.ends_with('/')
            && value
                .split('/')
                .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

fn valid_media_type(value: &str) -> bool {
    let Some((kind, subtype)) = value.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && value.len() <= 128
        && kind.chars().chain(subtype.chars()).all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'
                )
        })
}

fn validate_plugin_selections(
    revision: Option<&Value>,
    selections: Option<&Value>,
) -> Result<(), LocalAgentStoreError> {
    let Some(selections) = selections else {
        if let Some(revision) = revision {
            validate_id(
                "pluginCatalogRevision",
                revision.as_str().ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "plugin_selection_invalid",
                        "pluginCatalogRevision 必须是字符串。",
                    )
                })?,
            )?;
        }
        return Ok(());
    };
    let selections = selections.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("plugin_selection_invalid", "pluginSelections 必须是数组。")
    })?;
    if !selections.is_empty() {
        validate_id(
            "pluginCatalogRevision",
            revision.and_then(Value::as_str).ok_or_else(|| {
                LocalAgentStoreError::new(
                    "plugin_selection_invalid",
                    "非空 pluginSelections 必须包含 pluginCatalogRevision。",
                )
            })?,
        )?;
    }
    validate_plugin_selection_list(&Value::Array(selections.clone()))
}

fn validate_plugin_selection_list(selections: &Value) -> Result<(), LocalAgentStoreError> {
    let selections = selections.as_array().ok_or_else(|| {
        LocalAgentStoreError::new("plugin_selection_invalid", "pluginSelections 必须是数组。")
    })?;
    if selections.len() > 16 {
        return Err(LocalAgentStoreError::new(
            "plugin_selection_invalid",
            "单次请求最多选择 16 个插件。",
        ));
    }
    let mut selection_ids = std::collections::HashSet::new();
    let mut uris = std::collections::HashSet::new();
    for selection in selections {
        exact_object(selection, &["selectionId", "uri", "label"], &[])?;
        let selection_id = required_string(selection, "selectionId")?;
        validate_id("selectionId", selection_id)?;
        let uri = required_string(selection, "uri")?;
        if !valid_plugin_uri(uri) {
            return Err(LocalAgentStoreError::new(
                "plugin_selection_invalid",
                "Plugin URI 必须是 source-qualified plugin://name@source。",
            ));
        }
        let label = required_string(selection, "label")?;
        validate_display_title(label)?;
        if !selection_ids.insert(selection_id) || !uris.insert(uri) {
            return Err(LocalAgentStoreError::new(
                "plugin_selection_invalid",
                "pluginSelections 的 selectionId 和 uri 不能重复。",
            ));
        }
    }
    Ok(())
}

fn valid_plugin_uri(value: &str) -> bool {
    let Some(identity) = value.strip_prefix("plugin://") else {
        return false;
    };
    let Some((name, source)) = identity.split_once('@') else {
        return false;
    };
    !name.is_empty()
        && !source.is_empty()
        && !name.contains('@')
        && name.chars().chain(source.chars()).all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
}

fn run_provider_runtime_from_connection(
    connection: &Connection,
    session_id: &str,
    run_id: &str,
) -> Result<RunProviderRuntime, LocalAgentStoreError> {
    let mut statement = connection
        .prepare(
            "SELECT payload_json FROM session_events
             WHERE session_id=?1 AND run_id=?2 AND event_type='run.started'
             ORDER BY sequence ASC",
        )
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?;
    let mut rows = statement
        .query(params![session_id, run_id])
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?;
    let encoded = rows
        .next()
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_run_runtime_snapshot_missing",
                "run.started 缺少冻结的 Provider runtime snapshot。",
            )
        })?
        .get::<_, String>(0)
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?;
    if rows
        .next()
        .map_err(sql_error("session_run_runtime_snapshot_read_failed"))?
        .is_some()
    {
        return Err(LocalAgentStoreError::new(
            "session_run_runtime_snapshot_ambiguous",
            "同一 run 存在多个 run.started runtime snapshot。",
        ));
    }
    let payload = decode_json(&encoded, "session_run_runtime_snapshot_corrupt")?;
    let runtime_snapshot = payload.get("runtimeSnapshot").ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_run_runtime_snapshot_corrupt",
            "run.started 缺少 runtimeSnapshot。",
        )
    })?;
    validate_run_runtime_snapshot(runtime_snapshot)
}

fn validate_provider_output_identity(
    transaction: &Transaction<'_>,
    event: &Value,
    completion_required: bool,
) -> Result<(), LocalAgentStoreError> {
    let session_id = required_string(event, "sessionId")?;
    let run_id = required_string(event, "runId")?;
    let payload = event.get("payload").expect("validated payload");
    let provider_request_id = required_string(payload, "providerRequestId")?;
    let composition_exists: bool = transaction
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
    if !composition_exists {
        return Err(LocalAgentStoreError::new(
            "provider_output_composition_missing",
            "Provider 输出缺少同 run 的 context.composed 事实。",
        ));
    }
    if completion_required {
        let completion_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM session_events
                     WHERE session_id=?1 AND run_id=?2 AND event_type='provider.turn.settled'
                       AND json_extract(payload_json, '$.providerRequestId')=?3
                       AND json_extract(payload_json, '$.outcome')='completed'
                 )",
                params![session_id, run_id, provider_request_id],
                |row| row.get(0),
            )
            .map_err(sql_error("session_event_fact_read_failed"))?;
        if !completion_exists {
            return Err(LocalAgentStoreError::new(
                "provider_output_completion_missing",
                "Assistant message 必须在同一 Provider turn 完成后提交。",
            ));
        }
        let duplicate: bool = transaction
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM session_events
                     WHERE session_id=?1 AND run_id=?2 AND event_type='message.committed'
                       AND json_extract(payload_json, '$.role')='assistant'
                       AND json_extract(payload_json, '$.providerRequestId')=?3
                 )",
                params![session_id, run_id, provider_request_id],
                |row| row.get(0),
            )
            .map_err(sql_error("session_event_fact_read_failed"))?;
        if duplicate {
            return Err(LocalAgentStoreError::new(
                "provider_output_duplicate",
                "同一 Provider turn 已经提交 assistant message。",
            ));
        }
    }
    Ok(())
}

fn pending_provider_composition_exists(
    transaction: &Transaction<'_>,
    session_id: &str,
    run_id: &str,
) -> Result<bool, LocalAgentStoreError> {
    transaction
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM session_events AS composed
                 WHERE composed.session_id=?1 AND composed.run_id=?2
                   AND composed.event_type='context.composed'
                   AND NOT EXISTS(
                     SELECT 1 FROM session_events AS completed
                     WHERE completed.session_id=composed.session_id
                       AND completed.run_id=composed.run_id
                       AND completed.event_type='provider.turn.settled'
                       AND json_extract(completed.payload_json, '$.providerRequestId')
                           = json_extract(composed.payload_json, '$.providerRequestId')
                   )
             )",
            params![session_id, run_id],
            |row| row.get(0),
        )
        .map_err(sql_error("session_event_fact_read_failed"))
}

fn run_runtime_snapshot_fact(
    connection: &Connection,
    session_id: &str,
    run_id: &str,
) -> Result<Value, LocalAgentStoreError> {
    let encoded: Option<String> = connection
        .query_row(
            "SELECT payload_json FROM session_events
             WHERE session_id=?1 AND run_id=?2 AND event_type='run.started'
             ORDER BY sequence ASC LIMIT 1",
            params![session_id, run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error("session_event_fact_read_failed"))?;
    let payload = encoded
        .map(|encoded| decode_json(&encoded, "session_event_fact_corrupt"))
        .transpose()?
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "run_runtime_snapshot_missing",
                "Run 缺少 run.started runtime snapshot。",
            )
        })?;
    let runtime = payload.get("runtimeSnapshot").cloned().ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_event_fact_corrupt",
            "run.started 缺少 runtimeSnapshot。",
        )
    })?;
    validate_run_runtime_snapshot(&runtime)?;
    Ok(runtime)
}

fn validate_run_runtime_snapshot(
    value: &Value,
) -> Result<RunProviderRuntime, LocalAgentStoreError> {
    exact_object(
        value,
        &[
            "runRuntimeSnapshotRef",
            "extensionGenerationRef",
            "kernelCatalogSnapshotRef",
            "provider",
            "webSearch",
            "instructions",
            "tools",
            "toolPromptContributions",
            "providerToolAliases",
            "selectedPlugins",
        ],
        &[],
    )?;
    let run_runtime_snapshot_ref = required_string(value, "runRuntimeSnapshotRef")?;
    let extension_generation_ref = required_string(value, "extensionGenerationRef")?;
    let kernel_catalog_snapshot_ref = required_string(value, "kernelCatalogSnapshotRef")?;
    for (field, identity) in [
        ("runRuntimeSnapshotRef", run_runtime_snapshot_ref),
        ("extensionGenerationRef", extension_generation_ref),
        ("kernelCatalogSnapshotRef", kernel_catalog_snapshot_ref),
    ] {
        validate_runtime_identity(field, identity)?;
    }
    if run_runtime_snapshot_ref == extension_generation_ref
        || run_runtime_snapshot_ref == kernel_catalog_snapshot_ref
        || extension_generation_ref == kernel_catalog_snapshot_ref
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "Run runtime、Extension generation 与 Kernel catalog snapshot 身份必须分离。",
        ));
    }

    let provider = value.get("provider").ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", "runtimeSnapshot 缺少 provider。")
    })?;
    exact_object(
        provider,
        &[
            "providerRuntimeRef",
            "profileId",
            "contextWindowTokens",
            "maxOutputTokens",
            "apiSurface",
            "hostedWebSearch",
        ],
        &["reasoningEffort", "reasoningEffortOverride", "thinking"],
    )?;
    let provider_runtime_ref = required_string(provider, "providerRuntimeRef")?;
    let profile_id = required_string(provider, "profileId")?;
    validate_runtime_identity("providerRuntimeRef", provider_runtime_ref)?;
    validate_runtime_identity("profileId", profile_id)?;
    let context_window_tokens = required_u64(provider, "contextWindowTokens")?;
    let max_output_tokens = required_u64(provider, "maxOutputTokens")?;
    let api_surface = required_string(provider, "apiSurface")?;
    let hosted_web_search = required_string(provider, "hostedWebSearch")?;
    for field in ["reasoningEffort", "reasoningEffortOverride"] {
        if let Some(effort) = provider.get(field) {
            if effort.is_null() {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "冻结的推理强度不能为 null。",
                ));
            }
            validate_reasoning_override(effort)?;
        }
    }
    if let Some(thinking) = provider.get("thinking") {
        if !matches!(thinking.as_str(), Some("enabled" | "disabled")) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "冻结的推理模式无效。",
            ));
        }
    }
    if provider.get("reasoningEffortOverride").is_some()
        && (provider["reasoningEffortOverride"] != provider["reasoningEffort"]
            || provider["thinking"] == "disabled")
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "推理强度覆盖与冻结的 Provider 配置不一致。",
        ));
    }
    if !matches!(
        api_surface,
        "chatCompletions" | "responses" | "anthropicMessages" | "ollamaChat"
    ) || !matches!(hosted_web_search, "none" | "web_search")
        || hosted_web_search == "web_search" && api_surface != "responses"
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot Provider API surface 或 hosted search capability 无效。",
        ));
    }
    let max_output_tokens = u32::try_from(max_output_tokens).map_err(|_| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot maxOutputTokens 超出 Provider 预算范围。",
        )
    })?;
    if context_window_tokens == 0
        || max_output_tokens == 0
        || u64::from(max_output_tokens) >= context_window_tokens
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot 要求正数预算且 maxOutputTokens 小于 contextWindowTokens。",
        ));
    }

    let instructions = value
        .get("instructions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot instructions 必须是数组。",
            )
        })?;
    let mut instruction_ids = std::collections::HashSet::with_capacity(instructions.len());
    for instruction in instructions {
        exact_object(instruction, &["id", "text"], &[])?;
        let instruction_id = required_string(instruction, "id")?;
        validate_runtime_identity("instructionId", instruction_id)?;
        if !instruction_ids.insert(instruction_id) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot instruction id 不能重复。",
            ));
        }
        let text = required_string(instruction, "text")?;
        if text.contains('\0') {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot instruction text 包含无效字符。",
            ));
        }
    }

    let tools = value
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tools 必须是数组。",
            )
        })?;
    let mut tool_names = std::collections::HashSet::with_capacity(tools.len());
    let mut binding_refs = std::collections::HashSet::with_capacity(tools.len());
    let mut callable_tool_names = std::collections::HashSet::with_capacity(tools.len());
    let mut tool_prompt_targets = std::collections::HashMap::with_capacity(tools.len());
    for tool in tools {
        let has_plugin_uri = tool.get("pluginUri").is_some();
        exact_object(
            tool,
            &[
                "name",
                "description",
                "inputSchema",
                "possibleEffects",
                "availability",
                "toolBindingRef",
                "origin",
            ],
            if has_plugin_uri { &["pluginUri"] } else { &[] },
        )?;
        let name = required_string(tool, "name")?;
        let binding_ref = required_string(tool, "toolBindingRef")?;
        validate_runtime_identity("toolName", name)?;
        validate_runtime_identity("toolBindingRef", binding_ref)?;
        if !tool_names.insert(name) || !binding_refs.insert(binding_ref) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool name 与 toolBindingRef 必须分别唯一。",
            ));
        }
        let description = required_string(tool, "description")?;
        if description.trim().is_empty() || description.contains('\0') {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool description 无效。",
            ));
        }
        if !tool.get("inputSchema").is_some_and(Value::is_object) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool inputSchema 必须是对象。",
            ));
        }
        let effects = tool
            .get("possibleEffects")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool possibleEffects 必须是数组。",
                )
            })?;
        let mut seen_effects = std::collections::HashSet::with_capacity(effects.len());
        for effect in effects {
            let effect = effect.as_str().ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool possibleEffects 包含无效值。",
                )
            })?;
            if !matches!(
                effect,
                "localRead"
                    | "workspaceRead"
                    | "workspaceMutation"
                    | "process"
                    | "network"
                    | "external"
            ) || !seen_effects.insert(effect)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool possibleEffects 无效或重复。",
                ));
            }
        }
        let availability = required_string(tool, "availability")?;
        if !matches!(availability, "callable" | "blocked") {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool availability 无效。",
            ));
        }
        if availability == "callable" {
            callable_tool_names.insert(name);
        }
        let origin = required_string(tool, "origin")?;
        if !matches!(origin, "coreBuiltin" | "extension") {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool origin 无效。",
            ));
        }
        let plugin_uri = if origin == "extension" {
            let plugin_uri = required_string(tool, "pluginUri")?;
            if !plugin_uri.starts_with("plugin://")
                || plugin_uri.split('@').count() != 2
                || plugin_uri.chars().any(char::is_whitespace)
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "extension runtimeSnapshot tool 缺少合法 pluginUri。",
                ));
            }
            Some(plugin_uri.to_string())
        } else if has_plugin_uri {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "core runtimeSnapshot tool 不能携带 pluginUri。",
            ));
        } else {
            None
        };
        tool_prompt_targets.insert(
            name.to_string(),
            (
                binding_ref.to_string(),
                availability.to_string(),
                origin.to_string(),
                plugin_uri,
            ),
        );
    }

    let tool_prompt_contributions = value
        .get("toolPromptContributions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot toolPromptContributions 必须是数组。",
            )
        })?;
    if tool_prompt_contributions.len() > 128 {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot toolPromptContributions 超过单次上限。",
        ));
    }
    let mut prompt_contribution_refs =
        std::collections::HashSet::with_capacity(tool_prompt_contributions.len());
    let mut prompt_tool_names =
        std::collections::HashSet::with_capacity(tool_prompt_contributions.len());
    let mut prompt_binding_refs =
        std::collections::HashSet::with_capacity(tool_prompt_contributions.len());
    let mut prompt_plugin_uris = std::collections::HashSet::new();
    for contribution in tool_prompt_contributions {
        let has_plugin_uri = contribution.get("pluginUri").is_some();
        let has_prompt_snippet = contribution.get("promptSnippet").is_some();
        let mut optional = Vec::new();
        if has_plugin_uri {
            optional.push("pluginUri");
        }
        if has_prompt_snippet {
            optional.push("promptSnippet");
        }
        exact_object(
            contribution,
            &[
                "contributionRef",
                "preparedToolBindingRef",
                "canonicalToolName",
                "origin",
                "usageGuidelines",
            ],
            &optional,
        )?;
        let contribution_ref = required_string(contribution, "contributionRef")?;
        let prepared_binding_ref = required_string(contribution, "preparedToolBindingRef")?;
        let canonical_tool_name = required_string(contribution, "canonicalToolName")?;
        validate_runtime_identity("toolPromptContributionRef", contribution_ref)?;
        validate_runtime_identity("preparedToolBindingRef", prepared_binding_ref)?;
        validate_runtime_identity("toolPromptCanonicalName", canonical_tool_name)?;
        if !prompt_contribution_refs.insert(contribution_ref)
            || !prompt_tool_names.insert(canonical_tool_name)
            || !prompt_binding_refs.insert(prepared_binding_ref)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt contribution、tool 与 binding 必须分别唯一。",
            ));
        }
        let (tool_binding_ref, availability, tool_origin, tool_plugin_uri) = tool_prompt_targets
            .get(canonical_tool_name)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool prompt contribution 指向不存在的工具。",
                )
            })?;
        if availability != "callable" || tool_binding_ref != prepared_binding_ref {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt contribution 未绑定 callable prepared tool。",
            ));
        }
        let origin = required_string(contribution, "origin")?;
        if origin != tool_origin {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt contribution origin 与工具不一致。",
            ));
        }
        match origin {
            "coreBuiltin" if !has_plugin_uri && tool_plugin_uri.is_none() => {}
            "extension" => {
                let plugin_uri = required_string(contribution, "pluginUri")?;
                if tool_plugin_uri.as_deref() != Some(plugin_uri) {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "runtimeSnapshot tool prompt contribution pluginUri 与工具不一致。",
                    ));
                }
                prompt_plugin_uris.insert(plugin_uri.to_string());
            }
            _ => {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool prompt contribution origin 或 pluginUri 无效。",
                ))
            }
        }
        let prompt_snippet = contribution.get("promptSnippet").and_then(Value::as_str);
        if has_prompt_snippet
            && prompt_snippet.is_none_or(|text| !valid_tool_prompt_line(text, 512))
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt snippet 无效。",
            ));
        }
        let usage_guidelines = contribution
            .get("usageGuidelines")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                LocalAgentStoreError::new(
                    "session_event_invalid",
                    "runtimeSnapshot tool prompt usageGuidelines 必须是数组。",
                )
            })?;
        if usage_guidelines.len() > 8
            || usage_guidelines.iter().any(|guideline| {
                guideline
                    .as_str()
                    .is_none_or(|text| !valid_tool_prompt_line(text, 1_024))
            })
            || prompt_snippet.is_none() && usage_guidelines.is_empty()
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot tool prompt guidelines 无效。",
            ));
        }
    }

    let aliases = value
        .get("providerToolAliases")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot providerToolAliases 必须是数组。",
            )
        })?;
    let mut alias_canonical_names = std::collections::HashSet::with_capacity(aliases.len());
    let mut alias_wire_names = std::collections::HashSet::with_capacity(aliases.len());
    for alias in aliases {
        exact_object(alias, &["canonicalName", "wireName"], &[])?;
        let canonical_name = required_string(alias, "canonicalName")?;
        let wire_name = required_string(alias, "wireName")?;
        if canonical_name.len() > 128
            || !canonical_name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
            || wire_name.len() > 64
            || !wire_name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
            || !alias_canonical_names.insert(canonical_name)
            || !alias_wire_names.insert(wire_name)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot providerToolAliases 包含无效或重复映射。",
            ));
        }
    }
    if callable_tool_names
        .iter()
        .any(|name| !alias_canonical_names.contains(*name))
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot providerToolAliases 缺少 callable 工具。",
        ));
    }

    let web_search = value.get("webSearch").ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot 缺少 webSearch binding。",
        )
    })?;
    let web_search_owner = required_string(web_search, "owner")?;
    let kernel_search_callable = callable_tool_names.contains("web.search");
    match web_search_owner {
        "providerHosted" => {
            exact_object(web_search, &["owner", "providerToolType"], &[])?;
            if required_string(web_search, "providerToolType")? != "web_search"
                || api_surface != "responses"
                || hosted_web_search != "web_search"
                || kernel_search_callable
            {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Provider hosted search binding 与 runtime capability 不一致。",
                ));
            }
        }
        "kernelAdapter" => {
            exact_object(web_search, &["owner", "toolName"], &[])?;
            if required_string(web_search, "toolName")? != "web.search" || !kernel_search_callable {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Kernel search adapter binding 缺少 callable web.search。",
                ));
            }
        }
        "unavailable" => {
            exact_object(web_search, &["owner"], &[])?;
            if kernel_search_callable {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "Unavailable search binding 不能同时暴露 callable web.search。",
                ));
            }
        }
        _ => {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot webSearch owner 无效。",
            ));
        }
    }

    let selected_plugins = value.get("selectedPlugins").ok_or_else(|| {
        LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot 缺少 selectedPlugins。",
        )
    })?;
    exact_object(selected_plugins, &["catalogRevision", "plugins"], &[])?;
    validate_runtime_identity(
        "pluginCatalogRevision",
        required_string(selected_plugins, "catalogRevision")?,
    )?;
    let plugins = selected_plugins
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot selectedPlugins.plugins 必须是数组。",
            )
        })?;
    if plugins.len() > 16 {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot selectedPlugins 超过单次选择上限。",
        ));
    }
    let mut plugin_uris = std::collections::HashSet::with_capacity(plugins.len());
    let mut plugin_instance_refs = std::collections::HashSet::with_capacity(plugins.len());
    for plugin in plugins {
        exact_object(
            plugin,
            &[
                "uri",
                "pluginArtifactRef",
                "pluginInstanceRef",
                "extensionGenerationRef",
                "capabilityRefs",
            ],
            &[],
        )?;
        let uri = required_string(plugin, "uri")?;
        if !uri.starts_with("plugin://")
            || uri.trim() != uri
            || uri.chars().any(char::is_whitespace)
            || !plugin_uris.insert(uri)
        {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot selected plugin URI 无效或重复。",
            ));
        }
        for field in ["pluginArtifactRef", "pluginInstanceRef"] {
            validate_runtime_identity(field, required_string(plugin, field)?)?;
        }
        if !plugin_instance_refs.insert(required_string(plugin, "pluginInstanceRef")?) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot pluginInstanceRef 不能重复。",
            ));
        }
        if required_string(plugin, "extensionGenerationRef")? != extension_generation_ref {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "runtimeSnapshot selected plugin generation 与 run 不一致。",
            ));
        }
        validate_unique_ids(plugin, "capabilityRefs")?;
    }
    if prompt_plugin_uris
        .iter()
        .any(|plugin_uri| !plugin_uris.contains(plugin_uri.as_str()))
    {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "runtimeSnapshot extension tool prompt contribution 未绑定 selected plugin。",
        ));
    }

    Ok(RunProviderRuntime {
        reasoning_effort_override: provider
            .get("reasoningEffortOverride")
            .and_then(Value::as_str)
            .map(str::to_string),
        provider_runtime_ref: provider_runtime_ref.to_string(),
        profile_id: profile_id.to_string(),
        context_window_tokens,
        max_output_tokens,
        api_surface: api_surface.to_string(),
        hosted_web_search: hosted_web_search.to_string(),
        web_search_owner: web_search_owner.to_string(),
    })
}

fn validate_runtime_identity(field: &str, value: &str) -> Result<(), LocalAgentStoreError> {
    validate_id(field, value)?;
    if value.trim() != value {
        return Err(LocalAgentStoreError::new(
            "local_agent_identity_invalid",
            format!("{field} 不是 canonical 标识。"),
        ));
    }
    Ok(())
}

fn valid_tool_prompt_line(value: &str, max_length: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max_length
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn validate_local_agent_error(value: &Value) -> Result<(), LocalAgentStoreError> {
    exact_object(value, &["code", "message"], &[])?;
    let code = required_string(value, "code")?;
    let message = required_string(value, "message")?;
    if code.trim() != code || message.trim().is_empty() || message.contains('\0') {
        return Err(LocalAgentStoreError::new(
            "session_event_invalid",
            "LocalAgentError code 或 message 无效。",
        ));
    }
    Ok(())
}

fn validate_input_rejection_error(error: &Value) -> Result<(), LocalAgentStoreError> {
    exact_object(error, &["code", "message", "issues"], &[])?;
    required_string(error, "code")?;
    required_string(error, "message")?;
    let issues = error["issues"]
        .as_array()
        .filter(|issues| !issues.is_empty())
        .ok_or_else(|| {
            LocalAgentStoreError::new("tool_rejection_invalid", "工具参数拒绝必须包含字段诊断。")
        })?;
    for issue in issues {
        exact_object(issue, &["path", "rule", "message"], &["expected"])?;
        for field in ["path", "rule", "message"] {
            required_string(issue, field)?;
        }
    }
    Ok(())
}

fn validate_run_settlement(value: &Value) -> Result<(), LocalAgentStoreError> {
    match required_string(value, "outcome")? {
        "completed" => {
            exact_object(value, &["outcome", "finalMessageId"], &[])?;
            validate_id("finalMessageId", required_string(value, "finalMessageId")?)?;
        }
        "failed" | "indeterminate" => {
            exact_object(value, &["outcome", "error"], &[])?;
            validate_local_agent_error(value.get("error").expect("validated error"))?;
        }
        "cancelled" => {
            exact_object(value, &["outcome"], &[])?;
        }
        _ => {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                "Run settlement outcome 无效。",
            ))
        }
    }
    Ok(())
}

fn validate_unique_ids(value: &Value, field: &str) -> Result<(), LocalAgentStoreError> {
    let values = value.get(field).and_then(Value::as_array).ok_or_else(|| {
        LocalAgentStoreError::new("session_event_invalid", format!("{field} 必须是数组。"))
    })?;
    let mut seen = std::collections::HashSet::with_capacity(values.len());
    for candidate in values {
        let identity = candidate.as_str().ok_or_else(|| {
            LocalAgentStoreError::new("session_event_invalid", format!("{field} 必须只包含标识。"))
        })?;
        validate_runtime_identity(field, identity)?;
        if !seen.insert(identity) {
            return Err(LocalAgentStoreError::new(
                "session_event_invalid",
                format!("{field} 不能重复。"),
            ));
        }
    }
    Ok(())
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

fn verify_current_event_constraint(connection: &Connection) -> Result<(), LocalAgentStoreError> {
    let table_sql = SESSION_STORE_SCHEMA
        .split(';')
        .map(str::trim)
        .find(|sql| sql.starts_with("CREATE TABLE IF NOT EXISTS session_events ("))
        .expect("canonical session_events table definition");
    let normalize = |sql: &str| {
        sql.replace(" IF NOT EXISTS", "")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let stored_sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name='session_events'",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error("session_store_verify_failed"))?;
    if normalize(&stored_sql) == normalize(table_sql) {
        return Ok(());
    }
    Err(LocalAgentStoreError::new(
        "session_store_event_schema_mismatch",
        "Session event 表与当前合同不一致；未修改数据库结构或历史记录。",
    ))
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

    fn plan_response_command(response: Value) -> Value {
        json!({
            "schemaVersion": COMMAND_VERSION,
            "type": "plan.respond",
            "commandId": "command:plan-response",
            "sessionId": "session:plan-response",
            "runId": "run:plan-response",
            "planId": "plan:plan-response",
            "revision": 1,
            "response": response
        })
    }

    fn command_reply(status: &str) -> Value {
        json!({
            "schemaVersion": REPLY_VERSION,
            "commandId": "command:plan-response",
            "sessionId": "session:plan-response",
            "status": status,
            "revision": 0,
            "error": {
                "code": "plan_not_pending",
                "message": "The Plan is no longer pending."
            }
        })
    }

    fn runtime_snapshot() -> Value {
        json!({
            "runRuntimeSnapshotRef": "run-runtime:test",
            "extensionGenerationRef": "extension-generation:test",
            "kernelCatalogSnapshotRef": "kernel-catalog:test",
            "provider": {
                "providerRuntimeRef": "provider-runtime:test",
                "profileId": "profile:test",
                "contextWindowTokens": 1000,
                "maxOutputTokens": 100,
                "apiSurface": "chatCompletions",
                "hostedWebSearch": "none"
            },
            "webSearch": {"owner":"unavailable"},
            "instructions": [],
            "tools": [],
            "toolPromptContributions": [],
            "providerToolAliases": [
                {"canonicalName":"interaction.request","wireName":"interaction_request"},
                {"canonicalName":"plan.publish","wireName":"plan_publish"}
            ],
            "selectedPlugins": {
                "catalogRevision": "plugin-catalog:test",
                "plugins": []
            }
        })
    }

    #[test]
    fn runtime_snapshot_requires_tool_prompt_to_match_a_callable_prepared_binding() {
        let mut runtime = runtime_snapshot();
        runtime["tools"] = json!([{
            "toolBindingRef": "tool-binding:read:test",
            "name": "fs.read",
            "description": "Read UTF-8 workspace text.",
            "inputSchema": {"type": "object"},
            "possibleEffects": ["workspaceRead"],
            "availability": "callable",
            "origin": "coreBuiltin"
        }]);
        runtime["providerToolAliases"]
            .as_array_mut()
            .expect("provider aliases")
            .push(json!({"canonicalName":"fs.read","wireName":"fs_read"}));
        runtime["toolPromptContributions"] = json!([{
            "contributionRef": "tool-prompt-contribution:read:test",
            "preparedToolBindingRef": "tool-binding:read:test",
            "canonicalToolName": "fs.read",
            "origin": "coreBuiltin",
            "promptSnippet": "Read known text files directly.",
            "usageGuidelines": ["Use bounded offsets when only a segment is needed."]
        }]);

        validate_run_runtime_snapshot(&runtime).expect("valid prepared prompt contribution");

        let mut stale_binding = runtime.clone();
        stale_binding["toolPromptContributions"][0]["preparedToolBindingRef"] =
            json!("tool-binding:read:stale");
        let error = validate_run_runtime_snapshot(&stale_binding)
            .expect_err("stale prompt binding must fail");
        assert_eq!(error.code, "session_event_invalid");

        let mut blocked = runtime;
        blocked["tools"][0]["availability"] = json!("blocked");
        let error = validate_run_runtime_snapshot(&blocked)
            .expect_err("blocked tools must not retain prepared prompt contributions");
        assert_eq!(error.code, "session_event_invalid");
    }

    #[test]
    fn journal_writes_model_settings_and_input_rejection_to_sqlite() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-loop-events-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).unwrap();
        journal
            .create_session("session:loop", "Loop", &json!([]), Some("profile:test"))
            .unwrap();
        append_model_settings_and_rejected_call(&journal);
        let events = journal.read_events("session:loop", 0).unwrap();
        let saved_command = journal
            .read_command("session:loop", "command:settings")
            .unwrap();
        drop(journal);
        let reopened = LocalAgentJournal::open(&path).unwrap();
        assert_eq!(reopened.read_events("session:loop", 0).unwrap(), events);
        assert_eq!(
            reopened
                .read_command("session:loop", "command:settings")
                .unwrap(),
            saved_command
        );
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn journal_persists_session_input_rejection_without_a_kernel_call() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-provider-input-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).unwrap();
        journal
            .create_session("session:loop", "Loop", &json!([]), Some("profile:test"))
            .unwrap();
        append_model_settings_and_rejected_call(&journal);
        let events = journal.read_events("session:loop", 0).unwrap();
        let mut composition = events
            .iter()
            .find(|event| event["type"] == "context.composed")
            .unwrap()
            .clone();
        let composition = composition.as_object_mut().unwrap();
        for field in ["schemaVersion", "eventId", "sequence", "occurredAt"] {
            composition.remove(field);
        }
        composition.get_mut("payload").unwrap()["providerRequestId"] =
            json!("provider-request:bad-arguments");
        journal.append(&Value::Object(composition.clone())).unwrap();
        let block = json!({
            "outputIndex":0,"kind":"toolCallRejected","callId":"call:raw-rejected",
            "providerCallId":"native:raw-rejected","toolName":"fs.read",
            "item":{"type":"function_call","call_id":"native:raw-rejected","name":"fs_read","arguments":"{\"path\":","status":"completed"},
            "error":{"code":"provider_tool_call_arguments_invalid","message":"Invalid JSON object.","issues":[{"path":"$","rule":"json_object","message":"Invalid JSON object."}]}
        });
        let completed = json!({
            "type":"provider.turn.settled","sessionId":"session:loop","runId":"run:loop",
            "payload":{"outcome":"completed","providerRequestId":"provider-request:bad-arguments","purpose":"agent",
                "providerRuntimeRef":"provider-runtime:test","orderedCallIds":[],"orderedOutputBlocks":[block]}
        });
        let mut fake_call_fact = completed.clone();
        fake_call_fact["payload"]["orderedCallIds"] = json!(["call:raw-rejected"]);
        assert!(
            journal.append(&fake_call_fact).is_err(),
            "a rejection must not invent an accepted call fact"
        );
        journal.append(&completed).unwrap();
        let saved = journal.read_events("session:loop", 0).unwrap();
        assert_eq!(
            saved
                .iter()
                .filter(|event| event["type"] == "tool.requested")
                .count(),
            1,
            "only the earlier Kernel fixture call exists"
        );
        assert_eq!(
            saved.last().unwrap()["payload"]["orderedOutputBlocks"][0],
            block
        );
        drop(journal);
        let reopened = LocalAgentJournal::open(&path).unwrap();
        assert_eq!(reopened.read_events("session:loop", 0).unwrap(), saved);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn journal_closes_unknown_tool_result_after_release_before_settlement() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-tool-interrupted-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).unwrap();
        journal
            .create_session("session:loop", "Loop", &json!([]), Some("profile:test"))
            .unwrap();
        append_model_settings_and_rejected_call(&journal);
        let events = journal.read_events("session:loop", 0).unwrap();
        for kind in [
            "context.composed",
            "tool.requested",
            "provider.turn.settled",
        ] {
            let mut event = events
                .iter()
                .find(|event| event["type"] == kind)
                .unwrap()
                .clone();
            let object = event.as_object_mut().unwrap();
            for key in ["schemaVersion", "eventId", "sequence", "occurredAt"] {
                object.remove(key);
            }
            if kind == "tool.requested" {
                event["callId"] = json!("call:unknown");
                event["payload"]["attemptId"] = json!("attempt:unknown");
                event["payload"]["providerCallId"] = json!("provider-call:unknown");
            } else {
                event["payload"]["providerRequestId"] = json!("provider-request:unknown");
                if kind == "provider.turn.settled" {
                    event["payload"]["orderedCallIds"] = json!(["call:unknown"]);
                }
            }
            journal.append(&event).unwrap();
        }
        let interrupted = json!({
            "type":"tool.interrupted", "sessionId":"session:loop", "runId":"run:loop", "callId":"call:unknown",
            "payload":{"attemptId":"attempt:unknown", "error":{"code":"tool_result_unknown", "message":"Kernel result unavailable after runtime release; original fetch failed."}}
        });
        assert_eq!(
            journal.append(&interrupted).unwrap_err().code,
            "tool_interruption_state_invalid"
        );
        let outcome = json!({"outcome":"failed", "error":{"code":"local_agent_transport_failed", "message":"fetch failed"}});
        journal.append(&json!({"type":"run.finishing", "sessionId":"session:loop", "runId":"run:loop", "payload":outcome})).unwrap();
        journal.append(&json!({
            "type":"run.runtime.released", "sessionId":"session:loop", "runId":"run:loop",
            "payload":{"runRuntimeSnapshotRef":"run-runtime:test", "extensionGenerationRef":"extension-generation:test", "kernelCatalogSnapshotRef":"kernel-catalog:test", "providerRuntimeRef":"provider-runtime:test", "pluginInstanceRefs":[], "alreadyReleased":false}
        })).unwrap();
        let settled = json!({"type":"run.settled", "sessionId":"session:loop", "runId":"run:loop", "payload":outcome});
        assert_eq!(
            journal.append(&settled).unwrap_err().code,
            "run_tool_result_missing"
        );
        let mut wrong_attempt = interrupted.clone();
        wrong_attempt["payload"]["attemptId"] = json!("attempt:other");
        assert_eq!(
            journal.append(&wrong_attempt).unwrap_err().code,
            "tool_interruption_state_invalid"
        );
        journal.append_batch(&[interrupted, settled]).unwrap();
        let saved = journal.read_events("session:loop", 0).unwrap();
        let last = &saved[saved.len() - 3..];
        assert_eq!(
            last.iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["run.runtime.released", "tool.interrupted", "run.settled"]
        );
        assert!(last[1]["payload"].get("record").is_none());
        assert!(last[1]["payload"].get("executed").is_none());
        assert_eq!(last[2]["payload"]["error"]["message"], "fetch failed");
        drop(journal);
        let reopened = LocalAgentJournal::open(&path).unwrap();
        assert_eq!(reopened.read_events("session:loop", 0).unwrap(), saved);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn journal_rejects_incorrect_event_constraint_without_rewriting_history() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-constraint-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let connection = Connection::open(&path).unwrap();
        // Reproduce the exact schema-7 omission observed in the installed app.
        connection
            .execute_batch(
                &SESSION_STORE_SCHEMA
                    .replace("        'session.model-settings.updated',\n", "")
                    .replace("        'tool.input-rejected',\n", ""),
            )
            .unwrap();
        let journal = LocalAgentJournal {
            connection: Arc::new(Mutex::new(connection)),
        };
        journal
            .create_session(
                "session:loop",
                "Existing conversation",
                &json!([
                    {"workspaceId":"workspace:test","displayName":"Test"}
                ]),
                Some("profile:test"),
            )
            .unwrap();
        journal.commit_command(&json!({
            "command":{
                "schemaVersion":COMMAND_VERSION,"type":"message.submit","sessionId":"session:loop",
                "commandId":"command:before-repair","text":"Preserve this conversation."
            },
            "events":[{
                "type":"input.accepted","sessionId":"session:loop",
                "payload":{"commandId":"command:before-repair","messageId":"message:before-repair","text":"Preserve this conversation."}
            }],
            "reply":{
                "schemaVersion":REPLY_VERSION,"sessionId":"session:loop",
                "commandId":"command:before-repair","status":"accepted","revision":0
            }
        })).unwrap();
        let before_events = journal.read_events("session:loop", 0).unwrap();
        let before_command = journal
            .read_command("session:loop", "command:before-repair")
            .unwrap();
        let read_indexes = |journal: &LocalAgentJournal| -> Vec<(String, String)> {
            journal.lock().unwrap()
                .prepare("SELECT name, sql FROM sqlite_schema WHERE type='index' AND tbl_name='session_events' AND sql IS NOT NULL ORDER BY name")
                .unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap().collect::<rusqlite::Result<_>>().unwrap()
        };
        let read_table =
            |journal: &LocalAgentJournal| -> String {
                journal.lock().unwrap().query_row(
                "SELECT sql FROM sqlite_schema WHERE type='table' AND name='session_events'",
                [], |row| row.get(0),
            ).unwrap()
            };
        let read_schema_revision = |journal: &LocalAgentJournal| -> u32 {
            journal
                .lock()
                .unwrap()
                .query_row("PRAGMA schema_version", [], |row| row.get(0))
                .unwrap()
        };
        let before_indexes = read_indexes(&journal);
        let before_table = read_table(&journal);
        let before_schema_revision = read_schema_revision(&journal);
        drop(journal);
        let error = LocalAgentJournal::open(&path)
            .err()
            .expect("invalid event table must fail open");
        assert_eq!(error.code, "session_store_event_schema_mismatch");
        // Inspect the original database directly after the rejected open.
        let unchanged = LocalAgentJournal {
            connection: Arc::new(Mutex::new(Connection::open(&path).unwrap())),
        };
        assert_eq!(
            unchanged.read_events("session:loop", 0).unwrap(),
            before_events
        );
        assert_eq!(
            unchanged
                .read_command("session:loop", "command:before-repair")
                .unwrap(),
            before_command
        );
        assert_eq!(read_indexes(&unchanged), before_indexes);
        assert_eq!(read_table(&unchanged), before_table);
        assert_eq!(read_schema_revision(&unchanged), before_schema_revision);
        assert_eq!(unchanged.lock().unwrap().query_row(
            "SELECT display_name FROM session_workspace_bindings WHERE session_id='session:loop'", [],
            |row| row.get::<_, String>(0)
        ).unwrap(), "Test");
        assert!(unchanged.lock().unwrap().execute(
            "INSERT INTO session_events(session_id,sequence,event_id,event_type,payload_json,occurred_at)
             VALUES ('session:loop',999,'event:invalid','undeclared.event','{}','2026-09-07T00:00:00Z')", []
        ).is_err(), "undeclared events must still fail the database CHECK");
        assert_eq!(
            unchanged
                .lock()
                .unwrap()
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        drop(unchanged);
        std::fs::remove_file(path).unwrap();
    }

    fn append_model_settings_and_rejected_call(journal: &LocalAgentJournal) {
        let settings = json!({"profileId":"profile:test","reasoningEffortOverride":"high"});
        let result = journal
            .commit_command(&json!({
                "command": {
                    "schemaVersion": COMMAND_VERSION,
                    "type":"session.model-settings.set", "sessionId":"session:loop",
                    "commandId":"command:settings", "settings":settings
                },
                "events":[{
                    "type":"session.model-settings.updated", "sessionId":"session:loop",
                    "payload":{"commandId":"command:settings","settings":settings}
                }],
                "reply":{
                    "schemaVersion":REPLY_VERSION,"sessionId":"session:loop",
                    "commandId":"command:settings","status":"accepted","revision":0
                }
            }))
            .expect("save settings through the real SQLite command transaction");
        assert_eq!(result["status"], "accepted");
        journal.append(&json!({
            "type":"run.started", "sessionId":"session:loop", "runId":"run:loop",
            "payload":{"inputMessageId":"message:loop","workspaceBindings":[],"runtimeSnapshot":runtime_snapshot()}
        })).unwrap();
        journal.append(&json!({
            "type":"context.composed", "sessionId":"session:loop", "runId":"run:loop",
            "payload":{
                "providerRequestId":"provider-request:loop","purpose":"agent","responseConstraint":"normal",
                "stableCoreHash":"context-hash-v1:0000000000000001",
                "baseToolSchemaHash":"context-hash-v1:0000000000000002",
                "selectedPluginSnapshotHash":"context-hash-v1:0000000000000003",
                "dynamicInstructionBytes":0,"messages":[],"workspaceBindings":[],"tools":[],
                "partitions":[
                    {"kind":"instructions","itemCount":0,"requestShapeUnits":1},
                    {"kind":"sessionControls","itemCount":0,"requestShapeUnits":0},
                    {"kind":"tools","itemCount":0,"requestShapeUnits":0},
                    {"kind":"workspaceBindings","itemCount":0,"requestShapeUnits":0},
                    {"kind":"contextProviders","itemCount":0,"requestShapeUnits":0},
                    {"kind":"journalMessages","itemCount":0,"requestShapeUnits":0},
                    {"kind":"filesystemReferences","itemCount":0,"requestShapeUnits":0}
                ]
            }
        })).unwrap();
        journal.append(&json!({
            "type":"tool.requested", "sessionId":"session:loop", "runId":"run:loop","callId":"call:loop",
            "payload":{
                "providerCallId":"provider-call:loop","attemptId":"attempt:loop","toolName":"bash",
                "input":{"command":"pwd","executionMode":"read"}
            }
        })).unwrap();
        journal.append(&json!({
            "type":"provider.turn.settled", "sessionId":"session:loop", "runId":"run:loop",
            "payload":{
                "outcome":"completed","providerRequestId":"provider-request:loop","purpose":"agent",
                "providerRuntimeRef":"provider-runtime:test","orderedCallIds":["call:loop"]
            }
        })).unwrap();
        let event = journal.append(&json!({
            "type":"tool.input-rejected", "sessionId":"session:loop", "runId":"run:loop","callId":"call:loop",
            "payload":{"rejection":{
                "sessionId":"session:loop","runId":"run:loop","callId":"call:loop","attemptId":"attempt:loop",
                "extensionGenerationRef":"extension-generation:test","kernelCatalogSnapshotRef":"kernel-catalog:test",
                "toolBindingRef":"tool-binding:bash","toolName":"bash","rejectedAt":"2026-09-07T00:00:00Z",
                "input":{"command":"pwd","executionMode":"read"},
                "error":{"code":"tool_input_invalid","message":"Tool was not executed.","issues":[{
                    "path":"$.executionMode","rule":"additionalProperties","message":"Remove this undeclared field."
                }]}
            }}
        })).expect("persist the rejected input without an execution record");
        assert_eq!(event["type"], "tool.input-rejected");
    }

    #[test]
    fn journal_persists_basic_provider_turn_and_usage_flow() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-facts-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).expect("open fact journal");
        journal
            .create_session("session:facts", "Facts", &json!([]), Some("profile:test"))
            .expect("create fact session");
        journal
            .append(&json!({
                "type":"run.started",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "inputMessageId":"message:facts",
                    "workspaceBindings":[],
                    "runtimeSnapshot": runtime_snapshot()
                }
            }))
            .expect("start fact run");
        journal
            .append(&json!({
                "type":"context.composed",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "providerRequestId":"provider-request:facts",
                    "purpose":"agent",
                    "responseConstraint":"normal",
                    "stableCoreHash":"context-hash-v1:0000000000000001",
                    "baseToolSchemaHash":"context-hash-v1:0000000000000002",
                    "selectedPluginSnapshotHash":"context-hash-v1:0000000000000003",
                    "dynamicInstructionBytes":1,
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
                        {"kind":"filesystemReferences","itemCount":0,"requestShapeUnits":0}
                    ]
                }
            }))
            .expect("record provider request composition");
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
            .expect("record structured provider call fact");
        journal
            .append(&json!({
                "type":"provider.turn.settled",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "outcome":"completed",
                    "providerRequestId":"provider-request:facts",
                    "purpose":"agent",
                    "providerRuntimeRef":"provider-runtime:test",
                    "orderedCallIds":["call:plan"]
                }
            }))
            .expect("complete provider turn");
        journal
            .append(&json!({
                "type":"context.updated",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "providerRequestId":"provider-request:facts",
                    "providerRuntimeRef":"provider-runtime:test",
                    "inputTokens":20,
                    "outputTokens":5,
                    "contextWindowTokens":1000,
                    "cacheReadInputTokens":8,
                    "cacheMissInputTokens":12
                }
            }))
            .expect("record receipt-linked usage");
        journal
            .append(&json!({
                "type":"message.committed",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "messageId":"message:final",
                    "role":"assistant",
                    "content":"Done.",
                    "providerRequestId":"provider-request:facts"
                }
            }))
            .expect("record final assistant message");
        journal
            .append(&json!({
                "type":"run.finishing",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{"outcome":"completed","finalMessageId":"message:final"}
            }))
            .expect("finish fact run");
        journal
            .append(&json!({
                "type":"run.runtime.released",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{
                    "runRuntimeSnapshotRef":"run-runtime:test",
                    "extensionGenerationRef":"extension-generation:test",
                    "kernelCatalogSnapshotRef":"kernel-catalog:test",
                    "providerRuntimeRef":"provider-runtime:test",
                    "pluginInstanceRefs":[],
                    "alreadyReleased":false
                }
            }))
            .expect("record runtime release receipt");
        journal
            .append(&json!({
                "type":"run.settled",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "payload":{"outcome":"completed","finalMessageId":"message:final"}
            }))
            .expect("settle fact run after release");
        let events = journal
            .read_events("session:facts", 0)
            .expect("read durable provider flow");
        let event_types = events
            .iter()
            .map(|event| event["type"].as_str().expect("event type"))
            .collect::<Vec<_>>();
        assert_eq!(
            event_types,
            [
                "session.created",
                "run.started",
                "context.composed",
                "plan.published",
                "provider.turn.settled",
                "context.updated",
                "message.committed",
                "run.finishing",
                "run.runtime.released",
                "run.settled",
            ]
        );
        assert_eq!(
            events[5]["payload"]["providerRequestId"],
            "provider-request:facts"
        );

        drop(journal);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pending_provider_composition_is_closed_atomically_before_run_finishing() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-provider-terminal-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).expect("open terminal fact journal");
        journal
            .create_session(
                "session:terminal",
                "Terminal",
                &json!([]),
                Some("profile:test"),
            )
            .expect("create terminal fact session");
        journal
            .append(&json!({
                "type":"run.started",
                "sessionId":"session:terminal",
                "runId":"run:terminal",
                "payload":{
                    "inputMessageId":"message:terminal",
                    "workspaceBindings":[],
                    "runtimeSnapshot":runtime_snapshot()
                }
            }))
            .expect("start terminal fact run");
        journal
            .append(&json!({
                "type":"context.composed",
                "sessionId":"session:terminal",
                "runId":"run:terminal",
                "payload":{
                    "providerRequestId":"provider-request:terminal",
                    "purpose":"agent",
                    "responseConstraint":"normal",
                    "stableCoreHash":"context-hash-v1:0000000000000001",
                    "baseToolSchemaHash":"context-hash-v1:0000000000000002",
                    "selectedPluginSnapshotHash":"context-hash-v1:0000000000000003",
                    "dynamicInstructionBytes":1,
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
                        {"kind":"filesystemReferences","itemCount":0,"requestShapeUnits":0}
                    ]
                }
            }))
            .expect("record pending provider composition");
        let error = json!({
            "code":"provider_turn_outcome_unknown",
            "message":"Provider completion was not observed."
        });
        let batch = [
            json!({
                "type":"provider.turn.settled",
                "sessionId":"session:terminal",
                "runId":"run:terminal",
                "payload":{
                    "providerRequestId":"provider-request:terminal",
                    "purpose":"agent",
                    "providerRuntimeRef":"provider-runtime:test",
                    "outcome":"indeterminate",
                    "error":error
                }
            }),
            json!({
                "type":"run.finishing",
                "sessionId":"session:terminal",
                "runId":"run:terminal",
                "payload":{
                    "outcome":"indeterminate",
                    "error":error
                }
            }),
        ];
        let before = journal.read_events("session:terminal", 0).unwrap();
        let mut invalid_shape = batch.clone();
        invalid_shape[1]["payload"] = Value::Null;
        let shape_error = journal
            .append_batch(&invalid_shape)
            .expect_err("invalid event shape must reject the whole batch");
        assert_eq!(shape_error.code, "session_event_invalid");
        assert_eq!(journal.read_events("session:terminal", 0).unwrap(), before);

        let fact_error = journal
            .append_batch(&[batch[0].clone(), batch[1].clone(), batch[1].clone()])
            .expect_err("invalid lifecycle facts must roll back the whole batch");
        assert_eq!(fact_error.code, "run_finishing_state_invalid");
        assert_eq!(journal.read_events("session:terminal", 0).unwrap(), before);

        let committed = journal
            .append_batch(&batch)
            .expect("settle provider and start run release in one transaction");
        assert_eq!(committed[0]["type"], "provider.turn.settled");
        assert_eq!(committed[1]["type"], "run.finishing");
        assert_eq!(
            committed[0]["sequence"].as_u64().unwrap() + 1,
            committed[1]["sequence"].as_u64().unwrap()
        );

        drop(journal);
        let _ = std::fs::remove_file(path);
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
    fn ordered_tool_call_identity_must_match_the_committed_provider_call_fact() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-ordered-call-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).expect("open ordered call journal");
        journal
            .create_session(
                "session:ordered-call",
                "Ordered call",
                &json!([]),
                Some("profile:test"),
            )
            .expect("create ordered call session");
        journal
            .append(&json!({
                "type":"run.started",
                "sessionId":"session:ordered-call",
                "runId":"run:ordered-call",
                "payload":{
                    "inputMessageId":"message:ordered-call",
                    "workspaceBindings":[],
                    "runtimeSnapshot":runtime_snapshot()
                }
            }))
            .expect("start ordered call run");
        journal
            .append(&json!({
                "type":"context.composed",
                "sessionId":"session:ordered-call",
                "runId":"run:ordered-call",
                "payload":{
                    "providerRequestId":"provider-request:ordered-call",
                    "purpose":"agent",
                    "responseConstraint":"normal",
                    "stableCoreHash":"context-hash-v1:0000000000000001",
                    "baseToolSchemaHash":"context-hash-v1:0000000000000002",
                    "selectedPluginSnapshotHash":"context-hash-v1:0000000000000003",
                    "dynamicInstructionBytes":1,
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
                        {"kind":"filesystemReferences","itemCount":0,"requestShapeUnits":0}
                    ]
                }
            }))
            .expect("record ordered call composition");
        journal
            .append(&json!({
                "type":"plan.published",
                "sessionId":"session:ordered-call",
                "runId":"run:ordered-call",
                "callId":"call:ordered-plan",
                "payload":{
                    "providerCallId":"provider-call:ordered-plan",
                    "planId":"plan:ordered-call",
                    "revision":1,
                    "title":"Inspect",
                    "summary":"Inspect the workspace.",
                    "steps":[{"stepId":"step:ordered","title":"Inspect","details":"Inspect files."}],
                    "mutationManifest":[]
                }
            }))
            .expect("record ordered plan call fact");

        let settlement = |provider_call_id: &str, tool_name: &str| {
            json!({
                "type":"provider.turn.settled",
                "sessionId":"session:ordered-call",
                "runId":"run:ordered-call",
                "payload":{
                    "outcome":"completed",
                    "providerRequestId":"provider-request:ordered-call",
                    "purpose":"agent",
                    "providerRuntimeRef":"provider-runtime:test",
                    "orderedCallIds":["call:ordered-plan"],
                    "orderedOutputBlocks":[{
                        "outputIndex":0,
                        "kind":"toolCall",
                        "callId":"call:ordered-plan",
                        "providerCallId":provider_call_id,
                        "toolName":tool_name,
                        "item":{
                            "type":"function_call",
                            "id":"provider-item:ordered-plan",
                            "call_id":provider_call_id,
                            "name":"plan_publish",
                            "arguments":"{}",
                            "status":"completed"
                        }
                    }]
                }
            })
        };
        let error = journal
            .append(&settlement("provider-call:wrong", "plan.publish"))
            .expect_err("mismatched provider call identity must fail");
        assert_eq!(error.code, "provider_turn_call_identity_mismatch");
        let error = journal
            .append(&settlement("provider-call:ordered-plan", "fs.read"))
            .expect_err("mismatched canonical tool name must fail");
        assert_eq!(error.code, "provider_turn_call_identity_mismatch");
        journal
            .append(&settlement("provider-call:ordered-plan", "plan.publish"))
            .expect("matching ordered tool call identity must persist");

        drop(journal);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejected_commands_are_eventless_while_accepted_plan_responses_remain_atomic() {
        let command = plan_response_command(json!({"kind": "cancel"}));
        let rejected = command_reply("rejected");
        validate_command_event_batch(&command, &[], &rejected)
            .expect("persist the real stale Plan rejection without lifecycle events");

        let rejected_with_event = [json!({
            "type": "plan.cancelled",
            "payload": {
                "planId": "plan:plan-response",
                "revision": 1,
                "commandId": "command:plan-response"
            }
        })];
        let error = validate_command_event_batch(&command, &rejected_with_event, &rejected)
            .expect_err("a rejected command must never mutate Session facts");
        assert_eq!(error.code, "rejected_command_event_batch_invalid");

        let accepted = command_reply("accepted");
        let error = validate_command_event_batch(&command, &[], &accepted)
            .expect_err("an accepted Plan response must carry its lifecycle fact");
        assert_eq!(error.code, "plan_command_event_batch_invalid");

        validate_command_event_batch(&command, &rejected_with_event, &accepted)
            .expect("the matching accepted Plan lifecycle fact remains valid");
    }

    #[test]
    fn explicit_plan_progress_persists_with_provider_order_and_tool_evidence() {
        let journal = LocalAgentJournal::open(Path::new(":memory:")).unwrap();
        journal
            .create_session(
                "session:progress",
                "Progress",
                &json!([]),
                Some("profile:test"),
            )
            .unwrap();
        let event = |kind: &str, payload: Value| json!({"type":kind, "sessionId":"session:progress", "runId":"run:progress", "payload":payload});
        let composition = |id: &str| {
            event(
                "context.composed",
                json!({
                    "providerRequestId":id,"purpose":"agent","responseConstraint":"normal",
                    "stableCoreHash":"context-hash-v1:0000000000000001", "baseToolSchemaHash":"context-hash-v1:0000000000000002",
                    "selectedPluginSnapshotHash":"context-hash-v1:0000000000000003", "dynamicInstructionBytes":0,
                    "messages":[], "workspaceBindings":[], "tools":[],
                    "partitions":[
                        {"kind":"instructions","itemCount":0,"requestShapeUnits":1},
                        {"kind":"sessionControls","itemCount":0,"requestShapeUnits":0},
                        {"kind":"tools","itemCount":0,"requestShapeUnits":0},
                        {"kind":"workspaceBindings","itemCount":0,"requestShapeUnits":0},
                        {"kind":"contextProviders","itemCount":0,"requestShapeUnits":0},
                        {"kind":"journalMessages","itemCount":0,"requestShapeUnits":0},
                        {"kind":"filesystemReferences","itemCount":0,"requestShapeUnits":0}
                    ]
                }),
            )
        };
        let settled = |id: &str, calls: Value| {
            event(
                "provider.turn.settled",
                json!({
                    "outcome":"completed", "providerRequestId":id, "purpose":"agent",
                    "providerRuntimeRef":"provider-runtime:test", "orderedCallIds":calls,
                }),
            )
        };
        journal.append(&event("run.started", json!({"inputMessageId":"message:progress", "workspaceBindings":[], "runtimeSnapshot":runtime_snapshot()}))).unwrap();
        journal.append(&composition("request:plan")).unwrap();
        let mut plan = event(
            "plan.published",
            json!({"providerCallId":"provider:plan", "planId":"plan:progress", "revision":1, "title":"Inspect", "summary":"Inspect files.", "steps":[{"stepId":"step:inspect", "title":"Inspect", "details":"Read source."}], "mutationManifest":[]}),
        );
        plan["callId"] = json!("call:plan");
        journal.append(&plan).unwrap();
        journal
            .append(&settled("request:plan", json!(["call:plan"])))
            .unwrap();
        let mut confirm = event(
            "plan.confirmed",
            json!({"planId":"plan:progress", "revision":1, "commandId":"command:confirm", "decisionId":"decision:confirm", "authorities":[]}),
        );
        confirm["callId"] = json!("call:plan");
        journal.append(&confirm).unwrap();
        journal.append(&event("todo.seeded", json!({"sourcePlanId":"plan:progress", "sourcePlanRevision":1, "items":[{"todoId":"todo:inspect", "sourceStepId":"step:inspect", "label":"Inspect", "status":"pending"}]}))).unwrap();
        // The store consumes the Kernel result as an opaque canonical record;
        // this fixture supplies the fields used by the Todo evidence boundary.
        let mut record = event(
            "tool.completed",
            json!({"record":{"recordId":"record:read", "outcome":"completed"}}),
        );
        record["callId"] = json!("call:read");
        journal.append(&record).unwrap();
        journal.append(&composition("request:progress")).unwrap();
        let mut progress = event(
            "todo.progressed",
            json!({
                "providerCallId":"provider:progress", "sourcePlanId":"plan:progress", "sourcePlanRevision":1,
                "sourceFactRef":"record:read", "updates":[{"todoId":"todo:inspect", "status":"completed"}],
            }),
        );
        progress["callId"] = json!("call:progress");
        let mut missing = progress.clone();
        missing["payload"]["sourceFactRef"] = json!("record:missing");
        assert_eq!(
            journal.append(&missing).unwrap_err().code,
            "todo_source_fact_missing"
        );
        let mut completion = settled("request:progress", json!(["call:progress"]));
        completion["payload"]["orderedOutputBlocks"] = json!([{
            "kind":"toolCall", "outputIndex":0, "callId":"call:progress", "providerCallId":"provider:progress", "toolName":"plan.progress",
            "item":{"type":"function_call", "call_id":"provider:progress", "name":"plan_progress", "arguments":"{}", "status":"completed"},
        }]);
        journal
            .append_batch(&[progress.clone(), completion])
            .unwrap();
        assert_eq!(
            journal.append(&progress).unwrap_err().code,
            "provider_turn_composition_missing"
        );
        journal
            .append(&event(
                "plan.completed",
                json!({"planId":"plan:progress", "revision":1}),
            ))
            .unwrap();
        let events = journal.read_events("session:progress", 0).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|value| value["type"] == "todo.progressed")
                .count(),
            1
        );
    }
}
