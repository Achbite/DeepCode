use crate::{fs, llm_profiles, user_settings, workspace};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs as stdfs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const STAGES: [&str; 4] = ["plan", "check", "complete", "review"];
const SEARCH_MAX_FILES: usize = 5000;
const SEARCH_MAX_MATCHES: usize = 500;
const SHELL_OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionResult {
    pub session: Value,
    pub events: Vec<Value>,
}

#[derive(Debug, Clone)]
struct PendingPermission {
    session_id: String,
    tool_call: Value,
    mode: String,
}

#[derive(Default)]
struct AgentState {
    sessions: HashMap<String, AgentSessionResult>,
    current_session_id: Option<String>,
    pending_permissions: HashMap<String, PendingPermission>,
    trace_events: HashMap<String, Vec<Value>>,
}

pub struct AgentManager {
    state: Mutex<AgentState>,
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(AgentState::default()),
        }
    }

    pub fn create_session(&self, request: Value) -> AgentSessionResult {
        let body = request.get("request").unwrap_or(&request);
        let mode = string_field(body, "initialMode").unwrap_or_else(|| "plan".into());
        let profile_id = string_field(body, "profileId");
        let id = format!("agent-{}", Utc::now().timestamp_millis());
        let now = now_iso();
        let session = json!({
            "id": id,
            "mode": mode,
            "profileId": profile_id,
            "createdAt": now,
            "updatedAt": now
        });
        let result = AgentSessionResult {
            session,
            events: Vec::new(),
        };
        let mut state = self.state.lock().expect("agent state poisoned");
        state.current_session_id = Some(id.clone());
        state.trace_events.insert(id.clone(), Vec::new());
        state.sessions.insert(id, result.clone());
        result
    }

    pub fn current_session(&self) -> Option<AgentSessionResult> {
        let state = self.state.lock().expect("agent state poisoned");
        let id = state.current_session_id.as_ref()?;
        state.sessions.get(id).cloned()
    }

    pub fn append_events(
        &self,
        session_id: &str,
        request: Value,
    ) -> Result<AgentSessionResult, String> {
        let events = request
            .get("request")
            .unwrap_or(&request)
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.append_events_direct(session_id, events)
    }

    pub fn append_feedback_trace(&self, request: Value) -> Value {
        let body = request.get("request").unwrap_or(&request);
        let event_id = string_field(body, "eventId");
        let session_id = string_field(body, "sessionId");
        let rating = string_field(body, "rating");
        let accepted = event_id.is_some() && rating.is_some();

        if let (Some(session_id), Some(event_id), Some(rating)) =
            (session_id.clone(), event_id.clone(), rating.clone())
        {
            let now = now_iso();
            let trace = json!({
                "id": format!("trace-feedback-{event_id}-{rating}"),
                "eventId": event_id,
                "sessionId": session_id,
                "turnId": event_id,
                "ts": now,
                "timestamp": now,
                "kind": "user.guidance",
                "source": "user",
                "level": "info",
                "summary": format!("User feedback: {rating}"),
                "payload": body
            });
            let mut state = self.state.lock().expect("agent state poisoned");
            if state.sessions.contains_key(&session_id) {
                let trace_store = state.trace_events.entry(session_id).or_default();
                if !trace_store
                    .iter()
                    .any(|item| string_field(item, "id") == string_field(&trace, "id"))
                {
                    trace_store.push(trace);
                }
            }
        }

        json!({
            "accepted": accepted,
            "message": "Agent feedback was recorded as a trace guidance event when sessionId is available."
        })
    }

    pub fn get_event_snapshot(&self, session_id: &str) -> Result<Value, String> {
        let state = self.state.lock().expect("agent state poisoned");
        if !state.sessions.contains_key(session_id) {
            return Err(format!("Agent session not found: {session_id}"));
        }
        let events = state
            .trace_events
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        let updated_at = events
            .last()
            .and_then(|event| string_field(event, "ts"))
            .unwrap_or_else(now_iso);
        Ok(json!({
            "sessionId": session_id,
            "trace": {
                "sessionId": session_id,
                "events": events,
                "eventCount": state.trace_events.get(session_id).map(|items| items.len()).unwrap_or(0),
                "updatedAt": updated_at
            }
        }))
    }

    pub async fn send_message(
        &self,
        session_id: &str,
        request: Value,
        workspace: &workspace::WorkspaceManager,
    ) -> Result<AgentSessionResult, String> {
        let current = {
            let state = self.state.lock().expect("agent state poisoned");
            state
                .sessions
                .get(session_id)
                .cloned()
                .ok_or_else(|| format!("Agent session not found: {session_id}"))?
        };

        let body = request.get("request").unwrap_or(&request);
        let mode = string_field(body, "mode")
            .or_else(|| string_field(&current.session, "mode"))
            .unwrap_or_else(|| "plan".into());
        let content = string_field(body, "content").unwrap_or_default();
        let workflow = string_field(body, "workflow").unwrap_or_else(|| "planFirst".into());
        let attachments = body
            .get("attachments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut latest = current.clone();
        let mut sequence = 0u64;
        let user_event = new_event(
            session_id,
            "user_msg",
            json!({
                "content": content,
                "attachments": attachments,
                "channel": "user",
                "visibility": "conversation"
            }),
        );
        let turn_id = event_id(&user_event);
        self.emit_events_direct(
            session_id,
            &mut latest,
            &turn_id,
            &mut sequence,
            vec![user_event],
        )?;

        let workflow_config = resolve_workflow_config(body, &current.session)?;
        if !has_configured_stage(&workflow_config) {
            self.emit_events_direct(session_id, &mut latest, &turn_id, &mut sequence, vec![new_event(
                session_id,
                "assistant_msg",
                json!({
                    "content": "Please configure a valid LLM provider profile and assign it to at least one Agent workflow stage.",
                    "channel": "final",
                    "visibility": "conversation",
                    "label": "Agent"
                }),
            )])?;
            return Ok(latest);
        }

        let context = build_prompt_text(&attachments, workspace);
        let mut stage_outputs: Vec<String> = Vec::new();
        let mut emitted_final = false;
        let mut last_user_visible_text = String::new();

        for stage in STAGES {
            let Some(profile_id) = workflow_config
                .get(stage)
                .and_then(|value| value.get("profileId"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
            else {
                continue;
            };

            let stage_run_id = format!("stage-{stage}-{}", Utc::now().timestamp_micros());
            let llm_call_id = format!("llm-{stage}-{}", Utc::now().timestamp_micros());
            let base_context = json!({
                "turnId": turn_id,
                "stage": stage,
                "phase": stage,
                "stageRunId": stage_run_id,
                "llmCallId": llm_call_id
            });

            self.emit_events_direct(
                session_id,
                &mut latest,
                &turn_id,
                &mut sequence,
                vec![new_event(
                    session_id,
                    "workflow_stage",
                    json!({
                        "stage": stage,
                        "phase": stage,
                        "stageRunId": stage_run_id,
                        "llmCallId": llm_call_id,
                        "profileId": profile_id,
                        "status": "started",
                        "channel": "task",
                        "visibility": "task"
                    }),
                )],
            )?;

            let prior = if stage_outputs.is_empty() {
                String::new()
            } else {
                format!(
                    "\n\nPrevious workflow stage output:\n{}",
                    stage_outputs.join("\n\n")
                )
            };
            let user_content = format!("{content}{prior}");
            let system_content = [
                context.as_str(),
                output_envelope_prompt(),
                stage_prompt(stage),
                &format!("Current permission mode: {mode}."),
                &format!("Default workflow behavior: {workflow}."),
                "Natural language alone must never trigger local operations; only explicit tool calls or deepcode-action blocks may do so.",
            ]
            .join("\n\n");
            let mut request_payload = json!({
                "profileId": profile_id,
                "messages": [
                    {
                        "role": "system",
                        "content": system_content
                    },
                    { "role": "user", "content": user_content }
                ],
                "stream": false
            });
            if stage == "complete" {
                request_payload["tools"] = Value::Array(list_agent_tools_value(Some(&mode)));
            }

            match llm_profiles::chat(request_payload).await {
                Ok(response) => {
                    let mut assistant_text = String::new();
                    let mut reasoning_text = String::new();
                    let mut stage_tool_calls: Vec<Value> = Vec::new();
                    let mut observation_events: Vec<Value> = Vec::new();
                    for chunk in response
                        .get("chunks")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        match string_field(chunk, "type").as_deref() {
                            Some("reasoning_delta") => {
                                if let Some(delta) = string_field(chunk, "content") {
                                    reasoning_text.push_str(&delta);
                                }
                            }
                            Some("delta") => {
                                if let Some(delta) = string_field(chunk, "content") {
                                    assistant_text.push_str(&delta);
                                }
                            }
                            Some("tool_call") if stage == "complete" => {
                                if let Some(tool_call) = chunk.get("toolCall") {
                                    stage_tool_calls.push(tool_call.clone());
                                }
                            }
                            Some("error") => {
                                self.emit_events_direct(session_id, &mut latest, &turn_id, &mut sequence, vec![new_event(
                                    session_id,
                                    "error",
                                    with_context(json!({
                                        "stage": stage,
                                        "phase": stage,
                                        "code": "llm_stream_error",
                                        "message": string_field(chunk, "error").unwrap_or_else(|| "LLM stream error".into())
                                    }), &base_context, json!({ "channel": "error", "visibility": "conversation" })),
                                )])?;
                            }
                            _ => {}
                        }
                    }

                    let trimmed = assistant_text.trim().to_string();
                    if !reasoning_text.trim().is_empty() {
                        self.emit_events_direct(
                            session_id,
                            &mut latest,
                            &turn_id,
                            &mut sequence,
                            vec![assistant_segment_event(
                                session_id,
                                &base_context,
                                "reasoning",
                                reasoning_text.trim(),
                            )],
                        )?;
                    }
                    if !trimmed.is_empty() {
                        stage_outputs.push(format!("[{stage}] {trimmed}"));
                        for (kind, content) in
                            parse_tagged_segments(&trimmed, fallback_segment_kind(stage))
                        {
                            self.emit_events_direct(
                                session_id,
                                &mut latest,
                                &turn_id,
                                &mut sequence,
                                vec![assistant_segment_event(
                                    session_id,
                                    &base_context,
                                    &kind,
                                    &content,
                                )],
                            )?;
                            if kind == "final" {
                                emitted_final = true;
                            }
                            if kind != "reasoning" {
                                last_user_visible_text = content;
                            }
                        }
                        if stage == "complete" {
                            let parsed = self.run_parsed_text_actions(
                                session_id,
                                &mode,
                                &trimmed,
                                workspace,
                                &base_context,
                            )?;
                            if !parsed.is_empty() {
                                observation_events.extend(parsed.clone());
                                self.emit_events_direct(
                                    session_id,
                                    &mut latest,
                                    &turn_id,
                                    &mut sequence,
                                    parsed,
                                )?;
                            }
                        }
                    } else if stage == "complete" && !stage_tool_calls.is_empty() {
                        self.emit_events_direct(
                            session_id,
                            &mut latest,
                            &turn_id,
                            &mut sequence,
                            vec![assistant_segment_event(
                                session_id,
                                &base_context,
                                "say",
                                "我会先按当前任务调用工具获取事实，再根据结果继续判断。",
                            )],
                        )?;
                    }

                    if stage == "complete" && !stage_tool_calls.is_empty() {
                        let batch_context = merge_context(
                            &base_context,
                            json!({
                                "batchId": format!("batch-{}", Utc::now().timestamp_micros()),
                                "batchLabel": tool_batch_label(&stage_tool_calls)
                            }),
                        );
                        for tool_call in stage_tool_calls {
                            let next = self.execute_or_ask(
                                session_id,
                                &mode,
                                tool_call,
                                workspace,
                                &batch_context,
                            )?;
                            observation_events.extend(next.clone());
                            self.emit_events_direct(
                                session_id,
                                &mut latest,
                                &turn_id,
                                &mut sequence,
                                next,
                            )?;
                        }
                    }

                    append_observation_context(&mut stage_outputs, stage, &observation_events);
                    if !observation_events.is_empty() {
                        let summaries: Vec<String> = observation_events
                            .iter()
                            .filter_map(tool_observation_summary)
                            .take(8)
                            .collect();
                        let observe_text = if summaries.is_empty() {
                            "已经获取工具结果，继续根据结果判断。".to_string()
                        } else {
                            format!(
                                "已经获取工具结果，继续根据结果判断。\n\n{}",
                                summaries.join("\n")
                            )
                        };
                        self.emit_events_direct(
                            session_id,
                            &mut latest,
                            &turn_id,
                            &mut sequence,
                            vec![assistant_segment_event(
                                session_id,
                                &base_context,
                                "observe",
                                &observe_text,
                            )],
                        )?;
                        last_user_visible_text = "已经获取工具结果，继续根据结果判断。".into();
                    }

                    self.emit_events_direct(session_id, &mut latest, &turn_id, &mut sequence, vec![new_event(
                        session_id,
                        "workflow_stage",
                        json!({
                            "stage": stage,
                            "phase": stage,
                            "stageRunId": stage_run_id,
                            "llmCallId": llm_call_id,
                            "profileId": profile_id,
                            "status": "completed",
                            "summary": if trimmed.is_empty() { "No textual output.".into() } else { take_chars(&trimmed, 240) },
                            "channel": "task",
                            "visibility": "task"
                        }),
                    )])?;
                }
                Err(err) => {
                    self.emit_events_direct(
                        session_id,
                        &mut latest,
                        &turn_id,
                        &mut sequence,
                        vec![
                            new_event(
                                session_id,
                                "workflow_stage",
                                json!({
                                    "stage": stage,
                                    "phase": stage,
                                    "stageRunId": stage_run_id,
                                    "llmCallId": llm_call_id,
                                    "profileId": profile_id,
                                    "status": "error",
                                    "summary": err,
                                    "channel": "task",
                                    "visibility": "task"
                                }),
                            ),
                            new_event(
                                session_id,
                                "error",
                                with_context(
                                    json!({
                                        "stage": stage,
                                        "phase": stage,
                                        "code": "llm_stage_error",
                                        "message": err
                                    }),
                                    &base_context,
                                    json!({ "channel": "error", "visibility": "conversation" }),
                                ),
                            ),
                        ],
                    )?;
                }
            }
        }

        if !emitted_final && !last_user_visible_text.trim().is_empty() {
            let final_context = json!({
                "turnId": turn_id,
                "stage": "review",
                "phase": "review",
                "stageRunId": format!("stage-final-{}", Utc::now().timestamp_micros()),
                "llmCallId": format!("llm-final-{}", Utc::now().timestamp_micros())
            });
            self.emit_events_direct(
                session_id,
                &mut latest,
                &turn_id,
                &mut sequence,
                vec![assistant_segment_event(
                    session_id,
                    &final_context,
                    "final",
                    last_user_visible_text.trim(),
                )],
            )?;
        }

        Ok(latest)
    }

    pub fn resolve_permission(
        &self,
        permission_id: &str,
        request: Value,
        workspace: &workspace::WorkspaceManager,
    ) -> Result<AgentSessionResult, String> {
        let body = request.get("request").unwrap_or(&request);
        let decision = string_field(body, "decision").unwrap_or_else(|| "reject".into());
        let pending = {
            let mut state = self.state.lock().expect("agent state poisoned");
            state
                .pending_permissions
                .remove(permission_id)
                .ok_or_else(|| format!("Agent permission not found: {permission_id}"))?
        };
        let mut events = vec![new_event(
            &pending.session_id,
            "permission_result",
            json!({
                "permissionId": permission_id,
                "decision": decision,
                "toolName": pending.tool_call.get("name").cloned().unwrap_or_else(|| json!("tool")),
                "status": if decision == "accept" { "accepted" } else { "rejected" }
            }),
        )];
        if decision == "accept" {
            let result = execute_agent_tool_value(
                json!({
                    "mode": pending.mode,
                    "toolCall": pending.tool_call,
                    "approved": true
                }),
                workspace,
            );
            events.push(new_event(
                &pending.session_id,
                "tool_result",
                with_tool_name(result, &pending.tool_call),
            ));
        } else {
            events.push(new_event(
                &pending.session_id,
                "tool_result",
                json!({
                    "callId": pending.tool_call.get("id").cloned().unwrap_or_else(|| json!("tool-call")),
                    "toolName": pending.tool_call.get("name").cloned().unwrap_or_else(|| json!("tool")),
                    "ok": false,
                    "status": "error",
                    "error": "permission_rejected"
                }),
            ));
        }
        self.append_events_direct(&pending.session_id, events)
    }

    fn append_events_direct(
        &self,
        session_id: &str,
        events: Vec<Value>,
    ) -> Result<AgentSessionResult, String> {
        let trace_events = agent_events_to_trace(session_id, &events);
        let mut state = self.state.lock().expect("agent state poisoned");
        if !state.sessions.contains_key(session_id) {
            return Err(format!("Agent session not found: {session_id}"));
        }

        {
            let trace_store = state
                .trace_events
                .entry(session_id.to_string())
                .or_default();
            let known: HashSet<String> = trace_store
                .iter()
                .filter_map(|event| string_field(event, "id"))
                .collect();
            for event in trace_events {
                if let Some(id) = string_field(&event, "id") {
                    if known.contains(&id) {
                        continue;
                    }
                }
                trace_store.push(event);
            }
        }

        let session = state
            .sessions
            .get_mut(session_id)
            .expect("session existence checked above");
        session.events.extend(events);
        if let Some(obj) = session.session.as_object_mut() {
            obj.insert("updatedAt".into(), Value::String(now_iso()));
        }
        Ok(session.clone())
    }

    fn emit_events_direct(
        &self,
        session_id: &str,
        latest: &mut AgentSessionResult,
        turn_id: &str,
        sequence: &mut u64,
        events: Vec<Value>,
    ) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        let decorated = events
            .into_iter()
            .map(|event| decorate_event(event, turn_id, sequence))
            .collect();
        *latest = self.append_events_direct(session_id, decorated)?;
        Ok(())
    }

    fn execute_or_ask(
        &self,
        session_id: &str,
        mode: &str,
        tool_call: Value,
        workspace: &workspace::WorkspaceManager,
        context: &Value,
    ) -> Result<Vec<Value>, String> {
        let mut events = vec![new_event(
            session_id,
            "tool_call",
            with_context(
                tool_call.clone(),
                context,
                json!({
                    "channel": "tool",
                    "visibility": "conversation",
                    "toolCall": tool_call.clone()
                }),
            ),
        )];
        let decision = evaluate_agent_permission_value(
            json!({ "mode": mode, "toolCall": tool_call.clone() }),
            workspace,
        );
        match string_field(&decision, "action").as_deref() {
            Some("deny") => {
                events.push(new_event(
                    session_id,
                    "tool_result",
                    with_context(json!({
                        "callId": tool_call.get("id").cloned().unwrap_or_else(|| json!("tool-call")),
                        "toolName": tool_call.get("name").cloned().unwrap_or_else(|| json!("tool")),
                        "ok": false,
                        "status": "blocked",
                        "error": string_field(&decision, "reason").unwrap_or_else(|| "permission denied".into())
                    }), context, json!({ "channel": "tool", "visibility": "conversation" })),
                ));
            }
            Some("ask") => {
                let request = decision
                    .get("request")
                    .cloned()
                    .ok_or_else(|| "permission request missing".to_string())?;
                let permission_id = string_field(&request, "id")
                    .ok_or_else(|| "permission id missing".to_string())?;
                let mut state = self.state.lock().expect("agent state poisoned");
                state.pending_permissions.insert(
                    permission_id,
                    PendingPermission {
                        session_id: session_id.to_string(),
                        tool_call,
                        mode: mode.to_string(),
                    },
                );
                events.push(new_event(
                    session_id,
                    "permission_request",
                    with_context(
                        request,
                        context,
                        json!({ "channel": "tool", "visibility": "conversation" }),
                    ),
                ));
            }
            _ => {
                let result = execute_agent_tool_value(
                    json!({ "mode": mode, "toolCall": tool_call.clone() }),
                    workspace,
                );
                events.push(new_event(
                    session_id,
                    "tool_result",
                    with_context(
                        with_tool_name(result, &tool_call),
                        context,
                        json!({ "channel": "tool", "visibility": "conversation" }),
                    ),
                ));
            }
        }
        Ok(events)
    }

    fn run_parsed_text_actions(
        &self,
        session_id: &str,
        mode: &str,
        content: &str,
        workspace: &workspace::WorkspaceManager,
        context: &Value,
    ) -> Result<Vec<Value>, String> {
        let actions = parse_agent_actions(content);
        let mut events = Vec::new();
        let tool_calls: Vec<Value> = actions
            .iter()
            .filter(|action| {
                string_field(action, "status").as_deref() == Some("parsed")
                    && string_field(action, "type").as_deref() != Some("final")
                    && string_field(action, "type").as_deref() != Some("patch.plan")
            })
            .map(action_to_tool_call)
            .collect();
        let batch_id = if tool_calls.is_empty() {
            None
        } else {
            Some(format!("batch-{}", Utc::now().timestamp_micros()))
        };
        let batch_label = tool_batch_label(&tool_calls);
        for action in actions {
            let action_type = string_field(&action, "type").unwrap_or_default();
            if string_field(&action, "status").as_deref() != Some("parsed") {
                events.push(new_event(
                    session_id,
                    "error",
                    with_context(
                        json!({ "code": "invalid_action", "message": "Invalid action", "action": action }),
                        context,
                        json!({ "channel": "error", "visibility": "conversation" }),
                    ),
                ));
                continue;
            }
            if action_type == "final" {
                events.push(new_event(
                    session_id,
                    "assistant_msg",
                    with_context(
                        action.get("payload").cloned().unwrap_or(Value::Null),
                        context,
                        json!({ "channel": "final", "visibility": "conversation", "label": "最终回复" }),
                    ),
                ));
                continue;
            }
            if action_type == "patch.plan" {
                events.push(new_event(
                    session_id,
                    "tool_result",
                    with_context(json!({
                        "callId": action.get("id").cloned().unwrap_or_else(|| json!("patch-plan")),
                        "toolName": "patch.plan",
                        "ok": false,
                        "status": "needsApproval",
                        "output": action.get("payload").cloned().unwrap_or(Value::Null),
                        "error": "patch_plan_needs_approval"
                    }), context, json!({
                        "channel": "tool",
                        "visibility": "conversation",
                        "batchId": batch_id.clone().unwrap_or_else(|| format!("batch-{}", string_field(&action, "id").unwrap_or_else(|| "patch".into()))),
                        "batchLabel": "规划补丁"
                    })),
                ));
                continue;
            }
            let tool_call = action_to_tool_call(&action);
            let batch_context = with_context(
                Value::Null,
                context,
                json!({
                    "batchId": batch_id.clone().unwrap_or_else(|| format!("batch-{}", string_field(&tool_call, "id").unwrap_or_else(|| "tool".into()))),
                    "batchLabel": batch_label
                }),
            );
            let mut next =
                self.execute_or_ask(session_id, mode, tool_call, workspace, &batch_context)?;
            events.append(&mut next);
        }
        Ok(events)
    }
}

