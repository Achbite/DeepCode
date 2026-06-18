use crate::model::CardModel;
use crate::renderer::Renderer;
use deepcode_kernel_client::{
    terminal_workspace_scope, AgentRunResult, CreateAgentSessionRequest, HttpKernelClient,
    ListAgentSessionsRequest, PermissionDecision, StartAgentRunRequest, TerminalWorkspaceScope,
};
use serde_json::Value;
use std::{
    env,
    time::{Duration, Instant},
};

const RUNNING_EVENT_POLL_INTERVAL: Duration = Duration::from_millis(300);
const RUNNING_TIMELINE_POLL_INTERVAL: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, Copy)]
enum RunOperation {
    Ask,
    Decision,
}

struct PendingRun {
    operation: RunOperation,
    session_id: String,
    run_id: String,
    last_event_poll: Instant,
    last_timeline_poll: Instant,
    last_event_count: Option<usize>,
    last_refresh_error: Option<String>,
}

pub struct TuiApp {
    client: HttpKernelClient,
    renderer: Renderer,
    cards: Vec<CardModel>,
    input: String,
    status: String,
    current_session_id: Option<String>,
    current_session_resume_hint: bool,
    host: TuiHostOptions,
    runtime_status: String,
    running_preview_active: bool,
    pending_run: Option<PendingRun>,
    events: Vec<Value>,
}

impl TuiApp {
    pub fn new(client: HttpKernelClient, renderer: Renderer, host: TuiHostOptions) -> Self {
        let status = format!("API {} · 等待连接", client.base_url());
        let runtime_status = "session runtime: daemon /runs".to_string();
        Self {
            client,
            renderer,
            cards: Vec::new(),
            input: String::new(),
            status,
            current_session_id: None,
            current_session_resume_hint: false,
            host,
            runtime_status,
            running_preview_active: false,
            pending_run: None,
            events: Vec::new(),
        }
    }

