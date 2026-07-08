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
    let all_events = events.clone();
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

    resolve_interaction_blocks(&mut turns, &all_events);

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

// The API timeline receives archived projection events without the in-memory
// InteractionLedger. Resolve obsolete waiting blocks from consumed owners so
// shells do not expose stale confirmation prompts as active work.
fn resolve_interaction_blocks(turns: &mut Vec<AgentTimelineTurn>, events: &[Value]) {
    let consumed = collect_consumed_interaction_owners(events);
    for turn in turns.iter_mut() {
        for block in turn.blocks.iter_mut() {
            if block.status != "waiting" && block.status != "blocked" {
                continue;
            }
            if block
                .events
                .iter()
                .any(|event| waiting_owner_was_consumed(event, &consumed))
            {
                block.status = "completed".to_string();
                block.default_collapsed = should_collapse(&block.kind, &block.status);
            }
        }
        *turn = finalize_turn(turn.clone());
    }
}

#[derive(Default)]
struct ConsumedInteractionOwners {
    plans: std::collections::HashSet<String>,
    requirements: std::collections::HashSet<String>,
    reviews: std::collections::HashSet<String>,
    permissions: std::collections::HashSet<String>,
}

fn collect_consumed_interaction_owners(events: &[Value]) -> ConsumedInteractionOwners {
    let mut consumed = ConsumedInteractionOwners::default();
    for event in events {
        let kind = event_kind(event);
        let payload = payload(event);
        match kind.as_str() {
            "requirement_decision" => {
                add_strings(
                    &mut consumed.requirements,
                    [
                        string_field(payload, "requirementId"),
                        string_field(payload, "interactionId"),
                        string_field(payload, "sourceInteractionId"),
                        string_field(payload, "targetId"),
                    ],
                );
            }
            "plan_review" => {
                let status = event_status(event).to_ascii_lowercase();
                if matches!(
                    status.as_str(),
                    "accepted"
                        | "rejected"
                        | "needsrevision"
                        | "failed"
                        | "completed"
                        | "cancelled"
                ) {
                    add_strings(
                        &mut consumed.plans,
                        [
                            string_field(payload, "planId"),
                            string_field(payload, "interactionId"),
                            string_field(payload, "sourceInteractionId"),
                            string_field(payload, "targetId"),
                        ],
                    );
                }
            }
            "review_summary" => {
                let status = event_status(event).to_ascii_lowercase();
                if !status.is_empty() && status != "waitinguserreview" && status != "pending" {
                    add_strings(
                        &mut consumed.reviews,
                        [
                            string_field(payload, "reviewId"),
                            string_field(payload, "interactionId"),
                            string_field(payload, "sourceInteractionId"),
                            string_field(payload, "targetId"),
                        ],
                    );
                    add_strings(
                        &mut consumed.plans,
                        [
                            string_field(payload, "planId"),
                            string_field(payload, "sourcePlanId"),
                        ],
                    );
                }
            }
            "permission_decision" => {
                add_strings(
                    &mut consumed.permissions,
                    [
                        string_field(payload, "permissionId"),
                        string_field(payload, "interactionId"),
                        string_field(payload, "sourceInteractionId"),
                        string_field(payload, "targetId"),
                    ],
                );
            }
            "session_run_state" => {
                let status = event_status(event);
                if status == "completed" || status == "cancelled" || status == "failed" {
                    add_session_run_state_owner(payload, &mut consumed);
                }
                if status == "running"
                    && string_field(payload, "reason").as_deref() == Some("accepted_plan_execution")
                {
                    let owner = object_payload(payload.get("decisionOwner"));
                    add_strings(
                        &mut consumed.plans,
                        [
                            string_field(payload, "planId"),
                            string_field(payload, "targetId"),
                            string_field(&owner, "targetId"),
                            string_field(&owner, "planId"),
                        ],
                    );
                }
            }
            _ => {}
        }
    }
    consumed
}

fn add_session_run_state_owner(payload: &Value, consumed: &mut ConsumedInteractionOwners) {
    let owner = object_payload(payload.get("decisionOwner"));
    let decision_kind =
        string_field(payload, "decisionKind").or_else(|| string_field(&owner, "kind"));
    match decision_kind.as_deref() {
        Some("plan") => add_strings(
            &mut consumed.plans,
            [
                string_field(payload, "planId"),
                string_field(payload, "targetId"),
                string_field(&owner, "planId"),
                string_field(&owner, "targetId"),
            ],
        ),
        Some("requirement") => add_strings(
            &mut consumed.requirements,
            [
                string_field(payload, "requirementId"),
                string_field(payload, "targetId"),
                string_field(&owner, "requirementId"),
                string_field(&owner, "targetId"),
            ],
        ),
        Some("review") => add_strings(
            &mut consumed.reviews,
            [
                string_field(payload, "reviewId"),
                string_field(payload, "targetId"),
                string_field(&owner, "reviewId"),
                string_field(&owner, "targetId"),
            ],
        ),
        Some("permission") => add_strings(
            &mut consumed.permissions,
            [
                string_field(payload, "permissionId"),
                string_field(payload, "targetId"),
                string_field(&owner, "permissionId"),
                string_field(&owner, "targetId"),
            ],
        ),
        _ => {}
    }
}