pub fn get_workflow_config() -> Value {
    let config = read_workflow_config();
    json!({
        "config": config,
        "storePath": workflow_config_path().to_string_lossy().replace('\\', "/"),
        "initialized": has_configured_stage(&config)
    })
}

pub fn patch_workflow_config(request: Value) -> Result<Value, String> {
    let body = request.get("request").unwrap_or(&request);
    let current = read_workflow_config();
    let patch = body.get("config").unwrap_or(&Value::Null);
    let mut next = normalize_workflow_config(Some(&current));
    if let Some(map) = patch.as_object() {
        for stage in STAGES {
            if let Some(value) = map.get(stage) {
                let profile_id = value
                    .get("profileId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                next[stage] = match profile_id {
                    Some(id) => json!({ "profileId": id }),
                    None => json!({}),
                };
            }
        }
    }
    write_json_atomic(workflow_config_path(), &next)?;
    Ok(json!({
        "config": next,
        "storePath": workflow_config_path().to_string_lossy().replace('\\', "/"),
        "initialized": has_configured_stage(&next)
    }))
}

pub fn list_tools(mode: Option<String>) -> Value {
    Value::Array(list_agent_tools_value(mode.as_deref()))
}

pub fn evaluate_permission(request: Value, workspace: &workspace::WorkspaceManager) -> Value {
    evaluate_agent_permission_value(request, workspace)
}

