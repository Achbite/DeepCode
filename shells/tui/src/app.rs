use crate::renderer::Renderer;
use deepcode_kernel_client::{
    approval_response_command, cancel_command, interaction_response_command,
    is_terminal_run_status, message_command, plan_cancel_command, plan_confirm_command,
    plan_revision_command, profile_selection_command, ConversationResourceReadResult,
    CreateConversationSessionRequest, HttpKernelClient, InteractionProjection, SessionProjection,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct TuiHostOptions {
    pub workspace_path: Option<PathBuf>,
    pub session_id: Option<String>,
}

pub struct TuiApp {
    client: HttpKernelClient,
    renderer: Renderer,
    host: TuiHostOptions,
    projection: Option<SessionProjection>,
    input: String,
    status: String,
    action_required: Option<String>,
    resource_preview: Option<ConversationResourceReadResult>,
    context_open: bool,
}

impl TuiApp {
    pub fn new(client: HttpKernelClient, renderer: Renderer, host: TuiHostOptions) -> Self {
        Self {
            status: format!("API {} · 初始化", client.base_url()),
            client,
            renderer,
            host,
            projection: None,
            input: String::new(),
            action_required: None,
            resource_preview: None,
            context_open: false,
        }
    }

    pub async fn bootstrap(&mut self) {
        let result = if let Some(session_id) = self.host.session_id.as_deref() {
            self.client.conversation_projection(session_id).await
        } else {
            let workspace_paths = match self.host.workspace_path.as_ref() {
                Some(path) => match path.canonicalize() {
                    Ok(root) => Some(vec![root.to_string_lossy().to_string()]),
                    Err(error) => {
                        self.status = format!("工作区不可用：{error}");
                        return;
                    }
                },
                None => None,
            };
            self.client
                .create_conversation_session(&CreateConversationSessionRequest {
                    session_id: None,
                    workspace_paths,
                    project_id: None,
                    profile_id: None,
                })
                .await
        };
        match result {
            Ok(projection) => {
                self.status = format!("session {} · ready", projection.session_id);
                self.projection = Some(projection);
                self.update_action_required();
            }
            Err(error) => self.status = format!("Session 初始化失败：{error}"),
        }
    }

    pub async fn poll(&mut self) {
        let Some(session_id) = self
            .projection
            .as_ref()
            .map(|projection| projection.session_id.clone())
        else {
            return;
        };
        match self.client.conversation_projection(&session_id).await {
            Ok(projection) => {
                self.status = projection
                    .run
                    .as_ref()
                    .map(|run| format!("run {} · {}", run.run_id, run.status))
                    .unwrap_or_else(|| format!("session {} · ready", projection.session_id));
                self.projection = Some(projection);
                self.update_action_required();
            }
            Err(error) => self.status = format!("刷新共享投影失败：{error}"),
        }
    }

    pub async fn submit_line(&mut self, line: &str) -> bool {
        let input = line.trim();
        if input.is_empty() {
            return true;
        }
        match input {
            "/quit" | "/exit" => return false,
            "/help" => {
                self.status = "/attach <path> /detach <workspace-id> /cancel-plan /model <profile> /cancel /context /open <workspace-id> <logical-path> /close /show /clear /quit；Plan 输入 1/确认".to_string();
            }
            "/show" => self.status = self.projection_label(),
            "/clear" => self.status = "可见输入已清理；durable Session 未修改".to_string(),
            "/context" => self.toggle_context(),
            "/close" => {
                self.context_open = false;
                self.resource_preview = None;
                self.status = "已关闭辅助视图。".to_string();
            }
            "/cancel-plan" => self.cancel_plan().await,
            "/cancel" => self.cancel_run().await,
            value if value.starts_with("/open ") => self.open_resource(value).await,
            value if value.starts_with("/attach ") => {
                self.attach_directory(value.trim_start_matches("/attach ").trim())
                    .await
            }
            value if value.starts_with("/detach ") => {
                self.detach_directory(value.trim_start_matches("/detach ").trim())
                    .await
            }
            value if value.starts_with("/model ") => {
                self.select_model(value.trim_start_matches("/model ").trim())
                    .await
            }
            value if value.starts_with('/') => self.status = format!("未知命令：{value}"),
            text => self.submit_contextual_input(text).await,
        }
        true
    }

    async fn submit_contextual_input(&mut self, text: &str) {
        let Some(projection) = self.projection.as_ref() else {
            self.status = "Session 尚未初始化。".to_string();
            return;
        };
        let session_id = projection.session_id.clone();
        let command = if let Some(approval) = projection.pending_approval.as_ref() {
            let decision = match approval_decision_for_input(text) {
                Ok(decision) => decision,
                Err(message) => {
                    self.status = message;
                    return;
                }
            };
            approval_response_command(&session_id, &new_id("command"), approval, decision)
        } else if let Some(plan) = projection.pending_plan.as_ref() {
            if is_plan_confirmation_input(text) {
                plan_confirm_command(&session_id, &new_id("command"), plan)
            } else {
                plan_revision_command(&session_id, &new_id("command"), plan, text)
            }
        } else if let Some(interaction) = projection.pending_interaction.as_ref() {
            let response = interaction_response_for_input(interaction, text);
            interaction_response_command(&session_id, &new_id("command"), interaction, &response)
        } else {
            message_command(&session_id, &new_id("command"), text)
        };
        self.submit_command(&session_id, command, "消息提交失败")
            .await;
    }

    pub async fn cancel_plan(&mut self) {
        let Some(projection) = self.projection.as_ref() else {
            self.status = "Session 尚未初始化。".to_string();
            return;
        };
        let Some(plan) = projection.pending_plan.as_ref() else {
            self.clear_input();
            self.status = "当前没有待处理 Plan。".to_string();
            return;
        };
        let session_id = projection.session_id.clone();
        let command = plan_cancel_command(&session_id, &new_id("command"), plan);
        self.clear_input();
        self.submit_command(&session_id, command, "取消 Plan 失败")
            .await;
    }

    async fn select_model(&mut self, profile_id: &str) {
        let Some(projection) = self.projection.as_ref() else {
            self.status = "Session 尚未初始化。".to_string();
            return;
        };
        let Some(run) = projection.run.as_ref() else {
            self.status = "当前没有活动 run。".to_string();
            return;
        };
        let session_id = projection.session_id.clone();
        let command =
            profile_selection_command(&session_id, &new_id("command"), &run.run_id, profile_id);
        self.submit_command(&session_id, command, "模型切换失败")
            .await;
    }

    async fn cancel_run(&mut self) {
        let Some(projection) = self.projection.as_ref() else {
            self.status = "Session 尚未初始化。".to_string();
            return;
        };
        let Some(run) = projection.run.as_ref() else {
            self.status = "当前没有运行。".to_string();
            return;
        };
        if is_terminal_run_status(&run.status) {
            self.status = format!("run {} 已经结束。", run.run_id);
            return;
        }
        let session_id = projection.session_id.clone();
        let command = cancel_command(&session_id, &new_id("command"), &run.run_id);
        self.submit_command(&session_id, command, "取消命令失败")
            .await;
    }

    async fn open_resource(&mut self, command: &str) {
        let mut parts = command.splitn(3, ' ');
        let _ = parts.next();
        let Some(workspace_id) = parts.next().filter(|value| !value.is_empty()) else {
            self.status = "用法：/open <workspace-id> <logical-path>".to_string();
            return;
        };
        let Some(logical_path) = parts
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            self.status = "用法：/open <workspace-id> <logical-path>".to_string();
            return;
        };
        let Some(session_id) = self
            .projection
            .as_ref()
            .map(|projection| projection.session_id.clone())
        else {
            self.status = "Session 尚未初始化。".to_string();
            return;
        };
        match self
            .client
            .conversation_resource_read(&session_id, workspace_id, logical_path)
            .await
        {
            Ok(resource) => {
                self.context_open = false;
                self.status = format!(
                    "只读资源 {} · {} bytes",
                    resource.logical_path, resource.size_bytes
                );
                self.resource_preview = Some(resource);
            }
            Err(error) => self.status = format!("资源读取失败：{error}"),
        }
    }

    async fn attach_directory(&mut self, path: &str) {
        if path.is_empty() {
            self.status = "用法：/attach <path>".to_string();
            return;
        }
        let Some(session_id) = self
            .projection
            .as_ref()
            .map(|projection| projection.session_id.clone())
        else {
            self.status = "Session 尚未初始化。".to_string();
            return;
        };
        match self
            .client
            .attach_conversation_directory_index(&session_id, path)
            .await
        {
            Ok(projection) => {
                self.projection = Some(projection);
                self.status = "目录索引已附加；从下一次 run 起生效。".to_string();
            }
            Err(error) => self.status = format!("目录索引附加失败：{error}"),
        }
    }

    async fn detach_directory(&mut self, workspace_id: &str) {
        if workspace_id.is_empty() {
            self.status = "用法：/detach <workspace-id>".to_string();
            return;
        }
        let Some(session_id) = self
            .projection
            .as_ref()
            .map(|projection| projection.session_id.clone())
        else {
            self.status = "Session 尚未初始化。".to_string();
            return;
        };
        match self
            .client
            .detach_conversation_directory_index(&session_id, workspace_id)
            .await
        {
            Ok(projection) => {
                self.projection = Some(projection);
                self.status = "目录索引已移除；运行中的 run 保留冻结快照。".to_string();
            }
            Err(error) => self.status = format!("目录索引移除失败：{error}"),
        }
    }

    pub async fn interrupt(&mut self) {
        self.cancel_run().await;
    }

    async fn submit_command(
        &mut self,
        session_id: &str,
        command: serde_json::Value,
        failure_label: &str,
    ) {
        match self
            .client
            .submit_conversation_command(session_id, &command)
            .await
        {
            Ok(reply) if reply.status != "rejected" => {
                self.status = format!("命令已接纳 · revision {}", reply.revision);
                self.poll().await;
            }
            Ok(reply) => {
                self.status = reply
                    .error
                    .map(|error| format!("{}：{}", error.code, error.message))
                    .unwrap_or_else(|| "命令被拒绝。".to_string());
            }
            Err(error) => self.status = format!("{failure_label}：{error}"),
        }
    }

    fn update_action_required(&mut self) {
        self.action_required = self.projection.as_ref().and_then(|projection| {
            if projection.pending_plan.is_some() {
                Some("Agent 正在等待 Plan 确认、修订说明或显式取消。".to_string())
            } else if projection.pending_interaction.is_some() {
                Some("Agent 正在等待你回答中间问题。".to_string())
            } else if projection.pending_approval.is_some() {
                Some("Agent 正在等待 effect 允许或拒绝。".to_string())
            } else {
                None
            }
        });
    }

    pub fn renderer(&self) -> &Renderer {
        &self.renderer
    }

    pub fn projection(&self) -> Option<&SessionProjection> {
        self.projection.as_ref()
    }

    pub fn resource_preview(&self) -> Option<&ConversationResourceReadResult> {
        self.resource_preview.as_ref()
    }

    pub fn context_open(&self) -> bool {
        self.context_open
    }

    pub fn input(&self) -> &str {
        &self.input
    }

    pub fn status(&self) -> &str {
        &self.status
    }

    pub fn push_input(&mut self, value: char) {
        self.input.push(value);
    }

    pub fn push_input_text(&mut self, value: &str) {
        self.input.push_str(value);
    }

    pub fn backspace_input(&mut self) {
        self.input.pop();
    }

    pub fn clear_input(&mut self) {
        self.input.clear();
    }

    pub fn take_input(&mut self) -> String {
        std::mem::take(&mut self.input)
    }

    pub fn has_pending_plan(&self) -> bool {
        self.projection
            .as_ref()
            .is_some_and(|projection| projection.pending_plan.is_some())
    }

    pub fn is_run_pending(&self) -> bool {
        self.projection
            .as_ref()
            .and_then(|projection| projection.run.as_ref())
            .is_some_and(|run| run.status == "running")
    }

    pub fn take_action_required(&mut self) -> Option<String> {
        self.action_required.take()
    }

    fn projection_label(&self) -> String {
        self.projection
            .as_ref()
            .map(|projection| {
                format!(
                    "session {} · revision {} · {} transcript item(s) · indexes [{}]",
                    projection.session_id,
                    projection.revision,
                    projection.messages.len() + projection.narratives.len(),
                    projection
                        .session_directory_indexes
                        .iter()
                        .map(|binding| format!(
                            "{} ({})",
                            binding.display_name, binding.workspace_id
                        ))
                        .collect::<Vec<_>>()
                        .join(", "),
                )
            })
            .unwrap_or_else(|| "Session 尚未初始化。".to_string())
    }

    fn toggle_context(&mut self) {
        self.context_open = !self.context_open;
        if self.context_open {
            self.resource_preview = None;
            self.status = "上下文视图已打开。".to_string();
        } else {
            self.status = "上下文视图已关闭。".to_string();
        }
    }
}

fn approval_decision_for_input(input: &str) -> Result<&'static str, String> {
    match input.trim().to_lowercase().as_str() {
        "1" | "allow" | "允许" | "同意" => Ok("allow"),
        "2" | "deny" | "拒绝" | "不同意" => Ok("deny"),
        _ => Err("当前等待 effect 裁决：输入 1/允许 或 2/拒绝。".to_string()),
    }
}

fn is_plan_confirmation_input(input: &str) -> bool {
    matches!(
        input.trim().to_ascii_lowercase().as_str(),
        "1" | "y" | "yes" | "confirm"
    ) || matches!(input.trim(), "确认" | "同意")
}

fn interaction_response_for_input(interaction: &InteractionProjection, input: &str) -> String {
    input
        .parse::<usize>()
        .ok()
        .and_then(|index| index.checked_sub(1))
        .and_then(|index| interaction.options.as_ref()?.get(index))
        .map(|option| option.label.clone())
        .unwrap_or_else(|| input.to_string())
}

fn new_id(kind: &str) -> String {
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{kind}:{}:{clock:x}:{sequence:x}", std::process::id())
}
