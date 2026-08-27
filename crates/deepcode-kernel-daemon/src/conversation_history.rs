use crate::prelude::*;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::HashMap;

const LEGACY_SESSION_STORE_VERSION: u32 = 2;
const LEGACY_EVENT_VERSION: &str = "deepcode.session-event.v1";
const SESSION_PROJECTION_VERSION: &str = "deepcode.session-projection.v2";
const JS_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone)]
pub(crate) struct ConversationHistoryReader {
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct ConversationHistoryError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ConversationHistoryError {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: "conversation_history_unavailable",
            message: message.into(),
        }
    }

    fn not_found(session_id: &str) -> Self {
        Self {
            code: "conversation_history_not_found",
            message: format!("旧版只读历史中不存在 Session {session_id}。"),
        }
    }
}

#[derive(Debug, Clone)]
struct LegacyEvent {
    sequence: u64,
    event_type: String,
    occurred_at: String,
    run_id: Option<String>,
    call_id: Option<String>,
    payload: Value,
}

#[derive(Debug, Clone)]
struct LegacyRun {
    run_id: String,
    input_message_id: String,
    profile_id: Option<String>,
    sequence: u64,
    started_at: String,
    completed_at: Option<String>,
    outcome: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    provider_call_count: u64,
    error: Option<Value>,
}

impl ConversationHistoryReader {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(crate) fn catalog_value(&self) -> Result<Value, ConversationHistoryError> {
        let Some(connection) = self.open()? else {
            return Ok(json!({ "projects": [], "sessions": [] }));
        };
        let mut statement = connection
            .prepare("SELECT session_id FROM sessions ORDER BY session_id ASC")
            .map_err(sql_error("准备读取旧版 Session catalog 失败"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sql_error("读取旧版 Session catalog 失败"))?;
        let mut sessions = Vec::new();
        for row in rows {
            let session_id = row.map_err(sql_error("读取旧版 Session catalog 失败"))?;
            let events = read_events(&connection, &session_id)?;
            sessions.push(history_summary(&session_id, &events)?);
        }
        sessions.sort_by(|left, right| {
            timestamp_sort_key(&right["updatedAt"])
                .cmp(&timestamp_sort_key(&left["updatedAt"]))
                .then_with(|| right["id"].as_str().cmp(&left["id"].as_str()))
        });
        Ok(json!({ "projects": [], "sessions": sessions }))
    }

    pub(crate) fn projection_value(
        &self,
        session_id: &str,
    ) -> Result<Value, ConversationHistoryError> {
        let Some(connection) = self.open()? else {
            return Err(ConversationHistoryError::not_found(session_id));
        };
        let exists = connection
            .query_row(
                "SELECT 1 FROM sessions WHERE session_id=?1",
                params![session_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(sql_error("读取旧版 Session 身份失败"))?
            .is_some();
        if !exists {
            return Err(ConversationHistoryError::not_found(session_id));
        }
        let events = read_events(&connection, session_id)?;
        history_projection(session_id, &events)
    }

    fn open(&self) -> Result<Option<Connection>, ConversationHistoryError> {
        if !self.path.exists() {
            return Ok(None);
        }
        if !self.path.is_file() {
            return Err(ConversationHistoryError::unavailable(format!(
                "旧版 Session 历史路径不是文件：{}",
                self.path.display()
            )));
        }
        let connection = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(sql_error("只读打开旧版 Session 历史失败"))?;
        verify_legacy_store(&connection)?;
        Ok(Some(connection))
    }
}

fn verify_legacy_store(connection: &Connection) -> Result<(), ConversationHistoryError> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error("读取旧版 Session Store 版本失败"))?;
    if version != LEGACY_SESSION_STORE_VERSION {
        return Err(ConversationHistoryError::unavailable(format!(
            "旧版 Session Store 版本应为 {LEGACY_SESSION_STORE_VERSION}，实际为 {version}。"
        )));
    }
    for table in ["sessions", "session_events", "session_commands"] {
        let present: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                params![table],
                |row| row.get(0),
            )
            .map_err(sql_error("验证旧版 Session Store 失败"))?;
        if !present {
            return Err(ConversationHistoryError::unavailable(format!(
                "旧版 Session Store 缺少 {table} 表。"
            )));
        }
    }
    Ok(())
}