pub fn execute_tool(request: Value, workspace: &workspace::WorkspaceManager) -> Value {
    execute_agent_tool_value(request, workspace)
}

pub fn code_search(request: Value, workspace: &workspace::WorkspaceManager) -> Value {
    let body = request.get("request").unwrap_or(&request);
    let query = string_field(body, "query").unwrap_or_default();
    let folder_id = string_field(body, "folderId");
    match search_workspace(workspace, folder_id.as_deref(), &query) {
        Ok(matches) => json!({ "matches": matches }),
        Err(error) => json!({ "matches": [], "error": error }),
    }
}

fn list_agent_tools_value(mode: Option<&str>) -> Vec<Value> {
    let tools = vec![
        tool(
            "fs.read",
            "Read a text file from the active workspace.",
            "low",
            false,
            vec!["readOnly", "plan", "askBeforeWrite"],
            json!({ "type": "object", "required": ["path"], "properties": { "path": { "type": "string" }, "folderId": { "type": "string" } } }),
        ),
        tool(
            "fs.list",
            "List a workspace directory tree with a bounded depth.",
            "low",
            false,
            vec!["readOnly", "plan", "askBeforeWrite"],
            json!({ "type": "object", "properties": { "path": { "type": "string" }, "folderId": { "type": "string" }, "depth": { "type": "number" } } }),
        ),
        tool(
            "fs.diff",
            "Preview a file diff without writing content.",
            "low",
            false,
            vec!["readOnly", "plan", "askBeforeWrite"],
            json!({ "type": "object", "required": ["path", "newContent"], "properties": { "path": { "type": "string" }, "folderId": { "type": "string" }, "newContent": { "type": "string" } } }),
        ),
        tool(
            "code.search",
            "Search text across the workspace with bounded results.",
            "low",
            false,
            vec!["readOnly", "plan", "askBeforeWrite"],
            json!({ "type": "object", "required": ["query"], "properties": { "query": { "type": "string" }, "isRegex": { "type": "boolean" }, "include": { "type": "array", "items": { "type": "string" } }, "folderId": { "type": "string" } } }),
        ),
        tool(
            "shell.propose",
            "Return a proposed shell command. The command is never executed.",
            "medium",
            false,
            vec!["plan", "askBeforeWrite"],
            json!({ "type": "object", "required": ["command"], "properties": { "command": { "type": "string" }, "reason": { "type": "string" } } }),
        ),
        tool(
            "shell.exec",
            "Run a command in an Agent-owned temporary shell after explicit approval.",
            "high",
            true,
            vec!["askBeforeWrite"],
            json!({ "type": "object", "required": ["command"], "properties": { "command": { "type": "string" }, "cwd": { "type": "string" }, "timeoutMs": { "type": "number" }, "reason": { "type": "string" } } }),
        ),
        tool(
            "fs.write",
            "Write a text file after an explicit permission approval.",
            "high",
            true,
            vec!["askBeforeWrite"],
            json!({ "type": "object", "required": ["path", "content"], "properties": { "path": { "type": "string" }, "content": { "type": "string" }, "folderId": { "type": "string" } } }),
        ),
    ];
    match mode {
        Some(mode) => tools
            .into_iter()
            .filter(|item| {
                item.get("allowedModes")
                    .and_then(Value::as_array)
                    .is_some_and(|modes| modes.iter().any(|value| value.as_str() == Some(mode)))
            })
            .collect(),
        None => tools,
    }
}