fn waiting_owner_was_consumed(event: &Value, consumed: &ConsumedInteractionOwners) -> bool {
    let payload = payload(event);
    match event_kind(event).as_str() {
        "plan_card" => has_any(
            &consumed.plans,
            [
                string_field(payload, "planId"),
                string_field(payload, "targetId"),
                string_field(payload, "interactionId"),
                string_field(payload, "sourceInteractionId"),
            ],
        ),
        "requirement_confirmation" => has_any(
            &consumed.requirements,
            [
                string_field(payload, "requirementId"),
                string_field(payload, "targetId"),
                string_field(payload, "interactionId"),
                string_field(payload, "sourceInteractionId"),
            ],
        ),
        "review_summary" => has_any(
            &consumed.reviews,
            [
                string_field(payload, "reviewId"),
                string_field(payload, "targetId"),
                string_field(payload, "interactionId"),
                string_field(payload, "sourceInteractionId"),
            ],
        ),
        "session_run_state" => session_run_state_owner_consumed(payload, consumed),
        _ => false,
    }
}

fn session_run_state_owner_consumed(payload: &Value, consumed: &ConsumedInteractionOwners) -> bool {
    let owner = object_payload(payload.get("decisionOwner"));
    let decision_kind =
        string_field(payload, "decisionKind").or_else(|| string_field(&owner, "kind"));
    let target_id = string_field(payload, "targetId").or_else(|| string_field(&owner, "targetId"));
    match decision_kind.as_deref() {
        Some("plan") => has_any(
            &consumed.plans,
            [
                target_id,
                string_field(payload, "planId"),
                string_field(&owner, "planId"),
            ],
        ),
        Some("requirement") => has_any(
            &consumed.requirements,
            [
                target_id,
                string_field(payload, "requirementId"),
                string_field(&owner, "requirementId"),
            ],
        ),
        Some("review") => has_any(
            &consumed.reviews,
            [
                target_id,
                string_field(payload, "reviewId"),
                string_field(&owner, "reviewId"),
            ],
        ),
        Some("permission") => has_any(
            &consumed.permissions,
            [
                target_id,
                string_field(payload, "permissionId"),
                string_field(&owner, "permissionId"),
            ],
        ),
        _ => false,
    }
}

fn add_strings<const N: usize>(
    target: &mut std::collections::HashSet<String>,
    values: [Option<String>; N],
) {
    for value in values.into_iter().flatten() {
        target.insert(value);
    }
}

fn has_any<const N: usize>(
    target: &std::collections::HashSet<String>,
    values: [Option<String>; N],
) -> bool {
    values
        .into_iter()
        .flatten()
        .any(|value| target.contains(&value))
}

