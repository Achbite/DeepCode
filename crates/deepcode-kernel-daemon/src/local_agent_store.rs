use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

const SESSION_STORE_SCHEMA: &str = include_str!("../../../contracts/agent-runtime-v2/session.sql");
const SESSION_STORE_V2_TO_V3: &str =
    include_str!("../../../contracts/agent-runtime-v2/session-v2-to-v3.sql");
const SESSION_STORE_V3_TO_V4: &str =
    include_str!("../../../contracts/agent-runtime-v2/session-v3-to-v4.sql");
const SESSION_STORE_V4_TO_V5: &str =
    include_str!("../../../contracts/agent-runtime-v2/session-v4-to-v5.sql");
const SESSION_STORE_V5_TO_V6: &str =
    include_str!("../../../contracts/agent-runtime-v2/session-v5-to-v6.sql");
const SESSION_STORE_VERSION: u32 = 6;
const EVENT_VERSION: &str = "deepcode.session-event.v2";
const COMMAND_VERSION: &str = "deepcode.command.v2";
const REPLY_VERSION: &str = "deepcode.command-reply.v2";

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
            0 if !existed || sqlite_is_empty(&connection)? => connection
                .execute_batch(SESSION_STORE_SCHEMA)
                .map_err(sql_error("session_store_schema_create_failed"))?,
            2 => {
                connection
                    .execute_batch(SESSION_STORE_V2_TO_V3)
                    .map_err(sql_error("session_store_v2_to_v3_failed"))?;
                connection
                    .execute_batch(SESSION_STORE_V3_TO_V4)
                    .map_err(sql_error("session_store_v3_to_v4_failed"))?;
                connection
                    .execute_batch(SESSION_STORE_V4_TO_V5)
                    .map_err(sql_error("session_store_v4_to_v5_failed"))?;
                connection
                    .execute_batch(SESSION_STORE_V5_TO_V6)
                    .map_err(sql_error("session_store_v5_to_v6_failed"))?;
                verify_session_store(&connection)?;
                verify_session_store_version(&connection)?;
            }
            3 => {
                connection
                    .execute_batch(SESSION_STORE_V3_TO_V4)
                    .map_err(sql_error("session_store_v3_to_v4_failed"))?;
                connection
                    .execute_batch(SESSION_STORE_V4_TO_V5)
                    .map_err(sql_error("session_store_v4_to_v5_failed"))?;
                connection
                    .execute_batch(SESSION_STORE_V5_TO_V6)
                    .map_err(sql_error("session_store_v5_to_v6_failed"))?;
                verify_session_store(&connection)?;
                verify_session_store_version(&connection)?;
            }
            4 => {
                connection
                    .execute_batch(SESSION_STORE_V4_TO_V5)
                    .map_err(sql_error("session_store_v4_to_v5_failed"))?;
                connection
                    .execute_batch(SESSION_STORE_V5_TO_V6)
                    .map_err(sql_error("session_store_v5_to_v6_failed"))?;
                verify_session_store(&connection)?;
                verify_session_store_version(&connection)?;
            }
            5 => {
                connection
                    .execute_batch(SESSION_STORE_V5_TO_V6)
                    .map_err(sql_error("session_store_v5_to_v6_failed"))?;
                verify_session_store(&connection)?;
                verify_session_store_version(&connection)?;
            }
            SESSION_STORE_VERSION => {
                verify_session_store(&connection)?;
                verify_session_store_version(&connection)?;
            }
            other => {
                return Err(LocalAgentStoreError::new(
                    "session_store_version_unsupported",
                    format!("Session Store 版本 {other} 不是当前 active-v2 store；hard cut 只接受 schema 2/3/4/5 的单向升级或 schema 6。"),
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
        run_id: &str,
        authority: &Value,
    ) -> Result<bool, LocalAgentStoreError> {
        validate_id("sessionId", session_id)?;
        validate_id("runId", run_id)?;
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT payload_json FROM session_events
                 WHERE session_id=?1 AND run_id=?2 AND event_type='plan.intent.resolved'
                 ORDER BY sequence DESC",
            )
            .map_err(sql_error("plan_authority_fact_read_failed"))?;
        let rows = statement
            .query_map(params![session_id, run_id], |row| row.get::<_, String>(0))
            .map_err(sql_error("plan_authority_fact_read_failed"))?;
        for row in rows {
            let payload = decode_json(
                &row.map_err(sql_error("plan_authority_fact_read_failed"))?,
                "plan_authority_fact_corrupt",
            )?;
            if payload.pointer("/response/kind").and_then(Value::as_str) != Some("select") {
                continue;
            }
            if payload
                .get("authorities")
                .and_then(Value::as_array)
                .is_some_and(|authorities| {
                    authorities.iter().any(|candidate| candidate == authority)
                })
            {
                return Ok(true);
            }
        }
        Ok(false)
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
        "plan.intent.requested",
        "plan.intent.resolved",
        "todo.updated",
        "tool.requested",
        "approval.requested",
        "approval.resolved",
        "tool.completed",
        "session.control.rejected",
        "context.composed",
        "context.updated",
        "run.waiting",
        "run.settled",
    ];
    if !allowed.contains(&event_type) || event_type == "session.created" && !allow_creation {
        return Err(LocalAgentStoreError::new(
            "session_event_type_invalid",
            format!("v2 不接受事件：{event_type}"),
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
        "todo.updated"
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
        "message.feedback.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["commandId", "messageId", "feedback"], &[])?;
            validate_id("commandId", required_string(payload, "commandId")?)?;
            validate_id("messageId", required_string(payload, "messageId")?)?;
            validate_feedback(payload.get("feedback").expect("validated feedback"))?;
        }
        "todo.updated" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["items"], &[])?;
            let items = payload
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    LocalAgentStoreError::new(
                        "session_event_invalid",
                        "todo.updated items 必须是数组。",
                    )
                })?;
            if items.len() > 12 {
                return Err(LocalAgentStoreError::new(
                    "session_event_invalid",
                    "todo.updated 最多包含十二项。",
                ));
            }
            let mut todo_ids = std::collections::HashSet::with_capacity(items.len());
            for item in items {
                exact_object(item, &["todoId", "label", "status"], &[])?;
                let todo_id = required_string(item, "todoId")?;
                let label = required_string(item, "label")?;
                validate_id("todoId", todo_id)?;
                if !todo_ids.insert(todo_id) {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "todo.updated 包含重复 todoId。",
                    ));
                }
                if label.trim().is_empty()
                    || label.trim() != label
                    || label.chars().count() > 240
                    || label.chars().any(char::is_control)
                {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "todo.updated label 无效。",
                    ));
                }
                if !matches!(
                    required_string(item, "status")?,
                    "pending" | "inProgress" | "completed"
                ) {
                    return Err(LocalAgentStoreError::new(
                        "session_event_invalid",
                        "todo.updated status 无效。",
                    ));
                }
            }
        }
        "session.control.rejected" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(payload, &["toolName", "input", "error"], &[])?;
            if !matches!(
                required_string(payload, "toolName")?,
                "interaction.request" | "plan.intent" | "todo.update"
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
        "context.composed" => {
            let payload = event.get("payload").expect("validated payload");
            exact_object(
                payload,
                &[
                    "providerRequestId",
                    "responseConstraint",
                    "messages",
                    "workspaceBindings",
                    "tools",
                ],
                &["partitions"],
            )?;
            validate_id(
                "providerRequestId",
                required_string(payload, "providerRequestId")?,
            )?;
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
            if let Some(partitions) = payload.get("partitions") {
                validate_context_partitions(partitions)?;
            }
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
        "todo.updated" | "session.control.rejected" | "context.composed" | "context.updated"
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
        "todo.updated" => {
            let call_id = required_string(event, "callId")?;
            let duplicate: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM session_events
                         WHERE session_id=?1 AND call_id=?2 AND event_type='todo.updated'
                     )",
                    params![session_id, call_id],
                    |row| row.get(0),
                )
                .map_err(sql_error("session_event_fact_read_failed"))?;
            if duplicate {
                return Err(LocalAgentStoreError::new(
                    "todo_call_duplicate",
                    "todo.update callId 已经写入当前 Session。",
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
            "只接受 deepcode.command.v2。",
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
            format!("v2 不接受命令：{command_type}"),
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
            "只接受 deepcode.command-reply.v2。",
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
            "session_store_version_migration_incomplete",
            format!("Session Store schema 迁移后版本仍为 {version}。"),
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
    fn fresh_v2_journal_has_immutable_binding_snapshot_and_plan_events() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-v2-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).expect("open v2 journal");
        let created = journal
            .create_session(
                "session:test",
                "新对话",
                &json!([{"workspaceId":"workspace:test","displayName":"Test"}]),
                Some("profile:test"),
            )
            .expect("create session");
        assert_eq!(created["schemaVersion"], EVENT_VERSION);
        let plan = journal
            .append(&json!({
                "type":"plan.intent.requested",
                "sessionId":"session:test",
                "runId":"run:test",
                "payload":{
                    "planId":"plan:test",
                    "prompt":"选择",
                    "options":[{"optionId":"option:test","label":"写入","operations":[{
                        "workspaceId":"workspace:test","operation":"fs.write","target":"README.md"
                    }]}]
                }
            }))
            .expect("append plan");
        assert_eq!(plan["type"], "plan.intent.requested");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn active_v2_store_migrates_once_and_preserves_events() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-v2-migrate-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let v2_schema = SESSION_STORE_SCHEMA
            .replace("PRAGMA user_version = 6;", "PRAGMA user_version = 2;")
            .replace("        'session.directory-index.attached',\n", "")
            .replace("        'session.directory-index.detached',\n", "")
            .replace("        'todo.updated',\n", "")
            .replace("        'message.feedback.updated',\n", "")
            .replace("        'context.composed',\n", "")
            .replace("        'session.control.rejected',\n", "");
        {
            let connection = Connection::open(&path).expect("open schema-2 store");
            connection
                .execute_batch(&v2_schema)
                .expect("create schema-2 store");
            connection.execute(
                "INSERT INTO sessions(session_id, display_title, created_at) VALUES (?1, ?2, ?3)",
                params!["session:migrate", "迁移", "2026-08-25T00:00:00Z"],
            ).expect("insert session");
            connection
                .execute(
                    "INSERT INTO session_events(
                    session_id, sequence, event_id, event_type, payload_json, occurred_at
                 ) VALUES (?1, 1, ?2, 'session.created', ?3, ?4)",
                    params![
                        "session:migrate",
                        "event:migrate",
                        r#"{"displayTitle":"迁移","workspaceBindings":[]}"#,
                        "2026-08-25T00:00:00Z",
                    ],
                )
                .expect("insert event");
        }

        let journal = LocalAgentJournal::open(&path).expect("migrate schema-2 store");
        let events = journal
            .read_events("session:migrate", 0)
            .expect("read migrated events");
        assert_eq!(events.len(), 1);
        journal
            .append(&json!({
                "type":"run.started",
                "sessionId":"session:migrate",
                "runId":"run:migrate",
                "payload":{
                    "inputMessageId":"message:migrate",
                    "workspaceBindings":[]
                }
            }))
            .expect("start migrated run");
        let todo = journal
            .append(&json!({
                "type":"todo.updated",
                "sessionId":"session:migrate",
                "runId":"run:migrate",
                "callId":"call:todo",
                "payload":{"items":[{"todoId":"todo:1","label":"检查","status":"pending"}]}
            }))
            .expect("append todo after migration");
        assert_eq!(todo["type"], "todo.updated");
        let connection = Connection::open(&path).expect("reopen migrated store");
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SESSION_STORE_VERSION);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn schema_three_run_snapshot_migrates_from_creation_bindings() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-v3-migrate-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let v3_schema = SESSION_STORE_SCHEMA
            .replace("PRAGMA user_version = 6;", "PRAGMA user_version = 3;")
            .replace("        'session.directory-index.attached',\n", "")
            .replace("        'session.directory-index.detached',\n", "")
            .replace("        'message.feedback.updated',\n", "")
            .replace("        'context.composed',\n", "")
            .replace("        'session.control.rejected',\n", "");
        {
            let connection = Connection::open(&path).expect("open schema-3 store");
            connection
                .execute_batch(&v3_schema)
                .expect("create schema-3 store");
            connection
                .execute(
                    "INSERT INTO sessions(session_id, display_title, created_at)
                     VALUES (?1, ?2, ?3)",
                    params!["session:migrate-v3", "迁移 v3", "2026-08-25T00:00:00Z"],
                )
                .expect("insert session");
            connection
                .execute(
                    "INSERT INTO session_workspace_bindings(
                         session_id, position, workspace_id, display_name
                     ) VALUES (?1, 0, ?2, ?3)",
                    params!["session:migrate-v3", "workspace:creation", "Creation"],
                )
                .expect("insert creation binding");
            connection
                .execute(
                    "INSERT INTO session_events(
                         session_id, sequence, event_id, event_type, payload_json, occurred_at
                     ) VALUES (?1, 1, ?2, 'session.created', ?3, ?4)",
                    params![
                        "session:migrate-v3",
                        "event:created-v3",
                        r#"{"displayTitle":"迁移 v3","workspaceBindings":[{"workspaceId":"workspace:creation","displayName":"Creation"}]}"#,
                        "2026-08-25T00:00:00Z",
                    ],
                )
                .expect("insert creation event");
            connection
                .execute(
                    "INSERT INTO session_events(
                         session_id, sequence, event_id, event_type, run_id,
                         payload_json, occurred_at
                     ) VALUES (?1, 2, ?2, 'run.started', ?3, ?4, ?5)",
                    params![
                        "session:migrate-v3",
                        "event:run-v3",
                        "run:migrate-v3",
                        r#"{"inputMessageId":"message:migrate-v3"}"#,
                        "2026-08-25T00:00:01Z",
                    ],
                )
                .expect("insert run event");
        }

        let journal = LocalAgentJournal::open(&path).expect("migrate schema-3 store");
        let events = journal
            .read_events("session:migrate-v3", 0)
            .expect("read migrated events");
        assert_eq!(
            events[1].pointer("/payload/workspaceBindings"),
            Some(&json!([{
                "workspaceId":"workspace:creation",
                "displayName":"Creation"
            }]))
        );
        assert_eq!(
            journal
                .run_workspace_binding_ids("session:migrate-v3", "run:migrate-v3")
                .expect("read frozen run roots"),
            vec!["workspace:creation".to_string()]
        );
        let connection = Connection::open(&path).expect("reopen migrated store");
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SESSION_STORE_VERSION);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn schema_four_store_migrates_to_feedback_and_request_receipt_vocabulary() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-v4-migrate-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let v4_schema = SESSION_STORE_SCHEMA
            .replace("PRAGMA user_version = 6;", "PRAGMA user_version = 4;")
            .replace("        'message.feedback.updated',\n", "")
            .replace("        'context.composed',\n", "")
            .replace("        'session.control.rejected',\n", "");
        {
            let connection = Connection::open(&path).expect("open schema-4 store");
            connection
                .execute_batch(&v4_schema)
                .expect("create schema-4 store");
            connection
                .execute(
                    "INSERT INTO sessions(session_id, display_title, created_at)
                     VALUES (?1, ?2, ?3)",
                    params!["session:migrate-v4", "迁移 v4", "2026-08-25T00:00:00Z"],
                )
                .expect("insert schema-4 session");
            connection
                .execute(
                    "INSERT INTO session_events(
                        session_id, sequence, event_id, event_type, run_id, payload_json, occurred_at
                     ) VALUES (?1, 1, ?2, 'context.updated', ?3, ?4, ?5)",
                    params![
                        "session:migrate-v4",
                        "event:legacy-context-v4",
                        "run:legacy-context-v4",
                        r#"{"inputTokens":100,"outputTokens":20,"contextWindowTokens":1000,"cacheReadInputTokens":70,"cacheMissInputTokens":30}"#,
                        "2026-08-25T00:00:01Z"
                    ],
                )
                .expect("insert schema-4 context usage without request receipt");
        }

        let journal = LocalAgentJournal::open(&path).expect("migrate schema-4 store");
        journal
            .append_batch(&[
                json!({
                    "type":"message.feedback.updated",
                    "sessionId":"session:migrate-v4",
                    "payload":{
                        "commandId":"command:feedback-v4",
                        "messageId":"message:answer-v4",
                        "feedback":"down"
                    }
                }),
                json!({
                    "type":"run.started",
                    "sessionId":"session:migrate-v4",
                    "runId":"run:receipt-v4",
                    "payload":{
                        "inputMessageId":"message:receipt-v4",
                        "workspaceBindings":[]
                    }
                }),
                json!({
                    "type":"context.composed",
                    "sessionId":"session:migrate-v4",
                    "runId":"run:receipt-v4",
                    "payload":{
                        "providerRequestId":"provider-request:v4",
                        "responseConstraint":"normal",
                        "messages":[],
                        "workspaceBindings":[],
                        "tools":[{"itemId":"fs.list","label":"fs.list"}]
                    }
                }),
            ])
            .expect("append current vocabulary after migration");
        let connection = Connection::open(&path).expect("reopen migrated store");
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SESSION_STORE_VERSION);
        let legacy_payload: Value = connection
            .query_row(
                "SELECT payload_json FROM session_events
                 WHERE event_id = 'event:legacy-context-v4'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|payload| serde_json::from_str(&payload).expect("decode legacy context payload"))
            .expect("read preserved schema-4 context usage");
        assert!(legacy_payload.get("providerRequestId").is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn schema_five_store_migrates_to_control_rejection_vocabulary() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-v5-migrate-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let v5_schema = SESSION_STORE_SCHEMA
            .replace("PRAGMA user_version = 6;", "PRAGMA user_version = 5;")
            .replace("        'session.control.rejected',\n", "");
        {
            let connection = Connection::open(&path).expect("open schema-5 store");
            connection
                .execute_batch(&v5_schema)
                .expect("create schema-5 store");
        }

        let journal = LocalAgentJournal::open(&path).expect("migrate schema-5 store");
        journal
            .create_session("session:migrate-v5", "迁移 v5", &json!([]), None)
            .expect("create migrated session");
        journal
            .append(&json!({
                "type":"run.started",
                "sessionId":"session:migrate-v5",
                "runId":"run:migrate-v5",
                "payload":{
                    "inputMessageId":"message:migrate-v5",
                    "workspaceBindings":[]
                }
            }))
            .expect("start migrated run");
        let rejection = journal
            .append(&json!({
                "type":"session.control.rejected",
                "sessionId":"session:migrate-v5",
                "runId":"run:migrate-v5",
                "callId":"plan:invalid",
                "payload":{
                    "toolName":"plan.intent",
                    "input":{
                        "prompt":"请选择。",
                        "options":[{"optionId":"write","label":"写入","operations":[]}]
                    },
                    "error":{
                        "code":"session_control_plan_operations_invalid",
                        "message":"每个 Plan option 必须包含至少一个闭合 operation。"
                    }
                }
            }))
            .expect("append schema-6 control rejection after migration");
        assert_eq!(rejection["type"], "session.control.rejected");
        let connection = Connection::open(&path).expect("reopen migrated store");
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SESSION_STORE_VERSION);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn schema_five_legacy_context_summary_is_read_only_history() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-session-v5-legacy-context-{}.sqlite3",
            random_id("test").unwrap().replace(':', "-")
        ));
        let journal = LocalAgentJournal::open(&path).expect("open current store");
        journal
            .create_session("session:legacy-context", "Legacy context", &json!([]), None)
            .expect("create legacy context session");
        journal
            .append(&json!({
                "type":"run.started",
                "sessionId":"session:legacy-context",
                "runId":"run:legacy-context",
                "payload":{
                    "inputMessageId":"message:legacy-context",
                    "workspaceBindings":[]
                }
            }))
            .expect("start legacy context run");
        let legacy_payload = json!({
            "providerRequestId":"provider-request:legacy-context",
            "responseConstraint":"normal",
            "categories":[{
                "kind":"journalMessages",
                "itemCount":1,
                "items":[{"itemId":"message:legacy-context","label":"用户消息"}]
            }]
        });
        Connection::open(&path)
            .expect("open legacy context store")
            .execute(
                "INSERT INTO session_events(
                     session_id, sequence, event_id, event_type, run_id,
                     payload_json, occurred_at
                 ) VALUES (?1, 3, ?2, 'context.composed', ?3, ?4, ?5)",
                params![
                    "session:legacy-context",
                    "event:legacy-context",
                    "run:legacy-context",
                    serde_json::to_string(&legacy_payload).expect("encode legacy context"),
                    "2026-08-25T00:00:02Z",
                ],
            )
            .expect("insert immutable legacy context receipt");

        let events = journal
            .read_events("session:legacy-context", 0)
            .expect("read legacy context history");
        assert_eq!(events[2]["payload"], legacy_payload);
        assert!(events[2]["payload"].get("messages").is_none());
        assert!(journal
            .append(&json!({
                "type":"context.composed",
                "sessionId":"session:legacy-context",
                "runId":"run:legacy-context",
                "payload":legacy_payload
            }))
            .is_err());
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
                "type":"todo.updated",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:todo-before-run",
                "payload":{"items":[{
                    "todoId":"todo:one",
                    "label":"Inspect",
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
                "type":"todo.updated",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:todo",
                "payload":{"items":[{
                    "todoId":"todo:one",
                    "label":"Inspect",
                    "status":"inProgress"
                }]}
            }))
            .expect("record active-run todo");
        let duplicate_todo = journal
            .append(&json!({
                "type":"todo.updated",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:todo",
                "payload":{"items":[]}
            }))
            .expect_err("todo call identity is immutable");
        assert_eq!(duplicate_todo.code, "todo_call_duplicate");

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
                    "responseConstraint":"normal",
                    "messages":[],
                    "workspaceBindings":[],
                    "tools":[]
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
                "type":"todo.updated",
                "sessionId":"session:facts",
                "runId":"run:facts",
                "callId":"call:todo-after-settlement",
                "payload":{"items":[]}
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
                    "../../../contracts/agent-runtime-v2/tool-record.sql"
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
                    "../../../contracts/agent-runtime-v2/tool-record.sql"
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
    fn provider_request_receipt_and_usage_share_closed_identity_shapes() {
        validate_new_event(
            &json!({
                "type": "context.composed",
                "sessionId": "session:receipt",
                "runId": "run:receipt",
                "payload": {
                    "providerRequestId": "provider-request:one",
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
                    "providerRequestId": "provider-request:legacy-summary",
                    "responseConstraint": "normal",
                    "categories": []
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
