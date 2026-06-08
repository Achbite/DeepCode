#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;
use std::collections::{BTreeMap, BTreeSet};

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
                match parse_agent_plan_response(
                    session_id,
                    &run_id.0,
                    response_envelope
                        .pointer("/assistantMessage/content")
                        .or_else(|| response_envelope.get("content"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ) {
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
    let blocks = extract_agent_plan_blocks(content)?;
    if blocks.contains_key("ANSWER") {
        if blocks.len() != 1 {
            return Err(
                "ANSWER cannot appear with plan, resource, permission, or code blocks".to_string(),
            );
        }
        let answer = required_plan_block(&blocks, "ANSWER")?;
        validate_answer_block_header(answer)?;
        let content = answer.content.trim();
        if content.is_empty() {
            return Err("ANSWER content must be non-empty".to_string());
        }
        return Ok(AgentPlanResponse::Answer(PendingAgentAnswer {
            content: content.to_string(),
        }));
    }
    if blocks.contains_key("RESOURCE_REQUEST") && blocks.contains_key("ACTION_BUNDLE") {
        return Err(
            "RESOURCE_REQUEST and ACTION_BUNDLE cannot appear in the same turn".to_string(),
        );
    }
    if blocks.contains_key("RESOURCE_REQUEST") {
        let block = required_plan_block(&blocks, "RESOURCE_REQUEST")?;
        validate_block_header(block, "RESOURCE_REQUEST")?;
        let request: Value = serde_json::from_str(block.content.trim())
            .map_err(|error| format!("RESOURCE_REQUEST must be valid JSON: {error}"))?;
        validate_resource_request_json(&request)?;
        return Ok(AgentPlanResponse::ResourceRequest(
            PendingAgentResourceRequest {
                user_plan: blocks
                    .get("USER_PLAN")
                    .map(|block| block.content.trim().to_string())
                    .filter(|value| !value.is_empty()),
                request,
            },
        ));
    }
    let user_plan = required_plan_block(&blocks, "USER_PLAN")?;
    let action_bundle_block = required_plan_block(&blocks, "ACTION_BUNDLE")?;
    validate_block_header(action_bundle_block, "ACTION_BUNDLE")?;
    let action_bundle: Value = serde_json::from_str(action_bundle_block.content.trim())
        .map_err(|error| format!("ACTION_BUNDLE must be valid JSON: {error}"))?;
    validate_action_bundle_json(&action_bundle, &blocks)?;
    let expected_validation = required_plan_block(&blocks, "EXPECTED_VALIDATION")?;
    let review_guide = required_plan_block(&blocks, "REVIEW_GUIDE")?;
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
        user_plan: user_plan.content.trim().to_string(),
        action_bundle,
        expected_validation: expected_validation.content.trim().to_string(),
        review_guide: review_guide.content.trim().to_string(),
        plan_review_report: None,
        created_at: now_text(),
    }))
}

#[derive(Debug, Clone)]
struct AgentPlanBlock {
    attrs: BTreeMap<String, String>,
    content: String,
}

