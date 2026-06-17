use crate::model::CardModel;
use crate::renderer::Renderer;
use deepcode_kernel_client::{
    CreateAgentSessionRequest, HttpKernelClient, ListAgentSessionsRequest, PermissionDecision,
    SessionHostBridgeRequest,
};
use serde_json::Value;
use std::env;

pub struct TuiApp {
    client: HttpKernelClient,
    renderer: Renderer,
    cards: Vec<CardModel>,
    input: String,
    status: String,
    current_session_id: Option<String>,
    host: TuiHostOptions,
}

impl TuiApp {
    pub fn new(client: HttpKernelClient, renderer: Renderer, host: TuiHostOptions) -> Self {
        let status = format!("API {} · 等待连接", client.base_url());
        Self {
            client,
            renderer,
            cards: Vec::new(),
            input: String::new(),
            status,
            current_session_id: None,
            host,
        }
    }

    pub async fn bootstrap(&mut self) {
        self.refresh_daemon_status().await;
        self.refresh_current_session().await;
    }

    pub fn renderer(&self) -> &Renderer {
        &self.renderer
    }

    pub fn cards(&self) -> &[CardModel] {
        &self.cards
    }

    pub fn input(&self) -> &str {
        &self.input
    }

    pub fn status(&self) -> &str {
        &self.status
    }

    pub fn push_input(&mut self, ch: char) {
        self.input.push(ch);
    }

    pub fn backspace_input(&mut self) {
        self.input.pop();
    }

    pub fn clear_input(&mut self) {
        self.input.clear();
    }

    pub fn take_input(&mut self) -> String {
        let input = self.input.trim().to_string();
        self.input.clear();
        input
    }

    pub async fn submit_line(&mut self, line: &str) -> bool {
        let line = line.trim();
        if line.is_empty() {
            return true;
        }
        match line {
            "/help" | "help" => self.cards.push(CardModel::command_help()),
            "/status" | "status" => self.refresh_daemon_status().await,
            "/sessions" | "sessions" => self.refresh_sessions().await,
            "/timeline" | "timeline" => self.refresh_timeline_for_current().await,
            "/audit" | "audit" => self.refresh_audit_status().await,
            "/clear" | "clear" => {
                self.cards.clear();
                self.cards.push(CardModel::stage(
                    "显示已清理",
                    "只清理当前 TUI 视图，不修改会话事实。",
                ));
            }
            "/quit" | "/exit" | "quit" | "exit" | "q" => return false,
            command if command.starts_with("/new") || command.starts_with("new") => {
                let title = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .filter(|value| !value.is_empty());
                self.create_session(title).await;
            }
            command if command.starts_with("/use ") || command.starts_with("use ") => {
                let session_id = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                self.activate_session(session_id).await;
            }
            command if command.starts_with("/timeline ") || command.starts_with("timeline ") => {
                let session_id = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                self.load_timeline(session_id).await;
            }
            command if command.starts_with("/rename ") || command.starts_with("rename ") => {
                let args = command
                    .split_once(' ')
                    .map(|(_, value)| value)
                    .unwrap_or_default();
                let Some((session_id, title)) = args.split_once(' ') else {
                    self.cards
                        .push(CardModel::error("用法：/rename <session-id> <title>"));
                    return true;
                };
                self.rename_session(session_id.trim(), title.trim()).await;
            }
            command if command.starts_with("/delete ") || command.starts_with("delete ") => {
                let session_id = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                self.delete_session(session_id).await;
            }
            command if command.starts_with("/archive ") || command.starts_with("archive ") => {
                let session_id = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                self.archive_session(session_id).await;
            }
            command if command.starts_with("/allow ") || command.starts_with("allow ") => {
                let permission_id = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                self.resolve_permission(permission_id, PermissionDecision::Allow)
                    .await;
            }
            command if command.starts_with("/deny ") || command.starts_with("deny ") => {
                let permission_id = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                self.resolve_permission(permission_id, PermissionDecision::Deny)
                    .await;
            }
            command if command.starts_with("/decision ") || command.starts_with("decision ") => {
                let args = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                self.resolve_session_decision(args).await;
            }
            command if command.starts_with('/') => self.cards.push(CardModel::error(format!(
                "未知命令：{command}\n输入 /help 查看可用命令。"
            ))),
            command => self.ask(command).await,
        }
        true
    }

    async fn ask(&mut self, prompt: &str) {
        self.cards.push(CardModel::stage(
            "DeepCode",
            "正在通过共享 SessionDriverLoop 处理输入...",
        ));
        let mut request = SessionHostBridgeRequest::ask(prompt.to_string());
        request.session_id = self.current_session_id.clone();
        request.workspace_path = self.workspace_path();
        request.no_workspace = self.host.no_workspace;
        match self.client.run_session_host_bridge(request) {
            Ok(result) => {
                if let Some(session_id) = result.session_id.as_deref() {
                    self.current_session_id = Some(session_id.to_string());
                }
                if let Some(timeline) = result.timeline.as_ref() {
                    let next_cards = CardModel::from_timeline(timeline);
                    self.cards = if next_cards.is_empty() {
                        vec![CardModel::stage("Timeline", "当前请求已完成，但没有可显示的 timeline block。")]
                    } else {
                        next_cards
                    };
                } else if let Some(text) = result.final_text {
                    self.cards.push(CardModel::stage("DeepCode", text));
                }
            }
            Err(error) => self.cards.push(CardModel::error(format!(
                "发送失败：{error}\n确认 daemon 可用，并已运行 pnpm --filter @deepcode/session-core build。"
            ))),
        }
    }

