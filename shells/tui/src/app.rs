use crate::model::{CardModel, CurrentWorkModel};
use crate::renderer::Renderer;
use deepcode_kernel_client::{
    terminal_workspace_scope, AgentRunCallerRequest, AgentRunGuidanceRequest, AgentRunResult,
    AgentTimelinePendingInteraction, AgentTimelineRunStatus, AgentTimelineSnapshot,
    AgentTimelineStreamEvent, AgentTimelineStreamReduction, CreateAgentSessionRequest,
    HttpKernelClient, ListAgentSessionsRequest, StartAgentRunRequest, TerminalWorkspaceScope,
};
use serde_json::Value;
use std::{
    env,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TIMELINE_STREAM_CHANNEL_CAPACITY: usize = 16;
const HOST_TERMINAL_RECONCILE_WINDOW: Duration = Duration::from_secs(4);
const TIMELINE_SNAPSHOT_REQUEST_WINDOW: Duration = Duration::from_secs(2);
const TIMELINE_INITIAL_SNAPSHOT_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const TIMELINE_STREAM_WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
const TIMELINE_STREAM_RECONNECT_BACKOFF: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy)]
enum RunOperation {
    Ask,
    Decision,
}

struct PendingRun {
    operation: RunOperation,
    session_id: String,
    run_id: String,
    kernel_run_id: String,
    timeline_stream: Option<PendingTimelineStream>,
    projection_terminal_since: Option<Instant>,
    last_projection_activity_at: Instant,
    last_watchdog_snapshot_at: Instant,
    stream_reconnect_not_before: Instant,
    cancel_requested: bool,
    last_refresh_error: Option<String>,
}

enum TimelineStreamMessage {
    Event(AgentTimelineStreamEvent),
    Closed,
    Failed(String),
}

struct PendingTimelineStream {
    receiver: tokio::sync::mpsc::Receiver<TimelineStreamMessage>,
    task: tokio::task::JoinHandle<()>,
}

impl PendingTimelineStream {
    fn spawn(client: HttpKernelClient, session_id: String, after_revision: Option<u64>) -> Self {
        let (sender, receiver) = tokio::sync::mpsc::channel(TIMELINE_STREAM_CHANNEL_CAPACITY);
        let task = tokio::spawn(async move {
            let mut stream = match client
                .agent_timeline_stream_v2(&session_id, after_revision)
                .await
            {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = sender
                        .send(TimelineStreamMessage::Failed(error.to_string()))
                        .await;
                    return;
                }
            };
            loop {
                match stream.next_event().await {
                    Ok(Some(event)) => {
                        if sender
                            .send(TimelineStreamMessage::Event(event))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    Ok(None) => {
                        let _ = sender.send(TimelineStreamMessage::Closed).await;
                        return;
                    }
                    Err(error) => {
                        let _ = sender
                            .send(TimelineStreamMessage::Failed(error.to_string()))
                            .await;
                        return;
                    }
                }
            }
        });
        Self { receiver, task }
    }
}

impl Drop for PendingTimelineStream {
    fn drop(&mut self) {
        self.task.abort();
    }
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
    timeline: Option<AgentTimelineSnapshot>,
    current_work: Option<CurrentWorkModel>,
    action_required: Option<String>,
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
            timeline: None,
            current_work: None,
            action_required: None,
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

