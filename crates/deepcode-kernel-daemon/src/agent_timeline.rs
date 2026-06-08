#![allow(dead_code)]

use crate::prelude::*;
use crate::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTimelineBlock {
    id: String,
    kind: String,
    title: String,
    summary: String,
    status: String,
    default_collapsed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_markdown: Option<String>,
    events: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTimelineTurn {
    id: String,
    session_id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    blocks: Vec<AgentTimelineBlock>,
}

pub(crate) async fn agent_session_timeline(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let events = session_projection(&state, &session_id);
    let timeline = build_agent_timeline(&session_id, events);
    ApiResponse::ok(serde_json::to_value(timeline).unwrap_or_else(|_| json!({})))
}

fn build_agent_timeline(session_id: &str, events: Vec<Value>) -> Value {
    let event_count = events.len();
    let mut turns: Vec<AgentTimelineTurn> = Vec::new();
    let mut current: Option<AgentTimelineTurn> = None;
    let mut synthetic_index = 0usize;

    for (index, event) in events.into_iter().enumerate() {
        if event_kind(&event) == "user_msg" {
            if let Some(turn) = current.take() {
                turns.push(finalize_turn(turn));
            }
            let turn_id = format!(
                "turn-{}",
                event_id(&event).unwrap_or_else(|| index.to_string())
            );
            let mut turn = AgentTimelineTurn {
                id: turn_id,
                session_id: session_id.to_string(),
                status: "running".to_string(),
                started_at: event_ts(&event),
                completed_at: None,
                blocks: Vec::new(),
            };
            turn.blocks.push(block_from_event(&event, "user", index));
            current = Some(turn);
            continue;
        }

        if current.is_none() {
            synthetic_index += 1;
            current = Some(AgentTimelineTurn {
                id: format!("turn-orphan-{synthetic_index}"),
                session_id: session_id.to_string(),
                status: "running".to_string(),
                started_at: event_ts(&event),
                completed_at: None,
                blocks: Vec::new(),
            });
        }

        if let Some(turn) = current.as_mut() {
            append_event_block(turn, event, index);
        }
    }

    if let Some(turn) = current.take() {
        turns.push(finalize_turn(turn));
    }

    json!({
        "sessionId": session_id,
        "generatedAt": now_text(),
        "turns": turns,
        "eventCount": event_count
    })
}

fn finalize_turn(mut turn: AgentTimelineTurn) -> AgentTimelineTurn {
    let has_failure = turn.blocks.iter().any(|block| block.status == "failed");
    let has_waiting = turn
        .blocks
        .iter()
        .any(|block| block.status == "waiting" || block.status == "blocked");
    let has_running = turn.blocks.iter().any(|block| block.status == "running");
    let has_final = turn.blocks.iter().any(|block| block.kind == "assistant");

    turn.status = if has_failure {
        "failed".to_string()
    } else if has_waiting {
        "blocked".to_string()
    } else if has_running && !has_final {
        "running".to_string()
    } else {
        "completed".to_string()
    };

    if turn.status == "completed" || turn.status == "failed" {
        turn.completed_at = turn
            .blocks
            .iter()
            .rev()
            .flat_map(|block| block.events.iter().rev())
            .find_map(event_ts);
    }
    turn
}

fn append_event_block(turn: &mut AgentTimelineTurn, event: Value, index: usize) {
    let kind = timeline_kind(&event);
    if kind == "toolBatch" || kind == "thinking" || kind == "stage" {
        if let Some(last) = turn.blocks.last_mut() {
            if last.kind == kind && last.status != "failed" {
                last.events.push(event);
                refresh_group_block(last);
                return;
            }
        }
    }
    turn.blocks.push(block_from_event(&event, &kind, index));
}

fn refresh_group_block(block: &mut AgentTimelineBlock) {
    block.summary = summarize_events(&block.events);
    block.status = group_status(&block.events);
    block.default_collapsed = should_collapse(&block.kind, &block.status);
}

fn block_from_event(event: &Value, kind: &str, index: usize) -> AgentTimelineBlock {
    let events = vec![event.clone()];
    let status = group_status(&events);
    AgentTimelineBlock {
        id: format!(
            "{}-{}",
            kind,
            event_id(event).unwrap_or_else(|| index.to_string())
        ),
        kind: kind.to_string(),
        title: block_title(event, kind),
        summary: summarize_events(&events),
        status: status.clone(),
        default_collapsed: should_collapse(kind, &status),
        body_markdown: block_body(event, kind),
        events,
    }
}

fn timeline_kind(event: &Value) -> String {
    let kind = event_kind(event);
    match kind.as_str() {
        "user_msg" => "user",
        "plan_card" => "plan",
        "plan_review" => "plan",
        "review_summary" => "review",
        "tool_call" | "tool_result" => "toolBatch",
        "permission_request" | "permission_result" => "permission",
        "workflow_stage" | "workflow_decision" => "stage",
        "error" => "error",
        "assistant_msg" => match event_channel(event).as_deref() {
            Some("reasoning") => "thinking",
            Some("final") => "assistant",
            Some("tool") | Some("action") | Some("progress") | Some("task") => "stage",
            _ => "assistant",
        },
        _ => "stage",
    }
    .to_string()
}

fn block_title(event: &Value, kind: &str) -> String {
    match kind {
        "user" => "User".to_string(),
        "assistant" => "Agent".to_string(),
        "thinking" => "Thinking".to_string(),
        "stage" => string_field(payload(event), "summary")
            .or_else(|| string_field(payload(event), "stage"))
            .unwrap_or_else(|| "Workflow".to_string()),
        "toolBatch" => string_field(payload(event), "batchLabel")
            .or_else(|| string_field(payload(event), "toolName"))
            .or_else(|| string_field(payload(event), "name"))
            .unwrap_or_else(|| "Tool work".to_string()),
        "permission" => {
            string_field(payload(event), "summary").unwrap_or_else(|| "Permission".to_string())
        }
        "plan" => string_field(payload(event), "title").unwrap_or_else(|| "Plan".to_string()),
        "review" => string_field(payload(event), "title").unwrap_or_else(|| "Review".to_string()),
        "error" => "Error".to_string(),
        _ => event_kind(event),
    }
}

fn summarize_events(events: &[Value]) -> String {
    let summaries = events
        .iter()
        .filter_map(|event| {
            let payload = payload(event);
            string_field(payload, "summary")
                .or_else(|| string_field(payload, "message"))
                .or_else(|| string_field(payload, "content"))
                .or_else(|| string_field(payload, "toolName"))
                .or_else(|| string_field(payload, "name"))
        })
        .collect::<Vec<_>>();
    if summaries.is_empty() {
        format!(
            "{} event{}",
            events.len(),
            if events.len() == 1 { "" } else { "s" }
        )
    } else if summaries.len() == 1 {
        trim_text(&summaries[0], 180)
    } else {
        trim_text(&summaries.join(" / "), 220)
    }
}

fn block_body(event: &Value, kind: &str) -> Option<String> {
    match kind {
        "user" | "assistant" | "thinking" | "plan" | "review" | "error" => {
            event_text(event).filter(|text| !text.trim().is_empty())
        }
        _ => None,
    }
}

fn group_status(events: &[Value]) -> String {
    if events
        .iter()
        .any(|event| event_kind(event) == "error" || event_status(event) == "error")
    {
        return "failed".to_string();
    }
    if events
        .iter()
        .any(|event| event_kind(event) == "permission_request")
    {
        let resolved = events
            .iter()
            .any(|event| event_kind(event) == "permission_result");
        if !resolved {
            return "waiting".to_string();
        }
    }
    if events.iter().any(|event| {
        let status = event_status(event);
        status == "started" || status == "running" || status == "llm_requested"
    }) {
        let resolved = events.iter().any(|event| {
            let status = event_status(event);
            status == "completed" || status == "done" || status == "ok"
        });
        if !resolved {
            return "running".to_string();
        }
    }
    if events.iter().any(|event| {
        event_status(event) == "awaitingUserApproval" || event_status(event) == "pending"
    }) {
        return "waiting".to_string();
    }
    "completed".to_string()
}

fn should_collapse(kind: &str, status: &str) -> bool {
    match kind {
        "thinking" | "stage" | "toolBatch" | "permission" => status == "completed",
        _ => false,
    }
}

fn event_kind(event: &Value) -> String {
    string_field(event, "kind").unwrap_or_else(|| "event".to_string())
}

fn event_id(event: &Value) -> Option<String> {
    string_field(event, "id")
}

fn event_ts(event: &Value) -> Option<String> {
    string_field(event, "ts")
}

fn event_channel(event: &Value) -> Option<String> {
    string_field(payload(event), "channel")
}

fn event_status(event: &Value) -> String {
    let payload = payload(event);
    if payload.get("ok").and_then(Value::as_bool) == Some(false) {
        return "error".to_string();
    }
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        return "ok".to_string();
    }
    string_field(payload, "status")
        .or_else(|| string_field(payload, "decision"))
        .unwrap_or_else(|| {
            if event_kind(event) == "tool_call" {
                "running".to_string()
            } else {
                "completed".to_string()
            }
        })
}

fn event_text(event: &Value) -> Option<String> {
    let payload = payload(event);
    string_field(payload, "content")
        .or_else(|| string_field(payload, "message"))
        .or_else(|| string_field(payload, "summary"))
        .or_else(|| string_field(payload, "details"))
}

fn payload(event: &Value) -> &Value {
    event.get("payload").unwrap_or(event)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
}

fn trim_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut output = value.chars().take(max_chars).collect::<String>();
    output.push_str("...");
    output
}