fn read_events(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<LegacyEvent>, ConversationHistoryError> {
    let mut statement = connection
        .prepare(
            "SELECT sequence, event_type, occurred_at, run_id, call_id, event_json
             FROM session_events WHERE session_id=?1 ORDER BY sequence ASC",
        )
        .map_err(sql_error("准备读取旧版 Session 事件失败"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(sql_error("读取旧版 Session 事件失败"))?;
    let mut events = Vec::new();
    for row in rows {
        let (sequence, event_type, occurred_at, run_id, call_id, event_json) =
            row.map_err(sql_error("读取旧版 Session 事件失败"))?;
        let sequence = safe_u64(sequence, "旧版 Session event sequence")?;
        let event: Value = serde_json::from_str(&event_json).map_err(|error| {
            ConversationHistoryError::unavailable(format!("旧版 Session 事件 JSON 已损坏：{error}"))
        })?;
        if event.get("schemaVersion").and_then(Value::as_str) != Some(LEGACY_EVENT_VERSION)
            || event.get("sessionId").and_then(Value::as_str) != Some(session_id)
            || event.get("type").and_then(Value::as_str) != Some(event_type.as_str())
            || event.get("sequence").and_then(Value::as_u64) != Some(sequence)
            || event.get("occurredAt").and_then(Value::as_str) != Some(occurred_at.as_str())
            || event.get("runId").and_then(Value::as_str) != run_id.as_deref()
            || event.get("callId").and_then(Value::as_str) != call_id.as_deref()
        {
            return Err(ConversationHistoryError::unavailable(format!(
                "旧版 Session {session_id} 的第 {sequence} 条事件与索引列不一致。"
            )));
        }
        if occurred_at.is_empty() || sequence > JS_SAFE_INTEGER_MAX {
            return Err(ConversationHistoryError::unavailable(format!(
                "旧版 Session {session_id} 的第 {sequence} 条事件超出共享投影范围。"
            )));
        }
        let payload = event
            .get("payload")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| {
                ConversationHistoryError::unavailable(format!(
                    "旧版 Session {session_id} 的第 {sequence} 条事件缺少对象 payload。"
                ))
            })?;
        events.push(LegacyEvent {
            sequence,
            event_type,
            occurred_at,
            run_id,
            call_id,
            payload,
        });
    }
    if events
        .iter()
        .enumerate()
        .any(|(index, event)| event.sequence != index as u64 + 1)
        || events.first().map(|event| event.event_type.as_str()) != Some("session.created")
    {
        return Err(ConversationHistoryError::unavailable(format!(
            "旧版 Session {session_id} 的事件序列不连续或缺少 session.created。"
        )));
    }
    Ok(events)
}

fn history_summary(
    session_id: &str,
    events: &[LegacyEvent],
) -> Result<Value, ConversationHistoryError> {
    let first = events.first().ok_or_else(|| {
        ConversationHistoryError::unavailable(format!(
            "旧版 Session {session_id} 没有 creation event。"
        ))
    })?;
    let title = history_title(events);
    let mut summary = json!({
        "id": session_id,
        "title": title,
        "entryKind": "historyOnly",
        "workspaceBindings": [],
        "createdAt": first.occurred_at,
        "updatedAt": events.last().map(|event| event.occurred_at.as_str()).unwrap_or(&first.occurred_at),
    });
    if let Some(profile_id) = first.payload.get("profileId").and_then(Value::as_str) {
        summary["profileId"] = json!(profile_id);
    }
    Ok(summary)
}

fn history_title(events: &[LegacyEvent]) -> String {
    let content = events.iter().find_map(|event| {
        if event.event_type == "message.committed"
            && event.payload.get("role").and_then(Value::as_str) == Some("user")
        {
            event.payload.get("content").and_then(Value::as_str)
        } else if event.event_type == "input.accepted" {
            event.payload.get("text").and_then(Value::as_str)
        } else {
            None
        }
    });
    content
        .map(crate::conversation_catalog::automatic_conversation_title)
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "只读历史".to_string())
}

fn history_projection(
    session_id: &str,
    events: &[LegacyEvent],
) -> Result<Value, ConversationHistoryError> {
    let mut messages = Vec::new();
    let mut message_titles = HashMap::<String, String>::new();
    let mut narratives = Vec::new();
    let mut activities = Vec::<Value>::new();
    let mut activity_by_run = HashMap::<String, usize>::new();
    let mut activity_by_call = HashMap::<String, usize>::new();
    let mut activity_by_approval = HashMap::<String, usize>::new();
    let mut activity_by_interaction = HashMap::<String, usize>::new();
    let mut runs = Vec::<LegacyRun>::new();
    let mut run_by_id = HashMap::<String, usize>::new();

    for event in events {
        match event.event_type.as_str() {
            "session.created" | "input.accepted" => {}
            "message.committed" => {
                let message_id = required_text(&event.payload, "messageId", event)?;
                let role = required_text(&event.payload, "role", event)?;
                if !matches!(role, "user" | "assistant" | "tool" | "system") {
                    return Err(event_error(event, "message role 无效"));
                }
                let content = required_string(&event.payload, "content", event)?;
                if role == "user" {
                    message_titles.insert(
                        message_id.to_string(),
                        crate::conversation_catalog::automatic_conversation_title(content),
                    );
                }
                messages.push(json!({
                    "messageId": message_id,
                    "role": role,
                    "content": content,
                    "attachments": [],
                    "feedback": null,
                    "sequence": event.sequence,
                    "createdAt": event.occurred_at,
                }));
            }
            "run.started" => {
                let run_id = required_event_run(event)?;
                if run_by_id.contains_key(run_id) {
                    return Err(event_error(event, "run.started 重复"));
                }
                let input_message_id = required_text(&event.payload, "inputMessageId", event)?;
                let profile_id = event
                    .payload
                    .get("profileId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let run_index = runs.len();
                runs.push(LegacyRun {
                    run_id: run_id.to_string(),
                    input_message_id: input_message_id.to_string(),
                    profile_id,
                    sequence: event.sequence,
                    started_at: event.occurred_at.clone(),
                    completed_at: None,
                    outcome: None,
                    input_tokens: 0,
                    output_tokens: 0,
                    provider_call_count: 0,
                    error: None,
                });
                run_by_id.insert(run_id.to_string(), run_index);
                activity_by_run.insert(run_id.to_string(), activities.len());
                activities.push(json!({
                    "activityId": format!("history:run:{}", event.sequence),
                    "kind": "run",
                    "status": "indeterminate",
                    "label": "Agent run",
                    "runId": run_id,
                    "sequence": event.sequence,
                }));
            }
            "run.profile.selected" => {
                let run = required_run_mut(event, &run_by_id, &mut runs)?;
                run.profile_id =
                    Some(required_text(&event.payload, "profileId", event)?.to_string());
            }
            "context.updated" => {
                let run = required_run_mut(event, &run_by_id, &mut runs)?;
                run.input_tokens = checked_token_add(
                    run.input_tokens,
                    required_u64(&event.payload, "inputTokens", event)?,
                    event,
                )?;
                run.output_tokens = checked_token_add(
                    run.output_tokens,
                    required_u64(&event.payload, "outputTokens", event)?,
                    event,
                )?;
                run.provider_call_count = checked_token_add(run.provider_call_count, 1, event)?;
            }
            "narrative.committed" => {
                let run_id = required_event_run(event)?;
                required_run_index(event, &run_by_id)?;
                let content = required_text(&event.payload, "content", event)?;
                let narrative_id = event
                    .payload
                    .get("narrativeId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("history:narrative:{}", event.sequence));
                narratives.push(json!({
                    "narrativeId": narrative_id,
                    "runId": run_id,
                    "content": content,
                    "sequence": event.sequence,
                    "createdAt": event.occurred_at,
                }));
            }
            "tool.requested" => {
                let run_id = required_event_run(event)?;
                required_run_index(event, &run_by_id)?;
                let call_id = required_event_call(event)?;
                if activity_by_call.contains_key(call_id) {
                    return Err(event_error(event, "tool call 重复"));
                }
                let tool_name = required_text(&event.payload, "toolName", event)?;
                let input = event
                    .payload
                    .get("input")
                    .filter(|value| value.is_object())
                    .ok_or_else(|| event_error(event, "tool.requested 缺少对象 input"))?;
                activity_by_call.insert(call_id.to_string(), activities.len());
                activities.push(json!({
                    "activityId": format!("history:tool:{}", event.sequence),
                    "kind": "tool",
                    "status": "requested",
                    "label": format!("使用工具 {tool_name}"),
                    "runId": run_id,
                    "callId": call_id,
                    "sequence": event.sequence,
                    "tool": {
                        "operation": tool_name,
                        "resources": logical_resources(input),
                    },
                }));
            }
            "tool.completed" => {
                required_run_index(event, &run_by_id)?;
                let call_id = required_event_call(event)?;
                let activity_index = *activity_by_call
                    .get(call_id)
                    .ok_or_else(|| event_error(event, "tool.completed 缺少对应 tool.requested"))?;
                let outcome = event
                    .payload
                    .pointer("/record/outcome")
                    .and_then(Value::as_str)
                    .ok_or_else(|| event_error(event, "tool.completed 缺少 record.outcome"))?;
                activities[activity_index]["status"] = json!(activity_status(outcome, event)?);
            }
            "approval.requested" => {
                let run_id = required_event_run(event)?;
                required_run_index(event, &run_by_id)?;
                let call_id = required_event_call(event)?;
                let approval_id = required_text(&event.payload, "approvalId", event)?;
                activity_by_approval.insert(approval_id.to_string(), activities.len());
                activities.push(json!({
                    "activityId": format!("history:approval:{}", event.sequence),
                    "kind": "approval",
                    "status": "waiting",
                    "label": "授权请求",
                    "runId": run_id,
                    "callId": call_id,
                    "sequence": event.sequence,
                }));
            }
            "approval.resolved" => {
                let approval_id = required_text(&event.payload, "approvalId", event)?;
                let activity_index = *activity_by_approval.get(approval_id).ok_or_else(|| {
                    event_error(event, "approval.resolved 缺少对应 approval.requested")
                })?;
                let decision = required_text(&event.payload, "decision", event)?;
                activities[activity_index]["status"] = json!(match decision {
                    "allow" => "completed",
                    "deny" => "denied",
                    _ => return Err(event_error(event, "approval decision 无效")),
                });
            }
            "interaction.requested" => {
                let run_id = required_event_run(event)?;
                required_run_index(event, &run_by_id)?;
                let interaction_id = required_text(&event.payload, "interactionId", event)?;
                activity_by_interaction.insert(interaction_id.to_string(), activities.len());
                activities.push(json!({
                    "activityId": format!("history:interaction:{}", event.sequence),
                    "kind": "interaction",
                    "status": "waiting",
                    "label": "等待用户输入",
                    "runId": run_id,
                    "sequence": event.sequence,
                }));
            }
            "interaction.resolved" => {
                let interaction_id = required_text(&event.payload, "interactionId", event)?;
                let activity_index =
                    *activity_by_interaction.get(interaction_id).ok_or_else(|| {
                        event_error(event, "interaction.resolved 缺少对应 interaction.requested")
                    })?;
                activities[activity_index]["status"] = json!("completed");
            }
            "run.waiting" => {
                required_run_index(event, &run_by_id)?;
            }
            "run.settled" => {
                let run_index = required_run_index(event, &run_by_id)?;
                let outcome = required_text(&event.payload, "outcome", event)?;
                let status = run_status(outcome, event)?;
                let run = &mut runs[run_index];
                if run.outcome.is_some() {
                    return Err(event_error(event, "run.settled 重复"));
                }
                run.outcome = Some(outcome.to_string());
                run.completed_at = Some(event.occurred_at.clone());
                run.error = event.payload.get("error").cloned();
                let activity_index = *activity_by_run
                    .get(&run.run_id)
                    .ok_or_else(|| event_error(event, "run activity 缺失"))?;
                activities[activity_index]["status"] = json!(status);
            }
            unsupported => {
                return Err(event_error(
                    event,
                    &format!("不支持的旧版事件类型 {unsupported}"),
                ));
            }
        }
    }

    let mut total = json!({
        "providerCallCount": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadInputTokens": 0,
        "cacheMissInputTokens": 0,
        "cacheReportedCallCount": 0,
    });
    for run in &runs {
        total["providerCallCount"] = json!(checked_projection_add(
            total["providerCallCount"].as_u64().unwrap_or_default(),
            run.provider_call_count,
        )?);
        total["inputTokens"] = json!(checked_projection_add(
            total["inputTokens"].as_u64().unwrap_or_default(),
            run.input_tokens,
        )?);
        total["outputTokens"] = json!(checked_projection_add(
            total["outputTokens"].as_u64().unwrap_or_default(),
            run.output_tokens,
        )?);
    }
    let mut token_usage_history = runs
        .iter()
        .map(|run| {
            let mut value = json!({
                "runId": run.run_id,
                "inputMessageId": run.input_message_id,
                "title": message_titles.get(&run.input_message_id).filter(|value| !value.is_empty()).cloned().unwrap_or_else(|| "历史运行".to_string()),
                "sequence": run.sequence,
                "startedAt": run.started_at,
                "providerCallCount": run.provider_call_count,
                "inputTokens": run.input_tokens,
                "outputTokens": run.output_tokens,
                "cacheReadInputTokens": 0,
                "cacheMissInputTokens": 0,
                "cacheReportedCallCount": 0,
            });
            if let Some(completed_at) = &run.completed_at {
                value["completedAt"] = json!(completed_at);
                value["outcome"] = json!(run.outcome.as_deref().unwrap_or("indeterminate"));
            }
            value
        })
        .collect::<Vec<_>>();
    token_usage_history
        .sort_by(|left, right| right["sequence"].as_u64().cmp(&left["sequence"].as_u64()));

    let latest_run = runs.iter().max_by_key(|run| run.sequence);
    let run_projection = latest_run.map(|run| {
        let mut value = json!({
            "runId": run.run_id,
            "workspaceBindings": [],
            "status": run.outcome.as_deref().unwrap_or("indeterminate"),
        });
        if let Some(profile_id) = &run.profile_id {
            value["profileId"] = json!(profile_id);
        }
        value
    });
    let terminal_error = latest_run
        .and_then(|run| run.error.clone())
        .and_then(|error| {
            let code = error.get("code")?.as_str()?;
            let message = error.get("message")?.as_str()?;
            Some(json!({ "code": code, "message": message }))
        });
    let revision = events
        .last()
        .map(|event| event.sequence)
        .unwrap_or_default();
    Ok(json!({
        "schemaVersion": SESSION_PROJECTION_VERSION,
        "sessionId": session_id,
        "revision": revision,
        "display": {
            "title": history_title(events),
            "entryKind": "historyOnly",
        },
        "workspaceBindings": [],
        "sessionDirectoryIndexes": [],
        "messages": messages,
        "narratives": narratives,
        "assistantDraft": null,
        "pendingInteraction": null,
        "pendingApproval": null,
        "pendingPlan": null,
        "todoList": null,
        "contextUsage": null,
        "contextCompositions": [],
        "tokenUsage": total,
        "tokenUsageHistory": token_usage_history,
        "run": run_projection,
        "activities": activities,
        "artifacts": [],
        "terminalError": terminal_error,
    }))
}

fn logical_resources(input: &Value) -> Vec<Value> {
    let mut candidates = Vec::new();
    for field in ["path", "target"] {
        if let Some(value) = input.get(field).and_then(Value::as_str) {
            candidates.push(value);
        }
    }
    if let Some(values) = input.get("paths").and_then(Value::as_array) {
        candidates.extend(values.iter().filter_map(Value::as_str));
    }
    candidates
        .into_iter()
        .filter(|value| is_normalized_logical_path(value))
        .map(|value| json!({ "kind": "logicalTarget", "label": value }))
        .collect()
}

fn is_normalized_logical_path(value: &str) -> bool {
    value == "."
        || (!value.is_empty()
            && !value.starts_with('/')
            && !value.starts_with('\\')
            && !value.ends_with('/')
            && !value.contains(':')
            && value
                .split('/')
                .all(|segment| !segment.is_empty() && segment != "." && segment != ".."))
}

fn required_run_mut<'a>(
    event: &LegacyEvent,
    run_by_id: &HashMap<String, usize>,
    runs: &'a mut [LegacyRun],
) -> Result<&'a mut LegacyRun, ConversationHistoryError> {
    let index = required_run_index(event, run_by_id)?;
    Ok(&mut runs[index])
}

fn required_run_index(
    event: &LegacyEvent,
    run_by_id: &HashMap<String, usize>,
) -> Result<usize, ConversationHistoryError> {
    let run_id = required_event_run(event)?;
    run_by_id
        .get(run_id)
        .copied()
        .ok_or_else(|| event_error(event, "事件引用了尚未开始的 run"))
}

fn required_event_run(event: &LegacyEvent) -> Result<&str, ConversationHistoryError> {
    event
        .run_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| event_error(event, "缺少 runId"))
}