fn tool(
    name: &str,
    description: &str,
    risk_level: &str,
    needs_approval: bool,
    allowed_modes: Vec<&str>,
    input_schema: Value,
) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "riskLevel": risk_level,
        "needsApproval": needs_approval,
        "allowedModes": allowed_modes
    })
}

fn evaluate_agent_permission_value(
    request: Value,
    _workspace: &workspace::WorkspaceManager,
) -> Value {
    let body = request.get("request").unwrap_or(&request);
    let mode = string_field(body, "mode").unwrap_or_else(|| "plan".into());
    let tool_call = body.get("toolCall").cloned().unwrap_or_else(|| json!({}));
    let tool_name = string_field(&tool_call, "name").unwrap_or_default();
    let Some(tool) = list_agent_tools_value(None)
        .into_iter()
        .find(|item| string_field(item, "name").as_deref() == Some(tool_name.as_str()))
    else {
        return json!({ "action": "deny", "reason": format!("Unsupported tool: {tool_name}") });
    };

    if !tool
        .get("allowedModes")
        .and_then(Value::as_array)
        .is_some_and(|modes| {
            modes
                .iter()
                .any(|value| value.as_str() == Some(mode.as_str()))
        })
    {
        return json!({ "action": "deny", "reason": format!("{tool_name} is not available in {mode} mode") });
    }

    if let Some(reason) = settings_policy_deny_reason(&tool_call) {
        return json!({ "action": "deny", "reason": reason });
    }

    if tool_name == "shell.exec" {
        let command = tool_call
            .get("arguments")
            .and_then(|args| string_field(args, "command"))
            .unwrap_or_default()
            .to_lowercase();
        if let Some(fragment) = command_blacklist()
            .into_iter()
            .find(|fragment| command.contains(fragment))
        {
            return json!({
                "action": "ask",
                "reason": format!("Command matches manual approval blacklist: {fragment}"),
                "request": permission_request(&tool_call, "high", &format!("Command matches blacklist ({fragment}). Confirm before running in Agent temporary shell."), None)
            });
        }
        if bool_setting("agent.shell.autoExecuteCommands", false) {
            return json!({ "action": "allow", "reason": "Shell execution is allowed by Agent settings." });
        }
    }

    if tool
        .get("needsApproval")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let diff = if tool_name == "fs.write" {
            diff_preview_for_tool(&tool_call, _workspace).ok()
        } else {
            None
        };
        return json!({
            "action": "ask",
            "reason": "Tool requires explicit approval.",
            "request": permission_request(&tool_call, string_field(&tool, "riskLevel").unwrap_or_else(|| "high".into()).as_str(), &format!("{tool_name} requires approval."), diff)
        });
    }

    json!({ "action": "allow", "reason": "Allowed by current Agent mode." })
}

fn execute_agent_tool_value(request: Value, workspace: &workspace::WorkspaceManager) -> Value {
    let body = request.get("request").unwrap_or(&request);
    let mode = string_field(body, "mode").unwrap_or_else(|| "plan".into());
    let tool_call = body.get("toolCall").cloned().unwrap_or_else(|| json!({}));
    let approved = body
        .get("approved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let decision = evaluate_agent_permission_value(
        json!({ "mode": mode, "toolCall": tool_call.clone() }),
        workspace,
    );
    match string_field(&decision, "action").as_deref() {
        Some("deny") => {
            return tool_failure(
                &tool_call,
                string_field(&decision, "reason").unwrap_or_else(|| "permission denied".into()),
            )
        }
        Some("ask") if !approved => return tool_failure(&tool_call, "approval_required".into()),
        _ => {}
    }

    let result = match string_field(&tool_call, "name").as_deref() {
        Some("fs.read") => exec_fs_read(&tool_call, workspace),
        Some("fs.list") => exec_fs_list(&tool_call, workspace),
        Some("fs.diff") => exec_fs_diff(&tool_call, workspace),
        Some("fs.write") => exec_fs_write(&tool_call, workspace),
        Some("code.search") => exec_code_search(&tool_call, workspace),
        Some("shell.propose") => exec_shell_propose(&tool_call),
        Some("shell.exec") => exec_shell_exec(&tool_call),
        Some(name) => Err(format!("Unsupported tool: {name}")),
        None => Err("Missing tool name".into()),
    };
    match result {
        Ok(output) => tool_success(&tool_call, output),
        Err(error) => tool_failure(&tool_call, error),
    }
}

fn exec_fs_read(
    tool_call: &Value,
    workspace: &workspace::WorkspaceManager,
) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let path = required_string(args, "path")?;
    let folder_id = string_field(args, "folderId");
    let folder = workspace.resolve_folder(folder_id.as_deref())?;
    serde_json::to_value(fs::read_text_file(
        &folder.absolute_path,
        &folder.id,
        &path,
    )?)
    .map_err(|err| err.to_string())
}

fn exec_fs_list(
    tool_call: &Value,
    workspace: &workspace::WorkspaceManager,
) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let path = string_field(args, "path").unwrap_or_default();
    let folder_id = string_field(args, "folderId");
    let folder = workspace.resolve_folder(folder_id.as_deref())?;
    let root = if path.trim().is_empty() {
        PathBuf::from(&folder.absolute_path)
    } else {
        resolve_child_path(&folder.absolute_path, &path)?
    };
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }
    let root_text = root.to_string_lossy().to_string();
    let nodes = fs::build_file_tree(&root_text, &folder.id)?;
    Ok(json!({ "folderId": folder.id, "path": path, "nodes": nodes }))
}

fn exec_fs_diff(
    tool_call: &Value,
    workspace: &workspace::WorkspaceManager,
) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let path = required_string(args, "path")?;
    let new_content = required_string(args, "newContent")?;
    let old_content = read_file_content_for_diff(args, workspace).unwrap_or_default();
    Ok(Value::String(diff_preview(
        &path,
        &old_content,
        &new_content,
    )))
}

fn exec_fs_write(
    tool_call: &Value,
    workspace: &workspace::WorkspaceManager,
) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let path = required_string(args, "path")?;
    let content = required_string(args, "content")?;
    let folder_id = string_field(args, "folderId");
    let folder = workspace.resolve_folder(folder_id.as_deref())?;
    serde_json::to_value(fs::write_text_file(
        &folder.absolute_path,
        &folder.id,
        &path,
        &content,
    )?)
    .map_err(|err| err.to_string())
}

fn exec_code_search(
    tool_call: &Value,
    workspace: &workspace::WorkspaceManager,
) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let query = required_string(args, "query")?;
    let folder_id = string_field(args, "folderId");
    Ok(code_search(
        json!({ "query": query, "folderId": folder_id }),
        workspace,
    ))
}

