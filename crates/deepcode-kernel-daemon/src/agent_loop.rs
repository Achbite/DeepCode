#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;
use deepcode_kernel_abi::LlmProviderDiagnostic;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub(crate) struct AgentRunRequest {
    pub(crate) content: String,
    pub(crate) attachments: Vec<Value>,
    pub(crate) workflow_ref: Option<String>,
    pub(crate) profile_id: Option<String>,
    pub(crate) workspace_binding: Option<WorkspaceBinding>,
}

pub(crate) fn build_agent_run_request(body: &Value) -> AgentRunRequest {
    AgentRunRequest {
        content: body
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        attachments: body
            .get("attachments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        workflow_ref: body
            .get("workflow")
            .or_else(|| body.get("workflowRef"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "dynamic")
            .map(str::to_string),
        profile_id: body
            .get("profileId")
            .and_then(Value::as_str)
            .map(str::to_string),
        workspace_binding: body
            .get("workspaceBinding")
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
    }
}

const USER_ATTACHMENT_MAX_CONTEXT_CHARS: usize = 40_000;
const USER_ATTACHMENT_MAX_FILE_CHARS: usize = 12_000;
const USER_ATTACHMENT_MAX_DIR_ENTRIES: usize = 300;
const USER_ATTACHMENT_MAX_DIR_DEPTH: usize = 2;
const AGENT_PROTOCOL_SCHEMA_VERSION: &str = "deepcode.agent.protocol.v2";

pub(crate) fn user_input_with_selected_attachment_context(request: &AgentRunRequest) -> String {
    let context = build_explicit_attachment_context(&request.attachments, None);
    if context.trim().is_empty() {
        return request.content.clone();
    }
    format!(
        "{}\n\n## User-selected context\n{}",
        request.content.trim_end(),
        context
    )
}

pub(crate) fn user_input_with_explicit_attachment_context(
    request: &AgentRunRequest,
    workspace: Option<&Value>,
) -> String {
    let context = build_explicit_attachment_context(&request.attachments, workspace);
    if context.trim().is_empty() {
        return request.content.clone();
    }
    format!(
        "{}\n\n## User-selected context\n{}",
        request.content.trim_end(),
        context
    )
}

fn build_explicit_attachment_context(attachments: &[Value], workspace: Option<&Value>) -> String {
    let mut parts = Vec::new();
    let mut total_chars = 0_usize;
    let mut manifest_entries = Vec::new();
    for attachment in attachments {
        let source = attachment
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(source, "userSelected" | "contextMenu" | "mention") {
            continue;
        }
        let kind = attachment
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("file");
        let folder_id = attachment
            .get("folderId")
            .and_then(Value::as_str)
            .unwrap_or("wf-0");
        let relative_path = attachment
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let absolute_path = attachment
            .get("absolutePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                relative_path.and_then(|path| {
                    resolve_attachment_path_from_workspace(workspace, folder_id, path)
                })
            });
        let Some(path_buf) = absolute_path else {
            continue;
        };
        let display_path = relative_path
            .map(str::to_string)
            .unwrap_or_else(|| path_buf.to_string_lossy().to_string());
        let absolute_display = path_buf.to_string_lossy().to_string();
        manifest_entries.push(json!({
            "kind": kind,
            "source": source,
            "folderId": folder_id,
            "path": display_path,
            "absolutePath": absolute_display,
        }));
        let rendered = if kind == "directory" {
            render_user_selected_directory(&display_path, &path_buf)
        } else {
            render_user_selected_file(&display_path, &path_buf)
        };
        let remaining = USER_ATTACHMENT_MAX_CONTEXT_CHARS.saturating_sub(total_chars);
        if remaining == 0 {
            break;
        }
        let rendered = clip_chars(&rendered, remaining);
        total_chars += rendered.chars().count();
        parts.push(rendered);
    }
    if !manifest_entries.is_empty() {
        let manifest =
            serde_json::to_string_pretty(&manifest_entries).unwrap_or_else(|_| "[]".to_string());
        parts.insert(
            0,
            format!(
                "### ATTACHMENTS manifest\n```json\n{manifest}\n```\nUse these explicit user attachments before guessing references such as \"this file\"."
            ),
        );
    }
    parts.join("\n\n")
}

fn resolve_attachment_path_from_workspace(
    workspace: Option<&Value>,
    folder_id: &str,
    relative_path: &str,
) -> Option<PathBuf> {
    validate_workspace_path(relative_path, "attachment.path").ok()?;
    let workspace = workspace?.get("current")?;
    if workspace.is_null() {
        return None;
    }
    let folders = workspace.get("folders")?.as_array()?;
    let folder = folders
        .iter()
        .find(|folder| folder.get("id").and_then(Value::as_str) == Some(folder_id))
        .or_else(|| folders.first())?;
    let root = PathBuf::from(folder.get("absolutePath")?.as_str()?);
    let candidate = root.join(relative_path);
    let normalized = candidate.components().collect::<PathBuf>();
    if !normalized.starts_with(&root) {
        return None;
    }
    Some(normalized)
}

fn render_user_selected_file(display_path: &str, path_buf: &Path) -> String {
    if !path_buf.is_file() {
        return format!(
            "### file:{display_path}\nRead failed: the user-selected path is not a file."
        );
    }
    match std::fs::read_to_string(path_buf) {
        Ok(content) => {
            let clipped = clip_chars(&content, USER_ATTACHMENT_MAX_FILE_CHARS);
            format!("### file:{display_path}\n```text\n{clipped}\n```")
        }
        Err(error) => format!("### file:{display_path}\nRead failed: {error}"),
    }
}

fn render_user_selected_directory(display_path: &str, path_buf: &Path) -> String {
    if !path_buf.is_dir() {
        return format!(
            "### directory:{display_path}\nRead failed: the user-selected path is not a directory."
        );
    }
    let mut lines = Vec::new();
    collect_user_selected_directory_entries(path_buf, path_buf, 0, &mut lines);
    format!(
        "### directory:{display_path}\n```text\n{}\n```",
        lines.join("\n")
    )
}

fn collect_user_selected_directory_entries(
    root: &Path,
    current: &Path,
    depth: usize,
    lines: &mut Vec<String>,
) {
    if depth >= USER_ATTACHMENT_MAX_DIR_DEPTH || lines.len() >= USER_ATTACHMENT_MAX_DIR_ENTRIES {
        return;
    }
    let Ok(entries) = sorted_dir_entries(current) else {
        return;
    };
    for entry in entries {
        if lines.len() >= USER_ATTACHMENT_MAX_DIR_ENTRIES {
            break;
        }
        let path = entry.path();
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let kind = if path.is_dir() { "[dir]" } else { "[file]" };
        lines.push(format!(
            "{}- {} {}",
            "  ".repeat(depth),
            kind,
            relative.to_string_lossy()
        ));
        if path.is_dir() {
            collect_user_selected_directory_entries(root, &path, depth + 1, lines);
        }
    }
}

fn clip_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head_chars = max_chars.saturating_mul(65) / 100;
    let tail_chars = max_chars.saturating_mul(25) / 100;
    let head = text.chars().take(head_chars).collect::<String>();
    let tail = text
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{head}\n\n[... truncated ...]\n\n{tail}")
}

