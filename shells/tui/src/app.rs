use crate::renderer::Renderer;
use deepcode_kernel_client::{
    approval_response_command, cancel_command, focus_command, interaction_response_command,
    is_terminal_run_status, message_command_with_profile_and_plugins, plan_cancel_command,
    plan_confirm_command, plan_revision_command, ConversationResourceReadResult,
    CreateConversationSessionRequest, HttpKernelClient, InteractionProjection, PluginCatalogItem,
    PluginCatalogProjection, PluginSelectionInput, SessionProjection,
};
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

pub struct TuiApp {
    client: HttpKernelClient,
    renderer: Renderer,
    host: TuiHostOptions,
    projection: Option<SessionProjection>,
    input: String,
    status: String,
    next_message_profile_id: Option<String>,
    plugin_catalog: Option<PluginCatalogProjection>,
    selected_plugins: Vec<PluginSelectionInput>,
    selected_mentions: Vec<SelectedMention>,
    plugin_picker: Option<PluginPickerState>,
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
            next_message_profile_id: None,
            plugin_catalog: None,
            selected_plugins: Vec::new(),
            selected_mentions: Vec::new(),
            plugin_picker: None,
            resource_preview: None,
            context_open: false,
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
                self.status = format!("session {} · ready", projection.session_id);
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
                self.status = projection
                    .run
                    .as_ref()
                    .map(|run| format!("run {} · {}", run.run_id, run.status))
                    .unwrap_or_else(|| format!("session {} · ready", projection.session_id));
                self.projection = Some(projection);
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
                self.status = "@ 选择下一次请求的插件；/focus <task> /attach <path> /detach <workspace-id> /cancel-plan /model <profile> /cancel /context /open <workspace-id> <logical-path> /close /show /clear /quit；Plan 输入 1/确认".to_string();
            }
            "/show" => self.status = self.projection_label(),
            "/clear" => {
                self.clear_input();
                self.status =
                    "可见输入与下一次请求的插件选择已清理；durable Session 未修改".to_string();
            }
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
            }
            value if value == "/focus" || value.starts_with("/focus ") => {
                self.submit_contextual_input(value).await
            }
            value if value.starts_with('/') => self.status = format!("未知命令：{value}"),
            value if value.starts_with('@') => self.select_plugin_from_plain_input(value).await,
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
        let mut consumes_plugins = false;
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
            consumes_plugins = true;
            let catalog_revision = self
                .plugin_catalog
                .as_ref()
                .map(|catalog| catalog.revision.as_str())
                .unwrap_or("");
            if let Some(task) = focus_task(text) {
                let Some(task) = task else {
                    self.status = "/focus 需要非空任务正文。".to_string();
                    return;
                };
                focus_command(
                    &session_id,
                    &new_id("command"),
                    task,
                    self.next_message_profile_id.as_deref(),
                    &[],
                    catalog_revision,
                    &self.selected_plugins,
                )
            } else {
                message_command_with_profile_and_plugins(
                    &session_id,
                    &new_id("command"),
                    text,
                    self.next_message_profile_id.as_deref(),
                    &[],
                    catalog_revision,
                    &self.selected_plugins,
                )
            }
        };
        if self
            .submit_command(&session_id, command, "消息提交失败")
            .await
            && consumes_plugins
        {
            self.clear_plugin_selections();
        }
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

    fn select_model(&mut self, profile_id: &str) {
        if profile_id.is_empty() {
            self.status = "用法：/model <profile>".to_string();
            return;
        }
        self.next_message_profile_id = Some(profile_id.to_string());
        self.status = format!("后续普通消息将提交模型 Profile {profile_id}；当前 run 不变。");
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
                Some("Agent 正在等待 Plan 确认、修订说明或显式取消。".to_string())
            } else if projection.pending_interaction.is_some() {
                Some("Agent 正在等待你回答中间问题。".to_string())
            } else if projection.pending_approval.is_some() {
                Some("Agent 正在等待 effect 允许或拒绝。".to_string())
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
                short_description: plugin.short_description.clone(),
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

    pub fn has_pending_plan(&self) -> bool {
        self.projection
            .as_ref()
            .is_some_and(|projection| projection.pending_plan.is_some())
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
                                .map(|plugin| format!("{} ({})", plugin.display_name, plugin.uri))
                                .collect::<Vec<_>>()
                                .join("；")
                        })
                        .unwrap_or_default();
                    self.status = if labels.is_empty() {
                        "当前没有可用插件。".to_string()
                    } else {
                        format!("可用插件：{labels}")
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
        selections.push(PluginSelectionInput {
            selection_id: new_id("plugin-selection"),
            uri: plugin.uri.clone(),
            label: plugin.display_name.clone(),
        });
    }
    Ok(selections)
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