fn append_event_block(turn: &mut AgentTimelineTurn, event: Value, index: usize) {
    if is_hidden_timeline_event(&event) {
        return;
    }
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

fn is_hidden_timeline_event(event: &Value) -> bool {
    let payload = payload(event);
    matches!(
        string_field(payload, "visibility").as_deref(),
        Some("debug" | "trace")
    ) || string_field(payload, "presentation").as_deref() == Some("traceOnly")
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
    if events.iter().any(|event| {
        let status = event_status(event);
        event_kind(event) == "error" || status == "error" || status == "failed"
    }) {
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
        matches!(
            event_status(event).as_str(),
            "awaitingUserApproval"
                | "pending"
                | "waiting"
                | "waitingUserReview"
                | "waitingUserConfirmation"
        )
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
    if let Some(status) = kernel_event_status(payload) {
        return status.to_string();
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

fn kernel_event_status(payload: &Value) -> Option<&'static str> {
    let kernel_event = payload.get("kernelEvent")?;
    let kind = string_field(kernel_event, "kind")?;
    match kind.as_str() {
        "review_gate.evaluated"
        | "review.facts_produced"
        | "work_unit.completed"
        | "tool.completed"
        | "permission.resolved" => Some("completed"),
        "work_unit.failed" | "tool.failed" => Some("failed"),
        "work_unit.blocked" => Some("blocked"),
        "work_unit.started" | "work_unit.queued" | "tool.started" => Some("running"),
        _ => None,
    }
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

fn object_payload(value: Option<&Value>) -> Value {
    value
        .filter(|item| item.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_message_renders_as_thinking_block() {
        let timeline = build_agent_timeline(
            "session-1",
            vec![
                json!({
                    "id": "user-1",
                    "kind": "user_msg",
                    "ts": "2026-01-01T00:00:00Z",
                    "payload": { "content": "hello" }
                }),
                json!({
                    "id": "reasoning-1",
                    "kind": "assistant_msg",
                    "ts": "2026-01-01T00:00:01Z",
                    "payload": {
                        "channel": "reasoning",
                        "content": "internal reasoning"
                    }
                }),
            ],
        );
        let blocks = timeline["turns"][0]["blocks"].as_array().unwrap();
        let thinking = blocks
            .iter()
            .find(|block| block.get("kind").and_then(Value::as_str) == Some("thinking"))
            .expect("thinking block must be retained");
        assert_eq!(thinking["bodyMarkdown"], "internal reasoning");
    }

    #[test]
    fn accepted_plan_review_closes_pending_plan_block() {
        let timeline = build_agent_timeline(
            "session-generic-plan",
            vec![
                json!({
                    "id": "user-generic-plan",
                    "kind": "user_msg",
                    "ts": "2026-01-01T00:00:00Z",
                    "payload": { "content": "Prepare a generic plan." }
                }),
                json!({
                    "id": "plan-generic",
                    "kind": "plan_card",
                    "ts": "2026-01-01T00:00:01Z",
                    "payload": {
                        "runId": "run-generic-plan",
                        "planId": "plan-generic",
                        "title": "Generic plan",
                        "status": "pending"
                    }
                }),
                json!({
                    "id": "state-generic-plan",
                    "kind": "session_run_state",
                    "ts": "2026-01-01T00:00:02Z",
                    "payload": {
                        "runId": "run-generic-plan",
                        "status": "waiting",
                        "decisionOwner": {
                            "kind": "plan",
                            "runId": "run-generic-plan",
                            "planId": "plan-generic",
                            "targetId": "plan-generic"
                        }
                    }
                }),
                json!({
                    "id": "plan-generic-accepted",
                    "kind": "plan_review",
                    "ts": "2026-01-01T00:00:03Z",
                    "payload": {
                        "runId": "run-generic-plan",
                        "planId": "plan-generic",
                        "status": "accepted"
                    }
                }),
            ],
        );
        let turn = &timeline["turns"][0];
        assert_eq!(turn["status"], "completed");
        let blocks = turn["blocks"].as_array().unwrap();
        let pending_plan = blocks
            .iter()
            .find(|block| {
                block["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["id"] == "plan-generic")
            })
            .expect("pending plan block must remain visible");
        assert_eq!(pending_plan["status"], "completed");
        let waiting_state = blocks
            .iter()
            .find(|block| {
                block["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["id"] == "state-generic-plan")
            })
            .expect("waiting run-state block must remain visible");
        assert_eq!(waiting_state["status"], "completed");
    }

    #[test]
    fn accepted_review_closes_waiting_review_block() {
        let timeline = build_agent_timeline(
            "session-generic-review",
            vec![
                json!({
                    "id": "user-generic-review",
                    "kind": "user_msg",
                    "ts": "2026-01-01T00:00:00Z",
                    "payload": { "content": "Run a generic review." }
                }),
                json!({
                    "id": "review-generic-waiting",
                    "kind": "review_summary",
                    "ts": "2026-01-01T00:00:01Z",
                    "payload": {
                        "runId": "run-generic-review",
                        "reviewId": "review-generic",
                        "sourcePlanId": "plan-generic",
                        "title": "Generic review",
                        "status": "waitingUserReview"
                    }
                }),
                json!({
                    "id": "review-generic-state",
                    "kind": "session_run_state",
                    "ts": "2026-01-01T00:00:02Z",
                    "payload": {
                        "runId": "run-generic-review",
                        "status": "waiting",
                        "decisionOwner": {
                            "kind": "review",
                            "runId": "run-generic-review",
                            "reviewId": "review-generic",
                            "targetId": "review-generic"
                        }
                    }
                }),
                json!({
                    "id": "review-generic-accepted",
                    "kind": "review_summary",
                    "ts": "2026-01-01T00:00:03Z",
                    "payload": {
                        "runId": "run-generic-review",
                        "reviewId": "review-generic",
                        "sourcePlanId": "plan-generic",
                        "status": "accepted"
                    }
                }),
                json!({
                    "id": "review-gate-terminal",
                    "kind": "workflow_stage",
                    "ts": "2026-01-01T00:00:04Z",
                    "payload": {
                        "status": "running",
                        "kernelEvent": {
                            "kind": "review_gate.evaluated",
                            "runId": "run-generic-review",
                            "reviewId": "review-generic",
                            "result": { "status": "accepted" }
                        }
                    }
                }),
            ],
        );
        let turn = &timeline["turns"][0];
        assert_eq!(turn["status"], "completed");
        let blocks = turn["blocks"].as_array().unwrap();
        let waiting_review = blocks
            .iter()
            .find(|block| {
                block["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["id"] == "review-generic-waiting")
            })
            .expect("waiting review block must remain visible");
        assert_eq!(waiting_review["status"], "completed");
        let waiting_state = blocks
            .iter()
            .find(|block| {
                block["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["id"] == "review-generic-state")
            })
            .expect("waiting review run-state block must remain visible");
        assert_eq!(waiting_state["status"], "completed");
        let review_gate = blocks
            .iter()
            .find(|block| {
                block["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["id"] == "review-gate-terminal")
            })
            .expect("terminal review gate block must remain visible");
        assert_eq!(review_gate["status"], "completed");
    }
}