fn extract_agent_plan_blocks(content: &str) -> Result<BTreeMap<String, AgentPlanBlock>, String> {
    let mut blocks = BTreeMap::new();
    let mut index = 0;
    while let Some(open_offset) = content[index..].find('<') {
        let open_index = index + open_offset;
        if content[open_index..].starts_with("</") {
            return Err("unmatched closing tag".to_string());
        }
        let Some(close_angle_offset) = content[open_index..].find('>') else {
            return Err("unterminated tag".to_string());
        };
        let close_angle_index = open_index + close_angle_offset;
        let header = &content[open_index + 1..close_angle_index];
        let (tag, attrs) = parse_plan_tag_header(header)?;
        if !is_known_plan_tag(&tag) {
            return Err(format!("unknown agent plan tag {tag}"));
        }
        if tag != "CODE_BLOCK" && blocks.contains_key(&tag) {
            return Err(format!("duplicate {tag} block"));
        }
        let close_tag = format!("</{tag}>");
        let content_start = close_angle_index + 1;
        let Some(close_offset) = content[content_start..].find(&close_tag) else {
            return Err(format!("missing closing {tag} tag"));
        };
        let content_end = content_start + close_offset;
        let block_content = &content[content_start..content_end];
        if tag != "CODE_BLOCK" && contains_plan_tag(block_content) {
            return Err(format!("{tag} contains a nested tag"));
        }
        let key = if tag == "CODE_BLOCK" {
            let Some(id) = attrs.get("id").filter(|value| !value.trim().is_empty()) else {
                return Err("CODE_BLOCK is missing id".to_string());
            };
            let Some(path) = attrs.get("path").filter(|value| !value.trim().is_empty()) else {
                return Err("CODE_BLOCK is missing path".to_string());
            };
            validate_workspace_path(path, "CODE_BLOCK.path")?;
            format!("CODE_BLOCK:{id}")
        } else {
            tag.clone()
        };
        if blocks.contains_key(&key) {
            return Err(format!("duplicate {tag} block"));
        }
        blocks.insert(
            key,
            AgentPlanBlock {
                attrs,
                content: block_content.to_string(),
            },
        );
        index = content_end + close_tag.len();
    }
    if content[index..].contains('>') {
        return Err("unmatched tag text".to_string());
    }
    Ok(blocks)
}

fn parse_plan_tag_header(header: &str) -> Result<(String, BTreeMap<String, String>), String> {
    let mut parts = header.split_whitespace();
    let Some(tag) = parts.next() else {
        return Err("empty tag".to_string());
    };
    let mut attrs = BTreeMap::new();
    for part in parts {
        let Some((key, raw_value)) = part.split_once('=') else {
            return Err(format!("{tag} contains invalid attr {part}"));
        };
        let value = raw_value.trim_matches('"').trim_matches('\'').to_string();
        attrs.insert(key.to_string(), value);
    }
    Ok((tag.to_string(), attrs))
}

fn is_known_plan_tag(tag: &str) -> bool {
    matches!(
        tag,
        "ANSWER"
            | "USER_PLAN"
            | "RESOURCE_REQUEST"
            | "ACTION_BUNDLE"
            | "CODE_BLOCK"
            | "EXPECTED_VALIDATION"
            | "REVIEW_GUIDE"
            | "PERMISSION_HINTS"
    )
}

fn contains_plan_tag(content: &str) -> bool {
    [
        "<ANSWER",
        "<USER_PLAN",
        "<RESOURCE_REQUEST",
        "<ACTION_BUNDLE",
        "<CODE_BLOCK",
        "<EXPECTED_VALIDATION",
        "<REVIEW_GUIDE",
        "<PERMISSION_HINTS",
    ]
    .iter()
    .any(|tag| content.contains(tag))
}

fn required_plan_block<'a>(
    blocks: &'a BTreeMap<String, AgentPlanBlock>,
    tag: &str,
) -> Result<&'a AgentPlanBlock, String> {
    blocks
        .get(tag)
        .ok_or_else(|| format!("missing {tag} block"))
}

fn validate_block_header(block: &AgentPlanBlock, tag: &str) -> Result<(), String> {
    if block.attrs.get("format").map(String::as_str) != Some("json")
        || block.attrs.get("version").map(String::as_str) != Some("1")
    {
        return Err(format!("{tag} must declare format=\"json\" version=\"1\""));
    }
    Ok(())
}

