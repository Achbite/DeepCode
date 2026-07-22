use crate::prelude::*;
use crate::*;

pub(crate) fn validated_bridge_timeline(
    result: &Value,
    session_id: &str,
    expected_event_count: usize,
) -> Result<Value, String> {
    let timeline = result
        .get("timeline")
        .cloned()
        .ok_or_else(|| "session bridge result is missing the canonical timeline".to_string())?;
    if timeline.get("schemaVersion").and_then(Value::as_str) != Some("deepcode.session.timeline.v1")
    {
        return Err("session bridge timeline has an unsupported schema version".to_string());
    }
    if timeline.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err("session bridge timeline does not belong to the active session".to_string());
    }
    if timeline.get("turns").and_then(Value::as_array).is_none() {
        return Err("session bridge timeline is missing structured turns".to_string());
    }
    if timeline.get("eventCount").and_then(Value::as_u64) != Some(expected_event_count as u64) {
        return Err(format!(
            "session bridge timeline event count does not match committed projection: expected {expected_event_count}"
        ));
    }
    Ok(timeline)
}

fn is_final_assistant_event(event: &Value) -> bool {
    if event.get("kind").and_then(Value::as_str) != Some("assistant_msg") {
        return false;
    }
    let Some(payload) = event.get("payload") else {
        return false;
    };
    payload.get("channel").and_then(Value::as_str) == Some("final")
        || payload.get("kind").and_then(Value::as_str) == Some("final")
}

pub(crate) fn latest_final_text(
    state: &AppState,
    session_id: &str,
    start_event_count: usize,
) -> Option<String> {
    session_projection(state, session_id)
        .into_iter()
        .skip(start_event_count)
        .rev()
        .find_map(|event| {
            if is_final_assistant_event(&event) {
                event_message(&event)
            } else {
                None
            }
        })
}

fn event_message(event: &Value) -> Option<String> {
    event
        .get("payload")
        .and_then(|payload| {
            payload
                .get("content")
                .or_else(|| payload.get("summary"))
                .or_else(|| payload.get("message"))
        })
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn fail_run_with_event(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    code: &str,
    message: impl Into<String>,
) {
    let message = message.into();
    let _ = set_run_terminal(state, run_id, "failed", Some(message.clone()), None);
    append_session_projection(
        state,
        session_id,
        vec![
            agent_event(
                session_id,
                "error",
                json!({
                    "code": code,
                    "message": message,
                    "summary": message,
                    "channel": "error",
                    "visibility": "conversation",
                    "presentation": "body",
                    "runId": run_id
                }),
                &now_text(),
            ),
            terminal_session_run_state_event(session_id, run_id, "failed", "failed"),
        ],
    );
}

pub(crate) fn terminal_session_run_state_event(
    session_id: &str,
    run_id: &str,
    phase: &str,
    status: &str,
) -> Value {
    let summary_key = match status {
        "cancelled" => "session.runState.cancelled",
        _ => "session.runState.failed",
    };
    agent_event(
        session_id,
        "session_run_state",
        json!({
            "status": status,
            "phase": phase,
            "reason": "session",
            "runId": run_id,
            "decisionKind": "session",
            "decisionOwner": {
                "kind": "session",
                "runId": run_id
            },
            "summary": summary_key,
            "summaryKey": summary_key,
            "messageKey": summary_key,
            "messageArgs": {
                "reason": "session",
                "status": status
            },
            "channel": "task",
            "visibility": "debug",
            "presentation": "stageSummary"
        }),
        &now_text(),
    )
}

pub(crate) fn set_run_terminal(
    state: &AppState,
    run_id: &str,
    status: &str,
    message: Option<String>,
    final_text: Option<String>,
) -> bool {
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(run_id) else {
        return false;
    };
    if run_status_terminal(&run.status) {
        return false;
    }
    let now = now_text();
    run.status = status.to_string();
    run.updated_at = now.clone();
    run.completed_at = Some(now);
    run.message = message;
    run.final_text = final_text;
    true
}

pub(crate) fn request_run_cancellation(state: &AppState, run_id: &str) -> bool {
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(run_id) else {
        return false;
    };
    if run_status_terminal(&run.status) || run.status == "cancelling" {
        return false;
    }
    run.status = "cancelling".to_string();
    run.updated_at = now_text();
    run.message = Some("Run cancellation requested by user.".to_string());
    true
}

pub(crate) fn touch_run(state: &AppState, run_id: &str, message: Option<String>) -> bool {
    let mut runs = state.session_runs.lock().expect("session run state lock");
    let Some(run) = runs.get_mut(run_id) else {
        return false;
    };
    if run_status_terminal(&run.status) {
        return false;
    }
    run.updated_at = now_text();
    if let Some(message) = message {
        run.message = Some(message);
    }
    true
}

pub(crate) fn run_belongs_to_session(state: &AppState, session_id: &str, run_id: &str) -> bool {
    let runs = state.session_runs.lock().expect("session run state lock");
    runs.get(run_id)
        .map(|run| run.session_id == session_id)
        .unwrap_or(false)
}

pub(crate) fn normalize_run_delta(
    session_id: &str,
    host_run_id: &str,
    delta_seq: u64,
    mut delta: Value,
) -> Value {
    if let Value::Object(object) = &mut delta {
        object
            .entry("sessionId".to_string())
            .or_insert_with(|| json!(session_id));
        object
            .entry("hostRunId".to_string())
            .or_insert_with(|| json!(host_run_id));
        object
            .entry("deltaSeq".to_string())
            .or_insert_with(|| json!(delta_seq));
        object
            .entry("receivedAt".to_string())
            .or_insert_with(|| json!(now_text()));
    }
    delta
}

pub(crate) fn terminal_stream_event_tail(
    events: &[Value],
    sent_event_count: usize,
) -> (Vec<Value>, usize) {
    let start = sent_event_count.min(events.len());
    (events.iter().skip(start).cloned().collect(), events.len())
}

pub(crate) fn pending_permission_message(events: &[Value]) -> Option<String> {
    for event in events.iter().rev() {
        match event.get("kind").and_then(Value::as_str) {
            Some("permission_result") => return None,
            Some("permission_request") => {
                return Some(
                    event_message(event)
                        .unwrap_or_else(|| "permission confirmation is pending".to_string()),
                );
            }
            _ => {}
        }
    }
    None
}

pub(crate) fn sse_bytes(
    event: &str,
    payload: Value,
) -> Result<bytes::Bytes, std::convert::Infallible> {
    let data = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    Ok(bytes::Bytes::from(format!(
        "event: {event}\ndata: {data}\n\n"
    )))
}

pub(crate) fn run_cancelled(state: &AppState, run_id: &str) -> bool {
    let runs = state.session_runs.lock().expect("session run state lock");
    runs.get(run_id)
        .map(|run| run.status == "cancelling" || run.status == "cancelled")
        .unwrap_or(false)
}

pub(crate) fn run_status_active(status: &str) -> bool {
    !run_status_terminal(status)
}

pub(crate) fn run_status_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "waiting")
}
