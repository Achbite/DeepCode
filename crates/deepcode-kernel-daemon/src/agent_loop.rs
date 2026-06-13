#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;
use deepcode_kernel_abi::LlmProviderDiagnostic;
use std::collections::{BTreeMap, BTreeSet};
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
const SESSION_SHORT_MEMORY_MAX_CHARS: usize = 12_000;
const SESSION_SHORT_MEMORY_MAX_USER_TURNS: usize = 6;
const SESSION_SHORT_MEMORY_MAX_ASSISTANT_SUMMARIES: usize = 4;
const SESSION_SHORT_MEMORY_MAX_ATTACHMENTS: usize = 12;
const SESSION_SHORT_MEMORY_MAX_TEXT_CHARS: usize = 700;
const SESSION_RESOURCE_CONTEXT_MAX_CHARS: usize = 28_000;
const SESSION_RESOURCE_CONTEXT_MAX_ITEMS: usize = 12;
const SESSION_RESOURCE_CONTEXT_MAX_OUTPUT_CHARS: usize = 8_000;
const INTERNAL_READ_ONLY_MAX_ADVANCES: usize = 6;
// Legacy compatibility path only. New DriverLoop work must keep provider-facing
// prompt, repair, and AgentProtocolParser authority in userspace/session-core.
const AGENT_PROTOCOL_SCHEMA_VERSION: &str = "deepcode.agent.protocol.v2";
const READ_ONLY_DUPLICATE_RESOURCE_MESSAGE: &str = "当前只读探索计划只请求了本轮已经读取或搜索过的资源，Agent 已停止继续重复读取。请补充新的目录、文件、搜索词，或缩小需要分析的问题范围。";

#[derive(Debug, Clone)]
struct ReadOnlyContinuationSeed {
    profile: ResolvedLlmProfile,
    request_envelope: Value,
    event_session_id: Option<deepcode_kernel_abi::SessionId>,
}

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
                "### ATTACHMENTS manifest\n```json\n{manifest}\n```\nUse these explicit user attachments before guessing unresolved file or directory references."
            ),
        );
    }
    parts.join("\n\n")
}

fn request_envelope_with_session_short_memory(
    state: &AppState,
    session_id: &str,
    phase: &str,
    request_envelope: &Value,
) -> Value {
    if phase != "plan" {
        return request_envelope.clone();
    }
    let memory = build_session_short_memory_context(&session_projection(state, session_id));
    if memory.trim().is_empty() {
        return request_envelope.clone();
    }

    let mut next = request_envelope.clone();
    let Some(messages) = next.get_mut("messages").and_then(Value::as_array_mut) else {
        return request_envelope.clone();
    };
    let Some(user_message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    else {
        return request_envelope.clone();
    };
    let Some(content) = user_message.get("content").and_then(Value::as_str) else {
        return request_envelope.clone();
    };
    user_message["content"] = json!(format!(
        "{}\n\n## Session short-term memory\n{}",
        content.trim_end(),
        memory
    ));
    next
}

fn request_envelope_with_session_memory_block(
    state: &AppState,
    session_id: &str,
    request_envelope: &Value,
) -> Value {
    let memory = build_session_short_memory_context(&session_projection(state, session_id));
    if memory.trim().is_empty() {
        return request_envelope.clone();
    }
    append_user_context_block(request_envelope, "Session short-term memory", &memory)
}

fn read_only_analysis_request_envelope(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    request_envelope: &Value,
) -> Value {
    let mut next = request_envelope_with_session_memory_block(state, session_id, request_envelope);
    let system_prompt = read_only_analysis_system_prompt();
    set_system_message(&mut next, &system_prompt);
    let coverage = collect_read_only_coverage(state, run_id);
    if let Some(object) = next.as_object_mut() {
        object.insert("tools".to_string(), json!([]));
        object.insert(
            "readOnlyAnalysisLoop".to_string(),
            json!({
                "runId": run_id,
                "toolResultSource": "Kernel ToolCompleted events",
                "allowedPlanCapabilities": ["workspace.read", "workspace.search"],
                "coveredResources": coverage.as_json()
            }),
        );
    }
    let resource_context = build_session_resource_context(state, run_id);
    if resource_context.trim().is_empty() {
        return append_user_context_block(
            &next,
            "Read-only exploration state",
            "No Kernel read-only tool output has been collected yet. If more context is needed, request a bounded read-only actionBundle; otherwise answer from the available user message and memory.",
        );
    }
    append_user_context_block(&next, "Session resource context", &resource_context)
}

fn read_only_analysis_system_prompt() -> String {
    format!(
        "Return exactly one JSON object using schemaVersion \"{AGENT_PROTOCOL_SCHEMA_VERSION}\". Choose exactly one kind: \"answer\", \"resourceRequest\", or \"actionBundle\".\n\
kind=\"answer\" requires top-level answer={{\"format\":\"markdown\",\"content\":\"...\"}}.\n\
kind=\"resourceRequest\" requires top-level resourceRequest with version=\"1\", non-empty id/reason, and items[].id/items[].manifestEntryId/items[].reason.\n\
resourceRequest manifestEntryId values must reference ResourceManifest entry ids or protocol manifest handles. They must not be workspace paths. Use kind=\"actionBundle\" with workspace.read/workspace.search for concrete workspace paths, directories, files, or search queries.\n\
kind=\"actionBundle\" is allowed only for bounded read-only workspace context. actionBundle.version must be string \"1\". actionBundle.actions must be an array. actionBundle.validationExpectations and actionBundle.reviewExpectations must both be arrays, even when empty. Each action must include non-empty id/title/capability/kind and resourceScope as a string array.\n\
Allowed read-only action pairs: capability=\"workspace.read\" with kind=\"list\" or kind=\"read\"; capability=\"workspace.search\" with kind=\"search\". Kernel execution maps those pairs to fs.list, fs.read, and code.search. Do not use executor tool names as capabilities.\n\
Do not write, delete, execute processes, use network, mutate Git, or control the browser in this read-only loop. Do not put actions at the top level. Do not add params/input/command/script/path/content fields inside actions.\n\
Do not repeat a path, directory, or search query already listed in coveredResources or Session resource context. If no new read-only resource is needed, return kind=\"answer\". Output only the JSON object; do not include Markdown wrappers, code fences, or explanatory preambles."
    )
}

fn read_only_action_bundle_example() -> &'static str {
    "{\"schemaVersion\":\"deepcode.agent.protocol.v2\",\"kind\":\"actionBundle\",\"outputLanguage\":\"en-US\",\"userPlan\":\"Collect bounded read-only workspace context.\",\"actionBundle\":{\"version\":\"1\",\"id\":\"read-only-context\",\"goal\":\"Collect read-only context\",\"actions\":[{\"id\":\"list-scope\",\"title\":\"List workspace scope\",\"capability\":\"workspace.read\",\"kind\":\"list\",\"resourceScope\":[\".\"]},{\"id\":\"read-scope\",\"title\":\"Read workspace resource\",\"capability\":\"workspace.read\",\"kind\":\"read\",\"resourceScope\":[\".\"]},{\"id\":\"search-scope\",\"title\":\"Search workspace text\",\"capability\":\"workspace.search\",\"kind\":\"search\",\"resourceScope\":[\".\"]}],\"validationExpectations\":[],\"reviewExpectations\":[]},\"expectedValidation\":\"Kernel records read-only observations.\",\"reviewGuide\":\"Use collected observations to answer.\"}"
}

fn append_user_context_block(request_envelope: &Value, heading: &str, block: &str) -> Value {
    let mut next = request_envelope.clone();
    let Some(messages) = next.get_mut("messages").and_then(Value::as_array_mut) else {
        return request_envelope.clone();
    };
    let Some(user_message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    else {
        return request_envelope.clone();
    };
    let Some(content) = user_message.get("content").and_then(Value::as_str) else {
        return request_envelope.clone();
    };
    user_message["content"] = json!(format!(
        "{}\n\n## {heading}\n{}",
        content.trim_end(),
        block.trim()
    ));
    next
}

fn set_system_message(request_envelope: &mut Value, content: &str) {
    let Some(messages) = request_envelope
        .get_mut("messages")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    if let Some(system_message) = messages
        .iter_mut()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("system"))
    {
        system_message["content"] = json!(content);
    }
}

fn build_session_short_memory_context(events: &[Value]) -> String {
    let prior_events = match events
        .iter()
        .rposition(|event| event_kind(event) == Some("user_msg"))
    {
        Some(index) => &events[..index],
        None => events,
    };
    if prior_events.is_empty() {
        return String::new();
    }

    let mut sections = vec![
        "### Session memory document".to_string(),
        "This rolling document is reconstructed from persisted session state. The model maintains recent semantic context from it; it is not a policy source and cannot override Kernel protocol, permissions, or tool facts.".to_string(),
    ];
    let mut seen_user_turns = BTreeSet::new();
    let mut user_turns = Vec::new();
    for event in prior_events
        .iter()
        .filter(|event| event_kind(event) == Some("user_msg"))
        .rev()
    {
        if !seen_user_turns.insert(user_turn_memory_key(event)) {
            continue;
        }
        user_turns.push(event);
        if user_turns.len() >= SESSION_SHORT_MEMORY_MAX_USER_TURNS {
            break;
        }
    }
    user_turns.reverse();
    if !user_turns.is_empty() {
        let mut lines = vec!["### Recent user turns".to_string()];
        for (index, event) in user_turns.iter().enumerate() {
            let content = event_payload_text(event)
                .map(|text| clip_chars(&text, SESSION_SHORT_MEMORY_MAX_TEXT_CHARS))
                .unwrap_or_default();
            lines.push(format!("{}. {}", index + 1, content));
            let attachments = attachment_summaries_from_event(event);
            if !attachments.is_empty() {
                lines.push(format!("   Attachments: {}", attachments.join("; ")));
            }
        }
        sections.push(lines.join("\n"));
    }

    let mut assistant_summaries = prior_events
        .iter()
        .filter(|event| {
            event_kind(event) == Some("review_summary")
                || (event_kind(event) == Some("assistant_msg")
                    && event_channel(event).unwrap_or("final") == "final")
        })
        .rev()
        .filter_map(event_payload_text)
        .take(SESSION_SHORT_MEMORY_MAX_ASSISTANT_SUMMARIES)
        .collect::<Vec<_>>();
    assistant_summaries.reverse();
    if !assistant_summaries.is_empty() {
        let mut lines = vec!["### Recent assistant summaries".to_string()];
        for summary in assistant_summaries {
            lines.push(format!(
                "- {}",
                clip_chars(&summary, SESSION_SHORT_MEMORY_MAX_TEXT_CHARS)
            ));
        }
        sections.push(lines.join("\n"));
    }

    let attachments = recent_attachment_summaries(prior_events);
    if !attachments.is_empty() {
        let mut lines = vec!["### Recent explicit attachments".to_string()];
        for attachment in attachments
            .iter()
            .take(SESSION_SHORT_MEMORY_MAX_ATTACHMENTS)
        {
            lines.push(format!("- {}", attachment.summary));
        }
        sections.push(lines.join("\n"));
    }

    clip_chars_hard(&sections.join("\n\n"), SESSION_SHORT_MEMORY_MAX_CHARS)
}