pub(crate) async fn start_kernel_agent_run(
    state: &AppState,
    session_id: &str,
    request: AgentRunRequest,
) -> Result<(), String> {
    let prefers_chinese = user_prompt_prefers_chinese(&request.content);
    let needs_workspace = request_mentions_local_workspace(&request.content);
    if needs_workspace {
        if let Err(error) =
            ensure_workspace_binding(&state.runtime, request.workspace_binding.as_ref())
        {
            let message = if prefers_chinese {
                format!(
                    "当前没有可用工作区绑定：{}。请先打开一个文件夹或 .code-workspace 文件，再让 Agent 读取、搜索或修改文件。",
                    error.message
                )
            } else {
                format!(
                    "No workspace binding is available: {}. Open a folder or .code-workspace file before asking the Agent to read, search, or modify files.",
                    error.message
                )
            };
            append_session_projection(
                state,
                session_id,
                vec![assistant_final_event(session_id, &message)],
            );
            return Ok(());
        }
    } else if let Some(binding) = request.workspace_binding.as_ref() {
        let _ = ensure_workspace_binding(&state.runtime, Some(binding));
    }

    let Some(binding) =
        effective_workspace_binding(&state.runtime, request.workspace_binding.clone())
    else {
        let message = if prefers_chinese {
            "当前没有可用工作区绑定。请先打开一个文件夹或 .code-workspace 文件，再让 Agent 读取、搜索或修改文件。"
        } else {
            "No workspace binding is available. Open a folder or .code-workspace file before asking the Agent to read, search, or modify files."
        };
        append_session_projection(
            state,
            session_id,
            vec![assistant_final_event(session_id, message)],
        );
        return Ok(());
    };
    let workspace_snapshot = current_workspace_json(&state.runtime).ok();
    let run_input_text =
        user_input_with_explicit_attachment_context(&request, workspace_snapshot.as_ref());

    let kernel_events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::RunStart {
                request_id: rid("agent-run-start"),
                session_id: Some(deepcode_kernel_abi::SessionId(session_id.to_string())),
                input: deepcode_kernel_abi::UserInput {
                    text: run_input_text,
                    attachments: request.attachments.clone(),
                },
                workspace_binding: Some(binding),
                profile_ref: request.profile_id.as_ref().map(|id| {
                    deepcode_kernel_abi::ProfileRef {
                        id: id.clone(),
                        kind: Some("llm".to_string()),
                        hash: None,
                    }
                }),
                workflow_ref: request.workflow_ref.as_ref().map(|workflow_ref| {
                    deepcode_kernel_abi::WorkflowRef {
                        id: workflow_ref.clone(),
                        version: None,
                        hash: None,
                    }
                }),
                run_overrides: None,
            })
            .map_err(|error| error.to_string())?
    };
    drive_kernel_agent_loop(state, session_id, kernel_events).await
}