fn exec_shell_propose(tool_call: &Value) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let command = required_string(args, "command")?;
    Ok(json!({
        "command": command,
        "reason": string_field(args, "reason"),
        "dryRun": true,
        "executed": false
    }))
}

fn exec_shell_exec(tool_call: &Value) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let command = required_string(args, "command")?;
    let cwd = string_field(args, "cwd").unwrap_or_else(default_cwd);
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(8000)
        .clamp(1000, 120_000);
    execute_agent_shell_command(&command, &cwd, timeout_ms)
}

fn standard_shell_command(command: &str) -> String {
    format!(
        "export LANG=\"${{LANG:-C.UTF-8}}\"; export LC_ALL=\"${{LC_ALL:-C.UTF-8}}\"; export PYTHONIOENCODING=\"utf-8\"\n{}",
        command
    )
}

fn execute_agent_shell_command(command: &str, cwd: &str, timeout_ms: u64) -> Result<Value, String> {
    let temp_session_id = format!("agent-shell-{}", Utc::now().timestamp_millis());
    let started = Instant::now();
    let normalized_command = standard_shell_command(command);
    let mut cmd = if cfg!(target_os = "windows") {
        let mut command_builder = Command::new("wsl.exe");
        command_builder.args(["--", "bash", "-lc", normalized_command.as_str()]);
        command_builder
    } else {
        let mut command_builder = Command::new("bash");
        command_builder.args(["-lc", normalized_command.as_str()]);
        command_builder.current_dir(cwd);
        command_builder
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_subprocess_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|err| {
        if cfg!(target_os = "windows") && err.kind() == std::io::ErrorKind::NotFound {
            "wsl_missing: Windows Agent shell execution requires WSL. Install WSL and configure Docker before running Agent shell tools.".to_string()
        } else {
            format!("shell spawn failed: {err}")
        }
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || read_pipe(stdout));
    let stderr_handle = std::thread::spawn(move || read_pipe(stderr));

    let mut timed_out = false;
    let exit_code = loop {
        if let Some(status) = child.try_wait().map_err(|err| err.to_string())? {
            break status.code().unwrap_or(-1);
        }
        if started.elapsed() > Duration::from_millis(timeout_ms) {
            timed_out = true;
            let _ = child.kill();
            let status = child.wait().map_err(|err| err.to_string())?;
            break status.code().unwrap_or(-1);
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();
    let (stdout, out_truncated) = truncate_text(stdout);
    let (stderr, err_truncated) = truncate_text(stderr);
    Ok(json!({
        "command": command,
        "cwd": cwd,
        "executed": true,
        "exitCode": exit_code,
        "stdout": stdout,
        "stderr": if timed_out && stderr.is_empty() { "agent shell command timed out".to_string() } else { stderr },
        "durationMs": started.elapsed().as_millis() as u64,
        "truncated": out_truncated || err_truncated,
        "tempSessionId": temp_session_id,
        "cleanupStatus": if timed_out { "terminated" } else { "alreadyExited" }
    }))
}

fn read_pipe(pipe: Option<impl Read>) -> String {
    let mut output = String::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_string(&mut output);
    }
    output
}

fn search_workspace(
    workspace: &workspace::WorkspaceManager,
    folder_id: Option<&str>,
    query: &str,
) -> Result<Vec<Value>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let folder = workspace.resolve_folder(folder_id)?;
    let root = PathBuf::from(&folder.absolute_path);
    let mut matches = Vec::new();
    let mut visited = 0usize;
    search_dir(&root, &root, &folder.id, query, &mut visited, &mut matches)?;
    Ok(matches)
}

fn search_dir(
    root: &Path,
    dir: &Path,
    folder_id: &str,
    query: &str,
    visited: &mut usize,
    matches: &mut Vec<Value>,
) -> Result<(), String> {
    if *visited >= SEARCH_MAX_FILES || matches.len() >= SEARCH_MAX_MATCHES {
        return Ok(());
    }
    let entries = stdfs::read_dir(dir).map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || excluded_dir(&name) {
            continue;
        }
        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        if metadata.is_dir() {
            search_dir(root, &path, folder_id, query, visited, matches)?;
        } else if metadata.is_file() {
            *visited += 1;
            if metadata.len() > 1024 * 1024 {
                continue;
            }
            if let Ok(content) = stdfs::read_to_string(&path) {
                for (index, line) in content.lines().enumerate() {
                    if let Some(column) = line.to_lowercase().find(&query.to_lowercase()) {
                        let rel = path
                            .strip_prefix(root)
                            .unwrap_or(path.as_path())
                            .to_string_lossy()
                            .replace('\\', "/");
                        matches.push(json!({
                            "folderId": folder_id,
                            "path": rel,
                            "line": index + 1,
                            "column": column + 1,
                            "preview": line.trim()
                        }));
                        if matches.len() >= SEARCH_MAX_MATCHES {
                            return Ok(());
                        }
                    }
                }
            }
        }
        if *visited >= SEARCH_MAX_FILES || matches.len() >= SEARCH_MAX_MATCHES {
            break;
        }
    }
    Ok(())
}

fn parse_agent_actions(content: &str) -> Vec<Value> {
    let mut actions = Vec::new();
    let mut in_block = false;
    let mut block = String::new();
    for line in content.lines() {
        if !in_block && line.trim_start().starts_with("```deepcode-action") {
            in_block = true;
            block.clear();
            continue;
        }
        if in_block && line.trim_start().starts_with("```") {
            in_block = false;
            if let Ok(value) = serde_json::from_str::<Value>(&block) {
                actions.push(normalize_action(value, "jsonBlock"));
            }
            continue;
        }
        if in_block {
            block.push_str(line);
            block.push('\n');
        }
    }
    actions
}

fn normalize_action(raw: Value, source: &str) -> Value {
    let action_type = string_field(&raw, "action")
        .or_else(|| string_field(&raw, "type"))
        .or_else(|| string_field(&raw, "tool"))
        .unwrap_or_else(|| "final".into());
    let payload = raw
        .get("input")
        .or_else(|| raw.get("arguments"))
        .or_else(|| raw.get("payload"))
        .cloned()
        .unwrap_or_else(|| {
            if action_type == "final" {
                json!({ "content": string_field(&raw, "result").or_else(|| string_field(&raw, "content")).unwrap_or_default() })
            } else {
                raw.clone()
            }
        });
    json!({
        "id": format!("action-{}", Utc::now().timestamp_micros()),
        "sourceMessageId": "tauri-message",
        "type": action_type,
        "payload": payload,
        "parseSource": source,
        "status": "parsed"
    })
}

fn resolve_workflow_config(request: &Value, session: &Value) -> Result<Value, String> {
    if let Some(config) = request.get("workflowConfig") {
        let config = normalize_workflow_config(Some(config));
        if has_configured_stage(&config) {
            return Ok(config);
        }
    }
    let stored = read_workflow_config();
    if has_configured_stage(&stored) {
        return Ok(stored);
    }
    let fallback =
        string_field(request, "profileId").or_else(|| string_field(session, "profileId"));
    let mut config = empty_workflow_config();
    if let Some(profile_id) = fallback {
        config["complete"] = json!({ "profileId": profile_id });
    }
    Ok(config)
}

fn read_workflow_config() -> Value {
    stdfs::read_to_string(workflow_config_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|value| normalize_workflow_config(Some(&value)))
        .unwrap_or_else(empty_workflow_config)
}

