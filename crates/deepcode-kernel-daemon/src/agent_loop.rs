#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

#[derive(Debug, Clone)]
pub(crate) struct AgentRunRequest {
    pub(crate) content: String,
    pub(crate) workflow: String,
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
        workflow: body
            .get("workflow")
            .and_then(Value::as_str)
            .unwrap_or("planFirst")
            .to_string(),
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
                workflow_ref: Some(deepcode_kernel_abi::WorkflowRef {
                    id: request.workflow.clone(),
                    version: None,
                    hash: None,
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
                        run_id,
                        session_id: event_session_id,
                        llm_call_id,
                        response_envelope,
                    })
                    .map_err(|error| error.to_string())?
            };
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
    let session_id = state
        .gui
        .lock()
        .expect("gui state lock")
        .current_session_id
        .clone()
        .unwrap_or_else(|| "tool-session".to_string());
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
    if system_instruction.contains("复核阶段") {
        let content = if request_mentions_temp_lifecycle(user_prompt) {
            "<final>我是 DeepCode Agent。本轮已根据 Kernel 工具事实完成工作区读取、组件验证、临时文件创建读取与受控清理。</final>"
        } else if request_mentions_local_workspace(user_prompt) {
            "<final>我是 DeepCode Agent。本轮已根据 Kernel 工具事实完成工作区读取与组件验证。</final>"
        } else {
            "<final>我是 DeepCode Agent。本轮已根据 Kernel 结构化事件完成当前任务。</final>"
        };
        return LlmChatOutput {
            content: content.to_string(),
            ..LlmChatOutput::default()
        };
    }
    if system_instruction.contains("规划阶段") {
        return LlmChatOutput {
            content: "<plan>我会先规划测试目标，再通过 Kernel syscall 验证工作区读取、搜索、临时文件写入、读取和清理，最终只在复核阶段回答身份和汇总结果。</plan>".to_string(),
            ..LlmChatOutput::default()
        };
    }
    if system_instruction.contains("检查阶段") {
        return LlmChatOutput {
            content: "<observe>计划检查通过：路径使用工作区相对 `_agent_tmp_*`，写入需要权限，清理由 Kernel 隐藏受控能力完成。</observe>".to_string(),
            ..LlmChatOutput::default()
        };
    }
    LlmChatOutput {
        content: "<say>开始执行工具验证。</say>".to_string(),
        ..LlmChatOutput::default()
    }
}