fn required_event_call(event: &LegacyEvent) -> Result<&str, ConversationHistoryError> {
    event
        .call_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| event_error(event, "缺少 callId"))
}

fn required_text<'a>(
    value: &'a Value,
    field: &str,
    event: &LegacyEvent,
) -> Result<&'a str, ConversationHistoryError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|candidate| !candidate.is_empty())
        .ok_or_else(|| event_error(event, &format!("缺少 {field}")))
}

fn required_string<'a>(
    value: &'a Value,
    field: &str,
    event: &LegacyEvent,
) -> Result<&'a str, ConversationHistoryError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| event_error(event, &format!("缺少 {field}")))
}

fn required_u64(
    value: &Value,
    field: &str,
    event: &LegacyEvent,
) -> Result<u64, ConversationHistoryError> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .filter(|number| *number <= JS_SAFE_INTEGER_MAX)
        .ok_or_else(|| event_error(event, &format!("{field} 不是安全自然数")))
}

fn checked_token_add(
    left: u64,
    right: u64,
    event: &LegacyEvent,
) -> Result<u64, ConversationHistoryError> {
    left.checked_add(right)
        .filter(|sum| *sum <= JS_SAFE_INTEGER_MAX)
        .ok_or_else(|| event_error(event, "token 计数溢出共享投影范围"))
}