pub(crate) async fn drive_kernel_agent_loop(
    state: &AppState,
    session_id: &str,
    mut kernel_events: Vec<KernelEvent>,
) -> Result<(), String> {
    loop {
        record_kernel_events(state, &kernel_events);
        append_session_projection(
            state,
            session_id,
            kernel_events_to_agent_events(session_id, &kernel_events),
        );
        if kernel_events
            .iter()
            .any(|event| matches!(event, KernelEvent::PermissionRequested { .. }))
        {
            return Ok(());
        }
        let llm_requests = kernel_events
            .iter()
            .filter_map(|event| match event {
                KernelEvent::LlmCallRequested {
                    run_id,
                    session_id,
                    phase,
                    llm_call_id,
                    profile_ref,
                    request_envelope,
                    ..
                } => Some((
                    run_id.clone(),
                    session_id.clone(),
                    phase.clone(),
                    llm_call_id.clone(),
                    profile_ref.clone(),
                    request_envelope.clone(),
                )),
                _ => None,
            })
            .collect::<Vec<_>>();
        if llm_requests.is_empty() {
            return Ok(());
        }

        let mut next_events = Vec::new();
        for (run_id, event_session_id, phase, llm_call_id, profile_ref, request_envelope) in
            llm_requests
        {
            let profile = resolve_kernel_llm_profile(state, profile_ref.as_ref())?;
            append_trace_event(
                state,
                session_id,
                "llm.requested",
                json!({
                    "stage": phase,
                    "llmCallId": llm_call_id,
                    "profileId": profile.id,
                    "model": profile.model,
                    "toolCount": request_envelope
                        .get("tools")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0)
                }),
            );
            let output = match call_llm_profile(&profile, request_envelope.clone()).await {
                Ok(output) => output,
                Err(error) => {
                    let provider_event = KernelEvent::LlmProviderError {
                        run_id: run_id.clone(),
                        session_id: event_session_id.clone().or_else(|| {
                            Some(deepcode_kernel_abi::SessionId(session_id.to_string()))
                        }),
                        phase: phase.clone(),
                        llm_call_id: llm_call_id.clone(),
                        diagnostic: error.clone(),
                        sequence: None,
                    };
                    record_kernel_events(state, &[provider_event.clone()]);
                    append_trace_event(
                        state,
                        session_id,
                        "llm.provider_error",
                        json!({
                            "runId": run_id.0.clone(),
                            "phase": phase.clone(),
                            "llmCallId": llm_call_id.clone(),
                            "profileId": profile.id.clone(),
                            "model": profile.model.clone(),
                            "providerError": provider_error_value(&error)
                        }),
                    );
                    append_session_projection(
                        state,
                        session_id,
                        kernel_events_to_agent_events(session_id, &[provider_event]),
                    );
                    continue;
                }
            };
            append_trace_event(
                state,
                session_id,
                "llm.completed",
                json!({
                    "stage": phase,
                    "llmCallId": llm_call_id,
                    "profileId": profile.id,
                    "contentBytes": output.content.len(),
                    "toolCallCount": output.tool_calls.len()
                }),
            );
            let response_envelope = llm_output_payload(output);
            let submitted = {
                let mut runtime = state.runtime.lock().expect("kernel runtime lock");
                runtime
                    .dispatch(KernelCommand::LlmResponseSubmit {
                        request_id: rid("llm-response-submit"),
                        run_id: run_id.clone(),
                        session_id: event_session_id,
                        llm_call_id,
                        response_envelope: response_envelope.clone(),
                    })
                    .map_err(|error| error.to_string())?
            };
            if phase == "plan" {
                let mut submitted = submitted;
                let original_content = response_envelope
                    .pointer("/assistantMessage/content")
                    .or_else(|| response_envelope.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let parsed_plan = parse_or_repair_agent_plan_response(
                    state,
                    session_id,
                    &run_id.0,
                    &profile,
                    &request_envelope,
                    original_content,
                )
                .await;
                match parsed_plan {
                    Ok(AgentPlanResponse::Answer(answer)) => {
                        append_session_projection(
                            state,
                            session_id,
                            vec![answer_event(session_id, &run_id.0, &answer)],
                        );
                    }
                    Ok(AgentPlanResponse::ResourceRequest(resource_request)) => {
                        append_session_projection(
                            state,
                            session_id,
                            vec![resource_request_event(
                                session_id,
                                &run_id.0,
                                &resource_request,
                            )],
                        );
                    }
                    Ok(AgentPlanResponse::ActionPlan(mut plan)) => {
                        append_session_projection(
                            state,
                            session_id,
                            vec![plan_card_event(session_id, &plan)],
                        );
                        let review_events = {
                            let mut runtime = state.runtime.lock().expect("kernel runtime lock");
                            runtime
                                .dispatch(KernelCommand::PlanContractSubmit {
                                    request_id: rid("agent-plan-review"),
                                    run_id: Some(run_id.clone()),
                                    session_id: Some(deepcode_kernel_abi::SessionId(
                                        session_id.to_string(),
                                    )),
                                    contract: plan.action_bundle.clone(),
                                })
                                .map_err(|error| error.to_string())?
                        };
                        plan.plan_review_report = review_events.iter().find_map(|event| {
                            if let KernelEvent::PlanReviewReportProduced { report, .. } = event {
                                Some(report.clone())
                            } else {
                                None
                            }
                        });
                        {
                            let mut gui = state.gui.lock().expect("gui state lock");
                            gui.pending_plans.insert(plan.plan_id.clone(), plan.clone());
                        }
                        submitted.extend(review_events);
                        if should_auto_accept_plan(state, &plan) {
                            let accept_events = {
                                let mut runtime =
                                    state.runtime.lock().expect("kernel runtime lock");
                                runtime
                                    .dispatch(KernelCommand::PlanAccept {
                                        request_id: rid("agent-plan-auto-accept"),
                                        run_id: run_id.clone(),
                                        plan_id: plan.plan_id.clone(),
                                    })
                                    .map_err(|error| error.to_string())?
                            };
                            submitted.extend(accept_events);
                        }
                    }
                    Err(error) => {
                        append_session_projection(
                            state,
                            session_id,
                            vec![plan_parse_error_event(session_id, &run_id.0, &error)],
                        );
                    }
                }
                next_events.extend(submitted);
                continue;
            }
            if phase == "review" {
                record_kernel_events(state, &submitted);
                append_session_projection(
                    state,
                    session_id,
                    kernel_events_to_agent_events(session_id, &submitted),
                );
                append_review_summary_from_response(
                    state,
                    session_id,
                    &run_id.0,
                    response_envelope
                        .pointer("/assistantMessage/content")
                        .or_else(|| response_envelope.get("content"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                continue;
            }
            next_events.extend(submitted);
        }
        kernel_events = next_events;
    }
}

pub(crate) async fn agent_tool_execute(
    State(state): State<AppState>,
    Json(body): Json<ToolExecuteRequest>,
) -> Json<ApiResponse> {
    if needs_workspace(&body.tool_call.name) {
        if let Err(error) =
            ensure_workspace_binding(&state.runtime, body.workspace_binding.as_ref())
        {
            return ApiResponse::ok(json!({
                "ok": false,
                "error": error.message,
                "code": error.code
            }));
        }
    }
    let session_id = {
        let mut gui = state.gui.lock().expect("gui state lock");
        body.workspace_binding
            .as_ref()
            .and_then(|binding| {
                let scope_key = scope_key_from_parts(
                    binding.workspace_id.as_deref(),
                    binding.workspace_hash.as_deref(),
                );
                current_agent_session_id_for_scope(&mut gui, &scope_key)
            })
            .or_else(|| gui.current_session_id.clone())
            .unwrap_or_else(|| "tool-session".to_string())
    };
    match invoke_kernel_tool(
        &state,
        &session_id,
        &body.workspace_binding,
        &body.tool_call,
    ) {
        Ok(events) => {
            let pending_permission = events.iter().find_map(|event| match event {
                KernelEvent::PermissionRequested { request, .. } => Some(request.clone()),
                _ => None,
            });
            let output = events.iter().find_map(|event| match event {
                KernelEvent::ToolCompleted { output, .. } => output.clone(),
                _ => None,
            });
            record_kernel_events(&state, &events);
            ApiResponse::ok(json!({
                "ok": pending_permission.is_none(),
                "output": output,
                "pendingPermission": pending_permission.is_some(),
                "permission": pending_permission,
                "events": events
            }))
        }
        Err(error) => ApiResponse::ok(json!({
            "ok": false,
            "error": error,
            "code": "kernel_tool_invoke_failed"
        })),
    }
}

pub(crate) fn append_trace_event(state: &AppState, session_id: &str, kind: &str, payload: Value) {
    let mut gui = state.gui.lock().expect("gui state lock");
    gui.trace_events
        .entry(session_id.to_string())
        .or_default()
        .push(json!({
            "id": format!("trace-{}", now_millis()),
            "sessionId": session_id,
            "ts": now_text(),
            "kind": kind,
            "source": "runtime",
            "level": if kind == "error" { "error" } else { "info" },
            "summary": payload.get("summary").and_then(Value::as_str).unwrap_or(kind),
            "payload": payload
        }));
}

async fn parse_or_repair_agent_plan_response(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    profile: &ResolvedLlmProfile,
    original_request_envelope: &Value,
    original_content: &str,
) -> Result<AgentPlanResponse, String> {
    match parse_agent_plan_response(session_id, run_id, original_content) {
        Ok(parsed) => return Ok(parsed),
        Err(first_error) => {
            append_trace_event(
                state,
                session_id,
                "llm.plan_parse_failed",
                json!({
                    "runId": run_id,
                    "error": first_error,
                    "repairPolicy": "single_llm_repair"
                }),
            );
            let repair_request = build_plan_repair_request(
                original_request_envelope,
                original_content,
                &first_error,
            );
            append_trace_event(
                state,
                session_id,
                "llm.repair_requested",
                json!({
                    "runId": run_id,
                    "profileId": profile.id,
                    "model": profile.model,
                    "reason": first_error
                }),
            );
            let repair_output = match call_llm_profile(profile, repair_request).await {
                Ok(output) => output,
                Err(error) => {
                    append_trace_event(
                        state,
                        session_id,
                        "llm.repair_failed",
                        json!({
                            "runId": run_id,
                            "providerError": provider_error_value(&error)
                        }),
                    );
                    return Err(format!("{first_error}; repair call failed: {error}"));
                }
            };
            let repair_content = repair_output.content.clone();
            append_trace_event(
                state,
                session_id,
                "llm.repair_completed",
                json!({
                    "runId": run_id,
                    "profileId": profile.id,
                    "contentBytes": repair_content.len(),
                    "toolCallCount": repair_output.tool_calls.len(),
                    "repairedResponse": llm_output_payload(repair_output)
                }),
            );
            parse_agent_plan_response(session_id, run_id, &repair_content).map_err(|repair_error| {
                append_trace_event(
                    state,
                    session_id,
                    "llm.repair_parse_failed",
                    json!({
                        "runId": run_id,
                        "originalError": first_error,
                        "repairError": repair_error
                    }),
                );
                format!("{first_error}; repair failed: {repair_error}")
            })
        }
    }
}

fn build_plan_repair_request(
    original_request_envelope: &Value,
    original_content: &str,
    parser_error: &str,
) -> Value {
    let tool_catalog = original_request_envelope
        .get("toolCatalog")
        .cloned()
        .unwrap_or_else(|| json!([]));
    json!({
        "messages": [
            {
                "role": "system",
                "content": "You are DeepCode plan protocol repair. Return only one valid JSON object using schemaVersion \"deepcode.agent.protocol.v2\". Keep strict fail-closed semantics: do not invent execution facts, do not add direct params/input/command/script/path/content fields inside actionBundle.actions or continuationExpectations, and do not combine resourceRequest with actionBundle. resourceRequest must be under the top-level key \"resourceRequest\"; never use a top-level \"request\" key. actionBundle.version must be string \"1\"; action.resourceScope must be a string array. Use capability namespace in actionBundle: workspace.read, workspace.search, workspace.write, workspace.delete, process.exec, network.egress, git.read, git.write, browser.control. Executor tool names such as fs.write/fs.delete/web.search/git.status/browser.open are only for complete-stage tool calls. File content drafts must be emitted as top-level codeBlocks, and write actions must reference sourceBlockId. If the user requested write then review then delete, current actions include only the write/review batch and the post-review delete intent goes in actionBundle.continuationExpectations."
            },
            {
                "role": "user",
                "content": format!(
                    "Parser error:\\n{}\\n\\nCanonical minimal JSON Envelope v2 resourceRequest example:\\n{{\"schemaVersion\":\"deepcode.agent.protocol.v2\",\"kind\":\"resourceRequest\",\"outputLanguage\":\"en-US\",\"resourceRequest\":{{\"version\":\"1\",\"id\":\"need-target\",\"reason\":\"Need a concrete target resource.\",\"items\":[{{\"id\":\"target-file\",\"manifestEntryId\":\"current-selection\",\"reason\":\"Resolve the user-selected file.\"}}]}}}}\\n\\nCanonical minimal JSON Envelope v2 write/review/continuation example:\\n{{\"schemaVersion\":\"deepcode.agent.protocol.v2\",\"kind\":\"actionBundle\",\"outputLanguage\":\"en-US\",\"userPlan\":\"Create test.md and wait for user review.\",\"codeBlocks\":[{{\"id\":\"write-test-md\",\"path\":\"test.md\",\"content\":\"test write content\"}}],\"actionBundle\":{{\"version\":\"1\",\"id\":\"write-test-md-plan\",\"goal\":\"Create test.md and wait for review\",\"actions\":[{{\"id\":\"write-test-md\",\"title\":\"Write test.md\",\"capability\":\"workspace.write\",\"kind\":\"write\",\"resourceScope\":[\"test.md\"],\"sourceBlockId\":\"write-test-md\"}}],\"continuationExpectations\":[{{\"id\":\"delete-test-md-after-review\",\"title\":\"Delete test.md after user review is accepted\",\"capability\":\"workspace.delete\",\"kind\":\"delete\",\"resourceScope\":[\"test.md\"]}}],\"validationExpectations\":[{{\"id\":\"file-written\",\"description\":\"Kernel fs.write returns ok\"}}],\"reviewExpectations\":[{{\"id\":\"user-review\",\"description\":\"User reviews before deletion\"}}]}},\"expectedValidation\":\"Kernel fs.write returns ok.\",\"reviewGuide\":\"Ask the user to review test.md. If accepted, Kernel continues to the scoped delete continuation.\"}}\\n\\nOriginal invalid output:\\n{}",
                    parser_error,
                    clip_chars(original_content, 48_000)
                )
            }
        ],
        "toolCatalog": tool_catalog,
        "tools": [],
        "repairPolicy": {
            "maxAttempts": 1,
            "parser": "strict"
        }
    })
}

#[derive(Debug, Clone)]
struct PendingAgentAnswer {
    content: String,
}

#[derive(Debug, Clone)]
struct PendingAgentResourceRequest {
    user_plan: Option<String>,
    request: Value,
}

#[derive(Debug, Clone)]
enum AgentPlanResponse {
    Answer(PendingAgentAnswer),
    ResourceRequest(PendingAgentResourceRequest),
    ActionPlan(PendingAgentPlan),
}

fn parse_agent_plan_response(
    session_id: &str,
    run_id: &str,
    content: &str,
) -> Result<AgentPlanResponse, String> {
    let trimmed = content.trim();
    if !trimmed.starts_with('{') {
        return Err("LLM plan output must be one JSON Envelope v2 object".to_string());
    }
    parse_agent_protocol_envelope_v2(session_id, run_id, trimmed)
}

fn parse_agent_protocol_envelope_v2(
    session_id: &str,
    run_id: &str,
    content: &str,
) -> Result<AgentPlanResponse, String> {
    let envelope: Value = serde_json::from_str(content)
        .map_err(|error| format!("JSON Envelope v2 must be valid JSON object: {error}"))?;
    let Some(object) = envelope.as_object() else {
        return Err("JSON Envelope v2 must be a JSON object".to_string());
    };
    reject_unknown_json_fields(
        object.keys(),
        &[
            "schemaVersion",
            "kind",
            "outputLanguage",
            "answer",
            "resourceRequest",
            "userPlan",
            "actionBundle",
            "codeBlocks",
            "expectedValidation",
            "reviewGuide",
        ],
        "JSON Envelope v2",
    )?;
    let schema_version = required_json_string(&envelope, "schemaVersion", "JSON Envelope v2")?;
    if schema_version != AGENT_PROTOCOL_SCHEMA_VERSION {
        return Err(format!(
            "JSON Envelope schemaVersion must be {AGENT_PROTOCOL_SCHEMA_VERSION}"
        ));
    }
    let kind = required_json_string(&envelope, "kind", "JSON Envelope v2")?;
    let output_language = required_json_string(&envelope, "outputLanguage", "JSON Envelope v2")?;
    if output_language.trim().is_empty() {
        return Err("JSON Envelope v2.outputLanguage must be non-empty".to_string());
    }
    match kind.as_str() {
        "answer" => parse_json_envelope_answer(&envelope),
        "resourceRequest" => parse_json_envelope_resource_request(&envelope),
        "actionBundle" => parse_json_envelope_action_bundle(session_id, run_id, &envelope),
        other => Err(format!("JSON Envelope v2.kind is unsupported: {other}")),
    }
}

fn parse_json_envelope_answer(envelope: &Value) -> Result<AgentPlanResponse, String> {
    reject_branch_payloads(
        envelope,
        "answer",
        &[
            "resourceRequest",
            "userPlan",
            "actionBundle",
            "codeBlocks",
            "expectedValidation",
            "reviewGuide",
        ],
    )?;
    let answer = envelope
        .get("answer")
        .ok_or_else(|| "JSON Envelope v2.answer is required".to_string())?;
    let Some(object) = answer.as_object() else {
        return Err("JSON Envelope v2.answer must be an object".to_string());
    };
    reject_unknown_json_fields(
        object.keys(),
        &["format", "content"],
        "JSON Envelope v2.answer",
    )?;
    let format = required_json_string(answer, "format", "JSON Envelope v2.answer")?;
    if format != "markdown" {
        return Err("JSON Envelope v2.answer.format must be markdown".to_string());
    }
    let content = required_json_string(answer, "content", "JSON Envelope v2.answer")?;
    Ok(AgentPlanResponse::Answer(PendingAgentAnswer { content }))
}

fn parse_json_envelope_resource_request(envelope: &Value) -> Result<AgentPlanResponse, String> {
    reject_branch_payloads(
        envelope,
        "resourceRequest",
        &[
            "answer",
            "actionBundle",
            "codeBlocks",
            "expectedValidation",
            "reviewGuide",
        ],
    )?;
    let request = envelope
        .get("resourceRequest")
        .cloned()
        .ok_or_else(|| "JSON Envelope v2.resourceRequest is required".to_string())?;
    validate_resource_request_json(&request)?;
    Ok(AgentPlanResponse::ResourceRequest(
        PendingAgentResourceRequest {
            user_plan: envelope
                .get("userPlan")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            request,
        },
    ))
}

fn parse_json_envelope_action_bundle(
    session_id: &str,
    run_id: &str,
    envelope: &Value,
) -> Result<AgentPlanResponse, String> {
    reject_branch_payloads(envelope, "actionBundle", &["answer", "resourceRequest"])?;
    let user_plan = required_json_string(envelope, "userPlan", "JSON Envelope v2")?;
    let action_bundle = envelope
        .get("actionBundle")
        .cloned()
        .ok_or_else(|| "JSON Envelope v2.actionBundle is required".to_string())?;
    let code_blocks = json_envelope_code_blocks(envelope)?;
    let code_block_ids = code_blocks
        .iter()
        .filter_map(|block| block.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<BTreeSet<_>>();
    validate_action_bundle_json(&action_bundle, &code_block_ids)?;
    let expected_validation =
        required_json_string(envelope, "expectedValidation", "JSON Envelope v2")?;
    let review_guide = required_json_string(envelope, "reviewGuide", "JSON Envelope v2")?;
    let plan_id = action_bundle
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("agent-plan")
        .to_string();
    Ok(AgentPlanResponse::ActionPlan(PendingAgentPlan {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        plan_id,
        user_plan,
        action_bundle,
        code_blocks,
        expected_validation,
        review_guide,
        plan_review_report: None,
        created_at: now_text(),
    }))
}

fn json_envelope_code_blocks(envelope: &Value) -> Result<Vec<Value>, String> {
    let Some(blocks) = envelope.get("codeBlocks") else {
        return Ok(Vec::new());
    };
    let Some(items) = blocks.as_array() else {
        return Err("JSON Envelope v2.codeBlocks must be an array".to_string());
    };
    let mut ids = BTreeSet::new();
    let mut normalized = Vec::new();
    for (index, block) in items.iter().enumerate() {
        let Some(object) = block.as_object() else {
            return Err(format!(
                "JSON Envelope v2.codeBlocks[{index}] must be an object"
            ));
        };
        reject_unknown_json_fields(
            object.keys(),
            &["id", "path", "language", "content"],
            &format!("JSON Envelope v2.codeBlocks[{index}]"),
        )?;
        let id = required_json_string(
            block,
            "id",
            &format!("JSON Envelope v2.codeBlocks[{index}]"),
        )?;
        if !ids.insert(id.clone()) {
            return Err(format!("duplicate codeBlocks id {id}"));
        }
        let path = required_json_string(
            block,
            "path",
            &format!("JSON Envelope v2.codeBlocks[{index}]"),
        )?;
        validate_workspace_path(&path, &format!("JSON Envelope v2.codeBlocks[{index}].path"))?;
        let content = required_json_string(
            block,
            "content",
            &format!("JSON Envelope v2.codeBlocks[{index}]"),
        )?;
        let mut next = json!({
            "id": id,
            "path": path,
            "content": content
        });
        if let Some(language) = block.get("language").and_then(Value::as_str) {
            next["language"] = json!(language);
        }
        normalized.push(next);
    }
    Ok(normalized)
}

fn reject_branch_payloads(
    envelope: &Value,
    branch: &str,
    forbidden: &[&str],
) -> Result<(), String> {
    for key in forbidden {
        if envelope.get(*key).is_some() {
            return Err(format!(
                "JSON Envelope v2 kind {branch} cannot include branch payload {key}"
            ));
        }
    }
    Ok(())
}

fn required_json_string(value: &Value, key: &str, label: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{label}.{key} must be a non-empty string"))
}

fn validate_resource_request_json(value: &Value) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err("RESOURCE_REQUEST must be a JSON object".to_string());
    };
    reject_unknown_json_fields(
        object.keys(),
        &["version", "id", "reason", "items"],
        "RESOURCE_REQUEST",
    )?;
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "RESOURCE_REQUEST.version is required".to_string())?;
    if version != "1" {
        return Err(format!("unsupported RESOURCE_REQUEST version {version}"));
    }
    for key in ["id", "reason"] {
        if object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .is_none()
        {
            return Err(format!("RESOURCE_REQUEST.{key} must be a non-empty string"));
        }
    }
    let items = object
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "RESOURCE_REQUEST.items must be an array".to_string())?;
    for (index, item) in items.iter().enumerate() {
        validate_resource_request_item_json(item, index)?;
    }
    Ok(())
}