    pub fn current_work(&self) -> Option<&CurrentWorkModel> {
        self.current_work.as_ref()
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

    pub fn take_action_required(&mut self) -> Option<String> {
        self.action_required.take()
    }

    pub fn should_hold_input_for_running_turn(&self) -> bool {
        false
    }

    pub fn notify_running_input_held(&mut self) {
        self.status = format!("API {} · running · 输入已保留", self.client.base_url());
    }

    pub async fn poll_pending_run(&mut self) {
        self.consume_pending_timeline_stream().await;
        self.settle_pending_action_required();
        let Some((session_id, run_id)) = self
            .pending_run
            .as_ref()
            .map(|pending| (pending.session_id.clone(), pending.run_id.clone()))
        else {
            return;
        };
        if self.pending_projection_terminal_status().is_none() {
            let projection_bound = self.pending_projection_is_bound();
            let watchdog_due = self.pending_run.as_ref().is_some_and(|pending| {
                if projection_bound {
                    pending.last_projection_activity_at.elapsed()
                        >= TIMELINE_STREAM_WATCHDOG_INTERVAL
                        && pending.last_watchdog_snapshot_at.elapsed()
                            >= TIMELINE_STREAM_WATCHDOG_INTERVAL
                } else {
                    pending.last_watchdog_snapshot_at.elapsed()
                        >= TIMELINE_INITIAL_SNAPSHOT_RETRY_INTERVAL
                }
            });
            if watchdog_due {
                if let Some(pending) = self.pending_run.as_mut() {
                    pending.last_watchdog_snapshot_at = Instant::now();
                }
                self.refresh_running_timeline(&session_id).await;
                self.settle_pending_action_required();
                if self.pending_run.is_none() {
                    return;
                }
                self.schedule_pending_timeline_stream_reconnect();
            }
        }
        let Some(projection_status) = self.pending_projection_terminal_status() else {
            self.ensure_pending_timeline_stream();
            if self
                .pending_run
                .as_ref()
                .is_some_and(|pending| pending.cancel_requested)
            {
                self.status = format!(
                    "API {} · cancel accepted · waiting for canonical terminal",
                    self.client.base_url()
                );
            }
            return;
        };
        let terminal_since = self
            .pending_run
            .as_ref()
            .and_then(|pending| pending.projection_terminal_since)
            .unwrap_or_else(Instant::now);
        let remaining = HOST_TERMINAL_RECONCILE_WINDOW.saturating_sub(terminal_since.elapsed());
        if remaining.is_zero() {
            self.pending_run = None;
            self.running_preview_active = false;
            self.status = format!(
                "API {} · terminal reconciliation failed",
                self.client.base_url()
            );
            self.cards.push(CardModel::error(format!(
                "Shared Projection 已到达 {projection_status:?}，但 Host Run {run_id} 未在 {} ms 内完成对账。已停止 watcher。",
                HOST_TERMINAL_RECONCILE_WINDOW.as_millis()
            )));
            return;
        }
        match tokio::time::timeout(remaining, self.client.get_agent_run(&session_id, &run_id)).await
        {
            Ok(Ok(result)) => {
                self.apply_run_snapshot(&result).await;
                if host_status_matches_projection(&result, projection_status) {
                    self.pending_run = None;
                    self.apply_run_result(result);
                    return;
                }
                let expired = self.pending_run.as_ref().is_some_and(|pending| {
                    pending
                        .projection_terminal_since
                        .is_some_and(|since| since.elapsed() >= HOST_TERMINAL_RECONCILE_WINDOW)
                });
                if expired {
                    let host_status = result.run.status.clone();
                    self.pending_run = None;
                    self.running_preview_active = false;
                    self.status = format!(
                        "API {} · terminal reconciliation failed",
                        self.client.base_url()
                    );
                    self.cards.push(CardModel::error(format!(
                        "Shared Projection 已到达 {projection_status:?}，但 Host Run {run_id} 在 {} ms 内仍为 {host_status}。已停止 watcher，未使用 Host 状态改写投影事实。",
                        HOST_TERMINAL_RECONCILE_WINDOW.as_millis()
                    )));
                } else {
                    self.status = format!(
                        "API {} · canonical terminal · reconciling Host",
                        self.client.base_url()
                    );
                }
            }
            Ok(Err(error)) => {
                let expired = self.pending_run.as_ref().is_some_and(|pending| {
                    pending
                        .projection_terminal_since
                        .is_some_and(|since| since.elapsed() >= HOST_TERMINAL_RECONCILE_WINDOW)
                });
                if expired {
                    self.pending_run = None;
                    self.running_preview_active = false;
                    self.status = format!(
                        "API {} · terminal reconciliation failed",
                        self.client.base_url()
                    );
                    self.cards.push(CardModel::error(format!(
                        "terminal 对账在 {} ms 内未能读取 Host Run；已停止 watcher：{error}",
                        HOST_TERMINAL_RECONCILE_WINDOW.as_millis()
                    )));
                } else {
                    self.record_pending_refresh_error(format!(
                        "读取 session run 状态失败：{error}"
                    ));
                }
            }
            Err(_) => {
                self.pending_run = None;
                self.running_preview_active = false;
                self.status = format!(
                    "API {} · terminal reconciliation failed",
                    self.client.base_url()
                );
                self.cards.push(CardModel::error(format!(
                    "terminal 对账未在剩余 {} ms 内完成；已停止 watcher。",
                    remaining.as_millis()
                )));
            }
        }
    }

    async fn consume_pending_timeline_stream(&mut self) {
        let mut messages = Vec::new();
        if let Some(pending) = self.pending_run.as_mut() {
            if let Some(stream) = pending.timeline_stream.as_mut() {
                while let Ok(message) = stream.receiver.try_recv() {
                    messages.push(message);
                }
            }
        }
        for message in messages {
            if self.pending_run.is_none() {
                return;
            }
            match message {
                TimelineStreamMessage::Event(event) => {
                    if let Some(pending) = self.pending_run.as_mut() {
                        pending.last_projection_activity_at = Instant::now();
                    }
                    match deepcode_kernel_client::reduce_agent_timeline_stream_event(
                        self.timeline.as_ref(),
                        &event,
                    ) {
                        Ok(AgentTimelineStreamReduction::Unchanged) => {}
                        Ok(AgentTimelineStreamReduction::Replace(timeline)) => {
                            self.apply_timeline_snapshot(timeline, false);
                            self.mark_pending_projection_terminal();
                            self.settle_pending_action_required();
                        }
                        Ok(AgentTimelineStreamReduction::ReconcileRequired { .. }) => {
                            self.reconcile_pending_timeline_stream().await;
                            return;
                        }
                        Err(error) => {
                            self.record_pending_refresh_error(format!(
                                "Shared Projection stream 协议错误：{error}"
                            ));
                            self.reconcile_pending_timeline_stream().await;
                            return;
                        }
                    }
                }
                TimelineStreamMessage::Closed => {
                    self.reconcile_pending_timeline_stream().await;
                    return;
                }
                TimelineStreamMessage::Failed(error) => {
                    self.record_pending_refresh_error(format!(
                        "读取 Shared Projection stream 失败：{error}"
                    ));
                    self.reconcile_pending_timeline_stream().await;
                    return;
                }
            }
        }
    }

    async fn reconcile_pending_timeline_stream(&mut self) {
        let Some(session_id) = self
            .pending_run
            .as_ref()
            .map(|pending| pending.session_id.clone())
        else {
            return;
        };
        self.refresh_running_timeline(&session_id).await;
        if self.pending_run.is_none() {
            return;
        }
        self.mark_pending_projection_terminal();
        if self.pending_projection_terminal_status().is_some() {
            return;
        }
        self.schedule_pending_timeline_stream_reconnect();
    }

    fn schedule_pending_timeline_stream_reconnect(&mut self) {
        if let Some(pending) = self.pending_run.as_mut() {
            pending.timeline_stream = None;
            pending.stream_reconnect_not_before =
                Instant::now() + TIMELINE_STREAM_RECONNECT_BACKOFF;
        }
    }

    fn ensure_pending_timeline_stream(&mut self) {
        if !self.pending_projection_is_bound() {
            return;
        }
        let Some((session_id, should_reconnect)) = self.pending_run.as_ref().map(|pending| {
            (
                pending.session_id.clone(),
                pending.timeline_stream.is_none()
                    && Instant::now() >= pending.stream_reconnect_not_before,
            )
        }) else {
            return;
        };
        if !should_reconnect || self.pending_projection_terminal_status().is_some() {
            return;
        }
        let after_revision = self.timeline.as_ref().map(|timeline| timeline.revision);
        if let Some(pending) = self.pending_run.as_mut() {
            pending.timeline_stream = Some(PendingTimelineStream::spawn(
                self.client.clone(),
                session_id,
                after_revision,
            ));
            pending.stream_reconnect_not_before =
                Instant::now() + TIMELINE_STREAM_RECONNECT_BACKOFF;
        }
    }

    async fn refresh_running_timeline(&mut self, target_session_id: &str) {
        if let Some(pending) = self
            .pending_run
            .as_mut()
            .filter(|pending| pending.session_id == target_session_id)
        {
            pending.last_watchdog_snapshot_at = Instant::now();
        }
        match tokio::time::timeout(
            TIMELINE_SNAPSHOT_REQUEST_WINDOW,
            self.client.agent_timeline_v2_optional(target_session_id),
        )
        .await
        {
            Ok(Ok(Some(timeline))) => {
                let revision = timeline.revision;
                let event = AgentTimelineStreamEvent::Snapshot {
                    session_id: timeline.session_id.clone(),
                    revision,
                    snapshot: timeline,
                };
                match deepcode_kernel_client::reduce_agent_timeline_stream_event(
                    self.timeline.as_ref(),
                    &event,
                ) {
                    Ok(AgentTimelineStreamReduction::Unchanged) => {}
                    Ok(AgentTimelineStreamReduction::Replace(timeline)) => {
                        self.apply_timeline_snapshot(timeline, false);
                    }
                    Ok(AgentTimelineStreamReduction::ReconcileRequired { .. }) => {
                        self.record_pending_refresh_error(format!(
                            "Shared Projection snapshot revision {revision} 与本地同 revision 内容冲突；拒绝静默覆盖"
                        ));
                        return;
                    }
                    Err(error) => {
                        self.record_pending_refresh_error(format!(
                            "Shared Projection snapshot 协议错误：{error}"
                        ));
                        return;
                    }
                }
                if let Some(pending) = self
                    .pending_run
                    .as_mut()
                    .filter(|pending| pending.session_id == target_session_id)
                {
                    pending.last_refresh_error = None;
                    pending.last_projection_activity_at = Instant::now();
                }
                self.current_session_id = Some(target_session_id.to_string());
                self.current_session_resume_hint = false;
                self.status = self
                    .current_work
                    .as_ref()
                    .and_then(|work| work.activity.as_deref())
                    .map(|activity| format!("API {} · {activity}", self.client.base_url()))
                    .unwrap_or_else(|| {
                        format!("API {} · projection r{revision}", self.client.base_url())
                    });
                self.mark_pending_projection_terminal();
                self.settle_pending_action_required();
            }
            Ok(Ok(None)) => {
                if let Some(pending) = self
                    .pending_run
                    .as_mut()
                    .filter(|pending| pending.session_id == target_session_id)
                {
                    pending.last_refresh_error = None;
                }
            }
            Ok(Err(error)) => {
                self.record_pending_refresh_error(format!("读取 running timeline 失败：{error}"))
            }
            Err(_) => self.record_pending_refresh_error(format!(
                "读取 running timeline 超过 {} ms；保持 watcher 并等待下一次低频对账",
                TIMELINE_SNAPSHOT_REQUEST_WINDOW.as_millis()
            )),
        }
    }

    fn apply_timeline_snapshot(&mut self, timeline: AgentTimelineSnapshot, replace_empty: bool) {
        let next_cards = CardModel::from_timeline(&timeline);
        if replace_empty || !next_cards.is_empty() {
            self.cards = next_cards;
            self.running_preview_active = false;
        }
        self.current_work = CurrentWorkModel::from_timeline(&timeline);
        self.timeline = Some(timeline);
    }

    fn pending_projection_terminal_status(&self) -> Option<AgentTimelineRunStatus> {
        let pending = self.pending_run.as_ref()?;
        let run = self.timeline.as_ref()?.run_projection.as_ref()?;
        (run.run_id == pending.kernel_run_id && run.status.is_terminal()).then_some(run.status)
    }

    fn pending_projection_is_bound(&self) -> bool {
        let Some(pending) = self.pending_run.as_ref() else {
            return false;
        };
        let Some(timeline) = self.timeline.as_ref() else {
            return false;
        };
        timeline.session_id == pending.session_id
            && timeline
                .run_projection
                .as_ref()
                .is_some_and(|run| run.run_id == pending.kernel_run_id)
    }

    fn mark_pending_projection_terminal(&mut self) {
        if self.pending_projection_terminal_status().is_none() {
            return;
        }
        if let Some(pending) = self.pending_run.as_mut() {
            pending.timeline_stream = None;
            pending
                .projection_terminal_since
                .get_or_insert_with(Instant::now);
        }
    }

    fn settle_pending_action_required(&mut self) {
        let Some(pending) = self.pending_run.as_ref() else {
            return;
        };
        let Some(run) = self
            .timeline
            .as_ref()
            .and_then(|timeline| timeline.run_projection.as_ref())
        else {
            return;
        };
        if run.run_id != pending.kernel_run_id {
            return;
        }
        if !matches!(
            run.status,
            AgentTimelineRunStatus::WaitingUser | AgentTimelineRunStatus::Paused
        ) {
            return;
        }
        let reason = run
            .wait
            .0
            .as_ref()
            .and_then(|wait| wait.reason.as_deref())
            .filter(|reason| !reason.trim().is_empty())
            .unwrap_or("Session requires an explicit user action");
        let message = format!(
            "shared session run {} requires user action: {reason}",
            pending.run_id
        );
        self.status = format!("API {} · action required", self.client.base_url());
        self.action_required = Some(message);
        self.pending_run = None;
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
        if latest_pending_decision(self.timeline.as_ref()).is_some()
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
        if let Some(pending) = latest_pending_decision(self.timeline.as_ref()) {
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
                self.current_work = None;
                self.cards.push(CardModel::notice(
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
                self.resolve_permission_alias(permission_id, "accept").await;
            }
            command if command.starts_with("/deny ") || command.starts_with("deny ") => {
                let permission_id = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                self.resolve_permission_alias(permission_id, "reject").await;
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
        let caller_request_id = match new_tui_request_id("ask") {
            Ok(request_id) => request_id,
            Err(error) => {
                self.running_preview_active = false;
                self.cards.push(CardModel::error(error));
                return;
            }
        };
        let mut request = StartAgentRunRequest::ask(prompt.to_string(), caller_request_id);
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
        self.submit_user_input_to_run(&session_id, &run_id, guidance)
            .await;
    }

    async fn submit_user_input_to_run(&mut self, session_id: &str, run_id: &str, input: &str) {
        let caller_request_id = match new_tui_request_id("input") {
            Ok(request_id) => request_id,
            Err(error) => {
                self.status = format!("API {} · input failed", self.client.base_url());
                self.cards.push(CardModel::error(error));
                return;
            }
        };
        let mut request = AgentRunGuidanceRequest::new(input, caller_request_id);
        request.workspace_path = self.workspace_path();
        request.no_workspace = Some(self.host.no_workspace);
        match self
            .client
            .submit_agent_run_guidance(session_id, run_id, request)
            .await
        {
            Ok(result) => {
                self.apply_run_snapshot(&result).await;
                self.status = format!("API {} · guidance accepted", self.client.base_url());
            }
            Err(error) => {
                self.status = format!("API {} · input failed", self.client.base_url());
                self.cards
                    .push(CardModel::error(format!("提交新用户输入失败：{error}")));
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
                "用法：/decision <plan|permission> <accept|reject|revise> [run-id] [target-id] [guidance]",
            ));
            return;
        };
        let Some(decision) = parts.get(1).cloned() else {
            self.cards.push(CardModel::error(
                "用法：/decision <plan|permission> <accept|reject|revise> [run-id] [target-id] [guidance]",
            ));
            return;
        };
        if !matches!(kind.as_str(), "plan" | "permission") {
            self.cards
                .push(CardModel::error("decision kind 必须是 plan 或 permission"));
            return;
        }
        if !matches!(
            (kind.as_str(), decision.as_str()),
            ("plan", "accept" | "reject" | "revise") | ("permission", "accept" | "reject")
        ) {
            self.cards.push(CardModel::error(
                "permission decision 只能是 accept 或 reject；plan 还可使用 revise",
            ));
            return;
        }
        if kind == "permission" && parts.len() > 4 {
            self.cards.push(CardModel::error(
                "permission decision 不接受自由文本 guidance",
            ));
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
        if pending.kind == "permission" {
            let decision = match parse_pending_permission_input(line) {
                Some(decision) => decision,
                None => {
                    let Some(session_id) = self.current_session_id.clone() else {
                        self.cards
                            .push(CardModel::error("当前没有激活会话，无法提交新的用户输入。"));
                        return;
                    };
                    self.submit_user_input_to_run(&session_id, &pending.run_id, line)
                        .await;
                    return;
                }
            };
            self.start_decision_request(
                pending.kind,
                decision,
                Some(pending.run_id),
                Some(pending.target_id),
                None,
            )
            .await;
            return;
        }
        let parsed = parse_pending_decision_input(line, &pending);
        self.start_decision_request(
            pending.kind,
            parsed.decision,
            Some(pending.run_id),
            Some(pending.target_id),
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
        if !matches!(
            (kind.as_str(), decision.as_str()),
            ("plan", "accept" | "reject" | "revise") | ("permission", "accept" | "reject")
        ) || (kind == "permission" && guidance.is_some())
        {
            self.cards.push(CardModel::error(
                "decision kind、decision 或 guidance 不符合 canonical Session decision contract。",
            ));
            return;
        }
        let Some(session_id) = self.current_session_id.clone() else {
            self.cards.push(CardModel::error(
                "当前没有激活会话。先发送一条消息，或使用 /use <session-id>。",
            ));
            return;
        };
        let timeline = match self.client.agent_timeline_v2(&session_id).await {
            Ok(timeline) => timeline,
            Err(error) => {
                self.cards.push(CardModel::error(format!(
                    "读取当前 pending interaction 失败：{error}"
                )));
                return;
            }
        };
        let Some(pending) = latest_pending_decision(Some(&timeline)) else {
            self.cards.push(CardModel::error(
                "当前 Shared Projection v2 没有可提交的精确 pending interaction；非当前 schema 返回 UnsupportedHistorySchema，不提供兼容读取。",
            ));
            return;
        };
        if pending.kind != kind
            || run_id
                .as_deref()
                .is_some_and(|expected| expected != pending.run_id)
            || target_id
                .as_deref()
                .is_some_and(|expected| expected != pending.target_id)
        {
            self.cards.push(CardModel::error(
                "pending interaction 已变化，请刷新 timeline 后重新选择。",
            ));
            self.timeline = Some(timeline);
            return;
        }
        let caller_request_id = match new_tui_request_id("decision") {
            Ok(request_id) => request_id,
            Err(error) => {
                self.cards.push(CardModel::error(error));
                return;
            }
        };
        let mut request = StartAgentRunRequest::resolve_decision(kind, decision, caller_request_id);
        request.run_id = Some(pending.run_id);
        request.target_id = Some(pending.target_id);
        request.guidance = guidance;
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
                let Some(kernel_run_id) = result.run.kernel_run_id.clone() else {
                    self.running_preview_active = false;
                    self.cards.push(CardModel::error(format!(
                        "Host Run {} 缺少精确 Kernel Run identity，TUI 拒绝推断投影绑定。",
                        result.run.run_id
                    )));
                    return;
                };
                self.action_required = None;
                if self
                    .timeline
                    .as_ref()
                    .is_some_and(|timeline| timeline.session_id != session_id)
                {
                    self.timeline = None;
                    self.current_work = None;
                }
                self.pending_run = Some(PendingRun {
                    operation,
                    session_id: session_id.clone(),
                    run_id: result.run.run_id.clone(),
                    kernel_run_id,
                    timeline_stream: None,
                    projection_terminal_since: None,
                    last_projection_activity_at: Instant::now(),
                    last_watchdog_snapshot_at: Instant::now(),
                    stream_reconnect_not_before: Instant::now(),
                    cancel_requested: false,
                    last_refresh_error: None,
                });
                let terminal = result.run.is_terminal();
                self.apply_run_snapshot(&result).await;
                self.refresh_running_timeline(&session_id).await;
                self.ensure_pending_timeline_stream();
                if terminal {
                    self.mark_pending_projection_terminal();
                    if self
                        .pending_projection_terminal_status()
                        .is_some_and(|status| host_status_matches_projection(&result, status))
                    {
                        self.pending_run = None;
                        self.apply_run_result(result);
                    }
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
        let Some(pending) = self.pending_run.as_ref() else {
            self.cards.push(CardModel::notice(
                "Cancel",
                "当前没有 TUI 正在等待的会话回合。",
            ));
            return;
        };
        let operation = pending.operation;
        let session_id = pending.session_id.clone();
        let run_id = pending.run_id.clone();
        let caller_request_id = match new_tui_request_id("cancel") {
            Ok(request_id) => request_id,
            Err(error) => {
                self.status = format!(
                    "API {} · cancel not submitted · still watching",
                    self.client.base_url()
                );
                self.cards.push(CardModel::error(format!(
                    "无法生成 cancel requestId，取消请求未提交；继续跟踪当前回合：{error}"
                )));
                return;
            }
        };
        match self
            .client
            .cancel_agent_run_by_id(
                &session_id,
                &run_id,
                AgentRunCallerRequest::new(caller_request_id),
            )
            .await
        {
            Ok(result) => {
                if let Some(pending) = self.pending_run.as_mut() {
                    pending.cancel_requested = true;
                }
                self.apply_run_snapshot(&result).await;
                self.status = format!(
                    "API {} · cancel accepted · waiting for canonical terminal",
                    self.client.base_url()
                );
                self.cards.push(CardModel::notice(
                    "Cancel",
                    match operation {
                        RunOperation::Ask => {
                            "停止请求已被 daemon 持久接纳；继续跟踪当前消息回合直到 typed projection terminal。"
                        }
                        RunOperation::Decision => {
                            "停止请求已被 daemon 持久接纳；继续跟踪当前决策回合直到 typed projection terminal。"
                        }
                    },
                ));
                if result.run.is_terminal() {
                    self.refresh_running_timeline(&session_id).await;
                    self.mark_pending_projection_terminal();
                }
            }
            Err(error) => {
                self.status = format!(
                    "API {} · cancel rejected · still watching",
                    self.client.base_url()
                );
                self.cards.push(CardModel::error(format!(
                    "daemon 未接纳 cancel 请求；当前回合与 watcher 保持有效：{error}"
                )));
            }
        }
    }

    async fn apply_run_snapshot(&mut self, result: &AgentRunResult) {
        if let Some(id) = session_id(&result.session) {
            self.current_session_id = Some(id.to_string());
            self.current_session_resume_hint = false;
        }
        if let Some(pending) = self
            .pending_run
            .as_mut()
            .filter(|pending| pending.session_id == result.run.session_id)
        {
            pending.last_refresh_error = None;
        }
        self.status = format!("API {} · {}", self.client.base_url(), result.run.status);
    }

    fn apply_run_result(&mut self, result: AgentRunResult) {
        self.running_preview_active = false;
        self.current_session_id = Some(result.run.session_id.clone());
        self.current_session_resume_hint = false;
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
                    self.cards.push(CardModel::notice(
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
        match self.client.daemon_status().await {
            Ok(status) => self.cards.push(CardModel::audit_status(
                if status.ok { "ok" } else { "degraded" },
                status
                    .raw
                    .get("audit")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "Host audit status unavailable.".to_string()),
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
                self.cards.push(CardModel::notice("Agent 会话", body));
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
                    self.timeline = None;
                    self.current_work = None;
                    self.cards.push(CardModel::notice(
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
                    self.cards.push(CardModel::notice(
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
        match self.client.agent_timeline_v2(session_id).await {
            Ok(timeline) => {
                let next_cards = CardModel::from_timeline(&timeline);
                self.apply_timeline_snapshot(timeline, true);
                if next_cards.is_empty() && self.current_work.is_none() {
                    self.cards.push(CardModel::notice(
                        "Timeline",
                        "当前会话还没有可显示的共享投影内容。",
                    ));
                }
                self.current_session_id = Some(session_id.to_string());
                self.current_session_resume_hint = false;
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("读取 timeline 失败：{error}"))),
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
        self.cards.push(CardModel::notice(
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
                self.timeline = None;
                self.current_work = None;
                self.cards.clear();
                self.cards.push(CardModel::notice(
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
                self.timeline = None;
                self.current_work = None;
                self.cards.clear();
                self.show_workspace_status();
                self.refresh_current_session().await;
            }
            path => {
                self.host.workspace_path = Some(path.to_string());
                self.host.no_workspace = false;
                self.current_session_id = None;
                self.timeline = None;
                self.current_work = None;
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
            Ok(result) => self.cards.push(CardModel::notice(
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
                self.timeline = None;
                self.current_work = None;
                self.cards.push(CardModel::notice(
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
                self.timeline = None;
                self.current_work = None;
                self.cards.push(CardModel::notice(
                    "会话已归档",
                    format!("{session_id}\n可见会话：{}", result.sessions.len()),
                ));
            }
            Err(error) => self
                .cards
                .push(CardModel::error(format!("归档会话失败：{error}"))),
        }
    }

    async fn resolve_permission_alias(&mut self, permission_id: &str, decision: &str) {
        if permission_id.is_empty() {
            self.cards.push(CardModel::error(
                "用法：/allow <permission-id> 或 /deny <permission-id>",
            ));
            return;
        }
        if self.is_run_pending() {
            self.notify_running_input_held();
            return;
        }
        self.start_decision_request(
            "permission".to_string(),
            decision.to_string(),
            None,
            Some(permission_id.to_string()),
            None,
        )
        .await;
    }
}

fn new_tui_request_id(prefix: &str) -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时钟早于 Unix epoch，无法生成 caller request identity。")?;
    Ok(format!(
        "tui-{prefix}-{}-{}",
        std::process::id(),
        timestamp.as_nanos()
    ))
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
    target_id: String,
}

struct ParsedDecisionInput {
    decision: String,
    guidance: Option<String>,
}

fn host_status_matches_projection(
    result: &AgentRunResult,
    projection_status: AgentTimelineRunStatus,
) -> bool {
    matches!(
        (projection_status, result.run.status.as_str()),
        (AgentTimelineRunStatus::Succeeded, "completed")
            | (AgentTimelineRunStatus::Failed, "failed")
            | (AgentTimelineRunStatus::Cancelled, "cancelled")
    )
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

fn latest_pending_decision(timeline: Option<&AgentTimelineSnapshot>) -> Option<PendingDecision> {
    let pending = timeline?
        .interaction_projection
        .as_ref()?
        .pending
        .as_ref()?;
    match pending {
        AgentTimelinePendingInteraction::Plan(plan) => Some(PendingDecision {
            kind: "plan".to_string(),
            run_id: plan.run_id.clone(),
            target_id: plan.target_id.clone(),
        }),
        AgentTimelinePendingInteraction::Permission(permission) => {
            if permission.request.id != permission.request_id
                || permission.request.id != permission.target_id
            {
                return None;
            }
            Some(PendingDecision {
                kind: "permission".to_string(),
                run_id: permission.request.run_id.clone()?,
                target_id: permission.target_id.clone(),
            })
        }
    }
}

fn parse_pending_decision_input(line: &str, _pending: &PendingDecision) -> ParsedDecisionInput {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.is_empty()
        || lower == "1"
        || lower == "accept"
        || trimmed == "确认"
        || trimmed == "同意"
    {
        return ParsedDecisionInput {
            decision: "accept".to_string(),
            guidance: None,
        };
    }
    if matches!(
        lower.as_str(),
        "3" | "end" | "stop" | "reject" | "/reject" | "/end" | "/stop"
    ) || matches!(trimmed, "结束" | "拒绝")
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

fn parse_pending_permission_input(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    if matches!(lower.as_str(), "1" | "accept" | "allow") || matches!(trimmed, "确认" | "同意")
    {
        return Some("accept".to_string());
    }
    if matches!(
        lower.as_str(),
        "2" | "reject" | "deny" | "/reject" | "/deny"
    ) || matches!(trimmed, "拒绝")
    {
        return Some("reject".to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_client::KernelClientConfig;
    use serde_json::json;

    // Supporting development contracts only. They verify typed projection
    // consumption and never replace a real TUI/CLI/GUI user-experience check.

    fn timeline_snapshot(session_id: &str, kernel_run_id: &str) -> AgentTimelineSnapshot {
        serde_json::from_value(json!({
            "schemaVersion": "deepcode.shared-conversation-projection.v2",
            "shapeVersion": "deepcode.shared-conversation.work-segments.v1",
            "sessionId": session_id,
            "revision": 1,
            "sourceEventVersion": 1,
            "generatedAt": "2026-08-05T00:00:00.000Z",
            "turns": [],
            "eventCount": 1,
            "runProjection": {
                "runId": kernel_run_id,
                "revision": 1,
                "status": "active",
                "phase": "processing",
                "currentActivity": null,
                "wait": null,
                "languageBinding": {
                    "language": "neutral",
                    "status": "unavailable"
                }
            }
        }))
        .expect("exact native work-segments timeline")
    }

    fn test_tui_app() -> TuiApp {
        let client = HttpKernelClient::new(
            KernelClientConfig::new("http://127.0.0.1:9")
                .with_host_shell_capability(format!("dchostv2_{}", "a".repeat(64))),
        )
        .expect("valid loopback test client");
        TuiApp::new(client, Renderer::default(), TuiHostOptions::default())
    }

    fn plain_pending_decision() -> PendingDecision {
        PendingDecision {
            kind: "plan".to_string(),
            run_id: "run-generic".to_string(),
            target_id: "target-generic".to_string(),
        }
    }

    fn timeline_with_pending(pending: serde_json::Value) -> AgentTimelineSnapshot {
        let mut timeline =
            serde_json::to_value(timeline_snapshot("session-pending", "kernel-run-pending"))
                .expect("encode exact typed timeline");
        timeline["interactionProjection"] = json!({ "pending": pending });
        serde_json::from_value(timeline).expect("decode exact typed pending interaction")
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

    #[tokio::test]
    async fn new_session_waits_for_matching_initial_snapshot_before_opening_stream() {
        let mut app = test_tui_app();
        app.current_session_id = Some("session-old".to_string());
        app.timeline = Some(timeline_snapshot("session-old", "kernel-run-old"));
        app.pending_run = Some(PendingRun {
            operation: RunOperation::Ask,
            session_id: "session-new".to_string(),
            run_id: "host-run-new".to_string(),
            kernel_run_id: "kernel-run-new".to_string(),
            timeline_stream: None,
            projection_terminal_since: None,
            last_projection_activity_at: Instant::now(),
            last_watchdog_snapshot_at: Instant::now(),
            stream_reconnect_not_before: Instant::now(),
            cancel_requested: false,
            last_refresh_error: None,
        });

        assert!(!app.pending_projection_is_bound());
        app.ensure_pending_timeline_stream();
        assert!(
            app.pending_run
                .as_ref()
                .is_some_and(|pending| pending.timeline_stream.is_none()),
            "stale prior-Session projection opened a timeline stream"
        );

        app.timeline = Some(timeline_snapshot("session-new", "kernel-run-new"));
        assert!(app.pending_projection_is_bound());
        app.ensure_pending_timeline_stream();
        assert!(
            app.pending_run
                .as_ref()
                .is_some_and(|pending| pending.timeline_stream.is_some()),
            "matching initial snapshot did not open the typed timeline stream"
        );

        app.pending_run = None;
    }

    #[test]
    fn latest_pending_decision_reads_exact_typed_plan_projection() {
        let timeline = timeline_with_pending(json!({
            "kind": "plan",
            "interactionId": "interaction-plan-generic",
            "interactionRevision": "interaction-revision-plan-generic",
            "targetId": "plan-generic",
            "runId": "run-generic",
            "planId": "plan-generic"
        }));
        let pending = latest_pending_decision(Some(&timeline)).expect("pending plan");
        assert_eq!(pending.kind, "plan");
        assert_eq!(pending.run_id, "run-generic");
        assert_eq!(pending.target_id, "plan-generic");
    }

    #[test]
    fn latest_pending_decision_rejects_mismatched_permission_identity() {
        let timeline = timeline_with_pending(json!({
            "kind": "permission",
            "interactionId": "interaction-permission-generic",
            "interactionRevision": "interaction-revision-permission-generic",
            "targetId": "permission-target-generic",
            "requestId": "permission-request-generic",
            "request": {
                "id": "permission-request-generic",
                "runId": "run-generic",
                "toolName": "fs.read",
                "riskLevel": "low",
                "summary": "Read one workspace file."
            }
        }));
        assert!(latest_pending_decision(Some(&timeline)).is_none());
    }
}
