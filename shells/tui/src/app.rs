use crate::renderer::Renderer;
use deepcode_kernel_client::{
    approval_response_command, cancel_command, focus_command, interaction_response_command,
    is_terminal_run_status, message_command_with_profile_and_plugins, plan_cancel_command,
    plan_confirm_command, plan_revision_command, ConversationResourceReadResult,
    CreateConversationSessionRequest, HttpKernelClient, InteractionProjection, PluginCatalogItem,
    PluginCatalogProjection, PluginSelectionInput, SessionProjection,
};
use serde_json::json;
use std::cell::Cell;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct TuiHostOptions {
    pub workspace_path: Option<PathBuf>,
    pub session_id: Option<String>,
    pub plugin_uris: Vec<String>,
}

#[derive(Debug, Clone)]
struct PluginPickerState {
    trigger_start: usize,
    query: String,
    selected_index: usize,
}

#[derive(Debug, Clone)]
struct SelectedMention {
    uri: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone)]
pub struct PluginPickerEntry {
    pub display_name: String,
    pub short_description: String,
    pub uri: String,
    pub highlighted: bool,
    pub already_selected: bool,
}

#[derive(Clone)]
struct ModelPicker {
    connection_id: Option<String>,
    selected: usize,
}

pub struct TuiApp {
    client: HttpKernelClient,
    renderer: Renderer,
    host: TuiHostOptions,
    projection: Option<SessionProjection>,
    input: String,
    status: String,
    connection_error: Option<String>,
    next_message_profile_id: Option<String>,
    model_connections: Option<deepcode_kernel_client::ModelConnections>,
    model_profiles: Vec<deepcode_kernel_client::ModelProfile>,
    model_picker: Option<ModelPicker>,
    plugin_catalog: Option<PluginCatalogProjection>,
    selected_plugins: Vec<PluginSelectionInput>,
    selected_mentions: Vec<SelectedMention>,
    plugin_picker: Option<PluginPickerState>,
    resource_preview: Option<ConversationResourceReadResult>,
    context_open: bool,
    tasks_open: bool,
    detail_preview: Option<String>,
    reasoning_enabled: bool,
    detail_scroll: u16,
    transcript_scroll: Cell<Option<usize>>,
    transcript_scroll_max: Cell<usize>,
}

impl TuiApp {
    pub fn new(client: HttpKernelClient, renderer: Renderer, host: TuiHostOptions) -> Self {
        Self {
            status: format!("API {} · 初始化", client.base_url()),
            connection_error: None,
            client,
            renderer,
            host,
            projection: None,
            input: String::new(),
            next_message_profile_id: None,
            model_connections: None,
            model_profiles: Vec::new(),
            model_picker: None,
            plugin_catalog: None,
            selected_plugins: Vec::new(),
            selected_mentions: Vec::new(),
            plugin_picker: None,
            resource_preview: None,
            context_open: false,
            tasks_open: false,
            detail_preview: None,
            reasoning_enabled: false,
            detail_scroll: 0,
            transcript_scroll: Cell::new(None),
            transcript_scroll_max: Cell::new(0),
        }
    }