fn validate_resource_request_item_json(value: &Value, index: usize) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err(format!("RESOURCE_REQUEST.items[{index}] must be an object"));
    };
    reject_unknown_json_fields(
        object.keys(),
        &["id", "manifestEntryId", "reason"],
        &format!("RESOURCE_REQUEST.items[{index}]"),
    )?;
    for key in ["id", "manifestEntryId", "reason"] {
        if object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .is_none()
        {
            return Err(format!(
                "RESOURCE_REQUEST.items[{index}].{key} must be a non-empty string"
            ));
        }
    }
    Ok(())
}

fn validate_action_bundle_json(
    value: &Value,
    code_block_ids: &BTreeSet<String>,
) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err("ACTION_BUNDLE must be a JSON object".to_string());
    };
    reject_unknown_json_fields(
        object.keys(),
        &[
            "version",
            "id",
            "goal",
            "requirementId",
            "actions",
            "continuationExpectations",
            "validationExpectations",
            "reviewExpectations",
            "repairPolicy",
        ],
        "ACTION_BUNDLE",
    )?;
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "ACTION_BUNDLE.version is required".to_string())?;
    if version != "1" {
        return Err(format!("unsupported ACTION_BUNDLE version {version}"));
    }
    let actions = object
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(|| "ACTION_BUNDLE.actions must be an array".to_string())?;
    let mut referenced_code_blocks = BTreeSet::new();
    for (index, action) in actions.iter().enumerate() {
        validate_action_json(
            action,
            &format!("actions[{index}]"),
            code_block_ids,
            &mut referenced_code_blocks,
        )?;
    }
    let continuations = object
        .get("continuationExpectations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, action) in continuations.iter().enumerate() {
        validate_action_json(
            action,
            &format!("continuationExpectations[{index}]"),
            code_block_ids,
            &mut referenced_code_blocks,
        )?;
    }
    for id in code_block_ids {
        if !referenced_code_blocks.contains(id) {
            return Err(format!(
                "CODE_BLOCK {id} is not referenced by ACTION_BUNDLE"
            ));
        }
    }
    if !object
        .get("validationExpectations")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        return Err("ACTION_BUNDLE.validationExpectations must be an array".to_string());
    }
    if !object
        .get("reviewExpectations")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        return Err("ACTION_BUNDLE.reviewExpectations must be an array".to_string());
    }
    Ok(())
}