fn normalize_workflow_config(raw: Option<&Value>) -> Value {
    let mut out = empty_workflow_config();
    let source = raw.and_then(Value::as_object);
    for stage in STAGES {
        let profile_id = source
            .and_then(|map| map.get(stage))
            .and_then(|value| value.get("profileId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(profile_id) = profile_id {
            out[stage] = json!({ "profileId": profile_id });
        }
    }
    out
}

fn empty_workflow_config() -> Value {
    json!({
        "plan": {},
        "check": {},
        "complete": {},
        "review": {}
    })
}

fn has_configured_stage(config: &Value) -> bool {
    STAGES.iter().any(|stage| {
        config
            .get(stage)
            .and_then(|value| value.get("profileId"))
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

fn build_prompt_text(attachments: &[Value], workspace: &workspace::WorkspaceManager) -> String {
    let mut parts = vec![
        "You are DeepCode Agent, a local coding assistant controlled by explicit permissions."
            .to_string(),
        "Use deepcode-action JSON blocks or provider tool calls for local operations.".to_string(),
    ];
    for attachment in attachments {
        let kind = string_field(attachment, "kind").unwrap_or_default();
        let path = string_field(attachment, "path").unwrap_or_default();
        let folder_id = string_field(attachment, "folderId");
        if path.is_empty() {
            continue;
        }
        if kind == "file" {
            if let Ok(folder) = workspace.resolve_folder(folder_id.as_deref()) {
                if let Ok(file) = fs::read_text_file(&folder.absolute_path, &folder.id, &path) {
                    parts.push(format!(
                        "Attached file: {path}\n{}",
                        take_chars(&file.content, 12_000)
                    ));
                }
            }
        } else if kind == "directory" {
            parts.push(format!(
                "Attached directory: {path}. Use fs.list/fs.read for details."
            ));
        } else if kind == "panelSnapshot" {
            parts.push(format!("Attached panel snapshot: {path}"));
        }
    }
    parts.join("\n\n")
}

fn stage_prompt(stage: &str) -> &'static str {
    match stage {
        "plan" => "You are the planning stage. Create a concise plan and classify whether this is directExecution or needsUserConfirmation. Do not request local writes or shell execution. Prefer <plan> for the plan and <say> for short progress notes. If the request only needs a direct answer, use <final>.",
        "check" => "You are the checking stage. Review plan, context, risks, and likely tool usage. Do not request local writes or shell execution. Use <observe> for the check result.",
        "complete" => "You are the completion stage. Use deepcode-action JSON blocks or tool calls when local operations are needed. Before tool actions, use <say> to tell the user what you are about to inspect or run. After observations, use <observe> to explain the result. Use <final> only for the final answer. When the user asks to render or return Markdown, tables, formulas, or diagrams, return the actual Markdown content, not a description of what would be returned. All local operations are subject to the permission gate.",
        "review" => "You are the review stage. Produce the final user-facing answer for the conversation. Keep it direct and avoid internal audit sections unless the user asked for a review. If the user requested Markdown, tables, formulas, or diagrams, include the actual renderable Markdown in the final answer. Use <final> for the final answer. Do not perform new local operations.",
        _ => "You are DeepCode Agent.",
    }
}

fn permission_request(
    tool_call: &Value,
    risk_level: &str,
    summary: &str,
    diff: Option<String>,
) -> Value {
    let mut map = Map::new();
    map.insert(
        "id".into(),
        Value::String(format!("perm-{}", Utc::now().timestamp_micros())),
    );
    map.insert(
        "toolName".into(),
        Value::String(string_field(tool_call, "name").unwrap_or_else(|| "tool".into())),
    );
    map.insert("riskLevel".into(), Value::String(risk_level.to_string()));
    map.insert("summary".into(), Value::String(summary.to_string()));
    map.insert(
        "argumentsPreview".into(),
        tool_call.get("arguments").cloned().unwrap_or(Value::Null),
    );
    if let Some(diff) = diff {
        map.insert("diff".into(), Value::String(diff));
    }
    Value::Object(map)
}

fn settings_policy_deny_reason(tool_call: &Value) -> Option<String> {
    let name = string_field(tool_call, "name")?;
    match name.as_str() {
        "fs.read" | "fs.list" | "fs.diff"
            if !bool_setting("agent.permissions.allowFileRead", true) =>
        {
            Some("Agent file read tools are disabled in Settings.".into())
        }
        "fs.write" if !bool_setting("agent.permissions.allowFileWrite", true) => {
            Some("Agent file write tools are disabled in Settings.".into())
        }
        "code.search" if !bool_setting("agent.permissions.allowCodeSearch", true) => {
            Some("Agent code search is disabled in Settings.".into())
        }
        "shell.propose" if !bool_setting("agent.permissions.allowShellPropose", true) => {
            Some("Agent shell command proposals are disabled in Settings.".into())
        }
        "shell.exec" if !bool_setting("agent.permissions.allowShellExec", true) => {
            Some("Agent shell execution requests are disabled in Settings.".into())
        }
        _ => None,
    }
}

fn bool_setting(key: &str, fallback: bool) -> bool {
    user_settings::get_user_settings()
        .settings
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn command_blacklist() -> Vec<String> {
    user_settings::get_user_settings()
        .settings
        .get("agent.shell.commandBlacklist")
        .and_then(Value::as_str)
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase())
        .collect()
}

fn diff_preview_for_tool(
    tool_call: &Value,
    workspace: &workspace::WorkspaceManager,
) -> Result<String, String> {
    let args = args_object(tool_call)?;
    let path = required_string(args, "path")?;
    let new_content = required_string(args, "content")?;
    let old_content = read_file_content_for_diff(args, workspace).unwrap_or_default();
    Ok(diff_preview(&path, &old_content, &new_content))
}

fn read_file_content_for_diff(
    args: &Value,
    workspace: &workspace::WorkspaceManager,
) -> Result<String, String> {
    let path = required_string(args, "path")?;
    let folder_id = string_field(args, "folderId");
    let folder = workspace.resolve_folder(folder_id.as_deref())?;
    Ok(fs::read_text_file(&folder.absolute_path, &folder.id, &path)?.content)
}

fn diff_preview(path: &str, old_text: &str, new_text: &str) -> String {
    if old_text == new_text {
        return format!("--- {path}\n+++ {path}\n(no changes)");
    }
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();
    let max = old_lines.len().max(new_lines.len());
    let mut out = vec![format!("--- {path}"), format!("+++ {path}")];
    let mut emitted = 0usize;
    for index in 0..max {
        let before = old_lines.get(index).copied().unwrap_or("");
        let after = new_lines.get(index).copied().unwrap_or("");
        if before == after {
            continue;
        }
        out.push(format!("@@ line {} @@", index + 1));
        if index < old_lines.len() {
            out.push(format!("-{before}"));
        }
        if index < new_lines.len() {
            out.push(format!("+{after}"));
        }
        emitted += 1;
        if emitted >= 80 {
            out.push("... diff truncated after 80 changed lines ...".into());
            break;
        }
    }
    out.join("\n")
}

fn tool_success(tool_call: &Value, output: Value) -> Value {
    json!({
        "callId": tool_call.get("id").cloned().unwrap_or_else(|| json!("tool-call")),
        "ok": true,
        "status": "ok",
        "output": output
    })
}

fn tool_failure(tool_call: &Value, error: String) -> Value {
    let message = if error.starts_with("no_workspace:") {
        "当前没有打开工作区。请先在 Explorer 中打开一个文件夹或 .code-workspace 文件，然后再读取、搜索或修改文件。".to_string()
    } else {
        error
    };
    json!({
        "callId": tool_call.get("id").cloned().unwrap_or_else(|| json!("tool-call")),
        "ok": false,
        "status": "error",
        "error": message
    })
}

fn with_tool_name(mut result: Value, tool_call: &Value) -> Value {
    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "toolName".into(),
            tool_call
                .get("name")
                .cloned()
                .unwrap_or_else(|| json!("tool")),
        );
        if !obj.contains_key("status") {
            let status = if obj.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                "ok"
            } else {
                "error"
            };
            obj.insert("status".into(), json!(status));
        }
    }
    result
}

fn args_object(tool_call: &Value) -> Result<&Value, String> {
    tool_call
        .get("arguments")
        .filter(|value| value.is_object())
        .ok_or_else(|| "Tool arguments must be an object.".to_string())
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    string_field(args, key).ok_or_else(|| format!("Missing string argument: {key}"))
}

fn resolve_child_path(root: &str, relative: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root);
    let full = root.join(relative);
    let root_canon = root.canonicalize().unwrap_or(root);
    let full_canon = full.canonicalize().unwrap_or(full);
    if !full_canon.starts_with(&root_canon) {
        return Err("path escapes workspace root".into());
    }
    Ok(full_canon)
}

fn excluded_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | "dist" | "build" | "target" | ".cache" | ".vite" | ".next"
    )
}

fn workflow_config_path() -> PathBuf {
    config_root()
        .join("user")
        .join(user_id())
        .join("agent")
        .join("workflow-config.json")
}

fn config_root() -> PathBuf {
    if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").ok().unwrap_or_else(|| {
            let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
            format!("{}/AppData/Roaming", home)
        });
        PathBuf::from(appdata).join("DeepCode").join("config")
    } else {
        let base = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
                PathBuf::from(home).join(".config")
            });
        base.join("deepcode").join("config")
    }
}

