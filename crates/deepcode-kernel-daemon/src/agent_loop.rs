#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

#[derive(Debug, Clone)]
pub(crate) struct AgentRunRequest {
    pub(crate) content: String,
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

pub(crate) async fn start_kernel_agent_run(
    state: &AppState,
    session_id: &str,
    request: AgentRunRequest,
) -> Result<(), String> {
    let needs_workspace = request_mentions_local_workspace(&request.content);
    if needs_workspace {
        if let Err(error) =
            ensure_workspace_binding(&state.runtime, request.workspace_binding.as_ref())
        {
            append_session_projection(
                state,
                session_id,
                vec![assistant_final_event(
                    session_id,
                    &format!(
                        "当前没有可用工作区绑定：{}。请先打开一个文件夹或 .code-workspace 文件，再让 Agent 读取、搜索或修改文件。",
                        error.message
                    ),
                )],
            );
            return Ok(());
        }
    } else if let Some(binding) = request.workspace_binding.as_ref() {
        let _ = ensure_workspace_binding(&state.runtime, Some(binding));
    }

    let Some(binding) =
        effective_workspace_binding(&state.runtime, request.workspace_binding.clone())
    else {
        append_session_projection(
            state,
            session_id,
            vec![assistant_final_event(
                session_id,
                "当前没有可用工作区绑定。请先打开一个文件夹或 .code-workspace 文件，再让 Agent 读取、搜索或修改文件。",
            )],
        );
        return Ok(());
    };

    let kernel_events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::RunStart {
                request_id: rid("agent-run-start"),
                session_id: Some(deepcode_kernel_abi::SessionId(session_id.to_string())),
                input: deepcode_kernel_abi::UserInput {
                    text: request.content.clone(),
                    attachments: Vec::new(),
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
            let output = call_llm_profile(&profile, request_envelope).await?;
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
                match parse_pending_agent_plan(
                    session_id,
                    &run_id.0,
                    response_envelope
                        .pointer("/assistantMessage/content")
                        .or_else(|| response_envelope.get("content"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ) {
                    Ok(mut plan) => {
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

fn parse_pending_agent_plan(
    session_id: &str,
    run_id: &str,
    content: &str,
) -> Result<PendingAgentPlan, String> {
    let user_plan =
        tagged_block(content, "USER_PLAN").ok_or_else(|| "missing USER_PLAN block".to_string())?;
    let action_bundle_raw = tagged_block(content, "ACTION_BUNDLE")
        .ok_or_else(|| "missing ACTION_BUNDLE block".to_string())?;
    let expected_validation = tagged_block(content, "EXPECTED_VALIDATION")
        .ok_or_else(|| "missing EXPECTED_VALIDATION block".to_string())?;
    let review_guide = tagged_block(content, "REVIEW_GUIDE")
        .ok_or_else(|| "missing REVIEW_GUIDE block".to_string())?;
    let action_bundle: Value = serde_json::from_str(action_bundle_raw.trim())
        .map_err(|error| format!("ACTION_BUNDLE must be valid JSON: {error}"))?;
    if !action_bundle.is_object() {
        return Err("ACTION_BUNDLE must be a JSON object".to_string());
    }
    let version = action_bundle
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "ACTION_BUNDLE.version is required".to_string())?;
    if version != "1" {
        return Err(format!("unsupported ACTION_BUNDLE version {version}"));
    }
    let plan_id = action_bundle
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("agent-plan")
        .to_string();
    Ok(PendingAgentPlan {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        plan_id,
        user_plan: user_plan.trim().to_string(),
        action_bundle,
        expected_validation: expected_validation.trim().to_string(),
        review_guide: review_guide.trim().to_string(),
        plan_review_report: None,
        created_at: now_text(),
    })
}

fn tagged_block<'a>(content: &'a str, tag: &str) -> Option<&'a str> {
    let open_start = format!("<{tag}");
    let close = format!("</{tag}>");
    let start = content.find(&open_start)?;
    let after_open = content[start..].find('>')? + start + 1;
    let end = content[after_open..].find(&close)? + after_open;
    Some(&content[after_open..end])
}

fn plan_card_event(session_id: &str, plan: &PendingAgentPlan) -> Value {
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
                "LLM 输出必须包含 USER_PLAN、JSON ACTION_BUNDLE、EXPECTED_VALIDATION、REVIEW_GUIDE。".to_string(),
                "解析失败时不能生成 ApprovedTaskQueue，也不能进入执行。".to_string()
            ],
            "channel": "progress",
            "visibility": "conversation",
            "presentation": "body"
        }),
        &now_text(),
    )
}

fn first_non_empty_line(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("计划已生成。")
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
                    "工具结果：{} -> {}{}",
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
                permission_facts.push(format!("权限决策：{} -> {:?}", permission_id, decision));
            }
            _ => {}
        }
    }
    if tool_facts.is_empty() {
        tool_facts.push("工具结果：无工具执行事实。".to_string());
    }
    tool_facts.extend(permission_facts);
    tool_facts.push("最终验收仍等待用户 review。".to_string());
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
        "code_search" => "code.search".to_string(),
        "shell_propose" => "shell.propose".to_string(),
        "shell_exec" => "shell.exec".to_string(),
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
    if system_instruction.contains("Review guidance") || system_instruction.contains("用户审查建议")
    {
        let content = if request_mentions_temp_lifecycle(user_prompt) {
            "我是 DeepCode。本轮工具事实显示工作区读取、组件验证、临时文件创建、读取与受控清理均已完成。请用户重点检查工具结果是否都为 ok、临时文件是否无残留、权限请求是否符合预期。"
        } else if request_mentions_local_workspace(user_prompt) {
            "我是 DeepCode。本轮工具事实显示工作区读取与组件验证已完成。请用户重点检查读取范围与结果是否符合预期。"
        } else {
            "我是 DeepCode。本轮已根据 Kernel 结构化事件完成当前任务的自检建议，最终验收仍由用户决定。"
        };
        return LlmChatOutput {
            content: content.to_string(),
            ..LlmChatOutput::default()
        };
    }
    if system_instruction.contains("ACTION_BUNDLE") && system_instruction.contains("USER_PLAN") {
        return LlmChatOutput {
            content: format!(
                "<USER_PLAN>\n我是 DeepCode，接下来我将作为你的助手验证当前 Agent 的文件系统、搜索与临时文件生命周期能力。计划会先列出工作区与搜索代码，再创建、读取并清理 `_agent_tmp_functional_test.txt`。\n</USER_PLAN>\n\n\
                <ACTION_BUNDLE format=\"json\" version=\"1\">\n{}\n</ACTION_BUNDLE>\n\n\
                <EXPECTED_VALIDATION>\n工具调用应全部返回 ok；临时文件读取内容应与写入内容一致；清理后文件不应残留。\n</EXPECTED_VALIDATION>\n\n\
                <REVIEW_GUIDE>\n请重点审查工具结果、权限请求和临时文件是否被清理。\n</REVIEW_GUIDE>",
                serde_json::json!({
                    "version": "1",
                    "id": "agent-functional-smoke-plan",
                    "goal": "验证 Agent 工作区读取、代码搜索和临时文件生命周期能力",
                    "actions": [
                        {
                            "id": "list-workspace-root",
                            "title": "列出工作区根目录",
                            "capability": "workspace.read",
                            "kind": "read",
                            "resourceScope": ["."]
                        },
                        {
                            "id": "search-workspace",
                            "title": "验证 code.search",
                            "capability": "code.search",
                            "kind": "read",
                            "resourceScope": ["workspace"]
                        },
                        {
                            "id": "write-temp-file",
                            "title": "创建临时文件",
                            "capability": "workspace.write",
                            "kind": "write",
                            "resourceScope": ["_agent_tmp_functional_test.txt"]
                        },
                        {
                            "id": "read-temp-file",
                            "title": "读取临时文件",
                            "capability": "workspace.read",
                            "kind": "read",
                            "resourceScope": ["_agent_tmp_functional_test.txt"]
                        },
                        {
                            "id": "delete-temp-file",
                            "title": "清理临时文件",
                            "capability": "workspace.delete",
                            "kind": "delete",
                            "resourceScope": ["_agent_tmp_functional_test.txt"]
                        }
                    ],
                    "validationExpectations": [
                        {
                            "id": "tool-results-ok",
                            "description": "fs.list、code.search、fs.write、fs.read、fs.delete 均返回 ok"
                        }
                    ],
                    "reviewExpectations": [
                        {
                            "id": "user-review-temp-cleanup",
                            "description": "用户确认临时文件已清理且权限请求符合预期"
                        }
                    ]
                })
            ),
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