fn validate_action_json(
    value: &Value,
    label: &str,
    code_block_ids: &BTreeSet<String>,
    referenced_code_blocks: &mut BTreeSet<String>,
) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err(format!("{label} must be an object"));
    };
    reject_unknown_json_fields(
        object.keys(),
        &[
            "id",
            "title",
            "capability",
            "kind",
            "resourceScope",
            "canParallelize",
            "conflictKeys",
            "purpose",
            "sourceBlockId",
        ],
        label,
    )?;
    for key in ["id", "title", "capability"] {
        if object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .is_none()
        {
            return Err(format!("{label}.{key} must be a non-empty string"));
        }
    }
    let capability = object
        .get("capability")
        .and_then(Value::as_str)
        .unwrap_or_default();
    validate_plan_capability(capability, &format!("{label}.capability"))?;
    let resource_scope = object
        .get("resourceScope")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label}.resourceScope must be an array"))?;
    for resource in resource_scope {
        let Some(resource) = resource.as_str().filter(|value| !value.trim().is_empty()) else {
            return Err(format!(
                "{label}.resourceScope must contain non-empty strings"
            ));
        };
        validate_resource_scope(resource, &format!("{label}.resourceScope"))?;
    }
    if let Some(source_block_id) = object.get("sourceBlockId").and_then(Value::as_str) {
        if !code_block_ids.contains(source_block_id) {
            return Err(format!(
                "{label} references missing CODE_BLOCK {source_block_id}"
            ));
        }
        referenced_code_blocks.insert(source_block_id.to_string());
    } else if capability == "workspace.write"
        && object.get("kind").and_then(Value::as_str) == Some("write")
    {
        return Err(format!(
            "{label} workspace.write must reference a CODE_BLOCK via sourceBlockId"
        ));
    }
    Ok(())
}

fn validate_plan_capability(value: &str, label: &str) -> Result<(), String> {
    if matches!(
        value,
        "workspace.read"
            | "workspace.search"
            | "workspace.preview_diff"
            | "workspace.write"
            | "workspace.delete"
            | "process.propose"
            | "process.exec"
            | "network.egress"
            | "git.read"
            | "git.write"
            | "browser.control"
    ) {
        return Ok(());
    }
    if value.contains('.') {
        return Err(format!(
            "{label} must use capability namespace, not executor tool name {value}"
        ));
    }
    Err(format!("{label} is not a known capability"))
}

fn reject_unknown_json_fields<'a>(
    keys: impl Iterator<Item = &'a String>,
    allowed: &[&str],
    label: &str,
) -> Result<(), String> {
    for key in keys {
        if !allowed.iter().any(|allowed_key| *allowed_key == key) {
            return Err(format!("{label} contains unknown field {key}"));
        }
    }
    Ok(())
}

fn validate_resource_scope(value: &str, label: &str) -> Result<(), String> {
    if value.contains('*')
        || value.starts_with("symbol:")
        || value.starts_with("search:")
        || value.starts_with("checkpoint:")
    {
        return Ok(());
    }
    validate_workspace_path(value, label)
}

fn validate_workspace_path(value: &str, label: &str) -> Result<(), String> {
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.get(1..3) == Some(":/")
        || normalized == ".."
        || normalized.starts_with("../")
        || normalized.contains("/../")
        || normalized.ends_with("/..")
    {
        return Err(format!(
            "{label} must be workspace-relative and must not contain .."
        ));
    }
    Ok(())
}

pub(crate) fn plan_card_event(session_id: &str, plan: &PendingAgentPlan) -> Value {
    let actions = plan
        .action_bundle
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    crate::event_projection::agent_event(
        session_id,
        "plan_card",
        json!({
            "title": "Plan",
            "summary": first_non_empty_line(&plan.user_plan),
            "content": plan.user_plan,
            "runId": plan.run_id,
            "planId": plan.plan_id,
            "actionBundle": plan.action_bundle,
            "codeBlocks": plan.code_blocks,
            "expectedValidation": plan.expected_validation,
            "reviewGuide": plan.review_guide,
            "facts": [
                format!("任务数：{}", actions.len()),
                "计划确认前不会进入执行。".to_string()
            ],
            "channel": "progress",
            "visibility": "conversation",
            "presentation": "body"
        }),
        &now_text(),
    )
}

fn answer_event(session_id: &str, run_id: &str, answer: &PendingAgentAnswer) -> Value {
    crate::event_projection::agent_event(
        session_id,
        "assistant_msg",
        json!({
            "content": answer.content.clone(),
            "channel": "final",
            "visibility": "conversation",
            "label": "Agent",
            "runId": run_id,
            "kind": "answer",
            "presentation": "body"
        }),
        &now_text(),
    )
}

fn resource_request_event(
    session_id: &str,
    run_id: &str,
    resource_request: &PendingAgentResourceRequest,
) -> Value {
    let item_count = resource_request
        .request
        .get("items")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    let reason = resource_request
        .request
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("需要补充上下文。");
    crate::event_projection::agent_event(
        session_id,
        "resource_request",
        json!({
            "title": "ResourceRequest",
            "summary": reason,
            "runId": run_id,
            "userPlan": resource_request.user_plan.clone(),
            "resourceRequest": resource_request.request.clone(),
            "facts": [
                format!("资源请求项：{}", item_count),
                "ResourceRequest 不会直接执行工具；资源补全必须通过 Kernel resource resolver 或权限链路。".to_string()
            ],
            "channel": "progress",
            "visibility": "conversation",
            "presentation": "body"
        }),
        &now_text(),
    )
}

fn plan_parse_error_event(session_id: &str, run_id: &str, error: &str) -> Value {
    crate::event_projection::agent_event(
        session_id,
        "plan_review",
        json!({
            "title": "Check / 计划确认",
            "summary": format!("计划解析失败，已停止执行：{error}"),
            "status": "needsRevision",
            "runId": run_id,
            "confirmable": false,
            "facts": [
                "LLM plan 阶段必须输出合法 deepcode.agent.protocol.v2 JSON Envelope；tagged Markdown 协议已移除。".to_string(),
                "解析失败时不能生成 ApprovedTaskQueue，也不能进入执行。".to_string()
            ],
            "channel": "progress",
            "visibility": "conversation",
            "presentation": "body"
        }),
        &now_text(),
    )
}

fn provider_error_value(error: &LlmProviderDiagnostic) -> Value {
    serde_json::to_value(error).unwrap_or_else(|_| json!({ "message": error.to_string() }))
}

fn first_non_empty_line(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Plan generated.")
        .to_string()
}