fn validate_answer_block_header(block: &AgentPlanBlock) -> Result<(), String> {
    if block.attrs.get("format").map(String::as_str) != Some("markdown")
        || block.attrs.get("version").map(String::as_str) != Some("1")
    {
        return Err("ANSWER must declare format=\"markdown\" version=\"1\"".to_string());
    }
    Ok(())
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
    blocks: &BTreeMap<String, AgentPlanBlock>,
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
    let code_block_ids = blocks
        .keys()
        .filter_map(|key| key.strip_prefix("CODE_BLOCK:"))
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    for (index, action) in actions.iter().enumerate() {
        validate_action_json(action, index, &code_block_ids, &mut referenced_code_blocks)?;
    }
    for key in blocks.keys().filter(|key| key.starts_with("CODE_BLOCK:")) {
        let id = key.trim_start_matches("CODE_BLOCK:");
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
    index: usize,
    code_block_ids: &BTreeSet<String>,
    referenced_code_blocks: &mut BTreeSet<String>,
) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err(format!("actions[{index}] must be an object"));
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
        &format!("actions[{index}]"),
    )?;
    for key in ["id", "title", "capability"] {
        if object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .is_none()
        {
            return Err(format!("actions[{index}].{key} must be a non-empty string"));
        }
    }
    let resource_scope = object
        .get("resourceScope")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("actions[{index}].resourceScope must be an array"))?;
    for resource in resource_scope {
        let Some(resource) = resource.as_str().filter(|value| !value.trim().is_empty()) else {
            return Err(format!(
                "actions[{index}].resourceScope must contain non-empty strings"
            ));
        };
        validate_resource_scope(resource, &format!("actions[{index}].resourceScope"))?;
    }
    if let Some(source_block_id) = object.get("sourceBlockId").and_then(Value::as_str) {
        if !code_block_ids.contains(source_block_id) {
            return Err(format!(
                "actions[{index}] references missing CODE_BLOCK {source_block_id}"
            ));
        }
        referenced_code_blocks.insert(source_block_id.to_string());
    }
    Ok(())
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
                "LLM plan 阶段必须输出合法 ANSWER、RESOURCE_REQUEST 或 USER_PLAN + JSON ACTION_BUNDLE + EXPECTED_VALIDATION + REVIEW_GUIDE。".to_string(),
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
        "fs_delete" => "fs.delete".to_string(),
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
    if system_instruction.contains("<ANSWER")
        && !request_mentions_temp_lifecycle(user_prompt)
        && !request_mentions_local_workspace(user_prompt)
    {
        return LlmChatOutput {
            content: "<ANSWER format=\"markdown\" version=\"1\">\n我是 DeepCode 的本地 Agent。我的会话协议由 Kernel 约束：纯问答会直接回答，需要上下文时会请求 ResourceRequest，需要执行时会生成可审查的 ACTION_BUNDLE，并由 Kernel 权限系统控制工具执行。\n</ANSWER>".to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_accepts_answer_only() {
        let parsed = parse_agent_plan_response(
            "session-1",
            "run-1",
            "<ANSWER format=\"markdown\" version=\"1\">\n我是 DeepCode。\n</ANSWER>",
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
            "<RESOURCE_REQUEST format=\"json\" version=\"1\">\n{\"version\":\"1\",\"id\":\"rr-1\",\"reason\":\"need context\",\"items\":[{\"id\":\"item-1\",\"manifestEntryId\":\"file-readme\",\"reason\":\"read README\"}]}\n</RESOURCE_REQUEST>",
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
            "<ANSWER format=\"markdown\" version=\"1\">ok</ANSWER>\n<USER_PLAN>plan</USER_PLAN>",
        )
        .unwrap_err();
        assert!(error.contains("ANSWER cannot appear"));
    }

    #[test]
    fn parser_rejects_action_params_field() {
        let content = "<USER_PLAN>\nplan\n</USER_PLAN>\n\
            <ACTION_BUNDLE format=\"json\" version=\"1\">\n\
            {\"version\":\"1\",\"id\":\"plan-1\",\"goal\":\"test\",\"actions\":[{\"id\":\"a1\",\"title\":\"bad\",\"capability\":\"workspace.read\",\"kind\":\"read\",\"resourceScope\":[\"README.md\"],\"params\":{\"path\":\"README.md\"}}],\"validationExpectations\":[],\"reviewExpectations\":[]}\n\
            </ACTION_BUNDLE>\n\
            <EXPECTED_VALIDATION>none</EXPECTED_VALIDATION>\n\
            <REVIEW_GUIDE>review</REVIEW_GUIDE>";
        let error = parse_agent_plan_response("session-1", "run-1", content).unwrap_err();
        assert!(error.contains("unknown field params"));
    }

    #[test]
    fn provider_name_roundtrip_includes_delete() {
        assert_eq!(internal_tool_name("fs_delete"), "fs.delete");
    }
}