    pub async fn bootstrap(&mut self) {
        self.update_daemon_status(false).await;
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

    pub fn workspace_status(&self) -> String {
        if self.host.no_workspace {
            return "workspace: none (ordinary chat only)".to_string();
        }
        if self.host.workspace_path.is_some() {
            return format!(
                "workspace: {}",
                self.workspace_path().unwrap_or_else(|| "-".to_string())
            );
        }
        format!(
            "workspace: cwd fallback {}",
            self.workspace_path().unwrap_or_else(|| "-".to_string())
        )
    }

    pub fn current_session_label(&self) -> String {
        self.current_session_id
            .as_deref()
            .unwrap_or("no active session")
            .to_string()
    }

    pub fn runtime_status(&self) -> &str {
        &self.runtime_status
    }

    pub fn is_run_pending(&self) -> bool {
        self.pending_run.is_some()
    }

    pub fn should_hold_input_for_running_turn(&self) -> bool {
        false
    }

    pub fn notify_running_input_held(&mut self) {
        self.status = format!("API {} · running · 输入已保留", self.client.base_url());
    }

    pub async fn poll_pending_run(&mut self) {
        self.refresh_pending_run_projection().await;
        let Some((session_id, run_id)) = self
            .pending_run
            .as_ref()
            .map(|pending| (pending.session_id.clone(), pending.run_id.clone()))
        else {
            return;
        };
        match self.client.get_agent_run(&session_id, &run_id).await {
            Ok(result) => {
                let terminal = result.run.is_terminal();
                self.apply_run_snapshot(&result).await;
                if terminal {
                    self.pending_run = None;
                    self.refresh_running_timeline(&session_id).await;
                    self.apply_run_result(result);
                }
            }
            Err(error) => {
                self.record_pending_refresh_error(format!("读取 session run 状态失败：{error}"));
            }
        }
    }

    async fn refresh_pending_run_projection(&mut self) {
        let now = Instant::now();
        let mut event_session_id = None;
        let mut timeline_session_id = None;
        if let Some(pending) = self.pending_run.as_mut() {
            if now.duration_since(pending.last_event_poll) >= RUNNING_EVENT_POLL_INTERVAL {
                pending.last_event_poll = now;
                event_session_id = Some(pending.session_id.clone());
            }
            if now.duration_since(pending.last_timeline_poll) >= RUNNING_TIMELINE_POLL_INTERVAL {
                pending.last_timeline_poll = now;
                timeline_session_id = Some(pending.session_id.clone());
            }
        }
        if let Some(session_id) = event_session_id {
            self.refresh_running_events(&session_id).await;
        }
        if let Some(session_id) = timeline_session_id {
            self.refresh_running_timeline(&session_id).await;
        }
    }

    async fn refresh_running_events(&mut self, target_session_id: &str) {
        match self.client.get_agent_session(target_session_id).await {
            Ok(result) => {
                let event_count = result.events.len();
                self.events = result.events.clone();
                let previous_event_count = self
                    .pending_run
                    .as_ref()
                    .filter(|pending| pending.session_id == target_session_id)
                    .and_then(|pending| pending.last_event_count);
                if let Some(id) = session_id(&result.session) {
                    self.current_session_id = Some(id.to_string());
                    self.current_session_resume_hint = false;
                }
                if let Some(pending) = self
                    .pending_run
                    .as_mut()
                    .filter(|pending| pending.session_id == target_session_id)
                {
                    pending.last_event_count = Some(event_count);
                    pending.last_refresh_error = None;
                }
                self.status = format!(
                    "API {} · running · events {}",
                    self.client.base_url(),
                    event_count
                );
                if previous_event_count != Some(event_count) {
                    self.refresh_running_timeline(target_session_id).await;
                }
            }
            Err(error) => {
                self.record_pending_refresh_error(format!("读取 session events 失败：{error}"))
            }
        }
    }

    async fn refresh_running_timeline(&mut self, target_session_id: &str) {
        match self.client.agent_timeline(target_session_id).await {
            Ok(timeline) => {
                let next_cards = CardModel::from_timeline(&timeline);
                if !next_cards.is_empty() {
                    self.cards = next_cards;
                    self.running_preview_active = false;
                }
                if let Some(pending) = self
                    .pending_run
                    .as_mut()
                    .filter(|pending| pending.session_id == target_session_id)
                {
                    pending.last_refresh_error = None;
                }
                self.current_session_id = Some(target_session_id.to_string());
                self.current_session_resume_hint = false;
                self.status = format!("API {} · running · timeline", self.client.base_url());
            }
            Err(error) => {
                self.record_pending_refresh_error(format!("读取 running timeline 失败：{error}"))
            }
        }
    }

    fn record_pending_refresh_error(&mut self, message: String) {
        self.status = format!("API {} · running · refresh failed", self.client.base_url());
        let should_push = self
            .pending_run
            .as_ref()
            .is_none_or(|pending| pending.last_refresh_error.as_deref() != Some(message.as_str()));
        if let Some(pending) = self.pending_run.as_mut() {
            pending.last_refresh_error = Some(message.clone());
        }
        if should_push {
            self.cards.push(CardModel::error(message));
        }
    }

    pub fn push_input(&mut self, ch: char) {
        self.input.push(ch);
    }

    pub fn push_input_text(&mut self, text: &str) {
        for ch in text.chars() {
            match ch {
                '\n' | '\r' => self.input.push(' '),
                _ if !ch.is_control() => self.input.push(ch),
                _ => {}
            }
        }
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

    pub fn preview_submit_line(&mut self, line: &str) -> bool {
        let line = line.trim();
        if latest_pending_decision(&self.events).is_some()
            && (line.is_empty()
                || !looks_like_command(line)
                || matches!(line, "/reject" | "/end" | "/stop" | "结束" | "拒绝"))
        {
            return false;
        }
        if line.is_empty() || looks_like_command(line) {
            return false;
        }
        self.preview_user_turn(line);
        true
    }

    pub async fn submit_line(&mut self, line: &str) -> bool {
        let line = line.trim();
        if let Some(pending) = latest_pending_decision(&self.events) {
            if line.is_empty()
                || !looks_like_command(line)
                || matches!(line, "/reject" | "/end" | "/stop" | "结束" | "拒绝")
            {
                self.resolve_pending_decision_line(pending, line).await;
                return true;
            }
        }
        if line.is_empty() {
            return true;
        }
        match line {
            "/help" | "help" => self.cards.push(CardModel::command_help()),
            "/status" | "status" => self.refresh_daemon_status().await,
            "/sessions" | "sessions" => self.refresh_sessions().await,
            "/timeline" | "timeline" => self.refresh_timeline_for_current().await,
            "/audit" | "audit" => self.refresh_audit_status().await,
            "/workspace" | "workspace" => self.show_workspace_status(),
            "/cancel" | "cancel" => self.cancel_current_run().await,
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
            command if command.starts_with("/workspace ") || command.starts_with("workspace ") => {
                let args = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                self.update_workspace(args).await;
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
            command if self.is_run_pending() => self.submit_guidance(command).await,
            command => self.ask(command).await,
        }
        true
    }

    async fn ask(&mut self, prompt: &str) {
        if self.is_run_pending() {
            self.submit_guidance(prompt).await;
            return;
        }
        if !self.running_preview_active {
            self.preview_user_turn(prompt);
        }
        let Some(session_id) = self.ensure_current_session_for_turn(prompt).await else {
            self.running_preview_active = false;
            return;
        };
        let mut request = StartAgentRunRequest::ask(prompt.to_string());
        request.workspace_path = self.workspace_path();
        request.no_workspace = Some(self.host.no_workspace);
        self.start_run_request(RunOperation::Ask, session_id.clone(), request)
            .await;
    }

    async fn submit_guidance(&mut self, guidance: &str) {
        let Some(pending) = self.pending_run.as_ref() else {
            return;
        };
        let session_id = pending.session_id.clone();
        let run_id = pending.run_id.clone();
        self.cards.push(CardModel::user(guidance.to_string()));
        self.cards.push(CardModel::stage(
            "Guidance",
            "补充引导已提交给共享 Session Runtime，将在下一次 provider checkpoint 生效。",
        ));
        self.status = format!("API {} · guidance queued", self.client.base_url());
        match self
            .client
            .submit_agent_run_guidance(&session_id, &run_id, guidance.to_string(), Vec::new())
            .await
        {
            Ok(result) => self.apply_run_snapshot(&result).await,
            Err(error) => {
                self.status = format!("API {} · guidance failed", self.client.base_url());
                self.cards.push(CardModel::error(format!(
                    "提交补充引导失败：{error}\n如果当前正在等待权限或 Review，请先处理 pending decision。"
                )));
            }
        }
    }

    async fn resolve_session_decision(&mut self, args: &str) {
        if self.is_run_pending() {
            self.notify_running_input_held();
            return;
        }
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
        self.start_decision_request(
            kind,
            decision,
            parts.get(2).cloned(),
            parts.get(3).cloned(),
            if parts.len() > 4 {
                Some(parts[4..].join(" "))
            } else {
                None
            },
        )
        .await;
    }

    async fn resolve_pending_decision_line(&mut self, pending: PendingDecision, line: &str) {
        let parsed = parse_pending_decision_input(line, &pending);
        self.cards.push(CardModel::stage(
            "确认输入",
            match parsed.decision.as_str() {
                "accept" => "已选择确认。",
                "reject" => "已选择结束。",
                _ => "已提交 Review 信息。",
            },
        ));
        self.start_decision_request(
            pending.kind,
            parsed.decision,
            Some(pending.run_id),
            pending.target_id,
            parsed.guidance,
        )
        .await;
    }

    async fn start_decision_request(
        &mut self,
        kind: String,
        decision: String,
        run_id: Option<String>,
        target_id: Option<String>,
        guidance: Option<String>,
    ) {
        let Some(session_id) = self.current_session_id.clone() else {
            self.cards.push(CardModel::error(
                "当前没有激活会话。先发送一条消息，或使用 /use <session-id>。",
            ));
            return;
        };
        let mut request = StartAgentRunRequest::resolve_decision(kind, decision);
        request.run_id = run_id;
        request.target_id = target_id;
        request.guidance = guidance;
        request.workspace_path = self.workspace_path();
        request.no_workspace = Some(self.host.no_workspace);
        self.cards.push(CardModel::stage(
            "Running",
            "共享 Session Runtime 正在处理决策...",
        ));
        self.status = format!("API {} · running", self.client.base_url());
        self.running_preview_active = true;
        self.start_run_request(RunOperation::Decision, session_id, request)
            .await;
    }

    pub fn workspace_path(&self) -> Option<String> {
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

    fn workspace_scope(&self) -> Option<TerminalWorkspaceScope> {
        let path = self.workspace_path();
        terminal_workspace_scope(path.as_deref())
    }

    fn session_list_request(&self, include_archived: Option<bool>) -> ListAgentSessionsRequest {
        let scope = self.workspace_scope();
        ListAgentSessionsRequest {
            workspace_id: scope.as_ref().map(|scope| scope.workspace_id.clone()),
            workspace_hash: scope.as_ref().map(|scope| scope.workspace_hash.clone()),
            include_archived,
        }
    }

    async fn ensure_current_session_for_turn(&mut self, title: &str) -> Option<String> {
        if let Some(session_id) = self.current_session_id.clone() {
            if self.current_session_resume_hint {
                self.current_session_id = None;
                self.current_session_resume_hint = false;
            } else {
                return Some(session_id);
            }
        } else {
            match self
                .client
                .current_agent_session(self.session_list_request(None))
                .await
            {
                Ok(Some(result)) => {
                    if let Some(session_id) = session_id(&result.session) {
                        let session_id = session_id.to_string();
                        self.current_session_id = Some(session_id.clone());
                        return Some(session_id);
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    self.status = format!("API {} · session failed", self.client.base_url());
                    self.cards
                        .push(CardModel::error(format!("读取当前会话失败：{error}")));
                    return None;
                }
            }
        }

        let scope = self.workspace_scope();
        match self
            .client
            .create_agent_session(CreateAgentSessionRequest {
                initial_mode: Some("plan".to_string()),
                workspace_id: scope.as_ref().map(|scope| scope.workspace_id.clone()),
                workspace_hash: scope.as_ref().map(|scope| scope.workspace_hash.clone()),
                title: Some(title.to_string()),
                ..CreateAgentSessionRequest::default()
            })
            .await
        {
            Ok(result) => {
                if let Some(session_id) = session_id(&result.session) {
                    let session_id = session_id.to_string();
                    self.current_session_id = Some(session_id.clone());
                    self.current_session_resume_hint = false;
                    Some(session_id)
                } else {
                    self.status = format!("API {} · session missing id", self.client.base_url());
                    self.cards
                        .push(CardModel::error("创建会话成功但响应缺少 session id。"));
                    None
                }
            }
            Err(error) => {
                self.status = format!("API {} · session failed", self.client.base_url());
                self.cards
                    .push(CardModel::error(format!("创建会话失败：{error}")));
                None
            }
        }
    }

    fn preview_user_turn(&mut self, prompt: &str) {
        self.cards.push(CardModel::user(prompt.to_string()));
        self.cards.push(CardModel::stage(
            "Running",
            "共享 Session Runtime 正在处理输入...",
        ));
        self.status = format!("API {} · running", self.client.base_url());
        self.running_preview_active = true;
    }

    async fn start_run_request(
        &mut self,
        operation: RunOperation,
        session_id: String,
        request: StartAgentRunRequest,
    ) {
        match self.client.start_agent_run(&session_id, request).await {
            Ok(result) => {
                let now = Instant::now();
                self.cards.push(CardModel::stage(
                    "Run",
                    format!("run id: {}\nstatus: {}", result.run.run_id, result.run.status),
                ));
                self.pending_run = Some(PendingRun {
                    operation,
                    session_id: session_id.clone(),
                    run_id: result.run.run_id.clone(),
                    last_event_poll: now - RUNNING_EVENT_POLL_INTERVAL,
                    last_timeline_poll: now - RUNNING_TIMELINE_POLL_INTERVAL,
                    last_event_count: None,
                    last_refresh_error: None,
                });
                let terminal = result.run.is_terminal();
                self.apply_run_snapshot(&result).await;
                if terminal {
                    self.pending_run = None;
                    self.apply_run_result(result);
                }
            }
            Err(error) => {
                self.running_preview_active = false;
                self.status = format!("API {} · run failed", self.client.base_url());
                let prefix = match operation {
                    RunOperation::Ask => String::new(),
                    RunOperation::Decision => "处理决策失败：".to_string(),
                };
                self.cards.push(CardModel::error(format!(
                    "{prefix}{error}\n\n检查项：\n- daemon/API 是否可用\n- 共享 Session Runtime 是否已构建并可运行\n- provider 请求是否失败或被权限门禁阻塞"
                )));
            }
        }
    }

    async fn cancel_current_run(&mut self) {
        let Some(pending) = self.pending_run.take() else {
            self.cards.push(CardModel::stage(
                "Cancel",
                "当前没有 TUI 正在等待的会话回合。",
            ));
            return;
        };
        let operation = pending.operation;
        let session_id = pending.session_id;
        let run_id = pending.run_id;
        self.running_preview_active = false;
        self.status = format!("API {} · stopped", self.client.base_url());
        match self
            .client
            .cancel_agent_run_by_id(&session_id, &run_id)
            .await
        {
            Ok(result) => self.apply_run_result(result),
            Err(error) => self.cards.push(CardModel::error(format!(
                "通知 daemon cancel 失败：{error}"
            ))),
        }
        self.cards.push(CardModel::stage(
            "Cancel",
            match operation {
                RunOperation::Ask => "已请求停止当前消息回合。",
                RunOperation::Decision => "已请求停止当前决策回合。",
            },
        ));
        self.load_timeline_if_visible(&session_id).await;
    }

    async fn apply_run_snapshot(&mut self, result: &AgentRunResult) {
        if let Some(id) = session_id(&result.session) {
            self.current_session_id = Some(id.to_string());
            self.current_session_resume_hint = false;
        }
        let event_count = result.events.len();
        self.events = result.events.clone();
        let previous_event_count = self
            .pending_run
            .as_ref()
            .filter(|pending| pending.session_id == result.run.session_id)
            .and_then(|pending| pending.last_event_count);
        if let Some(pending) = self
            .pending_run
            .as_mut()
            .filter(|pending| pending.session_id == result.run.session_id)
        {
            pending.last_event_count = Some(event_count);
            pending.last_refresh_error = None;
        }
        self.status = format!(
            "API {} · {} · events {}",
            self.client.base_url(),
            result.run.status,
            event_count
        );
        if previous_event_count != Some(event_count) {
            self.refresh_running_timeline(&result.run.session_id).await;
        }
    }

    fn apply_run_result(&mut self, result: AgentRunResult) {
        self.running_preview_active = false;
        self.current_session_id = Some(result.run.session_id.clone());
        self.current_session_resume_hint = false;
        self.events = result.events.clone();
        self.status = match result.run.status.as_str() {
            "completed" => format!("API {} · 回合完成", self.client.base_url()),
            "waiting" => format!("API {} · 等待用户决策", self.client.base_url()),
            "cancelled" => format!("API {} · stopped", self.client.base_url()),
            "failed" => format!("API {} · run failed", self.client.base_url()),
            other => format!("API {} · {other}", self.client.base_url()),
        };
        if result.run.status == "failed" {
            if let Some(message) = result.run.message {
                self.cards.push(CardModel::error(message));
            }
        } else if self.cards.is_empty() {
            if let Some(text) = result.run.final_text {
                self.cards.push(CardModel::stage("DeepCode", text));
            }
        }
    }

    async fn refresh_daemon_status(&mut self) {
        self.update_daemon_status(true).await;
    }

    async fn update_daemon_status(&mut self, push_card: bool) {
        match self.client.daemon_status().await {
            Ok(status) => {
                self.status = format!(
                    "API {} · {} · {}",
                    self.client.base_url(),
                    status.service,
                    if status.ok { "已连接" } else { "降级" }
                );
                if push_card {
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
            .current_agent_session(self.session_list_request(None))
            .await
        {
            Ok(Some(result)) => {
                if let Some(session_id) = session_id(&result.session) {
                    self.current_session_id = Some(session_id.to_string());
                    self.current_session_resume_hint = true;
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
            .list_agent_sessions(self.session_list_request(None))
            .await
        {
            Ok(result) => {
                self.current_session_id = result.current_session_id.clone();
                self.current_session_resume_hint = result.current_session_id.is_some();
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
        let scope = self.workspace_scope();
        let result = self
            .client
            .create_agent_session(CreateAgentSessionRequest {
                initial_mode: Some("plan".to_string()),
                workspace_id: scope.as_ref().map(|scope| scope.workspace_id.clone()),
                workspace_hash: scope.as_ref().map(|scope| scope.workspace_hash.clone()),
                title: title.map(ToOwned::to_owned),
                ..CreateAgentSessionRequest::default()
            })
            .await;
        match result {
            Ok(result) => {
                if let Some(session_id) = session_id(&result.session) {
                    self.current_session_id = Some(session_id.to_string());
                    self.current_session_resume_hint = false;
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
                    self.current_session_resume_hint = false;
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
                self.current_session_resume_hint = false;
                self.refresh_events_for_session(session_id).await;
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("读取 timeline 失败：{error}"))),
        }
    }

    async fn load_timeline_if_visible(&mut self, session_id: &str) {
        match self.client.agent_timeline(session_id).await {
            Ok(timeline) => {
                let next_cards = CardModel::from_timeline(&timeline);
                if !next_cards.is_empty() {
                    self.cards = next_cards;
                }
                self.current_session_id = Some(session_id.to_string());
                self.current_session_resume_hint = false;
                self.refresh_events_for_session(session_id).await;
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("读取 timeline 失败：{error}"))),
        }
    }

    async fn refresh_events_for_session(&mut self, session_id: &str) {
        if let Ok(result) = self.client.get_agent_session(session_id).await {
            self.events = result.events;
        }
    }

    fn show_workspace_status(&mut self) {
        let scope = self.workspace_scope();
        let scope_line = scope
            .map(|scope| {
                format!(
                    "scope: {} / {}\nnormalized: {}",
                    scope.workspace_id, scope.workspace_hash, scope.normalized_path
                )
            })
            .unwrap_or_else(|| "scope: none".to_string());
        self.cards.push(CardModel::stage(
            "Workspace",
            format!("{}\n{scope_line}", self.workspace_status()),
        ));
    }

    async fn update_workspace(&mut self, args: &str) {
        match args.trim() {
            "" => self.show_workspace_status(),
            "clear" | "none" | "off" => {
                self.host.workspace_path = None;
                self.host.no_workspace = true;
                self.current_session_id = None;
                self.cards.clear();
                self.cards.push(CardModel::stage(
                    "Workspace",
                    "workspace cleared; ordinary chat remains available, workspace tools fail closed.",
                ));
                self.refresh_current_session().await;
            }
            "cwd" | "." => {
                self.host.workspace_path = env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().to_string());
                self.host.no_workspace = false;
                self.current_session_id = None;
                self.cards.clear();
                self.show_workspace_status();
                self.refresh_current_session().await;
            }
            path => {
                self.host.workspace_path = Some(path.to_string());
                self.host.no_workspace = false;
                self.current_session_id = None;
                self.cards.clear();
                self.show_workspace_status();
                self.refresh_current_session().await;
            }
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
                self.current_session_resume_hint = self.current_session_id.is_some();
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
                self.current_session_resume_hint = self.current_session_id.is_some();
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

#[derive(Debug, Clone)]
struct PendingDecision {
    kind: String,
    run_id: String,
    target_id: Option<String>,
    options: Vec<PendingDecisionOption>,
}

#[derive(Debug, Clone)]
struct PendingDecisionOption {
    id: String,
    label: String,
    description: Option<String>,
    recommended: bool,
}

struct ParsedDecisionInput {
    decision: String,
    guidance: Option<String>,
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

fn looks_like_command(line: &str) -> bool {
    if line.starts_with('/') {
        return true;
    }
    let first = line.split_whitespace().next().unwrap_or_default();
    matches!(
        first,
        "help"
            | "status"
            | "sessions"
            | "timeline"
            | "audit"
            | "cancel"
            | "clear"
            | "quit"
            | "exit"
            | "q"
            | "new"
            | "use"
            | "rename"
            | "delete"
            | "archive"
            | "allow"
            | "deny"
            | "decision"
            | "workspace"
    )
}

fn latest_pending_decision(events: &[Value]) -> Option<PendingDecision> {
    for event in events.iter().rev() {
        let kind = event.get("kind").and_then(Value::as_str).unwrap_or_default();
        let payload = event.get("payload").and_then(Value::as_object);
        let Some(payload) = payload else {
            continue;
        };
        match kind {
            "workflow_stage" => {
                let status = payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if matches!(status, "cancelled" | "failed") {
                    return None;
                }
            }
            "plan_card" => {
                let run_id = payload.get("runId").and_then(Value::as_str)?;
                let plan_id = payload.get("planId").and_then(Value::as_str)?;
                return Some(PendingDecision {
                    kind: "plan".to_string(),
                    run_id: run_id.to_string(),
                    target_id: Some(plan_id.to_string()),
                    options: Vec::new(),
                });
            }
            "plan_review" => {
                let status = payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if matches!(status, "accepted" | "rejected" | "needsRevision" | "denied") {
                    return None;
                }
                if !matches!(
                    status,
                    "awaitingUserApproval" | "awaitingTemporaryGrant" | "pending"
                ) {
                    continue;
                }
                let run_id = payload.get("runId").and_then(Value::as_str)?;
                let plan_id = payload.get("planId").and_then(Value::as_str)?;
                return Some(PendingDecision {
                    kind: "plan".to_string(),
                    run_id: run_id.to_string(),
                    target_id: Some(plan_id.to_string()),
                    options: Vec::new(),
                });
            }
            "review_summary" => {
                let status = payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if matches!(status, "accepted" | "rejected" | "needsRevision") {
                    return None;
                }
                if status != "waitingUserReview" {
                    continue;
                }
                let run_id = payload.get("runId").and_then(Value::as_str)?;
                return Some(PendingDecision {
                    kind: "review".to_string(),
                    run_id: run_id.to_string(),
                    target_id: payload
                        .get("reviewId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    options: Vec::new(),
                });
            }
            "requirement_confirmation" => {
                let status = payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if status != "waitingUserConfirmation" {
                    continue;
                }
                let run_id = payload.get("runId").and_then(Value::as_str)?;
                let requirement_id = payload.get("requirementId").and_then(Value::as_str)?;
                return Some(PendingDecision {
                    kind: "requirement".to_string(),
                    run_id: run_id.to_string(),
                    target_id: Some(requirement_id.to_string()),
                    options: decision_request_options(payload.get("decisionRequest")),
                });
            }
            "requirement_decision" => return None,
            _ => {}
        }
    }
    None
}

fn decision_request_options(value: Option<&Value>) -> Vec<PendingDecisionOption> {
    let Some(options) = value
        .and_then(|item| item.get("options"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let parsed = options
        .iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| item.get("label").and_then(Value::as_str))?;
            let label = item
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(id);
            Some(PendingDecisionOption {
                id: id.to_string(),
                label: label.to_string(),
                description: item
                    .get("description")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("impact").and_then(Value::as_str))
                    .or_else(|| item.get("tradeoff").and_then(Value::as_str))
                    .map(ToOwned::to_owned),
                recommended: item
                    .get("recommended")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect::<Vec<_>>();
    if parsed.len() >= 2 {
        parsed
    } else {
        Vec::new()
    }
}

fn parse_pending_decision_input(line: &str, pending: &PendingDecision) -> ParsedDecisionInput {
    if !pending.options.is_empty() {
        return parse_technical_choice_input(line, pending);
    }
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.is_empty() || lower == "1" || lower == "accept" || trimmed == "确认" || trimmed == "同意" {
        return ParsedDecisionInput {
            decision: "accept".to_string(),
            guidance: None,
        };
    }
    if matches!(lower.as_str(), "3" | "end" | "stop" | "reject" | "/reject" | "/end" | "/stop")
        || matches!(trimmed, "结束" | "拒绝")
    {
        return ParsedDecisionInput {
            decision: "reject".to_string(),
            guidance: None,
        };
    }
    let guidance = if lower == "2" {
        None
    } else if lower.starts_with("2 ") {
        Some(trimmed[2..].trim().to_string()).filter(|value| !value.is_empty())
    } else {
        Some(trimmed.to_string())
    };
    ParsedDecisionInput {
        decision: "revise".to_string(),
        guidance,
    }
}

fn parse_technical_choice_input(line: &str, pending: &PendingDecision) -> ParsedDecisionInput {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    if matches!(lower.as_str(), "end" | "stop" | "reject" | "/reject" | "/end" | "/stop")
        || matches!(trimmed, "结束" | "拒绝")
    {
        return ParsedDecisionInput {
            decision: "reject".to_string(),
            guidance: None,
        };
    }
    let default = pending
        .options
        .iter()
        .find(|option| option.recommended)
        .unwrap_or(&pending.options[0]);
    let (option, supplement) = if let Some((index, tail)) = numbered_choice(trimmed) {
        (
            pending.options.get(index).unwrap_or(default),
            tail.filter(|value| !value.is_empty()),
        )
    } else if trimmed.is_empty()
        || lower == "accept"
        || trimmed == "确认"
        || trimmed == "同意"
    {
        (default, None)
    } else {
        (default, Some(trimmed))
    };
    ParsedDecisionInput {
        decision: "accept".to_string(),
        guidance: Some(technical_choice_guidance(option, supplement)),
    }
}

fn numbered_choice(value: &str) -> Option<(usize, Option<&str>)> {
    let mut chars = value.chars();
    let first = chars.next()?;
    if !matches!(first, '1' | '2' | '3') {
        return None;
    }
    let rest = chars.as_str();
    if let Some(next) = rest.chars().next() {
        if !next.is_whitespace() {
            return None;
        }
    }
    let index = first.to_digit(10)? as usize - 1;
    Some((index, Some(rest.trim()).filter(|tail| !tail.is_empty())))
}

fn technical_choice_guidance(option: &PendingDecisionOption, supplement: Option<&str>) -> String {
    let mut lines = vec![
        "用户已选择技术方案：".to_string(),
        format!("- id: {}", normalize_guidance_line(&option.id)),
        format!("- label: {}", normalize_guidance_line(&option.label)),
    ];
    if let Some(description) = option.description.as_deref() {
        lines.push(format!(
            "- description: {}",
            normalize_guidance_line(description)
        ));
    }
    if let Some(supplement) = supplement {
        lines.push("用户补充信息：".to_string());
        lines.push(supplement.trim().to_string());
    }
    lines.join("\n")
}

fn normalize_guidance_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plain_pending_decision() -> PendingDecision {
        PendingDecision {
            kind: "plan".to_string(),
            run_id: "run-generic".to_string(),
            target_id: Some("target-generic".to_string()),
            options: Vec::new(),
        }
    }

    #[test]
    fn pending_decision_input_maps_confirm_review_and_end() {
        let pending = plain_pending_decision();
        let confirm = parse_pending_decision_input("", &pending);
        assert_eq!(confirm.decision, "accept");
        assert!(confirm.guidance.is_none());

        let review = parse_pending_decision_input("2 add review guidance", &pending);
        assert_eq!(review.decision, "revise");
        assert_eq!(review.guidance.as_deref(), Some("add review guidance"));

        let end = parse_pending_decision_input("结束", &pending);
        assert_eq!(end.decision, "reject");
        assert!(end.guidance.is_none());
    }

    #[test]
    fn pending_decision_input_maps_numbered_options_to_accept_guidance() {
        let pending = PendingDecision {
            kind: "requirement".to_string(),
            run_id: "run-choice".to_string(),
            target_id: Some("requirement-choice".to_string()),
            options: vec![
                PendingDecisionOption {
                    id: "option-a".to_string(),
                    label: "Option A".to_string(),
                    description: Some("First generic option.".to_string()),
                    recommended: true,
                },
                PendingDecisionOption {
                    id: "option-b".to_string(),
                    label: "Option B".to_string(),
                    description: Some("Second generic option.".to_string()),
                    recommended: false,
                },
            ],
        };

        let selected = parse_pending_decision_input("2 with extra constraint", &pending);
        assert_eq!(selected.decision, "accept");
        let guidance = selected.guidance.unwrap_or_default();
        assert!(guidance.contains("- id: option-b"));
        assert!(guidance.contains("- label: Option B"));
        assert!(guidance.contains("with extra constraint"));
    }

    #[test]
    fn latest_pending_decision_finds_plan_review() {
        let events = vec![json!({
            "kind": "plan_review",
            "payload": {
                "status": "awaitingTemporaryGrant",
                "runId": "run-generic",
                "planId": "plan-generic"
            }
        })];
        let pending = latest_pending_decision(&events).expect("pending plan");
        assert_eq!(pending.kind, "plan");
        assert_eq!(pending.run_id, "run-generic");
        assert_eq!(pending.target_id.as_deref(), Some("plan-generic"));
        assert!(pending.options.is_empty());
    }

    #[test]
    fn latest_pending_decision_finds_plan_card() {
        let events = vec![json!({
            "kind": "plan_card",
            "payload": {
                "runId": "run-plan-card",
                "planId": "plan-card"
            }
        })];
        let pending = latest_pending_decision(&events).expect("pending plan card");
        assert_eq!(pending.kind, "plan");
        assert_eq!(pending.run_id, "run-plan-card");
        assert_eq!(pending.target_id.as_deref(), Some("plan-card"));
        assert!(pending.options.is_empty());
    }

    #[test]
    fn latest_pending_decision_keeps_requirement_options() {
        let events = vec![json!({
            "kind": "requirement_confirmation",
            "payload": {
                "status": "waitingUserConfirmation",
                "runId": "run-requirement",
                "requirementId": "requirement-generic",
                "decisionRequest": {
                    "options": [
                        { "id": "option-a", "label": "Option A", "recommended": true },
                        { "id": "option-b", "label": "Option B", "description": "Second generic option." }
                    ]
                }
            }
        })];
        let pending = latest_pending_decision(&events).expect("pending requirement");
        assert_eq!(pending.kind, "requirement");
        assert_eq!(pending.options.len(), 2);
        assert_eq!(pending.options[0].id, "option-a");
        assert_eq!(pending.options[1].label, "Option B");
    }
}