fn checked_projection_add(left: u64, right: u64) -> Result<u64, ConversationHistoryError> {
    left.checked_add(right)
        .filter(|sum| *sum <= JS_SAFE_INTEGER_MAX)
        .ok_or_else(|| ConversationHistoryError::unavailable("旧版 token 总量超出共享投影范围。"))
}

fn safe_u64(value: i64, label: &str) -> Result<u64, ConversationHistoryError> {
    u64::try_from(value)
        .map_err(|_| ConversationHistoryError::unavailable(format!("{label} 不能是负数。")))
}

fn run_status<'a>(
    outcome: &'a str,
    event: &LegacyEvent,
) -> Result<&'a str, ConversationHistoryError> {
    match outcome {
        "completed" | "failed" | "cancelled" | "indeterminate" => Ok(outcome),
        _ => Err(event_error(event, "run outcome 无效")),
    }
}

fn activity_status<'a>(
    outcome: &'a str,
    event: &LegacyEvent,
) -> Result<&'a str, ConversationHistoryError> {
    match outcome {
        "completed" | "denied" | "failed" | "cancelled" | "indeterminate" => Ok(outcome),
        _ => Err(event_error(event, "tool outcome 无效")),
    }
}

fn event_error(event: &LegacyEvent, detail: &str) -> ConversationHistoryError {
    ConversationHistoryError::unavailable(format!(
        "旧版 Session 第 {} 条 {} 事件无效：{detail}",
        event.sequence, event.event_type
    ))
}