fn user_id() -> String {
    std::env::var("DEEPCODE_USER_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "local".into())
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn write_json_atomic(path: PathBuf, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid_store_path".to_string())?;
    stdfs::create_dir_all(parent).map_err(|err| format!("create store directory failed: {err}"))?;
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let raw = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    stdfs::write(&tmp, raw).map_err(|err| format!("write temp file failed: {err}"))?;
    stdfs::rename(&tmp, &path).map_err(|err| format!("rename temp file failed: {err}"))?;
    Ok(())
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn event_payload(event: &Value) -> &Value {
    event.get("payload").unwrap_or(&Value::Null)
}

fn event_kind(event: &Value) -> String {
    string_field(event, "kind").unwrap_or_else(|| "error".into())
}

fn event_id(event: &Value) -> String {
    string_field(event, "id").unwrap_or_else(|| format!("evt-{}", Utc::now().timestamp_micros()))
}

fn event_ts(event: &Value) -> String {
    string_field(event, "ts").unwrap_or_else(now_iso)
}

fn event_phase(event: &Value) -> Option<String> {
    let payload = event_payload(event);
    string_field(payload, "stage").or_else(|| string_field(payload, "phase"))
}

fn event_tool_name(event: &Value) -> Option<String> {
    let payload = event_payload(event);
    string_field(payload, "toolName")
        .or_else(|| string_field(payload, "name"))
        .or_else(|| {
            payload
                .get("toolCall")
                .and_then(|tool_call| string_field(tool_call, "name"))
        })
}

fn event_call_id(event: &Value) -> Option<String> {
    let payload = event_payload(event);
    string_field(payload, "callId").or_else(|| string_field(payload, "id"))
}

fn event_turn_id(event: &Value) -> Option<String> {
    string_field(event_payload(event), "turnId")
}

fn event_command(event: &Value) -> Option<String> {
    let payload = event_payload(event);
    payload
        .get("arguments")
        .and_then(|value| string_field(value, "command"))
        .or_else(|| {
            payload
                .get("input")
                .and_then(|value| string_field(value, "command"))
        })
        .or_else(|| {
            payload
                .get("output")
                .and_then(|value| string_field(value, "command"))
        })
        .or_else(|| string_field(payload, "command"))
}

fn event_summary(event: &Value) -> String {
    let kind = event_kind(event);
    let payload = event_payload(event);
    match kind.as_str() {
        "user_msg" => {
            string_field(payload, "content").unwrap_or_else(|| "User message received.".into())
        }
        "assistant_msg" => string_field(payload, "content")
            .unwrap_or_else(|| "Assistant response produced.".into()),
        "workflow_stage" => {
            let stage = string_field(payload, "stage").unwrap_or_else(|| "workflow".into());
            let status = string_field(payload, "status").unwrap_or_else(|| "updated".into());
            string_field(payload, "summary").unwrap_or_else(|| format!("{stage} {status}"))
        }
        "tool_call" => {
            if let Some(command) = event_command(event) {
                format!(
                    "{}: {command}",
                    event_tool_name(event).unwrap_or_else(|| "tool".into())
                )
            } else {
                format!(
                    "{} requested.",
                    event_tool_name(event).unwrap_or_else(|| "tool".into())
                )
            }
        }
        "tool_result" => string_field(payload, "error").unwrap_or_else(|| {
            let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
            format!(
                "{} {}.",
                event_tool_name(event).unwrap_or_else(|| "tool".into()),
                if ok { "completed" } else { "failed" }
            )
        }),
        "permission_request" => string_field(payload, "summary").unwrap_or_else(|| {
            format!(
                "{} requires permission.",
                event_tool_name(event).unwrap_or_else(|| "tool".into())
            )
        }),
        "permission_result" => {
            format!(
                "{} {}.",
                event_tool_name(event).unwrap_or_else(|| "permission".into()),
                string_field(payload, "status").unwrap_or_else(|| "resolved".into())
            )
        }
        "error" => string_field(payload, "message").unwrap_or_else(|| "Agent error.".into()),
        _ => kind,
    }
}

fn trace_kind_for_event(event: &Value) -> &'static str {
    let kind = event_kind(event);
    let payload = event_payload(event);
    match kind.as_str() {
        "user_msg" => "turn.started",
        "assistant_msg" => {
            if string_field(payload, "channel").as_deref() == Some("final") {
                "llm.completed"
            } else {
                "llm.response"
            }
        }
        "workflow_stage" => match string_field(payload, "status").as_deref() {
            Some("started") => "stage.started",
            Some("error") => "stage.failed",
            _ => "stage.completed",
        },
        "tool_call" => "tool.requested",
        "tool_result" => {
            let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
            let status = string_field(payload, "status").unwrap_or_default();
            if !ok || status == "error" || status == "blocked" {
                "tool.failed"
            } else {
                "tool.completed"
            }
        }
        "permission_request" => "permission.requested",
        "permission_result" => "permission.resolved",
        _ => "error",
    }
}

fn trace_from_agent_event(event: &Value, turn_id: &str) -> Value {
    let event_id = event_id(event);
    let ts = event_ts(event);
    let trace_kind = trace_kind_for_event(event);
    let failed = trace_kind.ends_with("failed") || event_kind(event) == "error";
    let mut value = json!({
        "id": format!("trace-{event_id}"),
        "eventId": event_id,
        "sessionId": string_field(event, "sessionId").unwrap_or_default(),
        "turnId": turn_id,
        "ts": ts,
        "timestamp": ts,
        "kind": trace_kind,
        "source": if event_kind(event) == "user_msg" { "user" } else { "agent" },
        "level": if failed { "error" } else { "info" },
        "summary": event_summary(event),
        "payload": event_payload(event).clone()
    });
    if let Some(phase) = event_phase(event) {
        value["phase"] = Value::String(phase);
    }
    if let Some(tool_call_id) = event_call_id(event) {
        value["toolCallId"] = Value::String(tool_call_id);
    }
    value
}

fn turn_completed_trace(session_id: &str, turn_id: &str) -> Value {
    let ts = now_iso();
    json!({
        "id": format!("trace-{turn_id}-completed"),
        "eventId": turn_id,
        "sessionId": session_id,
        "turnId": turn_id,
        "ts": ts,
        "timestamp": ts,
        "kind": "turn.completed",
        "source": "agent",
        "level": "info",
        "summary": "Agent turn completed."
    })
}

fn llm_trace_for_workflow_stage(event: &Value, turn_id: &str) -> Option<Value> {
    if event_kind(event) != "workflow_stage" {
        return None;
    }
    let payload = event_payload(event);
    let status = string_field(payload, "status")?;
    if status != "started" && status != "completed" {
        return None;
    }
    let mut base = trace_from_agent_event(event, turn_id);
    let requested = status == "started";
    let id = base
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("trace-workflow")
        .to_string();
    base["id"] = Value::String(format!(
        "{}-{}",
        id,
        if requested {
            "llm-requested"
        } else {
            "llm-completed"
        }
    ));
    base["kind"] = Value::String(
        if requested {
            "llm.requested"
        } else {
            "llm.completed"
        }
        .into(),
    );
    let stage = string_field(payload, "stage").unwrap_or_else(|| "workflow".into());
    base["summary"] = Value::String(if requested {
        format!("{stage} LLM request started.")
    } else {
        format!("{stage} LLM response completed.")
    });
    Some(base)
}

fn agent_events_to_trace(session_id: &str, events: &[Value]) -> Vec<Value> {
    if events.is_empty() {
        return Vec::new();
    }
    let mut turn_id = events
        .iter()
        .rev()
        .find_map(event_turn_id)
        .or_else(|| {
            events
                .iter()
                .rev()
                .find(|event| event_kind(event) == "user_msg")
                .map(event_id)
        })
        .unwrap_or_else(|| event_id(&events[0]));
    let mut saw_turn_start = false;
    let mut saw_terminal_output = false;
    let mut saw_final = false;
    let mut trace_events = Vec::new();
    for event in events {
        if event_kind(event) == "user_msg" {
            turn_id = event_id(event);
            saw_turn_start = true;
        } else if let Some(payload_turn_id) = event_turn_id(event) {
            turn_id = payload_turn_id;
        }
        if event_kind(event) == "assistant_msg"
            && string_field(event_payload(event), "channel").as_deref() == Some("final")
        {
            saw_final = true;
        }
        if event_kind(event) == "tool_result" {
            let payload = event_payload(event);
            let output = payload.get("output").unwrap_or(&Value::Null);
            if output.get("stdout").is_some() || output.get("stderr").is_some() {
                let mut shell_trace = trace_from_agent_event(event, &turn_id);
                shell_trace["id"] =
                    Value::String(format!("trace-{}-shell-output", event_id(event)));
                shell_trace["kind"] = Value::String("shell.output".into());
                shell_trace["summary"] = Value::String(event_summary(event));
                trace_events.push(shell_trace);
                saw_terminal_output = true;
            }
        }
        trace_events.push(trace_from_agent_event(event, &turn_id));
        if let Some(llm_trace) = llm_trace_for_workflow_stage(event, &turn_id) {
            trace_events.push(llm_trace);
        }
    }
    if saw_turn_start || saw_terminal_output || saw_final {
        trace_events.push(turn_completed_trace(session_id, &turn_id));
    }
    trace_events
}

fn new_event(session_id: &str, kind: &str, payload: Value) -> Value {
    json!({
        "id": format!("evt-{}-{}", Utc::now().timestamp_micros(), kind),
        "sessionId": session_id,
        "ts": now_iso(),
        "kind": kind,
        "payload": payload
    })
}

fn merge_context(context: &Value, extra: Value) -> Value {
    let mut out = context.clone();
    if let (Some(out_obj), Some(extra_obj)) = (out.as_object_mut(), extra.as_object()) {
        for (key, value) in extra_obj {
            out_obj.insert(key.clone(), value.clone());
        }
    }
    out
}

fn with_context(payload: Value, context: &Value, extra: Value) -> Value {
    let mut out = match payload {
        Value::Object(map) => Value::Object(map),
        Value::Null => json!({}),
        other => json!({ "value": other }),
    };
    if let Some(out_obj) = out.as_object_mut() {
        if let Some(context_obj) = context.as_object() {
            for (key, value) in context_obj {
                out_obj.insert(key.clone(), value.clone());
            }
        }
        if let Some(extra_obj) = extra.as_object() {
            for (key, value) in extra_obj {
                out_obj.insert(key.clone(), value.clone());
            }
        }
    }
    out
}

fn decorate_event(mut event: Value, turn_id: &str, sequence: &mut u64) -> Value {
    *sequence += 1;
    if let Some(obj) = event.as_object_mut() {
        let payload = obj.remove("payload").unwrap_or(Value::Null);
        obj.insert(
            "payload".into(),
            with_context(
                payload,
                &json!({ "turnId": turn_id, "sequence": *sequence }),
                json!({}),
            ),
        );
    }
    event
}

fn output_envelope_prompt() -> &'static str {
    "Format user-visible Agent output as ordered logical sections when useful:\n\
<reasoning>brief visible reasoning or provider-independent planning notes</reasoning>\n\
<say>short progress message for the user</say>\n\
<plan>task steps or execution strategy</plan>\n\
<observe>judgement based on tool observations</observe>\n\
<final>final answer to the user</final>\n\
Use only the sections that match the current stage. Local operations must still be expressed as provider tool calls or ```deepcode-action JSON blocks. Do not put deepcode-action JSON inside <final>."
}

fn segment_channel(kind: &str) -> &'static str {
    match kind {
        "reasoning" => "reasoning",
        "observe" => "observation",
        "final" => "final",
        _ => "progress",
    }
}