fn should_auto_accept_plan(state: &AppState, plan: &PendingAgentPlan) -> bool {
    let enabled = {
        let gui = state.gui.lock().expect("gui state lock");
        gui.user_settings
            .get("agent.plan.autoConfirmReadOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    if !enabled {
        return false;
    }
    let Some(report) = plan.plan_review_report.as_ref() else {
        return false;
    };
    if !report_array_empty(report, "permissionGaps")
        || !report_array_empty(report, "deniedReasons")
        || !report_array_empty(report, "hardFloorHits")
    {
        return false;
    }
    let capabilities = report
        .get("requiredCapabilities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    !capabilities.is_empty()
        && capabilities.iter().all(|capability| {
            matches!(
                capability.as_str(),
                Some("workspace.read") | Some("code.search")
            )
        })
}

fn report_array_empty(report: &Value, key: &str) -> bool {
    report
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.is_empty())
        .unwrap_or(true)
}

fn append_review_summary_from_response(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    guidance: &str,
) {
    let facts = review_facts_for_run(state, run_id);
    let pending_review = state
        .gui
        .lock()
        .expect("gui state lock")
        .pending_reviews
        .get(run_id)
        .cloned();
    let confirmable = pending_review.is_some();
    let continuation_count = pending_review
        .as_ref()
        .map(|review| review.continuations.len())
        .unwrap_or(0);
    append_session_projection(
        state,
        session_id,
        vec![crate::event_projection::agent_event(
            session_id,
            "review_summary",
            json!({
                "title": "Review",
                "summary": first_non_empty_line(guidance),
                "status": "waitingUserReview",
                "runId": run_id,
                "reviewId": run_id,
                "confirmable": confirmable,
                "continuationCount": continuation_count,
                "sourcePlanId": pending_review.as_ref().map(|review| review.source_plan_id.clone()),
                "reviewExpectations": pending_review.as_ref().map(|review| review.review_expectations.clone()).unwrap_or_default(),
                "continuationExpectations": pending_review.as_ref().map(|review| review.continuations.clone()).unwrap_or_default(),
                "llmGuidance": guidance,
                "facts": facts,
                "channel": "final",
                "visibility": "conversation",
                "presentation": "body"
            }),
            &now_text(),
        )],
    );
}

fn review_facts_for_run(state: &AppState, run_id: &str) -> Vec<String> {
    let events = state
        .kernel_events
        .lock()
        .expect("kernel event stream lock")
        .clone();
    let mut tool_facts = Vec::new();
    let mut permission_facts = Vec::new();
    for event in events {
        if event_run_id(&event).as_deref() != Some(run_id) {
            continue;
        }
        match event {
            KernelEvent::ToolCompleted {
                tool_name,
                ok,
                error,
                ..
            } => {
                tool_facts.push(format!(
                    "Tool result: {} -> {}{}",
                    tool_name,
                    if ok { "ok" } else { "error" },
                    error
                        .as_ref()
                        .map(|value| format!(" ({})", value.message))
                        .unwrap_or_default()
                ));
            }
            KernelEvent::PermissionResolved {
                permission_id,
                decision,
                ..
            } => {
                permission_facts.push(format!(
                    "Permission decision: {} -> {:?}",
                    permission_id, decision
                ));
            }
            _ => {}
        }
    }
    if tool_facts.is_empty() {
        tool_facts.push("Tool result: no tool execution facts.".to_string());
    }
    tool_facts.extend(permission_facts);
    tool_facts.push("Final acceptance still waits for user review.".to_string());
    tool_facts
}

fn event_run_id(event: &KernelEvent) -> Option<String> {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("runId").cloned())
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            Value::Object(map) => map
                .get("0")
                .or_else(|| map.get("value"))
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
}

pub(crate) fn invoke_kernel_tool(
    state: &AppState,
    session_id: &str,
    workspace_binding: &Option<WorkspaceBinding>,
    tool_call: &ToolCallRequest,
) -> Result<Vec<KernelEvent>, String> {
    ensure_kernel_run_for_session(state, session_id, workspace_binding)?;
    let events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::ToolInvoke {
                request_id: rid("kernel-tool-invoke"),
                run_id: None,
                session_id: Some(deepcode_kernel_abi::SessionId(session_id.to_string())),
                tool_call_id: tool_call
                    .id
                    .clone()
                    .unwrap_or_else(|| format!("tool-{}", now_millis())),
                tool_name: tool_call.name.clone(),
                arguments: tool_call.arguments.clone(),
                workspace_binding: workspace_binding.clone(),
            })
            .map_err(|error| error.to_string())?
    };
    record_kernel_events(state, &events);
    Ok(events)
}

pub(crate) fn ensure_kernel_run_for_session(
    state: &AppState,
    session_id: &str,
    workspace_binding: &Option<WorkspaceBinding>,
) -> Result<(), String> {
    let has_run = {
        let runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime.snapshot(Some(session_id)).run_id.is_some()
    };
    if has_run {
        return Ok(());
    }
    let binding = effective_workspace_binding(&state.runtime, workspace_binding.clone())
        .ok_or_else(|| "workspace binding is required before invoking a Kernel tool".to_string())?;
    let events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::RunStart {
                request_id: rid("kernel-tool-run-start"),
                session_id: Some(deepcode_kernel_abi::SessionId(session_id.to_string())),
                input: deepcode_kernel_abi::UserInput {
                    text: "Kernel tool invocation compatibility run".to_string(),
                    attachments: Vec::new(),
                },
                workspace_binding: Some(binding),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .map_err(|error| error.to_string())?
    };
    record_kernel_events(state, &events);
    Ok(())
}

pub(crate) fn request_mentions_local_workspace(content: &str) -> bool {
    request_mentions_temp_lifecycle(content)
        || content.contains("文件")
        || content.contains("工作区")
        || content.contains("搜索")
        || content.to_lowercase().contains("workspace")
}

pub(crate) fn request_mentions_temp_lifecycle(content: &str) -> bool {
    let lower = content.to_lowercase();
    content.contains("临时文件")
        || content.contains("读写")
        || content.contains("新建")
        || lower.contains("temporary file")
        || lower.contains("temp file")
}

pub(crate) fn effective_workspace_binding(
    runtime: &SharedRuntime,
    explicit: Option<WorkspaceBinding>,
) -> Option<WorkspaceBinding> {
    if explicit.is_some() {
        return explicit;
    }
    let current = current_workspace_json(runtime).ok()?;
    let workspace = current.get("current")?;
    if workspace.is_null() {
        return None;
    }
    let open_path = workspace
        .get("sourcePath")
        .and_then(Value::as_str)
        .or_else(|| {
            workspace
                .get("folders")
                .and_then(Value::as_array)
                .and_then(|folders| folders.first())
                .and_then(|folder| folder.get("absolutePath"))
                .and_then(Value::as_str)
        })?
        .to_string();
    Some(WorkspaceBinding {
        workspace_id: workspace
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
        workspace_hash: None,
        open_path: Some(open_path),
        active_folder_id: Some("wf-0".to_string()),
        folder_hash: None,
    })
}

pub(crate) fn normalize_openai_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

pub(crate) fn normalize_anthropic_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("https://api.anthropic.com")
        .trim_end_matches('/');
    if base.ends_with("/v1/messages") {
        base.to_string()
    } else {
        format!("{base}/v1/messages")
    }
}

pub(crate) fn normalize_ollama_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("http://127.0.0.1:11434")
        .trim_end_matches('/');
    if base.ends_with("/api/chat") {
        base.to_string()
    } else {
        format!("{base}/api/chat")
    }
}

pub(crate) fn split_system_messages(messages: Vec<Value>) -> (String, Vec<Value>) {
    let mut system = Vec::new();
    let mut chat = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) == Some("system") {
            if let Some(content) = message.get("content").and_then(Value::as_str) {
                system.push(content.to_string());
            }
        } else {
            chat.push(message);
        }
    }
    (system.join("\n\n"), chat)
}

pub(crate) fn provider_tool_name(name: &str) -> String {
    name.replace(
        |ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'),
        "_",
    )
}