fn timestamp_sort_key(value: &Value) -> u128 {
    value
        .as_str()
        .and_then(|text| text.parse::<u128>().ok())
        .unwrap_or_default()
}

fn sql_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> ConversationHistoryError {
    move |error| ConversationHistoryError::unavailable(format!("{context}：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_history_is_read_only_and_omits_workspace_authority() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-history-{}-{}.sqlite3",
            std::process::id(),
            crate::now_millis()
        ));
        let connection = Connection::open(&path).expect("create legacy fixture");
        connection
            .execute_batch(
                "PRAGMA user_version = 2;
                 CREATE TABLE sessions(session_id TEXT PRIMARY KEY) STRICT;
                 CREATE TABLE session_events(
                   session_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
                   event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, run_id TEXT, call_id TEXT,
                   command_id TEXT, event_json TEXT NOT NULL,
                   PRIMARY KEY(session_id, sequence)
                 ) STRICT;
                 CREATE TABLE session_commands(
                   session_id TEXT NOT NULL, command_id TEXT NOT NULL, admitted_sequence INTEGER NOT NULL,
                   command_json TEXT NOT NULL, reply_json TEXT NOT NULL,
                   PRIMARY KEY(session_id, command_id)
                 ) STRICT;",
            )
            .expect("legacy schema");
        connection
            .execute(
                "INSERT INTO sessions(session_id) VALUES ('session:old')",
                [],
            )
            .expect("legacy session");
        let events = [
            json!({
                "schemaVersion": LEGACY_EVENT_VERSION,
                "eventId": "event:1", "sessionId": "session:old", "sequence": 1,
                "occurredAt": "1000", "type": "session.created",
                "payload": { "workspaceRoot": "/secret/root", "profileId": "profile:old" }
            }),
            json!({
                "schemaVersion": LEGACY_EVENT_VERSION,
                "eventId": "event:2", "sessionId": "session:old", "sequence": 2,
                "occurredAt": "1001", "type": "message.committed", "runId": "run:old",
                "payload": { "messageId": "message:one", "role": "user", "content": "分析旧项目" }
            }),
            json!({
                "schemaVersion": LEGACY_EVENT_VERSION,
                "eventId": "event:3", "sessionId": "session:old", "sequence": 3,
                "occurredAt": "1002", "type": "run.started", "runId": "run:old",
                "payload": { "inputMessageId": "message:one", "profileId": "profile:old" }
            }),
            json!({
                "schemaVersion": LEGACY_EVENT_VERSION,
                "eventId": "event:4", "sessionId": "session:old", "sequence": 4,
                "occurredAt": "1003", "type": "context.updated", "runId": "run:old",
                "payload": { "inputTokens": 10, "outputTokens": 2, "contextWindowTokens": 100 }
            }),
            json!({
                "schemaVersion": LEGACY_EVENT_VERSION,
                "eventId": "event:5", "sessionId": "session:old", "sequence": 5,
                "occurredAt": "1004", "type": "run.settled", "runId": "run:old",
                "payload": { "outcome": "completed", "finalMessageId": "message:answer" }
            }),
            json!({
                "schemaVersion": LEGACY_EVENT_VERSION,
                "eventId": "event:6", "sessionId": "session:old", "sequence": 6,
                "occurredAt": "1005", "type": "message.committed", "runId": "run:unsettled",
                "payload": { "messageId": "message:two", "role": "user", "content": "未结算历史运行" }
            }),
            json!({
                "schemaVersion": LEGACY_EVENT_VERSION,
                "eventId": "event:7", "sessionId": "session:old", "sequence": 7,
                "occurredAt": "1006", "type": "run.started", "runId": "run:unsettled",
                "payload": { "inputMessageId": "message:two", "profileId": "profile:old" }
            }),
        ];
        for event in events {
            connection
                .execute(
                    "INSERT INTO session_events(
                       session_id, sequence, event_id, event_type, occurred_at, run_id, call_id,
                       command_id, event_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7)",
                    params![
                        "session:old",
                        i64::try_from(event["sequence"].as_u64().unwrap()).unwrap(),
                        event["eventId"].as_str().unwrap(),
                        event["type"].as_str().unwrap(),
                        event["occurredAt"].as_str().unwrap(),
                        event.get("runId").and_then(Value::as_str),
                        serde_json::to_string(&event).unwrap(),
                    ],
                )
                .expect("legacy event");
        }
        drop(connection);

        let reader = ConversationHistoryReader::new(path.clone());
        let catalog = reader.catalog_value().expect("history catalog");
        assert_eq!(catalog["sessions"][0]["entryKind"], "historyOnly");
        assert_eq!(catalog["sessions"][0]["title"], "分析旧项目");
        let projection = reader
            .projection_value("session:old")
            .expect("history projection");
        assert_eq!(projection["workspaceBindings"], json!([]));
        assert_eq!(projection["display"]["entryKind"], "historyOnly");
        assert_eq!(projection["tokenUsage"]["inputTokens"], 10);
        assert_eq!(projection["tokenUsage"]["cacheReportedCallCount"], 0);
        assert_eq!(projection["tokenUsageHistory"][0]["runId"], "run:unsettled");
        assert!(projection["tokenUsageHistory"][0]
            .get("completedAt")
            .is_none());
        assert!(projection["tokenUsageHistory"][0].get("outcome").is_none());
        assert_eq!(projection["tokenUsageHistory"][1]["outcome"], "completed");
        assert!(!projection.to_string().contains("/secret/root"));
        assert!(Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).is_ok());
        std::fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn missing_legacy_store_is_an_empty_history_catalog() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-history-missing-{}-{}.sqlite3",
            std::process::id(),
            crate::now_millis()
        ));
        let reader = ConversationHistoryReader::new(path);
        assert_eq!(
            reader.catalog_value().expect("empty history"),
            json!({ "projects": [], "sessions": [] })
        );
    }
}