    async fn resolve_session_decision(&mut self, args: &str) {
        let parts = args
            .split_whitespace()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let Some(kind) = parts.first().cloned() else {
            self.cards.push(CardModel::error(
                "用法：/decision <requirement|plan|review> <accept|reject|revise> [run-id] [target-id] [guidance]",
            ));
            return;
        };
        let Some(decision) = parts.get(1).cloned() else {
            self.cards.push(CardModel::error(
                "用法：/decision <requirement|plan|review> <accept|reject|revise> [run-id] [target-id] [guidance]",
            ));
            return;
        };
        if !matches!(kind.as_str(), "requirement" | "plan" | "review") {
            self.cards.push(CardModel::error(
                "decision kind 必须是 requirement、plan 或 review",
            ));
            return;
        }
        if !matches!(decision.as_str(), "accept" | "reject" | "revise") {
            self.cards
                .push(CardModel::error("decision 必须是 accept、reject 或 revise"));
            return;
        }
        let Some(session_id) = self.current_session_id.clone() else {
            self.cards.push(CardModel::error(
                "当前没有激活会话。先发送一条消息，或使用 /use <session-id>。",
            ));
            return;
        };
        let mut request = SessionHostBridgeRequest::resolve_decision(kind, decision);
        request.session_id = Some(session_id);
        request.run_id = parts.get(2).cloned();
        request.target_id = parts.get(3).cloned();
        request.guidance = if parts.len() > 4 {
            Some(parts[4..].join(" "))
        } else {
            None
        };
        request.workspace_path = self.workspace_path();
        request.no_workspace = self.host.no_workspace;
        match self.client.run_session_host_bridge(request) {
            Ok(result) => {
                if let Some(session_id) = result.session_id.as_deref() {
                    self.current_session_id = Some(session_id.to_string());
                }
                if let Some(timeline) = result.timeline.as_ref() {
                    self.cards = CardModel::from_timeline(timeline);
                }
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("处理决策失败：{error}"))),
        }
    }

    fn workspace_path(&self) -> Option<String> {
        if self.host.no_workspace {
            return None;
        }
        if let Some(path) = self.host.workspace_path.clone() {
            return Some(path);
        }
        env::current_dir()
            .ok()
            .map(|path| path.to_string_lossy().to_string())
    }

    async fn refresh_daemon_status(&mut self) {
        match self.client.daemon_status().await {
            Ok(status) => {
                self.status = format!(
                    "API {} · {} · {}",
                    self.client.base_url(),
                    status.service,
                    if status.ok { "已连接" } else { "降级" }
                );
                self.cards.push(CardModel::stage(
                    "API 已连接",
                    format!(
                        "{}\n{}\n{}",
                        status.service,
                        self.client.base_url(),
                        if status.ok {
                            "状态正常"
                        } else {
                            "状态降级"
                        }
                    ),
                ));
            }
            Err(error) => {
                self.status = format!("API {} · 不可用", self.client.base_url());
                self.cards.push(CardModel::error(format!(
                    "Kernel daemon 不可用：{error}\n启动 daemon 后输入 /status 重试。"
                )));
            }
        }
    }

    async fn refresh_audit_status(&mut self) {
        match self.client.audit_verify().await {
            Ok(report) => self.cards.push(CardModel::audit_status(
                report.status,
                format!("degraded: {}\n{}", report.degraded, report.message),
            )),
            Err(error) => self
                .cards
                .push(CardModel::error(format!("审计检查失败：{error}"))),
        }
    }

    async fn refresh_current_session(&mut self) {
        match self
            .client
            .current_agent_session(ListAgentSessionsRequest::default())
            .await
        {
            Ok(Some(result)) => {
                if let Some(session_id) = session_id(&result.session) {
                    self.current_session_id = Some(session_id.to_string());
                    self.load_timeline(session_id).await;
                }
            }
            Ok(None) => {}
            Err(error) => self
                .cards
                .push(CardModel::error(format!("读取当前会话失败：{error}"))),
        }
    }

    async fn refresh_sessions(&mut self) {
        match self
            .client
            .list_agent_sessions(ListAgentSessionsRequest::default())
            .await
        {
            Ok(result) => {
                self.current_session_id = result.current_session_id.clone();
                let mut body = String::new();
                for session in result.sessions {
                    let id = session_id(&session).unwrap_or("unknown");
                    let title = session_title(&session);
                    let marker = if Some(id) == self.current_session_id.as_deref() {
                        "*"
                    } else {
                        "-"
                    };
                    body.push_str(&format!("{marker} {title}  ({id})\n"));
                }
                if body.trim().is_empty() {
                    body.push_str("暂无会话。输入 /new 创建一个会话。\n");
                }
                self.cards.push(CardModel::stage("Agent 会话", body));
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("读取会话列表失败：{error}"))),
        }
    }

    async fn create_session(&mut self, title: Option<&str>) {
        let result = self
            .client
            .create_agent_session(CreateAgentSessionRequest {
                initial_mode: Some("plan".to_string()),
                title: title.map(ToOwned::to_owned),
                ..CreateAgentSessionRequest::default()
            })
            .await;
        match result {
            Ok(result) => {
                if let Some(session_id) = session_id(&result.session) {
                    self.current_session_id = Some(session_id.to_string());
                    self.cards.push(CardModel::stage(
                        "新会话",
                        format!("{} ({session_id})", session_title(&result.session)),
                    ));
                }
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("创建会话失败：{error}"))),
        }
    }

    async fn activate_session(&mut self, target_session_id: &str) {
        if target_session_id.is_empty() {
            self.cards.push(CardModel::error("用法：/use <session-id>"));
            return;
        }
        match self.client.activate_agent_session(target_session_id).await {
            Ok(result) => {
                if let Some(id) = session_id(&result.session) {
                    self.current_session_id = Some(id.to_string());
                    self.cards.push(CardModel::stage(
                        "已切换会话",
                        format!("{} ({id})", session_title(&result.session)),
                    ));
                    self.load_timeline(id).await;
                }
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("切换会话失败：{error}"))),
        }
    }

    async fn refresh_timeline_for_current(&mut self) {
        let Some(session_id) = self.current_session_id.clone() else {
            self.cards.push(CardModel::error(
                "当前没有激活会话。输入 /sessions 或 /new。",
            ));
            return;
        };
        self.load_timeline(&session_id).await;
    }

    async fn load_timeline(&mut self, session_id: &str) {
        if session_id.is_empty() {
            self.cards
                .push(CardModel::error("用法：/timeline <session-id>"));
            return;
        }
        match self.client.agent_timeline(session_id).await {
            Ok(timeline) => {
                let next_cards = CardModel::from_timeline(&timeline);
                self.cards = if next_cards.is_empty() {
                    vec![CardModel::stage(
                        "Timeline",
                        "当前会话还没有可显示的 timeline block。",
                    )]
                } else {
                    next_cards
                };
                self.current_session_id = Some(session_id.to_string());
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("读取 timeline 失败：{error}"))),
        }
    }

    async fn rename_session(&mut self, session_id: &str, title: &str) {
        if session_id.is_empty() || title.is_empty() {
            self.cards
                .push(CardModel::error("用法：/rename <session-id> <title>"));
            return;
        }
        match self.client.rename_agent_session(session_id, title).await {
            Ok(result) => self.cards.push(CardModel::stage(
                "会话已重命名",
                format!("{} ({session_id})", session_title(&result.session)),
            )),
            Err(error) => self
                .cards
                .push(CardModel::error(format!("重命名会话失败：{error}"))),
        }
    }

    async fn delete_session(&mut self, session_id: &str) {
        if session_id.is_empty() {
            self.cards
                .push(CardModel::error("用法：/delete <session-id>"));
            return;
        }
        match self.client.delete_agent_session(session_id).await {
            Ok(result) => {
                self.current_session_id = result.current_session_id;
                self.cards.push(CardModel::stage(
                    "会话已删除",
                    format!("{session_id}\n剩余会话：{}", result.sessions.len()),
                ));
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("删除会话失败：{error}"))),
        }
    }

    async fn archive_session(&mut self, session_id: &str) {
        if session_id.is_empty() {
            self.cards
                .push(CardModel::error("用法：/archive <session-id>"));
            return;
        }
        match self.client.archive_agent_session(session_id, true).await {
            Ok(result) => {
                self.current_session_id = result.current_session_id;
                self.cards.push(CardModel::stage(
                    "会话已归档",
                    format!("{session_id}\n可见会话：{}", result.sessions.len()),
                ));
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("归档会话失败：{error}"))),
        }
    }

    async fn resolve_permission(&mut self, permission_id: &str, decision: PermissionDecision) {
        if permission_id.is_empty() {
            self.cards.push(CardModel::error(
                "用法：/allow <permission-id> 或 /deny <permission-id>",
            ));
            return;
        }
        match self
            .client
            .resolve_permission(permission_id, decision)
            .await
        {
            Ok(_) => self.cards.push(CardModel::stage(
                "权限已处理",
                format!("{}: {}", permission_id, decision.as_str()),
            )),
            Err(error) => self
                .cards
                .push(CardModel::error(format!("处理权限失败：{error}"))),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TuiHostOptions {
    pub workspace_path: Option<String>,
    pub no_workspace: bool,
}

fn session_id(session: &Value) -> Option<&str> {
    session.get("id").and_then(Value::as_str)
}

fn session_title(session: &Value) -> &str {
    session
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Untitled Session")
}