pub(crate) fn internal_tool_name(name: &str) -> String {
    match name {
        "fs_read" => "fs.read".to_string(),
        "fs_list" => "fs.list".to_string(),
        "fs_diff" => "fs.diff".to_string(),
        "fs_write" => "fs.write".to_string(),
        "fs_delete" => "fs.delete".to_string(),
        "code_search" => "code.search".to_string(),
        "shell_propose" => "shell.propose".to_string(),
        "shell_exec" => "shell.exec".to_string(),
        "web_search" => "web.search".to_string(),
        "web_fetch" => "web.fetch".to_string(),
        "git_status" => "git.status".to_string(),
        "git_diff" => "git.diff".to_string(),
        "git_stage" => "git.stage".to_string(),
        "git_unstage" => "git.unstage".to_string(),
        "git_commit" => "git.commit".to_string(),
        "browser_open" => "browser.open".to_string(),
        "browser_reload" => "browser.reload".to_string(),
        "browser_snapshot" => "browser.snapshot".to_string(),
        "browser_inspect" => "browser.inspect".to_string(),
        "browser_click" => "browser.click".to_string(),
        "browser_type" => "browser.type".to_string(),
        "browser_scroll" => "browser.scroll".to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn token_limit_u32(value: &Value) -> Option<u32> {
    if let Some(integer) = value.as_u64() {
        return u32::try_from(integer).ok().filter(|value| *value > 0);
    }
    let number = value.as_f64()?;
    if !number.is_finite() || number <= 0.0 || number.fract() != 0.0 {
        return None;
    }
    if number > u32::MAX as f64 {
        return None;
    }
    Some(number as u32)
}

pub(crate) fn is_deepseek_profile(profile: &ResolvedLlmProfile) -> bool {
    profile
        .base_url
        .as_deref()
        .map(|value| value.contains("api.deepseek.com"))
        .unwrap_or(false)
        || profile.model.starts_with("deepseek-")
}

pub(crate) fn should_send_sampling(profile: &ResolvedLlmProfile) -> bool {
    !(is_deepseek_profile(profile) && profile.thinking.as_deref() == Some("enabled"))
}

pub(crate) fn llm_mock_enabled() -> bool {
    std::env::var("DEEPCODE_LLM_MOCK")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub(crate) fn mock_llm_output(system_instruction: &str, user_prompt: &str) -> LlmChatOutput {
    let prefers_chinese = user_prompt_prefers_chinese(user_prompt);
    let output_language = if prefers_chinese { "zh-CN" } else { "en-US" };
    if system_instruction.contains("review-guidance generator")
        || system_instruction.contains("Kernel tool-fact evidence")
    {
        let content = if request_mentions_temp_lifecycle(user_prompt) {
            if prefers_chinese {
                "我是 DeepCode。本轮工具事实显示工作区读取、组件验证、临时文件创建、读取与受控清理均已完成。请用户重点检查工具结果是否都为 ok、临时文件是否无残留、权限请求是否符合预期。"
            } else {
                "I am DeepCode. Kernel tool facts show that workspace reading, component verification, temp file creation, readback, and controlled cleanup completed. Please review whether tool results are ok, temp files have no residue, and permission requests match expectations."
            }
        } else if request_mentions_local_workspace(user_prompt) {
            if prefers_chinese {
                "我是 DeepCode。本轮工具事实显示工作区读取与组件验证已完成。请用户重点检查读取范围与结果是否符合预期。"
            } else {
                "I am DeepCode. Kernel tool facts show that workspace reading and component verification completed. Please review whether the read scope and results match the request."
            }
        } else if prefers_chinese {
            "我是 DeepCode。本轮已根据 Kernel 结构化事件完成当前任务的自检建议，最终验收仍由用户决定。"
        } else {
            "I am DeepCode. This review guidance is based on Kernel structured events. Final acceptance remains the user's decision."
        };
        return LlmChatOutput {
            content: content.to_string(),
            ..LlmChatOutput::default()
        };
    }
    if system_instruction.contains(AGENT_PROTOCOL_SCHEMA_VERSION)
        && !request_mentions_temp_lifecycle(user_prompt)
        && !request_mentions_local_workspace(user_prompt)
    {
        let answer_content = if prefers_chinese {
            "我是 DeepCode 的本地 Agent。我的会话协议由 Kernel 约束：纯问答会直接回答，需要上下文时会请求 resourceRequest，需要执行时会生成可审查的 actionBundle，并由 Kernel 权限系统控制工具执行。"
        } else {
            "I am the local DeepCode Agent. My session protocol is constrained by the Kernel: read-only questions are answered directly, missing context uses resourceRequest, and executable work uses reviewable actionBundle drafts controlled by Kernel permissions."
        };
        return LlmChatOutput {
            content: serde_json::json!({
                "schemaVersion": AGENT_PROTOCOL_SCHEMA_VERSION,
                "kind": "answer",
                "outputLanguage": output_language,
                "answer": {
                    "format": "markdown",
                    "content": answer_content
                }
            })
            .to_string(),
            ..LlmChatOutput::default()
        };
    }
    if system_instruction.contains(AGENT_PROTOCOL_SCHEMA_VERSION) {
        let user_plan = if prefers_chinese {
            "我是 DeepCode，接下来我将作为你的助手验证当前 Agent 的文件系统、搜索与临时文件生命周期能力。计划会先列出工作区与搜索代码，再创建并读取 `_agent_tmp_functional_test.txt`，随后等待用户 review 后再进入删除计划。"
        } else {
            "I will verify the current Agent file-system, search, and temporary-file lifecycle capabilities. The plan lists the workspace, runs code search, creates and reads `_agent_tmp_functional_test.txt`, then waits for user review before a later deletion plan."
        };
        let expected_validation = if prefers_chinese {
            "工具调用应全部返回 ok；临时文件读取内容应与写入内容一致；删除动作必须等待用户 review 后由下一轮计划触发。"
        } else {
            "All tool calls should return ok; the temp file read should match the written content; deletion must wait for user review and be planned in a later turn."
        };
        let review_guide = if prefers_chinese {
            "请重点审查工具结果、权限请求和临时文件内容；如确认通过，下一轮再生成删除计划。"
        } else {
            "Review tool results, permission requests, and temp file content. If accepted, deletion should be planned in the next turn."
        };
        let content = serde_json::json!({
            "schemaVersion": AGENT_PROTOCOL_SCHEMA_VERSION,
            "kind": "actionBundle",
            "outputLanguage": output_language,
            "userPlan": user_plan,
            "codeBlocks": [
                {
                    "id": "write-agent-functional-smoke",
                    "path": "_agent_tmp_functional_test.txt",
                    "content": format!("DeepCode Agent temp lifecycle test at {}", now_millis())
                }
            ],
            "actionBundle": {
                "version": "1",
                "id": "agent-functional-smoke-plan",
                "goal": "Verify Agent workspace read, code search, and temp write review flow",
                "actions": [
                    {
                        "id": "list-workspace-root",
                        "title": "List workspace root",
                        "capability": "workspace.read",
                        "kind": "read",
                        "resourceScope": ["."]
                    },
                    {
                        "id": "search-workspace",
                        "title": "Verify code.search",
                        "capability": "workspace.search",
                        "kind": "read",
                        "resourceScope": ["workspace"]
                    },
                    {
                        "id": "write-temp-file",
                        "title": "Create temp file",
                        "capability": "workspace.write",
                        "kind": "write",
                        "resourceScope": ["_agent_tmp_functional_test.txt"],
                        "sourceBlockId": "write-agent-functional-smoke"
                    },
                    {
                        "id": "read-temp-file",
                        "title": "Read temp file",
                        "capability": "workspace.read",
                        "kind": "read",
                        "resourceScope": ["_agent_tmp_functional_test.txt"]
                    }
                ],
                "validationExpectations": [
                    {
                        "id": "tool-results-ok",
                        "description": "Kernel tool results return ok for fs.list, code.search, fs.write, and fs.read"
                    }
                ],
                "reviewExpectations": [
                    {
                        "id": "user-review-temp-cleanup",
                        "description": "User reviews temp file content before deletion is planned"
                    }
                ]
            },
            "expectedValidation": expected_validation,
            "reviewGuide": review_guide
        })
        .to_string();
        return LlmChatOutput {
            content,
            ..LlmChatOutput::default()
        };
    }
    LlmChatOutput {
        content: String::new(),
        tool_calls: vec![
            LlmToolCall {
                id: "mock-fs-list".to_string(),
                name: "fs.list".to_string(),
                arguments: json!({ "path": "." }),
            },
            LlmToolCall {
                id: "mock-code-search".to_string(),
                name: "code.search".to_string(),
                arguments: json!({ "query": "DeepCode" }),
            },
            LlmToolCall {
                id: "mock-fs-write".to_string(),
                name: "fs.write".to_string(),
                arguments: json!({
                    "path": "_agent_tmp_functional_test.txt",
                    "content": format!("DeepCode Agent temp lifecycle test at {}", now_millis())
                }),
            },
        ],
        ..LlmChatOutput::default()
    }
}

fn user_prompt_prefers_chinese(user_prompt: &str) -> bool {
    user_prompt
        .chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_accepts_json_envelope_answer() {
        let parsed = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "answer",
                "outputLanguage": "zh-CN",
                "answer": {
                    "format": "markdown",
                    "content": "我是 DeepCode。"
                }
            })
            .to_string(),
        )
        .unwrap();
        match parsed {
            AgentPlanResponse::Answer(answer) => {
                assert!(answer.content.contains("DeepCode"));
            }
            other => panic!("expected answer, got {other:?}"),
        }
    }

    #[test]
    fn parser_accepts_json_envelope_action_bundle() {
        let parsed = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "actionBundle",
                "outputLanguage": "zh-CN",
                "userPlan": "Create test.md and wait for review.",
                "codeBlocks": [
                    {
                        "id": "write-test",
                        "path": "test.md",
                        "content": "hello"
                    }
                ],
                "actionBundle": {
                    "version": "1",
                    "id": "plan-1",
                    "goal": "Create test.md and wait for review",
                    "actions": [
                        {
                            "id": "a1",
                            "title": "Write test.md",
                            "capability": "workspace.write",
                            "kind": "write",
                            "resourceScope": ["test.md"],
                            "sourceBlockId": "write-test"
                        }
                    ],
                    "validationExpectations": [],
                    "reviewExpectations": []
                },
                "expectedValidation": "Kernel fs.write succeeds.",
                "reviewGuide": "Review test.md."
            })
            .to_string(),
        )
        .unwrap();
        match parsed {
            AgentPlanResponse::ActionPlan(plan) => {
                assert_eq!(plan.code_blocks.len(), 1);
                assert_eq!(plan.plan_id, "plan-1");
            }
            other => panic!("expected action plan, got {other:?}"),
        }
    }

    #[test]
    fn parser_rejects_json_envelope_answer_with_action_bundle() {
        let error = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "answer",
                "outputLanguage": "en-US",
                "answer": {
                    "format": "markdown",
                    "content": "ok"
                },
                "actionBundle": {}
            })
            .to_string(),
        )
        .unwrap_err();
        assert!(error.contains("cannot include branch payload actionBundle"));
    }

    #[test]
    fn parser_rejects_json_envelope_executor_capability() {
        let error = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "actionBundle",
                "outputLanguage": "en-US",
                "userPlan": "Bad plan.",
                "actionBundle": {
                    "version": "1",
                    "id": "plan-1",
                    "goal": "bad",
                    "actions": [
                        {
                            "id": "a1",
                            "title": "bad",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": ["test.md"]
                        }
                    ],
                    "validationExpectations": [],
                    "reviewExpectations": []
                },
                "expectedValidation": "none",
                "reviewGuide": "review"
            })
            .to_string(),
        )
        .unwrap_err();
        assert!(error.contains("must use capability namespace"));
    }

    #[test]
    fn parser_rejects_tagged_answer_protocol() {
        let error = parse_agent_plan_response(
            "session-1",
            "run-1",
            "<ANSWER format=\"markdown\" version=\"1\">\n我是 DeepCode。\n</ANSWER>",
        )
        .unwrap_err();
        assert!(error.contains("must be one JSON Envelope v2 object"));
    }

    #[test]
    fn parser_accepts_answer_only() {
        let parsed = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "answer",
                "outputLanguage": "zh-CN",
                "answer": {
                    "format": "markdown",
                    "content": "我是 DeepCode。"
                }
            })
            .to_string(),
        )
        .unwrap();
        match parsed {
            AgentPlanResponse::Answer(answer) => {
                assert!(answer.content.contains("DeepCode"));
            }
            other => panic!("expected answer, got {other:?}"),
        }
    }

    #[test]
    fn parser_accepts_resource_request_without_action_bundle() {
        let parsed = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "resourceRequest",
                "outputLanguage": "en-US",
                "resourceRequest": {
                    "version": "1",
                    "id": "rr-1",
                    "reason": "need context",
                    "items": [
                        {
                            "id": "item-1",
                            "manifestEntryId": "file-readme",
                            "reason": "read README"
                        }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();
        match parsed {
            AgentPlanResponse::ResourceRequest(request) => {
                assert_eq!(request.request["id"], "rr-1");
            }
            other => panic!("expected resource request, got {other:?}"),
        }
    }

    #[test]
    fn parser_rejects_answer_mixed_with_plan() {
        let error = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "answer",
                "outputLanguage": "en-US",
                "answer": {
                    "format": "markdown",
                    "content": "ok"
                },
                "actionBundle": {}
            })
            .to_string(),
        )
        .unwrap_err();
        assert!(error.contains("cannot include branch payload actionBundle"));
    }

    #[test]
    fn parser_rejects_action_params_field() {
        let content = serde_json::json!({
            "schemaVersion": "deepcode.agent.protocol.v2",
            "kind": "actionBundle",
            "outputLanguage": "en-US",
            "userPlan": "plan",
            "actionBundle": {
                "version": "1",
                "id": "plan-1",
                "goal": "test",
                "actions": [
                    {
                        "id": "a1",
                        "title": "bad",
                        "capability": "workspace.read",
                        "kind": "read",
                        "resourceScope": ["README.md"],
                        "params": { "path": "README.md" }
                    }
                ],
                "validationExpectations": [],
                "reviewExpectations": []
            },
            "expectedValidation": "none",
            "reviewGuide": "review"
        })
        .to_string();
        let error = parse_agent_plan_response("session-1", "run-1", &content).unwrap_err();
        assert!(error.contains("unknown field params"));
    }

    #[test]
    fn parser_rejects_action_bundle_missing_json_version() {
        let content = serde_json::json!({
            "schemaVersion": "deepcode.agent.protocol.v2",
            "kind": "actionBundle",
            "outputLanguage": "en-US",
            "userPlan": "plan",
            "actionBundle": {
                "id": "plan-1",
                "goal": "test",
                "actions": [],
                "validationExpectations": [],
                "reviewExpectations": []
            },
            "expectedValidation": "none",
            "reviewGuide": "review"
        })
        .to_string();
        let error = parse_agent_plan_response("session-1", "run-1", &content).unwrap_err();
        assert!(error.contains("ACTION_BUNDLE.version is required"));
    }

    #[test]
    fn parser_rejects_scalar_resource_scope() {
        let content = serde_json::json!({
            "schemaVersion": "deepcode.agent.protocol.v2",
            "kind": "actionBundle",
            "outputLanguage": "en-US",
            "userPlan": "plan",
            "actionBundle": {
                "version": "1",
                "id": "plan-1",
                "goal": "test",
                "actions": [
                    {
                        "id": "a1",
                        "title": "bad",
                        "capability": "workspace.read",
                        "kind": "read",
                        "resourceScope": "README.md"
                    }
                ],
                "validationExpectations": [],
                "reviewExpectations": []
            },
            "expectedValidation": "none",
            "reviewGuide": "review"
        })
        .to_string();
        let error = parse_agent_plan_response("session-1", "run-1", &content).unwrap_err();
        assert!(error.contains("resourceScope must be an array"));
    }

    #[test]
    fn parser_rejects_executor_tool_name_as_plan_capability() {
        let content = serde_json::json!({
            "schemaVersion": "deepcode.agent.protocol.v2",
            "kind": "actionBundle",
            "outputLanguage": "en-US",
            "userPlan": "plan",
            "actionBundle": {
                "version": "1",
                "id": "plan-1",
                "goal": "test",
                "actions": [
                    {
                        "id": "a1",
                        "title": "bad",
                        "capability": "fs.write",
                        "kind": "write",
                        "resourceScope": ["test.md"]
                    }
                ],
                "validationExpectations": [],
                "reviewExpectations": []
            },
            "expectedValidation": "none",
            "reviewGuide": "review"
        })
        .to_string();
        let error = parse_agent_plan_response("session-1", "run-1", &content).unwrap_err();
        assert!(error.contains("must use capability namespace"));
    }

    #[test]
    fn parser_accepts_source_block_write_plan() {
        let content = serde_json::json!({
            "schemaVersion": "deepcode.agent.protocol.v2",
            "kind": "actionBundle",
            "outputLanguage": "en-US",
            "userPlan": "plan",
            "codeBlocks": [
                {
                    "id": "write-test",
                    "path": "test.md",
                    "content": "hello"
                }
            ],
            "actionBundle": {
                "version": "1",
                "id": "plan-1",
                "goal": "test",
                "actions": [
                    {
                        "id": "a1",
                        "title": "write",
                        "capability": "workspace.write",
                        "kind": "write",
                        "resourceScope": ["test.md"],
                        "sourceBlockId": "write-test"
                    }
                ],
                "validationExpectations": [],
                "reviewExpectations": []
            },
            "expectedValidation": "Kernel fs.write succeeds.",
            "reviewGuide": "Review test.md."
        })
        .to_string();
        let parsed = parse_agent_plan_response("session-1", "run-1", &content).unwrap();
        assert!(matches!(parsed, AgentPlanResponse::ActionPlan(_)));
    }

    #[test]
    fn provider_name_roundtrip_includes_delete() {
        assert_eq!(internal_tool_name("fs_delete"), "fs.delete");
    }
}
