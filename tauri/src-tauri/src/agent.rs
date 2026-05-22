use crate::{fs, llm_profiles, user_settings, workspace};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
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
        state.sessions.insert(id, result.clone());
        result
    }

    pub fn current_session(&self) -> Option<AgentSessionResult> {
        let state = self.state.lock().expect("agent state poisoned");
        let id = state.current_session_id.as_ref()?;
        state.sessions.get(id).cloned()
    }

    pub fn append_events(&self, session_id: &str, request: Value) -> Result<AgentSessionResult, String> {
        let events = request
            .get("request")
            .unwrap_or(&request)
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut state = self.state.lock().expect("agent state poisoned");
        let Some(session) = state.sessions.get_mut(session_id) else {
            return Err(format!("Agent session not found: {session_id}"));
        };
        session.events.extend(events);
        if let Some(obj) = session.session.as_object_mut() {
            obj.insert("updatedAt".into(), Value::String(now_iso()));
        }
        Ok(session.clone())
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

        let mut events = vec![new_event(
            session_id,
            "user_msg",
            json!({ "content": content, "attachments": attachments }),
        )];

        let workflow_config = resolve_workflow_config(body, &current.session)?;
        if !has_configured_stage(&workflow_config) {
            events.push(new_event(
                session_id,
                "assistant_msg",
                json!({ "content": "Please configure a valid LLM provider profile and assign it to at least one Agent workflow stage." }),
            ));
            return self.append_events_direct(session_id, events);
        }

        let context = build_prompt_text(&attachments, workspace);
        let mut stage_outputs: Vec<String> = Vec::new();

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

            events.push(new_event(
                session_id,
                "workflow_stage",
                json!({ "stage": stage, "profileId": profile_id, "status": "started" }),
            ));

            let prior = if stage_outputs.is_empty() {
                String::new()
            } else {
                format!("\n\nPrevious workflow stage output:\n{}", stage_outputs.join("\n\n"))
            };
            let user_content = format!("{content}{prior}");
            let system_content = [
                context.as_str(),
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
                    for chunk in response
                        .get("chunks")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        match string_field(chunk, "type").as_deref() {
                            Some("delta") => {
                                if let Some(delta) = string_field(chunk, "content") {
                                    assistant_text.push_str(&delta);
                                }
                            }
                            Some("tool_call") if stage == "complete" => {
                                if let Some(tool_call) = chunk.get("toolCall") {
                                    let mut next = self.execute_or_ask(session_id, &mode, tool_call.clone(), workspace)?;
                                    events.append(&mut next);
                                }
                            }
                            Some("error") => {
                                events.push(new_event(
                                    session_id,
                                    "error",
                                    json!({ "stage": stage, "message": string_field(chunk, "error").unwrap_or_else(|| "LLM stream error".into()) }),
                                ));
                            }
                            _ => {}
                        }
                    }

                    let trimmed = assistant_text.trim().to_string();
                    if !trimmed.is_empty() {
                        stage_outputs.push(format!("[{stage}] {trimmed}"));
                        if stage != "review" {
                            events.push(new_event(
                                session_id,
                                "assistant_msg",
                                json!({ "stage": stage, "content": trimmed }),
                            ));
                        }
                        if stage == "complete" {
                            let mut parsed = self.run_parsed_text_actions(
                                session_id,
                                &mode,
                                &trimmed,
                                workspace,
                            )?;
                            events.append(&mut parsed);
                        }
                    }
                    events.push(new_event(
                        session_id,
                        "workflow_stage",
                        json!({
                            "stage": stage,
                            "profileId": profile_id,
                            "status": "completed",
                            "summary": if trimmed.is_empty() { "No textual output.".into() } else { take_chars(&trimmed, 240) },
                            "details": if stage == "review" && !trimmed.is_empty() { Value::String(trimmed) } else { Value::Null }
                        }),
                    ));
                }
                Err(err) => {
                    events.push(new_event(
                        session_id,
                        "workflow_stage",
                        json!({ "stage": stage, "profileId": profile_id, "status": "error", "summary": err }),
                    ));
                    events.push(new_event(session_id, "error", json!({ "stage": stage, "message": err })));
                }
            }
        }

        self.append_events_direct(session_id, events)
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
            json!({ "permissionId": permission_id, "decision": decision }),
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
                    "error": "permission_rejected"
                }),
            ));
        }
        self.append_events_direct(&pending.session_id, events)
    }

    fn append_events_direct(&self, session_id: &str, events: Vec<Value>) -> Result<AgentSessionResult, String> {
        let mut state = self.state.lock().expect("agent state poisoned");
        let Some(session) = state.sessions.get_mut(session_id) else {
            return Err(format!("Agent session not found: {session_id}"));
        };
        session.events.extend(events);
        if let Some(obj) = session.session.as_object_mut() {
            obj.insert("updatedAt".into(), Value::String(now_iso()));
        }
        Ok(session.clone())
    }

    fn execute_or_ask(
        &self,
        session_id: &str,
        mode: &str,
        tool_call: Value,
        workspace: &workspace::WorkspaceManager,
    ) -> Result<Vec<Value>, String> {
        let mut events = vec![new_event(session_id, "tool_call", tool_call.clone())];
        let decision = evaluate_agent_permission_value(
            json!({ "mode": mode, "toolCall": tool_call.clone() }),
            workspace,
        );
        match string_field(&decision, "action").as_deref() {
            Some("deny") => {
                events.push(new_event(
                    session_id,
                    "tool_result",
                    json!({
                        "callId": tool_call.get("id").cloned().unwrap_or_else(|| json!("tool-call")),
                        "toolName": tool_call.get("name").cloned().unwrap_or_else(|| json!("tool")),
                        "ok": false,
                        "error": string_field(&decision, "reason").unwrap_or_else(|| "permission denied".into())
                    }),
                ));
            }
            Some("ask") => {
                let request = decision.get("request").cloned().ok_or_else(|| "permission request missing".to_string())?;
                let permission_id = string_field(&request, "id").ok_or_else(|| "permission id missing".to_string())?;
                let mut state = self.state.lock().expect("agent state poisoned");
                state.pending_permissions.insert(
                    permission_id,
                    PendingPermission {
                        session_id: session_id.to_string(),
                        tool_call,
                        mode: mode.to_string(),
                    },
                );
                events.push(new_event(session_id, "permission_request", request));
            }
            _ => {
                let result = execute_agent_tool_value(
                    json!({ "mode": mode, "toolCall": tool_call.clone() }),
                    workspace,
                );
                events.push(new_event(session_id, "tool_result", with_tool_name(result, &tool_call)));
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
    ) -> Result<Vec<Value>, String> {
        let actions = parse_agent_actions(content);
        let mut events = Vec::new();
        for action in actions {
            let action_type = string_field(&action, "type").unwrap_or_default();
            if string_field(&action, "status").as_deref() != Some("parsed") {
                events.push(new_event(
                    session_id,
                    "error",
                    json!({ "message": "Invalid action", "action": action }),
                ));
                continue;
            }
            if action_type == "final" {
                events.push(new_event(session_id, "assistant_msg", action.get("payload").cloned().unwrap_or(Value::Null)));
                continue;
            }
            if action_type == "patch.plan" {
                events.push(new_event(
                    session_id,
                    "tool_result",
                    json!({
                        "callId": action.get("id").cloned().unwrap_or_else(|| json!("patch-plan")),
                        "toolName": "patch.plan",
                        "ok": false,
                        "status": "needsApproval",
                        "output": action.get("payload").cloned().unwrap_or(Value::Null),
                        "error": "patch_plan_needs_approval"
                    }),
                ));
                continue;
            }
            let tool_call = json!({
                "id": action.get("id").cloned().unwrap_or_else(|| json!("action")),
                "name": action_type,
                "arguments": action.get("payload").cloned().unwrap_or_else(|| json!({}))
            });
            let mut next = self.execute_or_ask(session_id, mode, tool_call, workspace)?;
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
        tool("fs.read", "Read a text file from the active workspace.", "low", false, vec!["readOnly", "plan", "askBeforeWrite"], json!({ "type": "object", "required": ["path"], "properties": { "path": { "type": "string" }, "folderId": { "type": "string" } } })),
        tool("fs.list", "List a workspace directory tree with a bounded depth.", "low", false, vec!["readOnly", "plan", "askBeforeWrite"], json!({ "type": "object", "properties": { "path": { "type": "string" }, "folderId": { "type": "string" }, "depth": { "type": "number" } } })),
        tool("fs.diff", "Preview a file diff without writing content.", "low", false, vec!["readOnly", "plan", "askBeforeWrite"], json!({ "type": "object", "required": ["path", "newContent"], "properties": { "path": { "type": "string" }, "folderId": { "type": "string" }, "newContent": { "type": "string" } } })),
        tool("code.search", "Search text across the workspace with bounded results.", "low", false, vec!["readOnly", "plan", "askBeforeWrite"], json!({ "type": "object", "required": ["query"], "properties": { "query": { "type": "string" }, "isRegex": { "type": "boolean" }, "include": { "type": "array", "items": { "type": "string" } }, "folderId": { "type": "string" } } })),
        tool("shell.propose", "Return a proposed shell command. The command is never executed.", "medium", false, vec!["plan", "askBeforeWrite"], json!({ "type": "object", "required": ["command"], "properties": { "command": { "type": "string" }, "reason": { "type": "string" } } })),
        tool("shell.exec", "Run a command in an Agent-owned temporary shell after explicit approval.", "high", true, vec!["askBeforeWrite"], json!({ "type": "object", "required": ["command"], "properties": { "command": { "type": "string" }, "cwd": { "type": "string" }, "timeoutMs": { "type": "number" }, "reason": { "type": "string" } } })),
        tool("fs.write", "Write a text file after an explicit permission approval.", "high", true, vec!["askBeforeWrite"], json!({ "type": "object", "required": ["path", "content"], "properties": { "path": { "type": "string" }, "content": { "type": "string" }, "folderId": { "type": "string" } } })),
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

fn evaluate_agent_permission_value(request: Value, _workspace: &workspace::WorkspaceManager) -> Value {
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
        .is_some_and(|modes| modes.iter().any(|value| value.as_str() == Some(mode.as_str())))
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
        if let Some(fragment) = command_blacklist().into_iter().find(|fragment| command.contains(fragment)) {
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

    if tool.get("needsApproval").and_then(Value::as_bool).unwrap_or(false) {
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
    let approved = body.get("approved").and_then(Value::as_bool).unwrap_or(false);
    let decision = evaluate_agent_permission_value(json!({ "mode": mode, "toolCall": tool_call.clone() }), workspace);
    match string_field(&decision, "action").as_deref() {
        Some("deny") => return tool_failure(&tool_call, string_field(&decision, "reason").unwrap_or_else(|| "permission denied".into())),
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

fn exec_fs_read(tool_call: &Value, workspace: &workspace::WorkspaceManager) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let path = required_string(args, "path")?;
    let folder_id = string_field(args, "folderId");
    let folder = workspace.resolve_folder(folder_id.as_deref())?;
    serde_json::to_value(fs::read_text_file(&folder.absolute_path, &folder.id, &path)?).map_err(|err| err.to_string())
}

fn exec_fs_list(tool_call: &Value, workspace: &workspace::WorkspaceManager) -> Result<Value, String> {
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

fn exec_fs_diff(tool_call: &Value, workspace: &workspace::WorkspaceManager) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let path = required_string(args, "path")?;
    let new_content = required_string(args, "newContent")?;
    let old_content = read_file_content_for_diff(args, workspace).unwrap_or_default();
    Ok(Value::String(diff_preview(&path, &old_content, &new_content)))
}

fn exec_fs_write(tool_call: &Value, workspace: &workspace::WorkspaceManager) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let path = required_string(args, "path")?;
    let content = required_string(args, "content")?;
    let folder_id = string_field(args, "folderId");
    let folder = workspace.resolve_folder(folder_id.as_deref())?;
    serde_json::to_value(fs::write_text_file(&folder.absolute_path, &folder.id, &path, &content)?).map_err(|err| err.to_string())
}

fn exec_code_search(tool_call: &Value, workspace: &workspace::WorkspaceManager) -> Result<Value, String> {
    let args = args_object(tool_call)?;
    let query = required_string(args, "query")?;
    let folder_id = string_field(args, "folderId");
    Ok(code_search(json!({ "query": query, "folderId": folder_id }), workspace))
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
    let timeout_ms = args.get("timeoutMs").and_then(Value::as_u64).unwrap_or(8000).clamp(1000, 120_000);
    execute_agent_shell_command(&command, &cwd, timeout_ms)
}

fn execute_agent_shell_command(command: &str, cwd: &str, timeout_ms: u64) -> Result<Value, String> {
    let temp_session_id = format!("agent-shell-{}", Utc::now().timestamp_millis());
    let started = Instant::now();
    let mut cmd = if cfg!(target_os = "windows") {
        let mut command_builder = Command::new("wsl.exe");
        command_builder.args(["--", "bash", "-lc", command]);
        command_builder
    } else {
        let mut command_builder = Command::new("bash");
        command_builder.args(["-lc", command]);
        command_builder.current_dir(cwd);
        command_builder
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
    let fallback = string_field(request, "profileId").or_else(|| string_field(session, "profileId"));
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
        "You are DeepCode Agent, a local coding assistant controlled by explicit permissions.".to_string(),
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
                    parts.push(format!("Attached file: {path}\n{}", take_chars(&file.content, 12_000)));
                }
            }
        } else if kind == "directory" {
            parts.push(format!("Attached directory: {path}. Use fs.list/fs.read for details."));
        } else if kind == "panelSnapshot" {
            parts.push(format!("Attached panel snapshot: {path}"));
        }
    }
    parts.join("\n\n")
}

fn stage_prompt(stage: &str) -> &'static str {
    match stage {
        "plan" => "You are the planning stage. Create a concise plan and classify whether this is directExecution or needsUserConfirmation. Do not request local writes or shell execution.",
        "check" => "You are the checking stage. Review plan, context, risks, and likely tool usage. Do not request local writes or shell execution.",
        "complete" => "You are the completion stage. Use deepcode-action JSON blocks or tool calls when local operations are needed. All local operations are subject to the permission gate.",
        "review" => "You are the review stage. Summarize what happened, observations, remaining risks, and next steps. Do not perform new local operations.",
        _ => "You are DeepCode Agent.",
    }
}

fn permission_request(tool_call: &Value, risk_level: &str, summary: &str, diff: Option<String>) -> Value {
    let mut map = Map::new();
    map.insert("id".into(), Value::String(format!("perm-{}", Utc::now().timestamp_micros())));
    map.insert("toolName".into(), Value::String(string_field(tool_call, "name").unwrap_or_else(|| "tool".into())));
    map.insert("riskLevel".into(), Value::String(risk_level.to_string()));
    map.insert("summary".into(), Value::String(summary.to_string()));
    map.insert("argumentsPreview".into(), tool_call.get("arguments").cloned().unwrap_or(Value::Null));
    if let Some(diff) = diff {
        map.insert("diff".into(), Value::String(diff));
    }
    Value::Object(map)
}

fn settings_policy_deny_reason(tool_call: &Value) -> Option<String> {
    let name = string_field(tool_call, "name")?;
    match name.as_str() {
        "fs.read" | "fs.list" | "fs.diff" if !bool_setting("agent.permissions.allowFileRead", true) => Some("Agent file read tools are disabled in Settings.".into()),
        "fs.write" if !bool_setting("agent.permissions.allowFileWrite", true) => Some("Agent file write tools are disabled in Settings.".into()),
        "code.search" if !bool_setting("agent.permissions.allowCodeSearch", true) => Some("Agent code search is disabled in Settings.".into()),
        "shell.propose" if !bool_setting("agent.permissions.allowShellPropose", true) => Some("Agent shell command proposals are disabled in Settings.".into()),
        "shell.exec" if !bool_setting("agent.permissions.allowShellExec", true) => Some("Agent shell execution requests are disabled in Settings.".into()),
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

fn diff_preview_for_tool(tool_call: &Value, workspace: &workspace::WorkspaceManager) -> Result<String, String> {
    let args = args_object(tool_call)?;
    let path = required_string(args, "path")?;
    let new_content = required_string(args, "content")?;
    let old_content = read_file_content_for_diff(args, workspace).unwrap_or_default();
    Ok(diff_preview(&path, &old_content, &new_content))
}

fn read_file_content_for_diff(args: &Value, workspace: &workspace::WorkspaceManager) -> Result<String, String> {
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
        "output": output
    })
}

fn tool_failure(tool_call: &Value, error: String) -> Value {
    json!({
        "callId": tool_call.get("id").cloned().unwrap_or_else(|| json!("tool-call")),
        "ok": false,
        "error": error
    })
}

fn with_tool_name(mut result: Value, tool_call: &Value) -> Value {
    if let Some(obj) = result.as_object_mut() {
        obj.insert("toolName".into(), tool_call.get("name").cloned().unwrap_or_else(|| json!("tool")));
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
    config_root().join("user").join(user_id()).join("agent").join("workflow-config.json")
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
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
        .collect()
}

fn write_json_atomic(path: PathBuf, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "invalid_store_path".to_string())?;
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

fn new_event(session_id: &str, kind: &str, payload: Value) -> Value {
    json!({
        "id": format!("evt-{}-{}", Utc::now().timestamp_micros(), kind),
        "sessionId": session_id,
        "ts": now_iso(),
        "kind": kind,
        "payload": payload
    })
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