fn user_turn_memory_key(event: &Value) -> String {
    let content = event_payload_text(event)
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    let mut attachments = event_payload_attachments(event)
        .into_iter()
        .map(|attachment| {
            let kind = attachment
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("file");
            let path = attachment_display_path(&attachment);
            let absolute_path = attachment
                .get("absolutePath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let source = attachment
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let scope = attachment
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("{kind}\u{1f}{path}\u{1f}{absolute_path}\u{1f}{source}\u{1f}{scope}")
        })
        .collect::<Vec<_>>();
    attachments.sort();
    format!("{content}\u{1e}{}", attachments.join("\u{1e}"))
}

#[derive(Debug, Clone)]
struct RecentAttachmentSummary {
    summary: String,
}

fn recent_attachment_summaries(events: &[Value]) -> Vec<RecentAttachmentSummary> {
    let mut seen = BTreeSet::new();
    let mut attachments = Vec::new();
    for event in events.iter().rev() {
        if event_kind(event) != Some("user_msg") {
            continue;
        }
        for attachment in event_payload_attachments(event).into_iter().rev() {
            let kind = attachment
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("file")
                .to_string();
            let path = attachment_display_path(&attachment);
            let absolute_path = attachment
                .get("absolutePath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let key = format!("{kind}\u{1f}{path}\u{1f}{absolute_path}");
            if !seen.insert(key) {
                continue;
            }
            let source = attachment
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let scope = attachment
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("message");
            let summary = if absolute_path.is_empty() {
                format!("{kind} {path} [source={source}, scope={scope}]")
            } else {
                format!(
                    "{kind} {path} [absolutePath={absolute_path}, source={source}, scope={scope}]"
                )
            };
            attachments.push(RecentAttachmentSummary { summary });
            if attachments.len() >= SESSION_SHORT_MEMORY_MAX_ATTACHMENTS {
                return attachments;
            }
        }
    }
    attachments
}

fn attachment_summaries_from_event(event: &Value) -> Vec<String> {
    event_payload_attachments(event)
        .into_iter()
        .map(|attachment| {
            let kind = attachment
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("file");
            format!("{kind} {}", attachment_display_path(&attachment))
        })
        .collect()
}

fn event_payload_attachments(event: &Value) -> Vec<Value> {
    event
        .get("payload")
        .and_then(|payload| payload.get("attachments"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn attachment_display_path(attachment: &Value) -> String {
    attachment
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .or_else(|| attachment.get("absolutePath").and_then(Value::as_str))
        .unwrap_or(".")
        .to_string()
}

fn clip_chars_hard(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let marker = "\n\n[... truncated ...]";
    let marker_chars = marker.chars().count();
    let keep = max_chars.saturating_sub(marker_chars);
    format!("{}{}", text.chars().take(keep).collect::<String>(), marker)
}

fn event_payload_text(event: &Value) -> Option<String> {
    let payload = event.get("payload")?;
    ["content", "summary", "message"].iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn event_kind(event: &Value) -> Option<&str> {
    event.get("kind").and_then(Value::as_str)
}

fn event_channel(event: &Value) -> Option<&str> {
    event
        .get("payload")
        .and_then(|payload| payload.get("channel"))
        .and_then(Value::as_str)
}

fn is_review_channel_assistant_event(event: &Value) -> bool {
    event_kind(event) == Some("assistant_msg") && event_channel(event) == Some("review")
}

fn resource_request_key(resource_request: &PendingAgentResourceRequest) -> String {
    let request = &resource_request.request;
    let version = request
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("1");
    let reason = request
        .get("reason")
        .and_then(Value::as_str)
        .map(normalize_resource_request_text)
        .unwrap_or_default();
    let mut items = request
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let manifest_entry_id = item
                        .get("manifestEntryId")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let item_reason = item
                        .get("reason")
                        .and_then(Value::as_str)
                        .map(normalize_resource_request_text)
                        .unwrap_or_default();
                    format!("{manifest_entry_id}:{item_reason}")
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    items.sort();
    format!("{version}|{reason}|{}", items.join("|"))
}

fn read_only_plan_key(plan: &PendingAgentPlan) -> String {
    let actions = plan
        .action_bundle
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut parts = actions
        .iter()
        .map(|action| {
            let capability = action
                .get("capability")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let kind = action
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let scope = action
                .get("resourceScope")
                .and_then(Value::as_array)
                .map(|items| {
                    let mut values = items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(normalize_resource_request_text)
                        .collect::<Vec<_>>();
                    values.sort();
                    values.join(",")
                })
                .unwrap_or_default();
            format!("{capability}:{kind}:{scope}")
        })
        .collect::<Vec<_>>();
    parts.sort();
    parts.join("|")
}

fn read_only_plan_covered_by_context(plan: &PendingAgentPlan, coverage: &ReadOnlyCoverage) -> bool {
    let keys = read_only_plan_resource_keys(plan);
    !keys.is_empty() && keys.iter().all(|key| coverage.contains_key(key))
}

fn read_only_plan_resource_keys(plan: &PendingAgentPlan) -> BTreeSet<String> {
    let actions = plan
        .action_bundle
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut keys = BTreeSet::new();
    for action in actions {
        let capability = action
            .get("capability")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let kind = action
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let scopes = action
            .get("resourceScope")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for scope in scopes.iter().filter_map(Value::as_str) {
            let scope = scope.trim();
            if scope.is_empty() {
                continue;
            }
            match capability {
                "workspace.read" => {
                    let path = normalize_coverage_value(scope);
                    let tool = if kind == "list" { "fs.list" } else { "fs.read" };
                    keys.insert(format!("{tool}:{path}"));
                }
                "workspace.search" | "code.search" => {
                    let query = normalize_search_scope(scope);
                    if !query.is_empty() {
                        keys.insert(format!("code.search:{query}"));
                    }
                }
                _ => {}
            }
        }
    }
    keys
}

fn normalize_resource_request_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn build_session_resource_context(state: &AppState, run_id: &str) -> String {
    let events = state
        .kernel_events
        .lock()
        .expect("kernel event stream lock")
        .clone();
    let coverage = collect_read_only_coverage_from_events(&events, run_id);
    let mut requested_args = BTreeMap::<String, Value>::new();
    for event in &events {
        if event_run_id(event).as_deref() != Some(run_id) {
            continue;
        }
        if let KernelEvent::ToolRequested {
            tool_call_id,
            tool_name,
            args_preview,
            ..
        } = event
        {
            if read_only_context_tool(tool_name) {
                requested_args.insert(tool_call_id.clone(), args_preview.clone());
            }
        }
    }

    let mut blocks = vec![
        "### ResourcePacket from Kernel read-only tool output".to_string(),
        "Use these observations as concrete workspace facts. Each item is clipped and may need follow-up reads if more detail is required.".to_string(),
    ];
    if !coverage.is_empty() {
        blocks.push(coverage.render_markdown());
    }
    let mut count = 0_usize;
    for event in events {
        if count >= SESSION_RESOURCE_CONTEXT_MAX_ITEMS {
            blocks.push(format!(
                "[truncated: more than {SESSION_RESOURCE_CONTEXT_MAX_ITEMS} read-only observations]"
            ));
            break;
        }
        if event_run_id(&event).as_deref() != Some(run_id) {
            continue;
        }
        let KernelEvent::ToolCompleted {
            tool_call_id,
            tool_name,
            ok,
            output,
            error,
            ..
        } = event
        else {
            continue;
        };
        if !read_only_context_tool(&tool_name) {
            continue;
        }
        count += 1;
        let args = requested_args
            .get(&tool_call_id)
            .cloned()
            .unwrap_or_else(|| json!({}));
        blocks.push(render_resource_observation(
            count,
            &tool_call_id,
            &tool_name,
            ok,
            &args,
            output.as_ref(),
            error.as_ref().map(|value| value.message.as_str()),
        ));
    }
    if count == 0 {
        return String::new();
    }
    clip_chars_hard(&blocks.join("\n\n"), SESSION_RESOURCE_CONTEXT_MAX_CHARS)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ReadOnlyCoverage {
    listed_paths: BTreeSet<String>,
    read_paths: BTreeSet<String>,
    searched_queries: BTreeSet<String>,
    failed_keys: BTreeSet<String>,
}

impl ReadOnlyCoverage {
    fn is_empty(&self) -> bool {
        self.listed_paths.is_empty()
            && self.read_paths.is_empty()
            && self.searched_queries.is_empty()
            && self.failed_keys.is_empty()
    }

    fn contains_key(&self, key: &str) -> bool {
        let Some((tool, value)) = key.split_once(':') else {
            return false;
        };
        let covered = match tool {
            "fs.list" => self.listed_paths.contains(value),
            "fs.read" => self.read_paths.contains(value),
            "code.search" => self.searched_queries.contains(value),
            _ => false,
        };
        covered || self.failed_keys.contains(key)
    }

    fn as_json(&self) -> Value {
        json!({
            "fs.list": self.listed_paths.iter().cloned().collect::<Vec<_>>(),
            "fs.read": self.read_paths.iter().cloned().collect::<Vec<_>>(),
            "code.search": self.searched_queries.iter().cloned().collect::<Vec<_>>(),
            "failed": self.failed_keys.iter().cloned().collect::<Vec<_>>()
        })
    }

    fn render_markdown(&self) -> String {
        let mut lines = vec!["### Covered read-only resources".to_string()];
        if !self.listed_paths.is_empty() {
            lines.push(format!(
                "- fs.list: {}",
                self.listed_paths
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !self.read_paths.is_empty() {
            lines.push(format!(
                "- fs.read: {}",
                self.read_paths
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !self.searched_queries.is_empty() {
            lines.push(format!(
                "- code.search: {}",
                self.searched_queries
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !self.failed_keys.is_empty() {
            lines.push(format!(
                "- failed: {}",
                self.failed_keys
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        lines.join("\n")
    }
}

fn collect_read_only_coverage(state: &AppState, run_id: &str) -> ReadOnlyCoverage {
    let events = state
        .kernel_events
        .lock()
        .expect("kernel event stream lock")
        .clone();
    collect_read_only_coverage_from_events(&events, run_id)
}

fn collect_read_only_coverage_from_events(
    events: &[KernelEvent],
    run_id: &str,
) -> ReadOnlyCoverage {
    let mut requested_args = BTreeMap::<String, Value>::new();
    for event in events {
        if event_run_id(event).as_deref() != Some(run_id) {
            continue;
        }
        if let KernelEvent::ToolRequested {
            tool_call_id,
            tool_name,
            args_preview,
            ..
        } = event
        {
            if read_only_context_tool(tool_name) {
                requested_args.insert(tool_call_id.clone(), args_preview.clone());
            }
        }
    }

    let mut coverage = ReadOnlyCoverage::default();
    for event in events {
        if event_run_id(event).as_deref() != Some(run_id) {
            continue;
        }
        let KernelEvent::ToolCompleted {
            tool_call_id,
            tool_name,
            ok,
            output,
            ..
        } = event
        else {
            continue;
        };
        if !read_only_context_tool(tool_name) {
            continue;
        }
        let args = requested_args.get(tool_call_id);
        if !ok {
            if let Some(key) = read_only_tool_coverage_key(tool_name, output.as_ref(), args) {
                coverage.failed_keys.insert(key);
            }
            continue;
        }
        match tool_name.as_str() {
            "fs.list" => {
                if let Some(path) = output
                    .as_ref()
                    .and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
                    .or_else(|| {
                        args.and_then(|value| value.get("path"))
                            .and_then(Value::as_str)
                    })
                    .map(normalize_coverage_value)
                    .filter(|value| !value.is_empty())
                {
                    coverage.listed_paths.insert(path);
                }
            }
            "fs.read" => {
                if let Some(path) = output
                    .as_ref()
                    .and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
                    .or_else(|| {
                        args.and_then(|value| value.get("path"))
                            .and_then(Value::as_str)
                    })
                    .map(normalize_coverage_value)
                    .filter(|value| !value.is_empty())
                {
                    coverage.read_paths.insert(path);
                }
            }
            "code.search" => {
                if let Some(query) = output
                    .as_ref()
                    .and_then(|value| value.get("query"))
                    .and_then(Value::as_str)
                    .or_else(|| {
                        args.and_then(|value| value.get("query"))
                            .and_then(Value::as_str)
                    })
                    .map(normalize_search_scope)
                    .filter(|value| !value.is_empty())
                {
                    coverage.searched_queries.insert(query);
                }
            }
            _ => {}
        }
    }
    coverage
}

fn read_only_tool_coverage_key(
    tool_name: &str,
    output: Option<&Value>,
    args: Option<&Value>,
) -> Option<String> {
    match tool_name {
        "fs.list" | "fs.read" => output
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
            .or_else(|| {
                args.and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
            })
            .map(normalize_coverage_value)
            .filter(|value| !value.is_empty())
            .map(|path| format!("{tool_name}:{path}")),
        "code.search" => output
            .and_then(|value| value.get("query"))
            .and_then(Value::as_str)
            .or_else(|| {
                args.and_then(|value| value.get("query"))
                    .and_then(Value::as_str)
            })
            .map(normalize_search_scope)
            .filter(|value| !value.is_empty())
            .map(|query| format!("code.search:{query}")),
        _ => None,
    }
}

fn normalize_coverage_value(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    while normalized.starts_with("./") {
        normalized = normalized[2..].to_string();
    }
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

fn normalize_search_scope(value: &str) -> String {
    normalize_resource_request_text(
        value
            .trim()
            .strip_prefix("search:")
            .or_else(|| value.trim().strip_prefix("symbol:"))
            .unwrap_or_else(|| value.trim()),
    )
}

fn render_resource_observation(
    index: usize,
    tool_call_id: &str,
    tool_name: &str,
    ok: bool,
    args: &Value,
    output: Option<&Value>,
    error: Option<&str>,
) -> String {
    let mut lines = vec![
        format!("#### Observation {index}: {tool_name}"),
        format!("- toolCallId: {tool_call_id}"),
        format!("- status: {}", if ok { "ok" } else { "error" }),
    ];
    if !args.is_null() {
        lines.push(format!("- arguments: {}", compact_json(args)));
    }
    if let Some(error) = error {
        lines.push(format!("- error: {}", clip_chars(error, 600)));
    }
    if let Some(output) = output {
        if let Some(path) = output.get("path").and_then(Value::as_str) {
            lines.push(format!("- path: {path}"));
        }
        if let Some(query) = output.get("query").and_then(Value::as_str) {
            lines.push(format!("- query: {query}"));
        }
        let (kind, content) = resource_observation_content(tool_name, output);
        lines.push(format!("- contentKind: {kind}"));
        lines.push(format!(
            "```text\n{}\n```",
            clip_chars(&content, SESSION_RESOURCE_CONTEXT_MAX_OUTPUT_CHARS)
        ));
    }
    lines.join("\n")
}

fn resource_observation_content(tool_name: &str, output: &Value) -> (&'static str, String) {
    match tool_name {
        "fs.read" => (
            "fileText",
            output
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
        "fs.list" => (
            "directoryTree",
            output
                .get("nodes")
                .map(pretty_json)
                .unwrap_or_else(|| pretty_json(output)),
        ),
        "code.search" => (
            "searchResults",
            output
                .get("matches")
                .map(pretty_json)
                .unwrap_or_else(|| pretty_json(output)),
        ),
        _ => ("json", pretty_json(output)),
    }
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn read_only_context_tool(tool_name: &str) -> bool {
    matches!(tool_name, "fs.list" | "fs.read" | "code.search")
}

fn visible_kernel_events_for_session(
    events: &[KernelEvent],
    internal_read_only_runs: &BTreeSet<String>,
) -> Vec<KernelEvent> {
    events
        .iter()
        .filter(|event| {
            let internal_read_only = event_run_id(event)
                .as_deref()
                .map(|run_id| internal_read_only_runs.contains(run_id))
                .unwrap_or(false);
            if !internal_read_only {
                return true;
            }
            !matches!(
                event,
                KernelEvent::PlanReviewReportProduced { .. }
                    | KernelEvent::PlanAccepted { .. }
                    | KernelEvent::PlanRejected { .. }
                    | KernelEvent::WorkflowDecisionMade { .. }
            )
        })
        .cloned()
        .collect()
}

fn internal_read_only_observation_run(
    events: &[KernelEvent],
    internal_read_only_runs: &BTreeSet<String>,
) -> Option<String> {
    events.iter().find_map(|event| {
        let KernelEvent::ToolCompleted {
            run_id: Some(run_id),
            tool_name,
            ..
        } = event
        else {
            return None;
        };
        if internal_read_only_runs.contains(&run_id.0) && read_only_context_tool(tool_name) {
            Some(run_id.0.clone())
        } else {
            None
        }
    })
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
    if let Some(binding) = request.workspace_binding.as_ref() {
        let _ = ensure_workspace_binding(&state.runtime, Some(binding));
    }

    let binding = effective_workspace_binding(&state.runtime, request.workspace_binding.clone());
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
                workspace_binding: binding,
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
    // Legacy agent brain retained until the Session DriverLoop v3 path can run
    // end-to-end. Do not add new prompt/parser/plan authority here.
    let mut seen_resource_requests = BTreeSet::new();
    let mut internal_read_only_runs = BTreeSet::new();
    let mut seen_internal_read_only_plan_keys = BTreeSet::new();
    let mut read_only_continuation_seeds = BTreeMap::<String, ReadOnlyContinuationSeed>::new();
    let mut internal_read_only_advances = 0_usize;
    loop {
        record_kernel_events(state, &kernel_events);
        let visible_kernel_events =
            visible_kernel_events_for_session(&kernel_events, &internal_read_only_runs);
        append_session_projection(
            state,
            session_id,
            kernel_events_to_agent_events(session_id, &visible_kernel_events),
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
            if let Some(run_id) =
                internal_read_only_observation_run(&kernel_events, &internal_read_only_runs)
            {
                if let Some(seed) = read_only_continuation_seeds.get(&run_id).cloned() {
                    let continuation_events = continue_read_only_analysis_loop(
                        state,
                        session_id,
                        &run_id,
                        seed,
                        &mut seen_resource_requests,
                        &mut seen_internal_read_only_plan_keys,
                        &mut internal_read_only_runs,
                        &mut read_only_continuation_seeds,
                        &mut internal_read_only_advances,
                    )
                    .await?;
                    if !continuation_events.is_empty() {
                        kernel_events = continuation_events;
                        continue;
                    }
                }
            }
            return Ok(());
        }

        let mut next_events = Vec::new();
        for (run_id, event_session_id, phase, llm_call_id, profile_ref, request_envelope) in
            llm_requests
        {
            let raw_request_envelope = request_envelope.clone();
            let profile = resolve_kernel_llm_profile(state, profile_ref.as_ref())?;
            let read_only_analysis_mode = phase == "review"
                && internal_read_only_runs.contains(&run_id.0)
                && !has_pending_review_for_run(state, &run_id.0);
            let request_envelope = if read_only_analysis_mode {
                read_only_analysis_request_envelope(state, session_id, &run_id.0, &request_envelope)
            } else {
                request_envelope_with_session_short_memory(
                    state,
                    session_id,
                    &phase,
                    &request_envelope,
                )
            };
            append_trace_event(
                state,
                session_id,
                "llm.requested",
                json!({
                    "stage": phase,
                    "llmCallId": llm_call_id,
                    "profileId": profile.id,
                    "model": profile.model,
                    "effectiveMaxOutputTokens": effective_profile_max_output_tokens_for_trace(&profile),
                    "toolCount": request_envelope
                        .get("tools")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0),
                    "requestEnvelope": request_envelope.clone()
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
            let response_envelope = llm_output_payload(output);
            append_trace_event(
                state,
                session_id,
                "llm.completed",
                json!({
                    "stage": phase,
                    "llmCallId": llm_call_id,
                    "profileId": profile.id,
                    "contentBytes": response_envelope
                        .pointer("/assistantMessage/content")
                        .or_else(|| response_envelope.get("content"))
                        .and_then(Value::as_str)
                        .map(str::len)
                        .unwrap_or(0),
                    "toolCallCount": response_envelope
                        .get("toolCalls")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0),
                    "responseEnvelope": response_envelope.clone()
                }),
            );
            if read_only_analysis_mode {
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
                        let submitted = {
                            let mut runtime = state.runtime.lock().expect("kernel runtime lock");
                            runtime
                                .dispatch(KernelCommand::LlmResponseSubmit {
                                    request_id: rid("llm-read-only-analysis-submit"),
                                    run_id: run_id.clone(),
                                    session_id: event_session_id.clone(),
                                    llm_call_id,
                                    response_envelope: response_envelope.clone(),
                                })
                                .map_err(|error| error.to_string())?
                        };
                        record_kernel_events(state, &submitted);
                        let mut projection = kernel_events_to_agent_events(session_id, &submitted);
                        projection.retain(|event| !is_review_channel_assistant_event(event));
                        append_session_projection(state, session_id, projection);
                        append_session_projection(
                            state,
                            session_id,
                            vec![answer_event(session_id, &run_id.0, &answer)],
                        );
                    }
                    Ok(AgentPlanResponse::ResourceRequest(resource_request)) => {
                        let key = resource_request_key(&resource_request);
                        let event = if seen_resource_requests.insert(key) {
                            resource_request_event(session_id, &run_id.0, &resource_request)
                        } else {
                            assistant_final_event(
                                session_id,
                                "当前资源请求与本轮前一次请求重复，Agent 已停止继续重复请求。请补充一个更明确的文件、目录或操作目标。",
                            )
                        };
                        append_session_projection(state, session_id, vec![event]);
                    }
                    Ok(AgentPlanResponse::ActionPlan(mut plan)) => {
                        let review_events = {
                            let mut runtime = state.runtime.lock().expect("kernel runtime lock");
                            runtime
                                .dispatch(KernelCommand::PlanContractSubmit {
                                    request_id: rid("agent-read-only-analysis-plan-review"),
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
                        if should_internally_advance_read_only_plan(&plan) {
                            let coverage = collect_read_only_coverage(state, &run_id.0);
                            if read_only_plan_covered_by_context(&plan, &coverage) {
                                append_session_projection(
                                    state,
                                    session_id,
                                    vec![assistant_final_event(
                                        session_id,
                                        READ_ONLY_DUPLICATE_RESOURCE_MESSAGE,
                                    )],
                                );
                                continue;
                            }
                            let key = read_only_plan_key(&plan);
                            if !seen_internal_read_only_plan_keys.insert(key) {
                                append_session_projection(
                                    state,
                                    session_id,
                                    vec![assistant_final_event(
                                        session_id,
                                        "当前只读探索计划与本轮前一次计划重复，Agent 已停止继续重复读取。请补充更明确的分析目标或资源范围。",
                                    )],
                                );
                                continue;
                            }
                            if internal_read_only_advances >= INTERNAL_READ_ONLY_MAX_ADVANCES {
                                append_session_projection(
                                    state,
                                    session_id,
                                    vec![assistant_final_event(
                                        session_id,
                                        "只读探索已达到本轮上下文预算上限，Agent 已停止继续读取。请缩小问题范围或指定需要分析的模块。",
                                    )],
                                );
                                continue;
                            }
                            internal_read_only_advances += 1;
                            record_kernel_events(state, &review_events);
                            append_trace_event(
                                state,
                                session_id,
                                "agent.read_only_plan.internal_accept",
                                json!({
                                    "runId": &plan.run_id,
                                    "planId": &plan.plan_id,
                                    "capabilities": plan_review_required_capabilities(&plan),
                                    "advanceCount": internal_read_only_advances
                                }),
                            );
                            internal_read_only_runs.insert(plan.run_id.clone());
                            read_only_continuation_seeds.insert(
                                plan.run_id.clone(),
                                ReadOnlyContinuationSeed {
                                    profile: profile.clone(),
                                    request_envelope: raw_request_envelope.clone(),
                                    event_session_id: event_session_id.clone(),
                                },
                            );
                            let attachments =
                                latest_user_attachments_for_session(state, session_id);
                            let approved_tools =
                                approved_tool_calls_for_pending_plan_with_attachments(
                                    &plan,
                                    &attachments,
                                );
                            if approved_tools.is_empty() {
                                append_session_projection(
                                    state,
                                    session_id,
                                    vec![assistant_final_event(
                                        session_id,
                                        "只读探索计划未能映射为 Kernel 只读工具调用，Agent 已停止执行该计划。",
                                    )],
                                );
                                continue;
                            }
                            let accept_events = {
                                let mut runtime =
                                    state.runtime.lock().expect("kernel runtime lock");
                                runtime
                                    .enqueue_approved_tool_calls(&plan.run_id, approved_tools)
                                    .map_err(|error| error.to_string())?;
                                runtime
                                    .dispatch(KernelCommand::PlanAccept {
                                        request_id: rid("agent-read-only-analysis-auto-accept"),
                                        run_id: run_id.clone(),
                                        plan_id: plan.plan_id.clone(),
                                    })
                                    .map_err(|error| error.to_string())?
                            };
                            next_events.extend(accept_events);
                        } else {
                            record_kernel_events(state, &review_events);
                            append_session_projection(
                                state,
                                session_id,
                                kernel_events_to_agent_events(session_id, &review_events),
                            );
                            append_session_projection(
                                state,
                                session_id,
                                vec![plan_card_event(session_id, &plan)],
                            );
                            {
                                let mut gui = state.gui.lock().expect("gui state lock");
                                gui.pending_plans.insert(plan.plan_id.clone(), plan.clone());
                            }
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
                continue;
            }
            let submitted = {
                let mut runtime = state.runtime.lock().expect("kernel runtime lock");
                runtime
                    .dispatch(KernelCommand::LlmResponseSubmit {
                        request_id: rid("llm-response-submit"),
                        run_id: run_id.clone(),
                        session_id: event_session_id.clone(),
                        llm_call_id,
                        response_envelope: response_envelope.clone(),
                    })
                    .map_err(|error| error.to_string())?
            };
            if phase == "plan" {
                let mut submitted = submitted;
                let mut internally_advanced_read_only_plan = false;
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
                        let key = resource_request_key(&resource_request);
                        let event = if seen_resource_requests.insert(key) {
                            resource_request_event(session_id, &run_id.0, &resource_request)
                        } else {
                            assistant_final_event(
                                session_id,
                                "当前资源请求与本轮前一次请求重复，Agent 已停止继续重复请求。请补充一个更明确的文件、目录或操作目标。",
                            )
                        };
                        append_session_projection(state, session_id, vec![event]);
                    }
                    Ok(AgentPlanResponse::ActionPlan(mut plan)) => {
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
                        if should_internally_advance_read_only_plan(&plan) {
                            let coverage = collect_read_only_coverage(state, &run_id.0);
                            if read_only_plan_covered_by_context(&plan, &coverage) {
                                append_session_projection(
                                    state,
                                    session_id,
                                    vec![assistant_final_event(
                                        session_id,
                                        READ_ONLY_DUPLICATE_RESOURCE_MESSAGE,
                                    )],
                                );
                                continue;
                            }
                            let key = read_only_plan_key(&plan);
                            if !seen_internal_read_only_plan_keys.insert(key) {
                                append_session_projection(
                                    state,
                                    session_id,
                                    vec![assistant_final_event(
                                        session_id,
                                        "当前只读探索计划与本轮前一次计划重复，Agent 已停止继续重复读取。请补充更明确的分析目标或资源范围。",
                                    )],
                                );
                                continue;
                            }
                            if internal_read_only_advances >= INTERNAL_READ_ONLY_MAX_ADVANCES {
                                append_session_projection(
                                    state,
                                    session_id,
                                    vec![assistant_final_event(
                                        session_id,
                                        "只读探索已达到本轮上下文预算上限，Agent 已停止继续读取。请缩小问题范围或指定需要分析的模块。",
                                    )],
                                );
                                continue;
                            }
                            internal_read_only_advances += 1;
                            record_kernel_events(state, &submitted);
                            record_kernel_events(state, &review_events);
                            append_trace_event(
                                state,
                                session_id,
                                "agent.read_only_plan.internal_accept",
                                json!({
                                    "runId": &plan.run_id,
                                    "planId": &plan.plan_id,
                                    "capabilities": plan_review_required_capabilities(&plan),
                                    "advanceCount": internal_read_only_advances
                                }),
                            );
                            internal_read_only_runs.insert(plan.run_id.clone());
                            read_only_continuation_seeds.insert(
                                plan.run_id.clone(),
                                ReadOnlyContinuationSeed {
                                    profile: profile.clone(),
                                    request_envelope: raw_request_envelope.clone(),
                                    event_session_id: event_session_id.clone(),
                                },
                            );
                            let attachments =
                                latest_user_attachments_for_session(state, session_id);
                            let approved_tools =
                                approved_tool_calls_for_pending_plan_with_attachments(
                                    &plan,
                                    &attachments,
                                );
                            if approved_tools.is_empty() {
                                append_session_projection(
                                    state,
                                    session_id,
                                    vec![assistant_final_event(
                                        session_id,
                                        "只读探索计划未能映射为 Kernel 只读工具调用，Agent 已停止执行该计划。",
                                    )],
                                );
                                continue;
                            }
                            let accept_events = {
                                let mut runtime =
                                    state.runtime.lock().expect("kernel runtime lock");
                                runtime
                                    .enqueue_approved_tool_calls(&plan.run_id, approved_tools)
                                    .map_err(|error| error.to_string())?;
                                runtime
                                    .dispatch(KernelCommand::PlanAccept {
                                        request_id: rid("agent-plan-auto-accept"),
                                        run_id: run_id.clone(),
                                        plan_id: plan.plan_id.clone(),
                                    })
                                    .map_err(|error| error.to_string())?
                            };
                            next_events.extend(accept_events);
                            internally_advanced_read_only_plan = true;
                        } else {
                            append_session_projection(
                                state,
                                session_id,
                                vec![plan_card_event(session_id, &plan)],
                            );
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
                    }
                    Err(error) => {
                        append_session_projection(
                            state,
                            session_id,
                            vec![plan_parse_error_event(session_id, &run_id.0, &error)],
                        );
                    }
                }
                if !internally_advanced_read_only_plan {
                    next_events.extend(submitted);
                }
                continue;
            }
            if phase == "review" {
                record_kernel_events(state, &submitted);
                let has_pending_review = has_pending_review_for_run(state, &run_id.0);
                let mut projection = kernel_events_to_agent_events(session_id, &submitted);
                if !has_pending_review {
                    projection.retain(|event| !is_review_channel_assistant_event(event));
                }
                append_session_projection(state, session_id, projection);
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

async fn continue_read_only_analysis_loop(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    seed: ReadOnlyContinuationSeed,
    seen_resource_requests: &mut BTreeSet<String>,
    seen_internal_read_only_plan_keys: &mut BTreeSet<String>,
    internal_read_only_runs: &mut BTreeSet<String>,
    read_only_continuation_seeds: &mut BTreeMap<String, ReadOnlyContinuationSeed>,
    internal_read_only_advances: &mut usize,
) -> Result<Vec<KernelEvent>, String> {
    let request_envelope =
        read_only_analysis_request_envelope(state, session_id, run_id, &seed.request_envelope);
    let llm_call_id = format!("llm-{run_id}-read-only-{}", now_millis());
    append_trace_event(
        state,
        session_id,
        "llm.requested",
        json!({
            "stage": "read_only_analysis",
            "llmCallId": llm_call_id,
            "profileId": seed.profile.id,
            "model": seed.profile.model,
            "effectiveMaxOutputTokens": effective_profile_max_output_tokens_for_trace(&seed.profile),
            "toolCount": request_envelope
                .get("tools")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0),
            "requestEnvelope": request_envelope.clone()
        }),
    );
    let output = match call_llm_profile(&seed.profile, request_envelope.clone()).await {
        Ok(output) => output,
        Err(error) => {
            append_trace_event(
                state,
                session_id,
                "llm.provider_error",
                json!({
                    "runId": run_id,
                    "phase": "read_only_analysis",
                    "llmCallId": llm_call_id,
                    "profileId": seed.profile.id,
                    "model": seed.profile.model,
                    "providerError": provider_error_value(&error)
                }),
            );
            append_session_projection(
                state,
                session_id,
                vec![assistant_final_event(
                    session_id,
                    "只读上下文已经读取，但继续分析时 LLM Provider 调用失败。请稍后重试，或缩小分析范围后再次发送。",
                )],
            );
            return Ok(Vec::new());
        }
    };
    let response_envelope = llm_output_payload(output);
    append_trace_event(
        state,
        session_id,
        "llm.completed",
        json!({
            "stage": "read_only_analysis",
            "llmCallId": llm_call_id,
            "profileId": seed.profile.id,
            "contentBytes": response_envelope
                .pointer("/assistantMessage/content")
                .or_else(|| response_envelope.get("content"))
                .and_then(Value::as_str)
                .map(str::len)
                .unwrap_or(0),
            "toolCallCount": response_envelope
                .get("toolCalls")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0),
            "responseEnvelope": response_envelope.clone()
        }),
    );
    handle_read_only_analysis_response(
        state,
        session_id,
        run_id,
        seed.event_session_id,
        &seed.profile,
        &seed.request_envelope,
        &request_envelope,
        response_envelope,
        seen_resource_requests,
        seen_internal_read_only_plan_keys,
        internal_read_only_runs,
        read_only_continuation_seeds,
        internal_read_only_advances,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn handle_read_only_analysis_response(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    event_session_id: Option<deepcode_kernel_abi::SessionId>,
    profile: &ResolvedLlmProfile,
    base_request_envelope: &Value,
    request_envelope: &Value,
    response_envelope: Value,
    seen_resource_requests: &mut BTreeSet<String>,
    seen_internal_read_only_plan_keys: &mut BTreeSet<String>,
    internal_read_only_runs: &mut BTreeSet<String>,
    read_only_continuation_seeds: &mut BTreeMap<String, ReadOnlyContinuationSeed>,
    internal_read_only_advances: &mut usize,
) -> Result<Vec<KernelEvent>, String> {
    let original_content = response_envelope
        .pointer("/assistantMessage/content")
        .or_else(|| response_envelope.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let parsed_plan = parse_or_repair_agent_plan_response(
        state,
        session_id,
        run_id,
        profile,
        request_envelope,
        original_content,
    )
    .await;
    match parsed_plan {
        Ok(AgentPlanResponse::Answer(answer)) => {
            append_session_projection(
                state,
                session_id,
                vec![answer_event(session_id, run_id, &answer)],
            );
            Ok(Vec::new())
        }
        Ok(AgentPlanResponse::ResourceRequest(resource_request)) => {
            let key = resource_request_key(&resource_request);
            let event = if seen_resource_requests.insert(key) {
                resource_request_event(session_id, run_id, &resource_request)
            } else {
                assistant_final_event(
                    session_id,
                    "当前资源请求与本轮前一次请求重复，Agent 已停止继续重复请求。请补充一个更明确的文件、目录或操作目标。",
                )
            };
            append_session_projection(state, session_id, vec![event]);
            Ok(Vec::new())
        }
        Ok(AgentPlanResponse::ActionPlan(mut plan)) => {
            let run = deepcode_kernel_abi::RunId(run_id.to_string());
            let review_events = {
                let mut runtime = state.runtime.lock().expect("kernel runtime lock");
                runtime
                    .dispatch(KernelCommand::PlanContractSubmit {
                        request_id: rid("agent-read-only-analysis-plan-review"),
                        run_id: Some(run.clone()),
                        session_id: Some(deepcode_kernel_abi::SessionId(session_id.to_string())),
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
            if should_internally_advance_read_only_plan(&plan) {
                let coverage = collect_read_only_coverage(state, run_id);
                if read_only_plan_covered_by_context(&plan, &coverage) {
                    append_session_projection(
                        state,
                        session_id,
                        vec![assistant_final_event(
                            session_id,
                            READ_ONLY_DUPLICATE_RESOURCE_MESSAGE,
                        )],
                    );
                    return Ok(Vec::new());
                }
                let key = read_only_plan_key(&plan);
                if !seen_internal_read_only_plan_keys.insert(key) {
                    append_session_projection(
                        state,
                        session_id,
                        vec![assistant_final_event(
                            session_id,
                            "当前只读探索计划与本轮前一次计划重复，Agent 已停止继续重复读取。请补充更明确的分析目标或资源范围。",
                        )],
                    );
                    return Ok(Vec::new());
                }
                if *internal_read_only_advances >= INTERNAL_READ_ONLY_MAX_ADVANCES {
                    append_session_projection(
                        state,
                        session_id,
                        vec![assistant_final_event(
                            session_id,
                            "只读探索已达到本轮上下文预算上限，Agent 已停止继续读取。请缩小问题范围或指定需要分析的模块。",
                        )],
                    );
                    return Ok(Vec::new());
                }
                *internal_read_only_advances += 1;
                record_kernel_events(state, &review_events);
                append_trace_event(
                    state,
                    session_id,
                    "agent.read_only_plan.internal_accept",
                    json!({
                        "runId": &plan.run_id,
                        "planId": &plan.plan_id,
                        "capabilities": plan_review_required_capabilities(&plan),
                        "advanceCount": *internal_read_only_advances
                    }),
                );
                internal_read_only_runs.insert(plan.run_id.clone());
                read_only_continuation_seeds.insert(
                    plan.run_id.clone(),
                    ReadOnlyContinuationSeed {
                        profile: profile.clone(),
                        request_envelope: base_request_envelope.clone(),
                        event_session_id: event_session_id.clone(),
                    },
                );
                let attachments = latest_user_attachments_for_session(state, session_id);
                let approved_tools =
                    approved_tool_calls_for_pending_plan_with_attachments(&plan, &attachments);
                if approved_tools.is_empty() {
                    append_session_projection(
                        state,
                        session_id,
                        vec![assistant_final_event(
                            session_id,
                            "只读探索计划未能映射为 Kernel 只读工具调用，Agent 已停止执行该计划。",
                        )],
                    );
                    return Ok(Vec::new());
                }
                let accept_events = {
                    let mut runtime = state.runtime.lock().expect("kernel runtime lock");
                    runtime
                        .enqueue_approved_tool_calls(&plan.run_id, approved_tools)
                        .map_err(|error| error.to_string())?;
                    runtime
                        .dispatch(KernelCommand::PlanAccept {
                            request_id: rid("agent-read-only-analysis-auto-accept"),
                            run_id: run,
                            plan_id: plan.plan_id.clone(),
                        })
                        .map_err(|error| error.to_string())?
                };
                Ok(accept_events)
            } else {
                record_kernel_events(state, &review_events);
                append_session_projection(
                    state,
                    session_id,
                    kernel_events_to_agent_events(session_id, &review_events),
                );
                append_session_projection(
                    state,
                    session_id,
                    vec![plan_card_event(session_id, &plan)],
                );
                {
                    let mut gui = state.gui.lock().expect("gui state lock");
                    gui.pending_plans.insert(plan.plan_id.clone(), plan);
                }
                Ok(Vec::new())
            }
        }
        Err(error) => {
            append_session_projection(
                state,
                session_id,
                vec![plan_parse_error_event(session_id, run_id, &error)],
            );
            Ok(Vec::new())
        }
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
    let mut trace_payload = match payload {
        Value::Object(_) => payload,
        value => json!({ "details": value }),
    };
    if let Some(object) = trace_payload.as_object_mut() {
        object
            .entry("traceKind".to_string())
            .or_insert_with(|| json!(kind));
        object
            .entry("channel".to_string())
            .or_insert_with(|| json!("trace"));
        object
            .entry("visibility".to_string())
            .or_insert_with(|| json!("trace"));
        object
            .entry("presentation".to_string())
            .or_insert_with(|| json!("debug"));
    }
    let event = json!({
        "id": format!("trace-{}", now_millis()),
        "sessionId": session_id,
        "ts": now_text(),
        "kind": kind,
        "source": "runtime",
        "level": if kind == "error" { "error" } else { "info" },
        "summary": trace_payload
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or(kind),
        "payload": trace_payload
    });
    let (archive_root, session) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.trace_events
            .entry(session_id.to_string())
            .or_default()
            .push(event.clone());
        (
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, session_id),
        )
    };
    if let Err(error) = append_conversation_archive_projection(
        &archive_root,
        session_id,
        session.as_ref(),
        &[event],
    ) {
        eprintln!("failed to append trace conversation archive: {error}");
    }
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
                    "effectiveMaxOutputTokens": effective_profile_max_output_tokens_for_trace(profile),
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
    let original_request_context = serde_json::to_string_pretty(original_request_envelope)
        .unwrap_or_else(|_| original_request_envelope.to_string());
    json!({
        "messages": [
            {
                "role": "system",
                "content": "You are DeepCode plan protocol repair. Return only one valid JSON object using schemaVersion \"deepcode.agent.protocol.v2\". Keep strict fail-closed semantics: do not invent execution facts, do not add direct params/input/command/script/path/content fields inside actionBundle.actions or continuationExpectations, and do not combine resourceRequest with actionBundle. resourceRequest must be under the top-level key \"resourceRequest\"; never use a top-level \"request\" key. resourceRequest manifestEntryId values must reference ResourceManifest entry ids or protocol manifest handles, not workspace paths; convert concrete workspace path, directory, file, or search needs into an actionBundle with workspace.read/workspace.search. actionBundle.version must be string \"1\"; actionBundle.actions must be an array; actionBundle.validationExpectations and actionBundle.reviewExpectations must both be arrays, even when empty; action.resourceScope must be a string array. If the invalid output has top-level actions, move them under actionBundle.actions and populate the required actionBundle wrapper fields. Use capability namespace in actionBundle: workspace.read, workspace.search, workspace.write, workspace.delete, process.exec, network.egress, git.read, git.write, browser.control. Executor tool names such as fs.write/fs.delete/code.search/web.search/git.status/browser.open are only for complete-stage tool calls. File content drafts must be emitted as top-level codeBlocks, and write actions must reference sourceBlockId. If the user requested write then review then delete, current actions include only the write/review batch and the post-review delete intent goes in actionBundle.continuationExpectations."
            },
            {
                "role": "user",
                "content": format!(
                    "Original request envelope context:\\n{}\\n\\nParser error:\\n{}\\n\\nCanonical minimal JSON Envelope v2 answer example:\\n{{\"schemaVersion\":\"deepcode.agent.protocol.v2\",\"kind\":\"answer\",\"outputLanguage\":\"en-US\",\"answer\":{{\"format\":\"markdown\",\"content\":\"Final user-facing answer.\"}}}}\\n\\nCanonical minimal JSON Envelope v2 resourceRequest example:\\n{{\"schemaVersion\":\"deepcode.agent.protocol.v2\",\"kind\":\"resourceRequest\",\"outputLanguage\":\"en-US\",\"resourceRequest\":{{\"version\":\"1\",\"id\":\"need-target\",\"reason\":\"Need a concrete target resource.\",\"items\":[{{\"id\":\"target-entry\",\"manifestEntryId\":\"current-selection\",\"reason\":\"Resolve a manifest entry.\"}}]}}}}\\n\\nCanonical minimal JSON Envelope v2 read-only actionBundle example:\\n{}\\n\\nCanonical minimal JSON Envelope v2 write/review/continuation example:\\n{{\"schemaVersion\":\"deepcode.agent.protocol.v2\",\"kind\":\"actionBundle\",\"outputLanguage\":\"en-US\",\"userPlan\":\"Create the referenced workspace resource and wait for user review.\",\"codeBlocks\":[{{\"id\":\"write-resource\",\"path\":\"<workspace-resource>\",\"content\":\"example content\"}}],\"actionBundle\":{{\"version\":\"1\",\"id\":\"write-resource-plan\",\"goal\":\"Create the referenced workspace resource and wait for review\",\"actions\":[{{\"id\":\"write-resource\",\"title\":\"Write referenced workspace resource\",\"capability\":\"workspace.write\",\"kind\":\"write\",\"resourceScope\":[\"<workspace-resource>\"],\"sourceBlockId\":\"write-resource\"}}],\"continuationExpectations\":[{{\"id\":\"delete-resource-after-review\",\"title\":\"Delete referenced workspace resource after user review is accepted\",\"capability\":\"workspace.delete\",\"kind\":\"delete\",\"resourceScope\":[\"<workspace-resource>\"]}}],\"validationExpectations\":[{{\"id\":\"file-written\",\"description\":\"Kernel fs.write returns ok\"}}],\"reviewExpectations\":[{{\"id\":\"user-review\",\"description\":\"User reviews before deletion\"}}]}},\"expectedValidation\":\"Kernel fs.write returns ok.\",\"reviewGuide\":\"Ask the user to review the referenced workspace resource. If accepted, Kernel continues to the scoped delete continuation.\"}}\\n\\nOriginal invalid model output:\\n{}",
                    clip_chars(&original_request_context, 24_000),
                    parser_error,
                    read_only_action_bundle_example(),
                    clip_chars(original_content, 24_000)
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
    let manifest_entry_id = object
        .get("manifestEntryId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    validate_manifest_entry_id(
        manifest_entry_id,
        &format!("RESOURCE_REQUEST.items[{index}].manifestEntryId"),
    )?;
    Ok(())
}

fn validate_manifest_entry_id(value: &str, label: &str) -> Result<(), String> {
    let value = value.trim();
    let is_path_like = value == "."
        || value == ".."
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with('/')
        || value.starts_with('~')
        || value.contains('/')
        || value.contains('\\')
        || value.contains("://");
    if !is_path_like {
        return Ok(());
    }
    Err(format!(
        "{label} must reference a ResourceManifest entry id, not a workspace path; use an actionBundle with workspace.read or workspace.search for concrete workspace resources"
    ))
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
    for key in ["id", "title", "capability", "kind"] {
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
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    validate_action_kind(capability, kind, label)?;
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

fn validate_action_kind(capability: &str, kind: &str, label: &str) -> Result<(), String> {
    let allowed = match capability {
        "workspace.read" => &["list", "read"][..],
        "workspace.search" => &["search"][..],
        "workspace.write" => &["write"][..],
        "workspace.delete" => &["delete"][..],
        _ => return Ok(()),
    };
    if allowed.contains(&kind) {
        return Ok(());
    }
    Err(format!(
        "{label}.kind must be one of [{}] for capability {capability}",
        allowed
            .iter()
            .map(|value| format!("\"{value}\""))
            .collect::<Vec<_>>()
            .join(", ")
    ))
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
    plan_review_allows_read_only_execution(plan)
}

fn should_internally_advance_read_only_plan(plan: &PendingAgentPlan) -> bool {
    plan_review_allows_read_only_execution(plan)
}

fn plan_review_allows_read_only_execution(plan: &PendingAgentPlan) -> bool {
    let Some(report) = plan.plan_review_report.as_ref() else {
        return false;
    };
    if !report_array_empty(report, "permissionGaps")
        || !report_array_empty(report, "deniedReasons")
        || !report_array_empty(report, "hardFloorHits")
    {
        return false;
    }
    let capabilities = plan_review_required_capabilities(plan);
    !capabilities.is_empty()
        && capabilities
            .iter()
            .all(|capability| read_only_context_capability(capability))
}

fn plan_review_required_capabilities(plan: &PendingAgentPlan) -> Vec<String> {
    plan.plan_review_report
        .as_ref()
        .and_then(|report| report.get("requiredCapabilities"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn read_only_context_capability(capability: &str) -> bool {
    matches!(capability, "workspace.read" | "workspace.search")
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
    if pending_review.is_none() {
        let visible = visible_review_guidance(guidance);
        let content = visible.trim();
        if !content.is_empty() {
            append_session_projection(
                state,
                session_id,
                vec![assistant_final_event(session_id, content)],
            );
        }
        return;
    }
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
            serde_json::json!({
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

fn visible_review_guidance(guidance: &str) -> String {
    let trimmed = guidance.trim();
    match parse_agent_plan_response("review-session", "review-run", trimmed) {
        Ok(AgentPlanResponse::Answer(answer)) => answer.content,
        Ok(_) => String::new(),
        Err(_) if looks_like_protocol_debug_text(trimmed) => String::new(),
        Err(_) => guidance.to_string(),
    }
}

fn looks_like_protocol_debug_text(value: &str) -> bool {
    let trimmed = value.trim_start();
    trimmed.starts_with('{')
        || trimmed.contains(AGENT_PROTOCOL_SCHEMA_VERSION)
        || trimmed.contains("JSON Envelope v2")
        || trimmed.contains("Parser error:")
        || trimmed.contains("Original invalid model output:")
        || trimmed.contains("ACTION_BUNDLE.")
}

fn has_pending_review_for_run(state: &AppState, run_id: &str) -> bool {
    state
        .gui
        .lock()
        .expect("gui state lock")
        .pending_reviews
        .contains_key(run_id)
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

fn effective_profile_max_output_tokens_for_trace(profile: &ResolvedLlmProfile) -> Option<u32> {
    match profile.kind.as_str() {
        "openaiCompatible" | "codex" => effective_openai_compatible_max_tokens(profile),
        "anthropic" => Some(profile.max_output_tokens.unwrap_or(4096)),
        _ => profile.max_output_tokens,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn neutral_resource() -> String {
        ["res", "ource"].concat()
    }

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
        let resource = neutral_resource();
        let parsed = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "actionBundle",
                "outputLanguage": "zh-CN",
                "userPlan": "Create referenced resource and wait for review.",
                "codeBlocks": [
                    {
                        "id": "write-test",
                        "path": resource.clone(),
                        "content": "hello"
                    }
                ],
                "actionBundle": {
                    "version": "1",
                    "id": "plan-1",
                    "goal": "Create referenced resource and wait for review",
                    "actions": [
                        {
                            "id": "a1",
                            "title": "Write referenced resource",
                            "capability": "workspace.write",
                            "kind": "write",
                            "resourceScope": [resource.clone()],
                            "sourceBlockId": "write-test"
                        }
                    ],
                    "validationExpectations": [],
                    "reviewExpectations": []
                },
                "expectedValidation": "Kernel fs.write succeeds.",
                "reviewGuide": "Review referenced resource."
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
        let resource = neutral_resource();
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
                            "resourceScope": [resource.clone()]
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
    fn parser_accepts_protocol_manifest_resource_request() {
        let parsed = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "resourceRequest",
                "outputLanguage": "en-US",
                "resourceRequest": {
                    "version": "1",
                    "id": "rr-current",
                    "reason": "need current manifest entry",
                    "items": [
                        {
                            "id": "target",
                            "manifestEntryId": "current-selection",
                            "reason": "resolve the active manifest entry"
                        }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();
        match parsed {
            AgentPlanResponse::ResourceRequest(request) => {
                assert_eq!(
                    request.request["items"][0]["manifestEntryId"],
                    "current-selection"
                );
            }
            other => panic!("expected resource request, got {other:?}"),
        }
    }

    #[test]
    fn parser_rejects_path_like_resource_request_manifest_entry_id() {
        let error = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "resourceRequest",
                "outputLanguage": "en-US",
                "resourceRequest": {
                    "version": "1",
                    "id": "rr-path",
                    "reason": "need concrete workspace resource",
                    "items": [
                        {
                            "id": "target",
                            "manifestEntryId": "scope/resource.ext",
                            "reason": "read the concrete resource"
                        }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap_err();
        assert!(error.contains("workspace path"));
        assert!(error.contains("actionBundle"));
        assert!(error.contains("workspace.read"));
    }

    #[test]
    fn resource_request_key_ignores_generated_ids() {
        let first = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "resourceRequest",
                "outputLanguage": "en-US",
                "resourceRequest": {
                    "version": "1",
                    "id": "rr-1",
                    "reason": "need  current context",
                    "items": [
                        {
                            "id": "item-1",
                            "manifestEntryId": "current-selection",
                            "reason": "Resolve manifest entry"
                        }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();
        let second = parse_agent_plan_response(
            "session-1",
            "run-1",
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "resourceRequest",
                "outputLanguage": "en-US",
                "resourceRequest": {
                    "version": "1",
                    "id": "rr-2",
                    "reason": "need current context",
                    "items": [
                        {
                            "id": "item-2",
                            "manifestEntryId": "current-selection",
                            "reason": "Resolve manifest entry"
                        }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();
        let AgentPlanResponse::ResourceRequest(first) = first else {
            panic!("expected first resource request");
        };
        let AgentPlanResponse::ResourceRequest(second) = second else {
            panic!("expected second resource request");
        };
        assert_eq!(resource_request_key(&first), resource_request_key(&second));
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
    fn parser_rejects_action_missing_kind() {
        let resource = neutral_resource();
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
                        "title": "read",
                        "capability": "workspace.read",
                        "resourceScope": [resource.clone()]
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
        assert!(error.contains("actions[0].kind must be a non-empty string"));
    }

    #[test]
    fn parser_rejects_read_action_with_invalid_kind() {
        let resource = neutral_resource();
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
                        "kind": "scan",
                        "resourceScope": [resource.clone()]
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
        assert!(error.contains("kind must be one of"));
        assert!(error.contains("workspace.read"));
    }

    #[test]
    fn parser_rejects_executor_tool_name_as_plan_capability() {
        let resource = neutral_resource();
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
                            "resourceScope": [resource.clone()]
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
        let resource = neutral_resource();
        let content = serde_json::json!({
            "schemaVersion": "deepcode.agent.protocol.v2",
            "kind": "actionBundle",
            "outputLanguage": "en-US",
            "userPlan": "plan",
            "codeBlocks": [
                {
                    "id": "write-test",
                    "path": resource.clone(),
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
                        "resourceScope": [resource.clone()],
                        "sourceBlockId": "write-test"
                    }
                ],
                "validationExpectations": [],
                "reviewExpectations": []
            },
            "expectedValidation": "Kernel fs.write succeeds.",
            "reviewGuide": "Review referenced resource."
        })
        .to_string();
        let parsed = parse_agent_plan_response("session-1", "run-1", &content).unwrap();
        assert!(matches!(parsed, AgentPlanResponse::ActionPlan(_)));
    }

    #[test]
    fn read_only_plan_review_can_advance_internally() {
        let plan = test_plan_with_review_capabilities(
            vec!["workspace.read", "workspace.search"],
            vec![],
            vec![],
            vec![],
        );

        assert!(should_internally_advance_read_only_plan(&plan));
    }

    #[test]
    fn write_plan_review_cannot_advance_internally() {
        let plan = test_plan_with_review_capabilities(
            vec!["workspace.read", "workspace.write"],
            vec![],
            vec![],
            vec![],
        );

        assert!(!should_internally_advance_read_only_plan(&plan));
    }

    #[test]
    fn read_only_plan_with_permission_gap_cannot_advance_internally() {
        let plan = test_plan_with_review_capabilities(
            vec!["workspace.read"],
            vec!["workspace.read"],
            vec![],
            vec![],
        );

        assert!(!should_internally_advance_read_only_plan(&plan));
    }

    #[test]
    fn internal_read_only_projection_hides_plan_confirmation_events() {
        let mut internal_runs = BTreeSet::new();
        internal_runs.insert("run-read".to_string());
        let events = vec![
            KernelEvent::PlanReviewReportProduced {
                request_id: None,
                run_id: Some(deepcode_kernel_abi::RunId("run-read".to_string())),
                session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                report: serde_json::json!({}),
                sequence: Some(1),
            },
            KernelEvent::PlanAccepted {
                run_id: deepcode_kernel_abi::RunId("run-read".to_string()),
                session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                plan_id: "plan-read".to_string(),
                auto_accepted: false,
                sequence: Some(2),
            },
            KernelEvent::WorkflowDecisionMade {
                request_id: None,
                run_id: deepcode_kernel_abi::RunId("run-read".to_string()),
                session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                decision: deepcode_kernel_abi::WorkflowDecision {
                    action: deepcode_kernel_abi::WorkflowDecisionAction::Blocked,
                    reason: deepcode_kernel_abi::WorkflowDecisionReason::ToolFailed,
                    phase: Some("complete".to_string()),
                    pending_steps: Vec::new(),
                    answer_obligations: Vec::new(),
                    summary: Some("read-only observation failed".to_string()),
                    fail_closed: true,
                },
                sequence: Some(3),
            },
            KernelEvent::PlanAccepted {
                run_id: deepcode_kernel_abi::RunId("run-write".to_string()),
                session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                plan_id: "plan-write".to_string(),
                auto_accepted: false,
                sequence: Some(4),
            },
        ];

        let visible = visible_kernel_events_for_session(&events, &internal_runs);
        assert_eq!(visible.len(), 1);
        assert!(matches!(
            &visible[0],
            KernelEvent::PlanAccepted { run_id, .. } if run_id.0 == "run-write"
        ));
    }

    #[test]
    fn session_resource_context_renders_read_only_tool_outputs() {
        let state = AppState {
            runtime: Arc::new(Mutex::new(DeepCodeKernelRuntime::new())),
            gui: Arc::new(Mutex::new(GuiState::new())),
            terminal_runtime: Arc::new(Mutex::new(crate::terminal_api::TerminalRuntime::new())),
            kernel_events: Arc::new(Mutex::new(vec![
                KernelEvent::ToolRequested {
                    run_id: Some(deepcode_kernel_abi::RunId("run-read".to_string())),
                    session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: "call-list".to_string(),
                    tool_name: "fs.list".to_string(),
                    args_preview: serde_json::json!({ "path": "src" }),
                    sequence: Some(1),
                },
                KernelEvent::ToolCompleted {
                    run_id: Some(deepcode_kernel_abi::RunId("run-read".to_string())),
                    session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: "call-list".to_string(),
                    tool_name: "fs.list".to_string(),
                    ok: true,
                    output: Some(serde_json::json!({
                        "path": "src",
                        "nodes": [
                            { "path": "src/lib.rs", "kind": "file" }
                        ]
                    })),
                    error: None,
                    sequence: Some(2),
                },
                KernelEvent::ToolRequested {
                    run_id: Some(deepcode_kernel_abi::RunId("run-read".to_string())),
                    session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: "call-read".to_string(),
                    tool_name: "fs.read".to_string(),
                    args_preview: serde_json::json!({ "path": "src/lib.rs" }),
                    sequence: Some(3),
                },
                KernelEvent::ToolCompleted {
                    run_id: Some(deepcode_kernel_abi::RunId("run-read".to_string())),
                    session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: "call-read".to_string(),
                    tool_name: "fs.read".to_string(),
                    ok: true,
                    output: Some(serde_json::json!({
                        "path": "src/lib.rs",
                        "content": "pub fn entry_point() {}"
                    })),
                    error: None,
                    sequence: Some(4),
                },
                KernelEvent::ToolRequested {
                    run_id: Some(deepcode_kernel_abi::RunId("run-read".to_string())),
                    session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: "call-search".to_string(),
                    tool_name: "code.search".to_string(),
                    args_preview: serde_json::json!({ "query": "entry_point" }),
                    sequence: Some(5),
                },
                KernelEvent::ToolCompleted {
                    run_id: Some(deepcode_kernel_abi::RunId("run-read".to_string())),
                    session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: "call-search".to_string(),
                    tool_name: "code.search".to_string(),
                    ok: true,
                    output: Some(serde_json::json!({
                        "query": "entry_point",
                        "matches": [
                            { "path": "src/lib.rs", "line": 1, "text": "pub fn entry_point() {}" }
                        ]
                    })),
                    error: None,
                    sequence: Some(6),
                },
            ])),
        };

        let context = build_session_resource_context(&state, "run-read");
        assert!(context.contains("ResourcePacket from Kernel read-only tool output"));
        assert!(context.contains("contentKind: directoryTree"));
        assert!(context.contains("contentKind: fileText"));
        assert!(context.contains("contentKind: searchResults"));
        assert!(context.contains("pub fn entry_point()"));
    }

    #[test]
    fn session_resource_context_renders_read_only_tool_errors() {
        let state = AppState {
            runtime: Arc::new(Mutex::new(DeepCodeKernelRuntime::new())),
            gui: Arc::new(Mutex::new(GuiState::new())),
            terminal_runtime: Arc::new(Mutex::new(crate::terminal_api::TerminalRuntime::new())),
            kernel_events: Arc::new(Mutex::new(vec![
                KernelEvent::ToolRequested {
                    run_id: Some(deepcode_kernel_abi::RunId("run-read".to_string())),
                    session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: "call-read".to_string(),
                    tool_name: "fs.read".to_string(),
                    args_preview: serde_json::json!({ "path": "module" }),
                    sequence: Some(1),
                },
                KernelEvent::ToolCompleted {
                    run_id: Some(deepcode_kernel_abi::RunId("run-read".to_string())),
                    session_id: Some(deepcode_kernel_abi::SessionId("session-1".to_string())),
                    turn_id: None,
                    tool_call_id: "call-read".to_string(),
                    tool_name: "fs.read".to_string(),
                    ok: false,
                    output: None,
                    error: Some(deepcode_kernel_abi::KernelErrorEnvelope {
                        code: "invalid_command".to_string(),
                        message: "module is not a file".to_string(),
                        message_key: None,
                        args: None,
                    }),
                    sequence: Some(2),
                },
            ])),
        };

        let context = build_session_resource_context(&state, "run-read");
        assert!(context.contains("status: error"));
        assert!(context.contains("module is not a file"));
        assert!(context.contains("\"path\":\"module\""));
    }

    #[test]
    fn review_guidance_json_answer_renders_only_answer_content() {
        let visible = visible_review_guidance(
            &serde_json::json!({
                "schemaVersion": "deepcode.agent.protocol.v2",
                "kind": "answer",
                "outputLanguage": "zh-CN",
                "answer": {
                    "format": "markdown",
                    "content": "这是最终正文。"
                }
            })
            .to_string(),
        );
        assert_eq!(visible, "这是最终正文。");
    }

    #[test]
    fn review_guidance_filters_protocol_debug_text() {
        let visible = visible_review_guidance(
            r#"{"schemaVersion":"deepcode.agent.protocol.v2","kind":"actionBundle","actions":[]}"#,
        );
        assert!(visible.is_empty());
    }

    #[test]
    fn read_only_analysis_prompt_contains_full_envelope_contract() {
        let prompt = read_only_analysis_system_prompt();
        assert!(prompt.contains("kind=\"answer\""));
        assert!(prompt.contains("kind=\"resourceRequest\""));
        assert!(prompt.contains("kind=\"actionBundle\""));
        assert!(prompt.contains("validationExpectations"));
        assert!(prompt.contains("reviewExpectations"));
        assert!(prompt.contains("Do not put actions at the top level"));
        assert!(prompt.contains("workspace.search"));
        assert!(!prompt.contains(&["plan", "ner"].concat()));
    }

    #[test]
    fn repair_request_contains_parser_error_invalid_output_and_read_only_example() {
        let request = build_plan_repair_request(
            &serde_json::json!({
                "messages": [
                    {
                        "role": "user",
                        "content": "Read context and answer."
                    }
                ]
            }),
            r#"{"actions":[]}"#,
            "JSON Envelope v2 contains unknown field actions",
        );
        let content = request["messages"][1]["content"]
            .as_str()
            .unwrap_or_default();
        assert!(content.contains("JSON Envelope v2 contains unknown field actions"));
        assert!(content.contains(r#"{"actions":[]}"#));
        assert!(
            content.contains("Canonical minimal JSON Envelope v2 read-only actionBundle example")
        );
        assert!(content.contains("manifestEntryId"));
        assert!(content.contains("workspace.read"));
        assert!(content.contains("workspace.search"));
        assert!(content.contains("\"validationExpectations\":[]"));
        assert!(content.contains("\"reviewExpectations\":[]"));
    }

    #[test]
    fn read_only_plan_key_deduplicates_same_scopes() {
        let first =
            test_plan_with_review_capabilities(vec!["workspace.read"], vec![], vec![], vec![]);
        let mut second = first.clone();
        second.plan_id = "plan-2".to_string();
        assert_eq!(read_only_plan_key(&first), read_only_plan_key(&second));
    }

    #[test]
    fn read_only_plan_coverage_detects_repeated_resources() {
        let plan = test_plan_with_actions(serde_json::json!([
            {
                "id": "list-src",
                "title": "List source",
                "capability": "workspace.read",
                "kind": "list",
                "resourceScope": ["src"]
            },
            {
                "id": "read-lib",
                "title": "Read entry file",
                "capability": "workspace.read",
                "kind": "read",
                "resourceScope": ["src/lib.rs"]
            },
            {
                "id": "search-entry",
                "title": "Search entry symbol",
                "capability": "workspace.search",
                "kind": "search",
                "resourceScope": ["search:entry_point"]
            }
        ]));
        let mut coverage = ReadOnlyCoverage::default();
        coverage.listed_paths.insert("src".to_string());
        coverage.read_paths.insert("src/lib.rs".to_string());
        coverage.searched_queries.insert("entry_point".to_string());

        assert!(read_only_plan_covered_by_context(&plan, &coverage));
    }

    #[test]
    fn workspace_search_plan_maps_to_code_search_tool() {
        let plan = test_plan_with_actions(serde_json::json!([
            {
                "id": "search-entry",
                "title": "Search entry symbol",
                "capability": "workspace.search",
                "kind": "search",
                "resourceScope": ["search:entry_point"]
            }
        ]));
        let calls = approved_tool_calls_for_pending_plan(&plan);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, "code.search");
        assert_eq!(calls[0].2["query"], "entry_point");
    }

    #[test]
    fn workspace_read_kind_selects_list_tool_for_root_scope() {
        let plan = test_plan_with_actions(serde_json::json!([
            {
                "id": "read-root",
                "title": "Read scope",
                "capability": "workspace.read",
                "kind": "read",
                "resourceScope": ["."]
            }
        ]));
        let calls = approved_tool_calls_for_pending_plan(&plan);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, "fs.list");
        assert_eq!(calls[0].2["path"], ".");
    }

    #[test]
    fn workspace_read_kind_anchors_relative_scope_to_directory_attachment() {
        let root = std::env::temp_dir().join(format!(
            "deepcode-daemon-attachment-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("note.txt"), "content").unwrap();

        let attachment = serde_json::json!({
            "id": "attachment-dir",
            "kind": "directory",
            "path": "attached",
            "absolutePath": root.to_string_lossy(),
            "source": "userSelected",
            "scope": "message"
        });
        let read_file_plan = test_plan_with_actions(serde_json::json!([
            {
                "id": "read-note",
                "title": "Read note",
                "capability": "workspace.read",
                "kind": "read",
                "resourceScope": ["note.txt"]
            }
        ]));
        let calls = approved_tool_calls_for_pending_plan_with_attachments(
            &read_file_plan,
            &[attachment.clone()],
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, "fs.read");
        assert_eq!(calls[0].2["path"], "note.txt");
        assert_eq!(calls[0].2["attachmentManifestEntryId"], "attachment-dir");
        let canonical_root = root.canonicalize().unwrap();
        assert_eq!(
            calls[0].2["attachmentRoot"].as_str(),
            Some(canonical_root.to_string_lossy().as_ref())
        );

        let read_dir_plan = test_plan_with_actions(serde_json::json!([
            {
                "id": "read-nested",
                "title": "Read nested",
                "capability": "workspace.read",
                "kind": "read",
                "resourceScope": ["nested"]
            }
        ]));
        let calls =
            approved_tool_calls_for_pending_plan_with_attachments(&read_dir_plan, &[attachment]);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1, "fs.list");
        assert_eq!(calls[0].2["path"], "nested");

        std::fs::remove_dir_all(root).unwrap();
    }

    fn test_plan_with_review_capabilities(
        capabilities: Vec<&str>,
        permission_gaps: Vec<&str>,
        denied_reasons: Vec<&str>,
        hard_floor_hits: Vec<&str>,
    ) -> PendingAgentPlan {
        PendingAgentPlan {
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            plan_id: "plan-1".to_string(),
            user_plan: "Read-only context plan.".to_string(),
            action_bundle: serde_json::json!({
                "version": "1",
                "id": "plan-1",
                "goal": "Read context",
                "actions": [],
                "validationExpectations": [],
                "reviewExpectations": []
            }),
            code_blocks: Vec::new(),
            expected_validation: "Read-only evidence is available.".to_string(),
            review_guide: "Summarize read-only evidence.".to_string(),
            plan_review_report: Some(serde_json::json!({
                "requiredCapabilities": capabilities,
                "permissionGaps": permission_gaps,
                "deniedReasons": denied_reasons,
                "hardFloorHits": hard_floor_hits
            })),
            created_at: now_text(),
        }
    }

    fn test_plan_with_actions(actions: Value) -> PendingAgentPlan {
        PendingAgentPlan {
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            plan_id: "plan-1".to_string(),
            user_plan: "Read bounded workspace context.".to_string(),
            action_bundle: serde_json::json!({
                "version": "1",
                "id": "plan-1",
                "goal": "Read bounded workspace context",
                "actions": actions,
                "validationExpectations": [],
                "reviewExpectations": []
            }),
            code_blocks: Vec::new(),
            expected_validation: "Kernel read-only tools return observations.".to_string(),
            review_guide: "Answer from read-only evidence.".to_string(),
            plan_review_report: Some(serde_json::json!({
                "requiredCapabilities": ["workspace.read", "workspace.search"],
                "permissionGaps": [],
                "deniedReasons": [],
                "hardFloorHits": []
            })),
            created_at: now_text(),
        }
    }

    #[test]
    fn session_short_memory_includes_recent_file_attachment() {
        let resource = neutral_resource();
        let events = vec![
            serde_json::json!({
                "kind": "user_msg",
                "payload": {
                    "content": "读取分析附加文件",
                    "attachments": [
                        {
                            "kind": "file",
                            "path": resource.clone(),
                            "source": "userSelected",
                            "scope": "message"
                        }
                    ]
                }
            }),
            serde_json::json!({
                "kind": "assistant_msg",
                "payload": {
                    "content": "文件分析完成：附加文件包含一个可读入口段落。",
                    "channel": "final"
                }
            }),
            serde_json::json!({
                "kind": "user_msg",
                "payload": {
                    "content": "删除最近分析的文件",
                    "attachments": []
                }
            }),
        ];

        let memory = build_session_short_memory_context(&events);
        assert!(memory.contains("Session memory document"));
        assert!(memory.contains("Recent explicit attachments"));
        assert!(memory.contains(&resource));
        assert!(!memory.contains("删除最近分析的文件"));
    }

    #[test]
    fn session_short_memory_includes_multiple_recent_attachments() {
        let resource_a = format!("{}-a", neutral_resource());
        let resource_b = format!("{}-b", neutral_resource());
        let events = vec![
            serde_json::json!({
                "kind": "user_msg",
                "payload": {
                    "content": "分析这些文件",
                    "attachments": [
                        { "kind": "file", "path": resource_a.clone(), "source": "userSelected", "scope": "message" },
                        { "kind": "file", "path": resource_b.clone(), "source": "userSelected", "scope": "message" }
                    ]
                }
            }),
            serde_json::json!({
                "kind": "user_msg",
                "payload": {
                    "content": "删除最近提到的文件",
                    "attachments": []
                }
            }),
        ];

        let memory = build_session_short_memory_context(&events);
        assert!(memory.contains("Recent explicit attachments"));
        assert!(memory.contains(&resource_a));
        assert!(memory.contains(&resource_b));
        assert!(!memory.contains("删除最近提到的文件"));
    }

    #[test]
    fn session_short_memory_includes_recent_directory_attachment() {
        let resource_group = format!("{}-group", neutral_resource());
        let events = vec![
            serde_json::json!({
                "kind": "user_msg",
                "payload": {
                    "content": "分析附加目录的项目结构",
                    "attachments": [
                        {
                            "kind": "directory",
                            "path": resource_group.clone(),
                            "source": "userSelected",
                            "scope": "message"
                        }
                    ]
                }
            }),
            serde_json::json!({
                "kind": "assistant_msg",
                "payload": {
                    "content": "目录分析完成，包含若干源码和配置文件。",
                    "channel": "final"
                }
            }),
            serde_json::json!({
                "kind": "user_msg",
                "payload": {
                    "content": "继续看一下里面的源代码",
                    "attachments": []
                }
            }),
        ];

        let memory = build_session_short_memory_context(&events);
        assert!(memory.contains("Recent explicit attachments"));
        assert!(memory.contains(&format!("directory {resource_group}")));
        assert!(!memory.contains("继续看一下里面的源代码"));
    }

    #[test]
    fn session_short_memory_deduplicates_repeated_user_turns_with_same_attachments() {
        let resource_group = format!("{}-group", neutral_resource());
        let repeated_turn = serde_json::json!({
            "kind": "user_msg",
            "payload": {
                "content": "分析附加资源",
                "attachments": [
                    {
                        "kind": "directory",
                        "path": resource_group.clone(),
                        "source": "userSelected",
                        "scope": "message"
                    }
                ]
            }
        });
        let events = vec![
            repeated_turn.clone(),
            repeated_turn,
            serde_json::json!({
                "kind": "user_msg",
                "payload": { "content": "继续", "attachments": [] }
            }),
        ];

        let memory = build_session_short_memory_context(&events);
        assert_eq!(memory.matches("分析附加资源").count(), 1);
        assert!(memory.contains(&resource_group));
        assert!(!memory.contains("继续"));
    }

    #[test]
    fn session_short_memory_is_bounded() {
        let resource = format!("{}-large", neutral_resource());
        let large_text = "很长的历史内容".repeat(5_000);
        let events = vec![
            serde_json::json!({
                "kind": "user_msg",
                "payload": {
                    "content": large_text,
                    "attachments": [
                        { "kind": "file", "path": resource.clone(), "source": "userSelected", "scope": "message" }
                    ]
                }
            }),
            serde_json::json!({
                "kind": "assistant_msg",
                "payload": {
                    "content": "分析完成。".repeat(5_000),
                    "channel": "final"
                }
            }),
            serde_json::json!({
                "kind": "user_msg",
                "payload": { "content": "继续", "attachments": [] }
            }),
        ];

        let memory = build_session_short_memory_context(&events);
        assert!(memory.chars().count() <= SESSION_SHORT_MEMORY_MAX_CHARS);
        assert!(memory.contains(&resource));
    }

    #[test]
    fn production_context_paths_do_not_contain_scenario_hardcoding() {
        let crate_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo_root = crate_root
            .parent()
            .and_then(std::path::Path::parent)
            .expect("repo root");
        let files = [
            crate_root.join("src/agent_loop.rs"),
            crate_root.join("src/llm_transport.rs"),
            crate_root.join("src/settings_api.rs"),
            repo_root.join("crates/deepcode-kernel-runtime/src/llm.rs"),
            repo_root.join("crates/deepcode-kernel-runtime/src/tools.rs"),
            repo_root.join("crates/deepcode-kernel-runtime/src/workflow.rs"),
            repo_root.join("crates/deepcode-kernel-workflow/src/decision_engine.rs"),
        ];
        let banned = [
            ["RL", "-Local", "Server"].concat(),
            ["Project", "/", "Test"].concat(),
            ["Test", ".", "cpp"].concat(),
            ["Project", "/", "Sample", "App"].concat(),
            ["其中", "的 cpp"].concat(),
            ["告诉我", "其中"].concat(),
            ["gRPC ", "服务入口"].concat(),
            ["_agent", "_tmp", "_functional", "_test"].concat(),
            ["_agent", "_tmp", "_fixture", "_lifecycle"].concat(),
            ["test", ".", "md"].concat(),
            ["next", "_kernel", "_autorun", "_tool"].concat(),
            ["agent", "Fixture"].concat(),
            ["from", "_", "leg", "acy", "_fixture"].concat(),
            ["DEEPCODE", "_LLM", "_MOCK"].concat(),
            ["mock", "_llm", "_output"].concat(),
            ["llm", "_mock", "_enabled"].concat(),
        ];
        for file in files {
            let content = std::fs::read_to_string(&file)
                .unwrap_or_else(|error| panic!("read {}: {error}", file.display()));
            for needle in &banned {
                assert!(
                    !content.contains(needle),
                    "{} contains banned scenario hardcoding: {}",
                    file.display(),
                    needle
                );
            }
        }
    }

    #[test]
    fn provider_name_roundtrip_includes_delete() {
        assert_eq!(internal_tool_name("fs_delete"), "fs.delete");
    }
}