    pub async fn bootstrap(&mut self) -> Result<(), String> {
        let result = if let Some(session_id) = self.host.session_id.as_deref() {
            self.client.conversation_projection(session_id).await
        } else {
            let workspace_paths = match self.host.workspace_path.as_ref() {
                Some(path) => match path.canonicalize() {
                    Ok(root) => Some(vec![root.to_string_lossy().to_string()]),
                    Err(error) => {
                        self.status = format!("工作区不可用：{error}");
                        return Err(self.status.clone());
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
                let catalog = self
                    .client
                    .conversation_plugin_catalog()
                    .await
                    .map_err(|error| format!("插件目录加载失败：{error}"))?;
                let selected_plugins =
                    plugin_selections_from_uris(&catalog, &self.host.plugin_uris)?;
                self.status = "就绪 · /help 查看命令".to_string();
                self.projection = Some(projection);
                self.plugin_catalog = Some(catalog);
                self.selected_plugins = selected_plugins;
                Ok(())
            }
            Err(error) => {
                self.status = format!("Session 初始化失败：{error}");
                Err(self.status.clone())
            }
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
                self.connection_error = None;
                self.projection = Some(projection);
            }
            Err(error) => self.connection_error = Some(format!("刷新共享投影失败：{error}")),
        }
    }

    pub async fn submit_line(&mut self, line: &str) -> bool {
        let input = line.trim();
        if input.is_empty() {
            return true;
        }
        self.transcript_scroll.set(None);
        match input {
            "/quit" | "/exit" => return false,
            "/help" => {
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_scroll = 0;
                self.detail_preview = Some("DeepCode 命令\n\n@ 选择下一次请求的插件\n/tasks 查看任务\n/context 查看上下文\n/focus <task> 开始任务\n/model 选择连接和模型；/model <profile> 直接选择已配置模型\n/attach <path> 附加目录\n/detach <workspace-id> 移除目录索引\n/open <workspace-id> <logical-path> 读取文件\n/next 继续读取\n/diff <record-id> <index> 查看修改\n/reasoning 开关推理详情\n/reasoning <request-id> 按需读取推理\n/cancel 取消运行\n/cancel-plan 取消计划\n/close 返回会话\n/clear 清空输入\n/show 查看会话信息\n/error 失败诊断与快照\n/decision 当前决策详情\n/tool <activity-id> 工具详情\n/quit 退出\n\nPgUp / PgDn 滚动当前视图；普通消息随时排队；/reply <答复> 回应交互或修订计划，/reply 1 确认计划。".into());
            }
            "/show" => self.status = self.projection_label(),
            "/error" | "/decision" => {
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_scroll = 0;
                self.detail_preview = Some(if input == "/error" {
                    crate::renderer::failure_details(self.projection.as_ref())
                } else {
                    crate::renderer::decision_details(self.projection.as_ref())
                });
            }
            "/clear" => {
                self.clear_input();
                self.status =
                    "可见输入与下一次请求的插件选择已清理；durable Session 未修改".to_string();
            }
            "/context" => self.toggle_context(),
            "/tasks" => {
                self.tasks_open = !self.tasks_open;
                self.context_open = false;
                self.resource_preview = None;
                self.detail_preview = None;
                self.detail_scroll = 0;
            }
            "/next" => self.next_resource().await,
            "/reasoning" => {
                self.reasoning_enabled = !self.reasoning_enabled;
                self.status = if self.reasoning_enabled { "推理详情已开启；使用 /reasoning <request-id> [offset] 展开，/reasoning-history 查阅历史。" } else { "推理详情已关闭，仅显示状态。" }.into();
            }
            value if value.starts_with("/diff ") => self.read_detail(value, false).await,
            value if value.starts_with("/reasoning ") || value == "/reasoning-history" => {
                self.read_detail(value, true).await
            }
            "/close" => {
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_preview = None;
                self.status = "已关闭辅助视图。".to_string();
            }
            value if value.starts_with("/tool ") => {
                self.context_open = false;
                self.tasks_open = false;
                self.resource_preview = None;
                self.detail_scroll = 0;
                self.detail_preview = Some(crate::renderer::tool_details(
                    self.projection.as_ref(),
                    value.trim_start_matches("/tool ").trim(),
                ));
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
            "/model" | "/connection" => {
                self.open_model_picker().await;
            }
            value if value.starts_with("/model ") => {
                self.open_model_picker().await;
                if self.model_picker.is_some() {
                    self.select_model(value.trim_start_matches("/model ").trim());
                }
            }
            value
                if value == "/focus"
                    || value.starts_with("/focus ")
                    || value == "/reply"
                    || value.starts_with("/reply ") =>
            {
                self.submit_contextual_input(value).await
            }
            value if value.starts_with('/') => self.status = format!("未知命令：{value}"),
            value if value.starts_with('@') => self.select_plugin_from_plain_input(value).await,
            _ => self.submit_contextual_input(line).await,
        }
        true
    }

    async fn submit_contextual_input(&mut self, text: &str) {
        let Some(projection) = self.projection.as_ref() else {
            self.status = "Session 尚未初始化。".to_string();
            return;
        };
        let session_id = projection.session_id.clone();
        let command = match self.contextual_input_command(projection, text) {
            Ok(command) => command,
            Err(error) => {
                self.status = error;
                return;
            }
        };
        if self
            .submit_command(&session_id, command, "消息提交失败")
            .await
            && text != "/reply"
            && !text.starts_with("/reply ")
        {
            self.clear_plugin_selections();
        }
    }

    fn contextual_input_command(
        &self,
        projection: &SessionProjection,
        text: &str,
    ) -> Result<serde_json::Value, String> {
        let session_id = projection.session_id.clone();
        let is_reply = text == "/reply" || text.starts_with("/reply ");
        let command = if is_reply {
            let response = text.strip_prefix("/reply").unwrap().trim();
            if response.is_empty() {
                return Err("用法：/reply <答复、确认或修订说明>".into());
            }
            if let Some(approval) = projection.pending_approval.as_ref() {
                let decision = approval_decision_for_input(response)?;
                if decision == "allow-run"
                    && approval.preview.authorization_scope.as_deref() != Some("runHostShell")
                {
                    return Err("当前操作未提供本轮宿主 Shell 授权。".into());
                }
                approval_response_command(&session_id, &new_id("command"), approval, decision)
            } else if let Some(plan) = projection.pending_plan.as_ref() {
                if is_plan_confirmation_input(response) {
                    plan_confirm_command(&session_id, &new_id("command"), plan)
                } else {
                    plan_revision_command(&session_id, &new_id("command"), plan, response)
                }
            } else if let Some(interaction) = projection.pending_interaction.as_ref() {
                let response = interaction_response_for_input(interaction, response);
                interaction_response_command(
                    &session_id,
                    &new_id("command"),
                    interaction,
                    &response,
                )
            } else {
                return Err("当前没有等待答复的 Plan、交互或 effect 审批。".into());
            }
        } else {
            let active_run = projection
                .run
                .as_ref()
                .filter(|run| matches!(run.status.as_str(), "running" | "waiting"));
            let profile_id = if active_run.is_some() {
                None
            } else {
                self.next_message_profile_id.as_deref()
            };
            let catalog_revision = self
                .plugin_catalog
                .as_ref()
                .map(|catalog| catalog.revision.as_str())
                .unwrap_or("");
            if let Some(task) = focus_task(text) {
                let Some(task) = task else {
                    return Err("/focus 需要非空任务正文。".to_string());
                };
                focus_command(
                    &session_id,
                    &new_id("command"),
                    task,
                    profile_id,
                    &[],
                    catalog_revision,
                    &self.selected_plugins,
                )
            } else {
                let mut command = message_command_with_profile_and_plugins(
                    &session_id,
                    &new_id("command"),
                    text,
                    profile_id,
                    &[],
                    catalog_revision,
                    &self.selected_plugins,
                );
                if let Some(run) = active_run {
                    command["runId"] = json!(run.run_id);
                }
                command
            }
        };
        Ok(command)
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

    async fn open_model_picker(&mut self) {
        match tokio::try_join!(
            self.client.model_connections(),
            self.client.model_profiles()
        ) {
            Ok((connections, profiles)) => {
                self.model_connections = Some(connections);
                self.model_profiles = profiles.profiles;
                self.plugin_picker = None;
                self.model_picker = Some(ModelPicker {
                    connection_id: None,
                    selected: 0,
                });
                self.status = "选择连接 · ↑/↓ 移动 · Enter 选择 · Esc 返回".into();
            }
            Err(error) => {
                self.model_picker = None;
                self.status = format!("模型目录读取失败：{error}");
            }
        }
    }

    fn select_model(&mut self, profile_id: &str) {
        let Some(profile) = self
            .model_profiles
            .iter()
            .find(|p| p.id == profile_id && p.parameters.enabled)
        else {
            self.status = "所选模型不存在或未启用。".into();
            return;
        };
        let connection_name = self
            .model_connections
            .as_ref()
            .and_then(|c| {
                c.connections
                    .iter()
                    .find(|c| c.connection.id == profile.connection_id)
            })
            .map(|c| c.connection.name.as_str())
            .unwrap_or(&profile.connection_id);
        self.next_message_profile_id = Some(profile_id.into());
        self.status = format!(
            "下次请求：{connection_name} / {}；当前 run 不变。",
            profile.parameters.name
        );
        self.model_picker = None;
    }

    pub fn model_picker_open(&self) -> bool {
        self.model_picker.is_some()
    }
    pub fn model_picker_title(&self) -> &str {
        if self
            .model_picker
            .as_ref()
            .is_some_and(|p| p.connection_id.is_some())
        {
            "选择模型"
        } else {
            "选择连接"
        }
    }
    pub fn model_picker_entries(&self) -> Vec<(String, String, bool)> {
        let Some(picker) = &self.model_picker else {
            return vec![];
        };
        let entries: Vec<(String, String)> = if let Some(id) = &picker.connection_id {
            self.model_profiles
                .iter()
                .filter(|p| &p.connection_id == id && p.parameters.enabled)
                .map(|p| {
                    (
                        p.id.clone(),
                        format!("{} · {}", p.parameters.name, p.parameters.model),
                    )
                })
                .collect()
        } else {
            self.model_connections
                .as_ref()
                .map(|catalog| {
                    catalog
                        .connections
                        .iter()
                        .map(|c| {
                            (
                                c.connection.id.clone(),
                                format!(
                                    "{} · {} · {}",
                                    c.connection.name,
                                    if c.connection.billing_mode == "subscription" {
                                        "Coding Plan"
                                    } else {
                                        "API"
                                    },
                                    match c.auth_status.as_str() {
                                        "ready" => "可用",
                                        "needsLogin" => "待登录",
                                        _ => "未配置",
                                    }
                                ),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        entries
            .into_iter()
            .enumerate()
            .map(|(i, (id, label))| (id, label, i == picker.selected))
            .collect()
    }
    pub fn model_picker_move(&mut self, delta: isize) {
        let count = self.model_picker_entries().len();
        if let Some(picker) = &mut self.model_picker {
            if count > 0 {
                picker.selected =
                    (picker.selected as isize + delta).rem_euclid(count as isize) as usize;
            }
        }
    }
    pub fn model_picker_select(&mut self) {
        let Some(picker) = self.model_picker.clone() else {
            return;
        };
        let Some((id, _, _)) = self.model_picker_entries().get(picker.selected).cloned() else {
            return;
        };
        if picker.connection_id.is_none() {
            self.model_picker = Some(ModelPicker {
                connection_id: Some(id),
                selected: 0,
            });
        } else {
            self.select_model(&id);
        }
    }
    pub fn model_picker_back(&mut self) {
        if self
            .model_picker
            .as_ref()
            .is_some_and(|p| p.connection_id.is_some())
        {
            self.model_picker = Some(ModelPicker {
                connection_id: None,
                selected: 0,
            });
        } else {
            self.model_picker = None;
        }
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

    async fn next_resource(&mut self) {
        let Some(resource) = self.resource_preview.clone() else {
            return;
        };
        let Some(next) = resource.next_byte else {
            self.status = "资源已读到末尾。".into();
            return;
        };
        let Some(projection) = &self.projection else {
            return;
        };
        match self
            .client
            .conversation_resource_read_range(
                &projection.session_id,
                &resource.workspace_id,
                &resource.logical_path,
                Some(next),
            )
            .await
        {
            Ok(resource) => {
                self.status = "已读取下一段；/next 续读。".into();
                self.detail_scroll = 0;
                self.resource_preview = Some(resource);
            }
            Err(error) => self.status = error.to_string(),
        }
    }

    async fn read_detail(&mut self, command: &str, reasoning: bool) {
        if reasoning && !self.reasoning_enabled {
            self.status = "先输入 /reasoning 开启可选详情。".into();
            return;
        }
        let Some(projection) = &self.projection else {
            return;
        };
        let words: Vec<_> = command.split_whitespace().collect();
        let result: Result<String, String> = if reasoning {
            let offset = words.get(2).map(|value| value.parse::<u64>()).transpose();
            match offset {
                Err(_) => Err("推理 offset 必须为非负整数。".into()),
                Ok(offset) => {
                    let query = if let Some(request) = words.get(1) {
                        json!({ "view": "reasoning", "providerRequestId": request, "offset": offset.unwrap_or(0) })
                    } else {
                        json!({ "view": "reasoning" })
                    };
                    self.client
                        .conversation_read(&projection.session_id, &query)
                        .await
                        .map(|value| {
                            serde_json::to_string_pretty(&value)
                                .unwrap_or_else(|error| error.to_string())
                        })
                        .map_err(|error| error.to_string())
                }
            }
        } else if words.len() == 3 {
            match words[2].parse::<usize>() {
                Ok(index) => self
                    .client
                    .conversation_change_read(&projection.session_id, words[1], index)
                    .await
                    .map(|change| change.unified_diff())
                    .map_err(|error| error.to_string()),
                Err(_) => Err("Diff index 必须为非负整数。".into()),
            }
        } else {
            Err("用法：/diff <record-id> <file-index>".into())
        };
        match result {
            Ok(content) => {
                self.detail_scroll = 0;
                self.detail_preview = Some(content);
                self.resource_preview = None;
                self.context_open = false;
                self.status = "按需详情 · /close 关闭".into();
            }
            Err(error) => self.status = error,
        }
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
                self.detail_preview = None;
                self.detail_scroll = 0;
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
    ) -> bool {
        match self
            .client
            .submit_conversation_command(session_id, &command)
            .await
        {
            Ok(reply) if reply.status != "rejected" => {
                self.status = format!("命令已接纳 · revision {}", reply.revision);
                self.poll().await;
                true
            }
            Ok(reply) => {
                let error = reply.error;
                let refresh_plugins = error.as_ref().is_some_and(|error| {
                    matches!(
                        error.code.as_str(),
                        "plugin_selection_stale" | "plugin_selection_unavailable"
                    )
                });
                self.status = error
                    .map(|error| format!("{}：{}", error.code, error.message))
                    .unwrap_or_else(|| "命令被拒绝。".to_string());
                if refresh_plugins {
                    self.clear_plugin_selections();
                    if let Err(error) = self.refresh_plugin_catalog().await {
                        self.status = format!("{}；插件目录刷新失败：{error}", self.status);
                    } else {
                        self.status.push_str("；插件目录已刷新，请重新选择。");
                    }
                }
                false
            }
            Err(error) => {
                self.status = format!("{failure_label}：{error}");
                false
            }
        }
    }

    pub fn action_required(&self) -> Option<String> {
        self.projection.as_ref().and_then(|projection| {
            if projection.pending_plan.is_some() {
                Some(
                    "Agent 正在等待 /reply 1 确认 Plan、/reply <修订说明> 或 /cancel-plan。"
                        .to_string(),
                )
            } else if projection.pending_interaction.is_some() {
                Some("Agent 正在等待 /reply <答复> 回答中间问题。".to_string())
            } else if projection.pending_approval.is_some() {
                Some("Agent 正在等待 /reply 1 允许或 /reply 2 拒绝 effect。".to_string())
            } else {
                None
            }
        })
    }

    pub fn renderer(&self) -> &Renderer {
        &self.renderer
    }

    pub fn projection(&self) -> Option<&SessionProjection> {
        self.projection.as_ref()
    }

    pub fn connection_error(&self) -> Option<&str> {
        self.connection_error.as_deref()
    }

    pub fn scroll_content(&mut self, down: bool) {
        self.scroll_lines(down, 12);
    }

    pub fn scroll_lines(&mut self, down: bool, lines: u16) {
        if self.detail_preview.is_some()
            || self.resource_preview.is_some()
            || self.context_open
            || self.tasks_open
        {
            self.detail_scroll = if down {
                self.detail_scroll.saturating_add(lines)
            } else {
                self.detail_scroll.saturating_sub(lines)
            };
        } else {
            let maximum = self.transcript_scroll_max.get();
            let current = self.transcript_scroll.get().unwrap_or(maximum);
            let next = if down {
                current.saturating_add(usize::from(lines)).min(maximum)
            } else {
                current.saturating_sub(usize::from(lines))
            };
            self.transcript_scroll.set((next < maximum).then_some(next));
        }
    }

    pub fn transcript_offset(&self, maximum: usize) -> usize {
        self.transcript_scroll_max.set(maximum);
        match self.transcript_scroll.get() {
            Some(offset) => {
                let offset = offset.min(maximum);
                self.transcript_scroll.set(Some(offset));
                offset
            }
            None => maximum,
        }
    }

    pub fn tasks_open(&self) -> bool {
        self.tasks_open
    }
    pub fn detail_scroll(&self) -> u16 {
        self.detail_scroll
    }
    pub fn detail_preview(&self) -> Option<&str> {
        self.detail_preview.as_deref()
    }

    pub fn reasoning_enabled(&self) -> bool {
        self.reasoning_enabled
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
        self.connection_error.as_deref().unwrap_or(&self.status)
    }

    pub fn next_message_profile(&self) -> Option<&str> {
        self.next_message_profile_id.as_deref()
    }

    pub fn push_input(&mut self, value: char) {
        self.input.push(value);
        self.sync_plugin_picker_from_input();
    }

    pub fn push_input_text(&mut self, value: &str) {
        self.input.push_str(value);
        self.sync_plugin_picker_from_input();
    }

    pub fn backspace_input(&mut self) {
        if let Some(mention) = self
            .selected_mentions
            .iter()
            .find(|mention| mention.end == self.input.len())
            .cloned()
        {
            self.input.truncate(mention.start);
            self.selected_mentions
                .retain(|candidate| candidate.uri != mention.uri);
            self.selected_plugins
                .retain(|selection| selection.uri != mention.uri);
            self.sync_plugin_picker_from_input();
            return;
        }
        self.input.pop();
        self.sync_plugin_picker_from_input();
    }

    pub fn clear_input(&mut self) {
        self.input.clear();
        self.clear_plugin_selections();
    }

    pub fn take_input(&mut self) -> String {
        self.plugin_picker = None;
        self.selected_mentions.clear();
        std::mem::take(&mut self.input)
    }

    pub fn plugin_picker_open(&self) -> bool {
        self.plugin_picker.is_some()
    }

    pub fn dismiss_plugin_picker(&mut self) {
        self.plugin_picker = None;
    }

    pub fn plugin_picker_move(&mut self, delta: isize) {
        let count = self.filtered_plugin_items().len();
        let Some(picker) = self.plugin_picker.as_mut() else {
            return;
        };
        if count == 0 {
            picker.selected_index = 0;
            return;
        }
        picker.selected_index = if delta.is_negative() {
            picker
                .selected_index
                .checked_sub(delta.unsigned_abs())
                .unwrap_or(count - 1)
        } else {
            (picker.selected_index + delta as usize) % count
        };
    }

    pub fn plugin_picker_select(&mut self) -> bool {
        let Some(picker) = self.plugin_picker.clone() else {
            return false;
        };
        let Some(plugin) = self
            .filtered_plugin_items()
            .get(picker.selected_index)
            .map(|plugin| (*plugin).clone())
        else {
            return false;
        };
        if let Some(error) = plugin_unavailable_reason(&plugin) {
            self.status = error;
            return true;
        }
        self.input.truncate(picker.trigger_start);
        if self
            .selected_plugins
            .iter()
            .any(|selection| selection.uri == plugin.uri)
        {
            self.plugin_picker = None;
            self.status = format!("插件已为下一次请求选择：{}", plugin.display_name);
            return true;
        }
        let mention = format!("@{}", plugin.display_name);
        let start = self.input.len();
        self.input.push_str(&mention);
        let end = self.input.len();
        self.input.push(' ');
        self.selected_mentions.push(SelectedMention {
            uri: plugin.uri.clone(),
            start,
            end,
        });
        self.selected_plugins.push(PluginSelectionInput {
            selection_id: new_id("plugin-selection"),
            uri: plugin.uri,
            label: plugin.display_name.clone(),
        });
        self.plugin_picker = None;
        self.status = format!("已为下一次请求选择插件：{}", plugin.display_name);
        true
    }

    pub fn plugin_picker_entries(&self) -> Vec<PluginPickerEntry> {
        let selected_index = self
            .plugin_picker
            .as_ref()
            .map(|picker| picker.selected_index)
            .unwrap_or(0);
        self.filtered_plugin_items()
            .into_iter()
            .take(8)
            .enumerate()
            .map(|(index, plugin)| PluginPickerEntry {
                already_selected: self
                    .selected_plugins
                    .iter()
                    .any(|selection| selection.uri == plugin.uri),
                display_name: plugin.display_name.clone(),
                short_description: plugin_unavailable_reason(plugin)
                    .unwrap_or_else(|| plugin.short_description.clone()),
                uri: plugin.uri.clone(),
                highlighted: index == selected_index,
            })
            .collect()
    }

    pub fn plugin_picker_query(&self) -> Option<&str> {
        self.plugin_picker
            .as_ref()
            .map(|picker| picker.query.as_str())
    }

    pub fn selected_plugin_labels(&self) -> Vec<&str> {
        self.selected_plugins
            .iter()
            .map(|selection| selection.label.as_str())
            .collect()
    }

    pub fn is_run_pending(&self) -> bool {
        self.projection
            .as_ref()
            .and_then(|projection| projection.run.as_ref())
            .is_some_and(|run| matches!(run.status.as_str(), "running" | "releasing"))
    }

    fn sync_plugin_picker_from_input(&mut self) {
        let Some(trigger_start) = plugin_trigger(&self.input) else {
            self.plugin_picker = None;
            return;
        };
        let query = self.input[trigger_start + 1..].to_string();
        let selected_index = self
            .plugin_picker
            .as_ref()
            .filter(|picker| picker.trigger_start == trigger_start)
            .map(|picker| picker.selected_index)
            .unwrap_or(0);
        self.plugin_picker = Some(PluginPickerState {
            trigger_start,
            query,
            selected_index,
        });
        let count = self.filtered_plugin_items().len();
        if let Some(picker) = self.plugin_picker.as_mut() {
            picker.selected_index = picker.selected_index.min(count.saturating_sub(1));
        }
    }

    fn filtered_plugin_items(&self) -> Vec<&PluginCatalogItem> {
        let Some(catalog) = self.plugin_catalog.as_ref() else {
            return Vec::new();
        };
        let query = self
            .plugin_picker
            .as_ref()
            .map(|picker| picker.query.trim().to_lowercase())
            .unwrap_or_default();
        catalog
            .plugins
            .iter()
            .filter(|plugin| {
                query.is_empty()
                    || plugin.display_name.to_lowercase().contains(&query)
                    || plugin.short_description.to_lowercase().contains(&query)
                    || plugin.uri.to_lowercase().contains(&query)
            })
            .collect()
    }

    async fn select_plugin_from_plain_input(&mut self, value: &str) {
        let query = value.trim_start_matches('@').trim();
        if query.is_empty() {
            match self.refresh_plugin_catalog().await {
                Ok(()) => {
                    let labels = self
                        .plugin_catalog
                        .as_ref()
                        .map(|catalog| {
                            catalog
                                .plugins
                                .iter()
                                .map(|plugin| {
                                    plugin_unavailable_reason(plugin).unwrap_or_else(|| {
                                        format!("{} ({})", plugin.display_name, plugin.uri)
                                    })
                                })
                                .collect::<Vec<_>>()
                                .join("；")
                        })
                        .unwrap_or_default();
                    self.status = if labels.is_empty() {
                        "当前没有可用插件。".to_string()
                    } else {
                        format!("插件目录：{labels}")
                    };
                }
                Err(error) => self.status = format!("插件目录刷新失败：{error}"),
            }
            return;
        }
        let plugin = self.plugin_catalog.as_ref().and_then(|catalog| {
            catalog
                .plugins
                .iter()
                .find(|plugin| {
                    plugin.uri == query || plugin.display_name.eq_ignore_ascii_case(query)
                })
                .cloned()
        });
        let Some(plugin) = plugin else {
            self.status = format!("未选择插件：没有精确匹配 {query}；输入 @ 查看候选。");
            return;
        };
        if let Some(error) = plugin_unavailable_reason(&plugin) {
            self.status = error;
            return;
        }
        if self
            .selected_plugins
            .iter()
            .any(|selection| selection.uri == plugin.uri)
        {
            self.status = format!("插件已为下一次请求选择：{}", plugin.display_name);
            return;
        }
        self.selected_plugins.push(PluginSelectionInput {
            selection_id: new_id("plugin-selection"),
            uri: plugin.uri,
            label: plugin.display_name.clone(),
        });
        self.status = format!("已为下一次请求选择插件：{}", plugin.display_name);
    }

    async fn refresh_plugin_catalog(&mut self) -> Result<(), String> {
        let catalog = self
            .client
            .conversation_plugin_catalog()
            .await
            .map_err(|error| error.to_string())?;
        self.plugin_catalog = Some(catalog);
        Ok(())
    }

    fn clear_plugin_selections(&mut self) {
        self.selected_plugins.clear();
        self.selected_mentions.clear();
        self.plugin_picker = None;
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
        self.tasks_open = false;
        self.detail_scroll = 0;
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
        "3" | "allow-run" | "允许本轮" => Ok("allow-run"),
        _ => Err("当前等待 effect 裁决：输入 /reply 1（允许）或 /reply 2（拒绝）。".to_string()),
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

fn plugin_selections_from_uris(
    catalog: &PluginCatalogProjection,
    plugin_uris: &[String],
) -> Result<Vec<PluginSelectionInput>, String> {
    let mut seen = HashSet::new();
    let mut selections = Vec::with_capacity(plugin_uris.len());
    for uri in plugin_uris {
        if !seen.insert(uri.as_str()) {
            continue;
        }
        let plugin = catalog
            .plugins
            .iter()
            .find(|plugin| plugin.uri == *uri)
            .ok_or_else(|| format!("插件不在当前目录中或不可用：{uri}"))?;
        if let Some(error) = plugin_unavailable_reason(plugin) {
            return Err(error);
        }
        selections.push(PluginSelectionInput {
            selection_id: new_id("plugin-selection"),
            uri: plugin.uri.clone(),
            label: plugin.display_name.clone(),
        });
    }
    Ok(selections)
}

fn plugin_unavailable_reason(plugin: &PluginCatalogItem) -> Option<String> {
    if plugin.available && plugin.enabled {
        return None;
    }
    Some(match &plugin.error {
        Some(error) => format!(
            "{}：{} ({})",
            plugin.display_name, error.message, error.code
        ),
        None => format!("插件不可用：{}", plugin.display_name),
    })
}

fn plugin_trigger(input: &str) -> Option<usize> {
    let start = input.rfind('@')?;
    if input[..start]
        .chars()
        .next_back()
        .is_some_and(|character| !character.is_whitespace())
    {
        return None;
    }
    let query = &input[start + 1..];
    (!query
        .chars()
        .any(|character| character.is_whitespace() || matches!(character, '@' | '/')))
    .then_some(start)
}

fn focus_task(input: &str) -> Option<Option<&str>> {
    if input == "/focus" {
        return Some(None);
    }
    input
        .strip_prefix("/focus ")
        .map(str::trim)
        .map(|task| (!task.is_empty()).then_some(task))
}

fn new_id(kind: &str) -> String {
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{kind}:{}:{clock:x}:{sequence:x}", std::process::id())
}

#[cfg(test)]
mod input_tests {
    use super::*;
    fn test_app() -> TuiApp {
        let client = HttpKernelClient::new(
            deepcode_kernel_client::KernelClientConfig::new("http://127.0.0.1:1")
                .with_host_shell_token(format!("dchost_{}", "01".repeat(32))),
        )
        .unwrap();
        TuiApp::new(
            client,
            Renderer::default(),
            TuiHostOptions {
                workspace_path: None,
                session_id: None,
                plugin_uris: vec![],
            },
        )
    }
    fn waiting_projection(field: &str, decision: serde_json::Value) -> SessionProjection {
        let mut value = json!({
            "schemaVersion": deepcode_kernel_client::SESSION_PROJECTION_VERSION,
            "sessionId":"session:test", "revision":1, "display":{"creationTitle":"input"},
            "workspaceBindings":[], "sessionDirectoryIndexes":[], "timeline":[], "messages":[],
            "queuedInputs":[], "narratives":[], "plans":[], "contextCompositions":[],
            "tokenUsageHistory":[], "activities":[], "artifacts":[],
            "tokenUsage":{"providerCallCount":0,"reportedCallCount":0,"inputTokens":0,"outputTokens":0,
              "cacheReadInputTokens":0,"cacheMissInputTokens":0,"cacheAvailable":false,"cacheComplete":false},
            "run":{"runId":"run:test","profileId":"profile:current","workspaceBindings":[],"status":"waiting"}
        });
        value[field] = decision;
        serde_json::from_value(value).unwrap()
    }

    fn pending_decisions() -> [(
        &'static str,
        serde_json::Value,
        &'static str,
        &'static str,
        serde_json::Value,
    ); 3] {
        [
            (
                "pendingPlan",
                json!({"planId":"plan:test","revision":1,"runId":"run:test","callId":"call:plan",
                "title":"Plan","summary":"Review","steps":[],"mutationManifest":[],"status":"published",
                "responseMode":"confirmReviseOrCancel","sequence":1,"createdAt":"now","updatedAt":"now"}),
                "plan.respond",
                "response",
                json!({"kind":"confirm"}),
            ),
            (
                "pendingInteraction",
                json!({"interactionId":"interaction:test","runId":"run:test","callId":"call:question",
                "kind":"question","prompt":"Choose","options":[{"id":"a","label":"Option A"}],
                "allowFreeform":true,"sequence":1,"createdAt":"now"}),
                "interaction.respond",
                "response",
                json!("Option A"),
            ),
            (
                "pendingApproval",
                json!({"approvalId":"approval:test","runId":"run:test","callId":"call:effect",
                "preview":{"summary":"Write","effects":[],"logicalTargets":[]},"sequence":1,"createdAt":"now"}),
                "approval.respond",
                "decision",
                json!("allow"),
            ),
        ]
    }
    #[test]
    fn pending_plain_input_queues_while_explicit_reply_keeps_decision_semantics() {
        for (field, decision, command_type, response_field, expected) in pending_decisions() {
            let projection = waiting_projection(field, decision);
            let mut app = test_app();
            app.next_message_profile_id = Some("profile:next".into());
            let ordinary = app.contextual_input_command(&projection, "1").unwrap();
            assert_eq!(ordinary["type"], "message.submit");
            assert_eq!(ordinary["runId"], "run:test");
            assert_eq!(ordinary["text"], "1");
            assert!(ordinary.get("profileId").is_none());
            let reply = app
                .contextual_input_command(&projection, "/reply 1")
                .unwrap();
            assert_eq!(reply["type"], command_type);
            assert_eq!(reply[response_field], expected);
            if field == "pendingPlan" {
                let revision = app
                    .contextual_input_command(&projection, "/reply clarify scope")
                    .unwrap();
                assert_eq!(
                    revision["response"],
                    json!({"kind":"requestRevision","text":"clarify scope"})
                );
            }
        }
    }

    #[test]
    fn decision_dock_keeps_reply_visible_in_narrow_terminal_without_changing_facts() {
        use ratatui::{backend::TestBackend, Terminal};
        for (field, decision, _, _, _) in pending_decisions() {
            let mut app = test_app();
            app.projection = Some(waiting_projection(field, decision));
            app.next_message_profile_id = Some("profile:next".into());
            app.push_input_text("中文输入最后一行");
            let before = app.projection.clone();
            let mut terminal = Terminal::new(TestBackend::new(60, 22)).unwrap();
            terminal
                .draw(|frame| app.renderer().draw(frame, &app))
                .unwrap();
            let buffer = terminal.backend().buffer();
            let text = buffer
                .content
                .chunks(60)
                .map(|row| {
                    let mut line = String::new();
                    let mut column = 0;
                    while column < row.len() {
                        let symbol = row[column].symbol();
                        line.push_str(symbol);
                        column += ratatui::text::Span::raw(symbol).width().max(1);
                    }
                    line
                })
                .collect::<Vec<_>>()
                .join("\n");
            assert!(text.contains("/reply"), "{text}");
            assert!(text.contains("/decision"), "{text}");
            assert!(text.contains("中文输入最后一行"), "{text}");
            assert!(text.contains("profile:current"), "{text}");
            assert!(text.contains("下次 profile:next"), "{text}");
            let cursor = terminal.get_cursor_position().unwrap();
            assert!(
                cursor.x < 59 && cursor.y < 19 && cursor.y > 10,
                "{cursor:?}"
            );
            assert_eq!(
                app.projection, before,
                "rendering must not mutate Session facts"
            );
        }
    }

    #[test]
    fn wheel_reading_stays_detached_until_reaching_latest() {
        let mut app = test_app();
        assert_eq!(app.transcript_offset(100), 100);
        app.scroll_lines(false, 4);
        assert_eq!(app.transcript_offset(120), 96);
        app.scroll_lines(true, 4);
        assert_eq!(app.transcript_offset(120), 100);
        app.scroll_lines(true, 24);
        assert_eq!(app.transcript_offset(140), 140);
    }

    fn screen_rows(app: &TuiApp, width: u16, height: u16) -> Vec<String> {
        use ratatui::{backend::TestBackend, text::Span, Terminal};
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| app.renderer().draw(frame, app))
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .chunks(width as usize)
            .map(|row| {
                let mut line = String::new();
                let mut column = 0;
                while column < row.len() {
                    let symbol = row[column].symbol();
                    line.push_str(symbol);
                    column += Span::raw(symbol).width().max(1);
                }
                line.trim_end().to_string()
            })
            .collect()
    }

    #[test]
    fn transcript_renders_user_lines_and_markdown_without_repeating_run_activities() {
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.run.as_mut().unwrap().status = "completed".into();
        for (index, (role, content)) in [
            ("user", "第一行\n\n**原样保留**"),
            ("assistant", "## 能力\n\n- **读文件**\n- 跑测试\n\n完成"),
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("message:{index}");
            projection.messages.push(serde_json::from_value(json!({"messageId":id,"role":role,"content":content,"filesystemReferences":[],"pluginSelections":[],"sequence":index + 1,"createdAt":"now"})).unwrap());
            projection.timeline.push(serde_json::from_value(json!({"kind":"message","timelineId":format!("timeline:{index}"),"sequence":index + 1,"messageId":id})).unwrap());
        }
        projection.activities.push(serde_json::from_value(json!({"activityId":"run:test","kind":"run","status":"completed","label":"Agent run","runId":"run:test","sequence":1})).unwrap());
        app.projection = Some(projection);
        let before = app.projection.clone();
        for width in [60, 120] {
            let rows = screen_rows(&app, width, 30);
            let text = rows.join("\n");
            assert!(text.contains("已完成"), "{text}");
            assert!(text.contains("第一行\n\n **原样保留**"), "{text}");
            assert!(text.contains("能力\n\n • 读文件\n • 跑测试"), "{text}");
            assert!(!text.contains("**读文件**"));
            assert!(!text.contains("run [completed]"));
            assert!(!text.contains("⠋"));
        }
        assert_eq!(app.projection, before);
    }

    #[test]
    fn spinner_follows_shared_status_and_stops_on_waiting_or_disconnect() {
        use crate::renderer::working_indicator;
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.run.as_mut().unwrap().status = "running".into();
        app.projection = Some(projection);
        let before = app.projection.clone();
        assert!(working_indicator(&app, 0).unwrap().contains("⠋ 运行中"));
        assert!(working_indicator(&app, 1).unwrap().contains("⠙ 运行中"));
        assert!(screen_rows(&app, 60, 22)
            .join("\n")
            .contains("/cancel 停止"));
        assert_eq!(app.projection, before);
        for status in [
            "waiting",
            "completed",
            "failed",
            "cancelled",
            "indeterminate",
            "releaseFailed",
        ] {
            app.projection
                .as_mut()
                .unwrap()
                .run
                .as_mut()
                .unwrap()
                .status = status.into();
            assert!(working_indicator(&app, 0).is_none(), "{status}");
        }
        app.projection
            .as_mut()
            .unwrap()
            .run
            .as_mut()
            .unwrap()
            .status = "releasing".into();
        assert!(working_indicator(&app, 0).unwrap().contains("正在结束"));
        app.connection_error = Some("刷新共享投影失败".into());
        assert!(working_indicator(&app, 1).is_none());
    }

    #[test]
    fn streaming_markdown_updates_without_a_journal_revision_change() {
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.run.as_mut().unwrap().status = "running".into();
        projection.assistant_draft = Some(serde_json::from_value(json!({"runId":"run:test","turnId":"request:test","blocks":[{"kind":"finalMessage","streamId":"stream:test","content":"## 草稿\n\n第一段"}]})).unwrap());
        app.projection = Some(projection);
        assert!(screen_rows(&app, 80, 24)
            .join("\n")
            .contains("草稿\n\n 第一段"));
        if let deepcode_kernel_client::AssistantDraftBlockProjection::FinalMessage {
            content, ..
        } = &mut app
            .projection
            .as_mut()
            .unwrap()
            .assistant_draft
            .as_mut()
            .unwrap()
            .blocks[0]
        {
            content.push_str("\n\n- 第二段");
        }
        assert!(screen_rows(&app, 80, 24).join("\n").contains("• 第二段"));
    }

    #[test]
    fn retry_and_failure_details_use_shared_projection_facts() {
        let mut app = test_app();
        let mut projection = waiting_projection("pendingPlan", serde_json::Value::Null);
        projection.run.as_mut().unwrap().status = "running".into();
        projection.provider_attempts.push(
            serde_json::from_value(json!({
                "providerRequestId":"request:test","providerAttemptId":"attempt:2","attempt":2,
                "purpose":"agent","phase":"retryWaiting","runId":"run:test","updatedAt":"now"
            }))
            .unwrap(),
        );
        app.projection = Some(projection);
        assert!(app
            .renderer()
            .render_plain(&app)
            .contains("等待第 3/5 次尝试"));
        let error = json!({"code":"provider_transport_failed","message":"原始连接失败", "diagnostics":{
            "source":"providerTransport","phase":"send","category":"network","retryable":true,
            "causes":[{"message":"Connection refused","osCode":61}]
        }});
        let projection = app.projection.as_mut().unwrap();
        projection.run.as_mut().unwrap().status = "failed".into();
        projection.terminal_error = Some(serde_json::from_value(error.clone()).unwrap());
        projection.failure_snapshot = Some(
            serde_json::from_value(json!({
                "revision":9,"phase":"send","error":error,"providerAttemptIds":["attempt:2"],
                "toolRecordIds":["record:done"],"pendingCallIds":[],"queuedMessageIds":[]
            }))
            .unwrap(),
        );
        let text = app.renderer().render_plain(&app);
        assert!(!text.contains("等待第 3/5 次尝试"));
        for fact in [
            "原始连接失败",
            "Connection refused",
            "OS 61",
            "revision 9",
            "工具记录 1",
        ] {
            assert!(text.contains(fact), "{text}");
        }
    }

    #[test]
    fn unavailable_plugin_selection_preserves_the_catalog_error() {
        let catalog: PluginCatalogProjection = serde_json::from_value(json!({"revision":"catalog:test", "plugins":[{
            "uri":"plugin://broken@mcp", "displayName":"Broken", "shortDescription":"Broken entry", "activationMediaTypes":[],
            "source":"mounted","category":"functional","contributionKind":"mcp","discovery":"default",
            "enabled":false,"available":false,"error":{"code":"plugin_manifest_invalid","message":"manifest parse failed"}
        }]})).unwrap();
        let error = plugin_selections_from_uris(&catalog, &["plugin://broken@mcp".into()])
            .err()
            .unwrap();
        assert!(error.contains("plugin_manifest_invalid"));
        assert!(error.contains("manifest parse failed"));
    }
}