fn segment_label(kind: &str) -> &'static str {
    match kind {
        "reasoning" => "思考中",
        "observe" => "检查结果",
        "final" => "最终回复",
        "plan" => "执行计划",
        _ => "Agent",
    }
}

fn fallback_segment_kind(stage: &str) -> &'static str {
    match stage {
        "review" => "final",
        "check" => "observe",
        "plan" => "plan",
        _ => "say",
    }
}

fn assistant_segment_event(session_id: &str, context: &Value, kind: &str, content: &str) -> Value {
    new_event(
        session_id,
        "assistant_msg",
        with_context(
            json!({
                "content": content,
                "label": segment_label(kind)
            }),
            context,
            json!({
                "channel": segment_channel(kind),
                "visibility": if kind == "reasoning" { "trace" } else { "conversation" }
            }),
        ),
    )
}

fn strip_deepcode_action_blocks(content: &str) -> String {
    let mut out = Vec::new();
    let mut in_block = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if !in_block && trimmed.starts_with("```deepcode-action") {
            in_block = true;
            continue;
        }
        if in_block && trimmed.starts_with("```") {
            in_block = false;
            continue;
        }
        if !in_block {
            out.push(line);
        }
    }
    out.join("\n").trim().to_string()
}

fn parse_tagged_segments(content: &str, fallback_kind: &str) -> Vec<(String, String)> {
    let tags = ["reasoning", "think", "say", "plan", "observe", "final"];
    let mut matches: Vec<(usize, usize, String, String)> = Vec::new();
    for tag in tags {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let mut offset = 0usize;
        while let Some(start_rel) = content[offset..].find(&open) {
            let start = offset + start_rel;
            let inner_start = start + open.len();
            let Some(end_rel) = content[inner_start..].find(&close) else {
                break;
            };
            let end = inner_start + end_rel;
            let after = end + close.len();
            let kind = if tag == "think" { "reasoning" } else { tag }.to_string();
            let text = strip_deepcode_action_blocks(content[inner_start..end].trim());
            if !text.is_empty() {
                matches.push((start, after, kind, text));
            }
            offset = after;
        }
    }
    matches.sort_by_key(|item| item.0);

    let mut remainder = content.to_string();
    for (start, end, _, _) in matches.iter().rev() {
        remainder.replace_range(*start..*end, "\n");
    }
    let mut segments: Vec<(String, String)> = matches
        .into_iter()
        .map(|(_, _, kind, text)| (kind, text))
        .collect();
    let clean = strip_deepcode_action_blocks(&remainder);
    if !clean.is_empty() {
        segments.push((fallback_kind.to_string(), clean));
    }
    segments
}

fn action_to_tool_call(action: &Value) -> Value {
    json!({
        "id": action.get("id").cloned().unwrap_or_else(|| json!("action")),
        "name": string_field(action, "type").unwrap_or_default(),
        "arguments": action.get("payload").cloned().unwrap_or_else(|| json!({}))
    })
}

fn tool_batch_label(tool_calls: &[Value]) -> String {
    if tool_calls.is_empty() {
        return "执行工具".into();
    }
    let names: Vec<String> = tool_calls
        .iter()
        .filter_map(|call| string_field(call, "name"))
        .collect();
    if names
        .iter()
        .all(|name| name == "fs.read" || name == "fs.list")
    {
        return "读取文件中".into();
    }
    if names.iter().all(|name| name == "code.search") {
        return "检索代码中".into();
    }
    if names.iter().all(|name| name.starts_with("shell.")) {
        return "执行命令".into();
    }
    "执行工具".into()
}

fn preview_value(value: &Value, limit: usize) -> String {
    let text = if let Some(text) = value.as_str() {
        text.to_string()
    } else {
        serde_json::to_string(value).unwrap_or_default()
    };
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() > limit {
        format!(
            "{}…",
            normalized
                .chars()
                .take(limit.saturating_sub(1))
                .collect::<String>()
        )
    } else {
        normalized
    }
}

fn tool_observation_summary(event: &Value) -> Option<String> {
    let payload = event_payload(event);
    match event_kind(event).as_str() {
        "tool_call" => {
            let tool_call = payload.get("toolCall").unwrap_or(payload);
            Some(format!(
                "- Tool requested: {} {}",
                string_field(tool_call, "name").unwrap_or_else(|| "tool".into()),
                preview_value(tool_call.get("arguments").unwrap_or(&Value::Null), 420)
            ))
        }
        "tool_result" => {
            let status = if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                "ok".to_string()
            } else {
                string_field(payload, "status").unwrap_or_else(|| "error".into())
            };
            let output = payload
                .get("output")
                .or_else(|| payload.get("error"))
                .or_else(|| payload.get("summary"))
                .unwrap_or(&Value::Null);
            Some(format!(
                "- Tool result: {} status={} {}",
                string_field(payload, "toolName").unwrap_or_else(|| "tool".into()),
                status,
                preview_value(output, 720)
            ))
        }
        "permission_request" => Some(format!(
            "- Permission requested: {} {}",
            string_field(payload, "toolName").unwrap_or_else(|| "tool".into()),
            preview_value(payload.get("summary").unwrap_or(payload), 520)
        )),
        "permission_result" => Some(format!(
            "- Permission result: {}",
            preview_value(payload, 420)
        )),
        "error" => Some(format!("- Runtime error: {}", preview_value(payload, 520))),
        _ => None,
    }
}

fn append_observation_context(stage_outputs: &mut Vec<String>, stage: &str, events: &[Value]) {
    let summaries: Vec<String> = events.iter().filter_map(tool_observation_summary).collect();
    if !summaries.is_empty() {
        stage_outputs.push(format!("[{stage} observations]\n{}", summaries.join("\n")));
    }
}

fn take_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn truncate_text(value: String) -> (String, bool) {
    if value.len() <= SHELL_OUTPUT_LIMIT {
        (value, false)
    } else {
        (value.chars().take(SHELL_OUTPUT_LIMIT).collect(), true)
    }
}

fn default_cwd() -> String {
    std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".into())
}

fn hide_subprocess_window(_command: &mut Command) {
    #[cfg(windows)]
    {
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}
