use deepcode_kernel_client::{
    AgentTimelineBlock, AgentTimelineBlockKind, AgentTimelineCurrentActivityCode,
    AgentTimelineEntryRole, AgentTimelineSnapshot, AgentTimelineStatus,
    AgentTimelineStructuredProjection, AgentTimelineTurnPart, AgentTimelineWaitKind,
    AgentTimelineWorkAttentionStatus, AgentTimelineWorkOperation, AgentTimelineWorkOperationStatus,
    AgentTimelineWorkSegment, AgentTimelineWorkSegmentLifecycle,
};

#[derive(Debug, Clone)]
pub enum CardKind {
    User,
    Assistant,
    CommandHelp,
    Notice,
    Permission,
    Plan,
    Review,
    Error,
    Final,
    AuditStatus,
}

#[derive(Debug, Clone)]
pub struct CardModel {
    pub kind: CardKind,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct CurrentWorkModel {
    pub activity: Option<String>,
    pub wait: Option<String>,
    pub segments: Vec<WorkSegmentModel>,
}

#[derive(Debug, Clone)]
pub struct WorkSegmentModel {
    pub title: String,
    pub summary: String,
    pub expanded: bool,
    pub attention: Option<String>,
    pub attention_unresolved: bool,
    pub operations: Vec<WorkOperationModel>,
}

#[derive(Debug, Clone)]
pub struct WorkOperationModel {
    pub title: String,
    pub status: String,
    pub detail: Option<String>,
}

impl CardModel {
    pub fn command_help() -> Self {
        Self::new(CardKind::CommandHelp, "帮助", command_help())
    }

    pub fn user(body: impl Into<String>) -> Self {
        Self::new(CardKind::User, "你", body)
    }

    pub fn notice(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self::new(CardKind::Notice, title, body)
    }

    pub fn error(body: impl Into<String>) -> Self {
        Self::new(CardKind::Error, "错误", body)
    }

    pub fn audit_status(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self::new(CardKind::AuditStatus, title, body)
    }

    pub fn from_timeline(timeline: &AgentTimelineSnapshot) -> Vec<Self> {
        let mut cards = Vec::new();
        for turn in &timeline.turns {
            for part in &turn.parts {
                if let AgentTimelineTurnPart::Block { block_id } = part {
                    if let Some(block) = turn.blocks.iter().find(|block| &block.id == block_id) {
                        if let Some(card) = Self::from_timeline_block(block) {
                            cards.push(card);
                        }
                    }
                }
            }
        }
        cards
    }

    fn from_timeline_block(block: &AgentTimelineBlock) -> Option<Self> {
        let body = block_body(block);
        let card_kind = match block.entry_role {
            AgentTimelineEntryRole::UserMessage => CardKind::User,
            AgentTimelineEntryRole::AgentUpdate => CardKind::Assistant,
            AgentTimelineEntryRole::FinalAnswer => CardKind::Final,
            AgentTimelineEntryRole::Diagnostic => CardKind::Error,
            AgentTimelineEntryRole::Interaction => match block.kind {
                AgentTimelineBlockKind::Permission => CardKind::Permission,
                AgentTimelineBlockKind::Plan => CardKind::Plan,
                AgentTimelineBlockKind::Review => CardKind::Review,
                AgentTimelineBlockKind::Error => CardKind::Error,
                _ => return None,
            },
        };
        let title = match card_kind {
            CardKind::User => "你".to_string(),
            CardKind::Assistant | CardKind::Final => "DeepCode".to_string(),
            _ => {
                let title = if block.title.trim().is_empty() {
                    timeline_kind_title(block.kind)
                } else {
                    block.title.as_str()
                };
                format!("{title} · {}", timeline_status_label(block.status))
            }
        };
        Some(Self::new(card_kind, title, body))
    }

    fn new(kind: CardKind, title: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            kind,
            title: title.into(),
            body: body.into(),
        }
    }
}

impl CurrentWorkModel {
    pub fn from_timeline(timeline: &AgentTimelineSnapshot) -> Option<Self> {
        let run = timeline.run_projection.as_ref();
        let turn = run
            .and_then(|run| run.turn_id.as_deref())
            .and_then(|turn_id| timeline.turns.iter().find(|turn| turn.id == turn_id));

        let activity = run
            .and_then(|run| run.current_activity.0.as_ref())
            .map(|activity| {
                activity
                    .summary
                    .as_deref()
                    .filter(|summary| !summary.trim().is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| current_activity_label(activity.code).to_string())
            });
        let wait = run.and_then(|run| run.wait.0.as_ref()).map(|wait| {
            let label = wait_kind_label(wait.kind);
            wait.reason
                .as_deref()
                .filter(|reason| !reason.trim().is_empty())
                .map(|reason| format!("{label}：{reason}"))
                .unwrap_or_else(|| label.to_string())
        });

        let mut segments = Vec::new();
        if let Some(turn) = turn {
            for part in &turn.parts {
                let AgentTimelineTurnPart::WorkSegment { work_segment_id } = part else {
                    continue;
                };
                if let Some(segment) = turn
                    .work_segments
                    .iter()
                    .find(|segment| &segment.id == work_segment_id)
                {
                    segments.push(WorkSegmentModel::from_segment(segment));
                }
            }
        }

        (activity.is_some() || wait.is_some() || !segments.is_empty()).then_some(Self {
            activity,
            wait,
            segments,
        })
    }
}

impl WorkSegmentModel {
    fn from_segment(segment: &AgentTimelineWorkSegment) -> Self {
        let attention = segment.attention.0.as_ref().map(|attention| {
            let state = match attention.status {
                AgentTimelineWorkAttentionStatus::Unresolved => "需要处理",
                AgentTimelineWorkAttentionStatus::Resolved => "已处理",
            };
            format!("{state}：{}", attention.summary)
        });
        let unresolved_attention = segment.attention.0.as_ref().is_some_and(|attention| {
            attention.status == AgentTimelineWorkAttentionStatus::Unresolved
        });
        let expanded =
            segment.lifecycle == AgentTimelineWorkSegmentLifecycle::Active || unresolved_attention;
        let operations = if expanded {
            segment
                .operations
                .iter()
                .map(WorkOperationModel::from_operation)
                .collect()
        } else {
            Vec::new()
        };
        Self {
            title: format!("工作 · {}", work_segment_lifecycle_label(segment.lifecycle)),
            summary: folded_operation_summary(&segment.operations),
            expanded,
            attention,
            attention_unresolved: unresolved_attention,
            operations,
        }
    }
}

impl WorkOperationModel {
    fn from_operation(operation: &AgentTimelineWorkOperation) -> Self {
        let mut details = Vec::new();
        if let Some(action) = operation
            .canonical_action
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            details.push(action.to_string());
        }
        if let Some(targets) = operation
            .targets
            .as_ref()
            .filter(|targets| !targets.is_empty())
        {
            details.push(targets.join(", "));
        }
        if let Some(effect) = operation
            .effect_summary
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            details.push(effect.to_string());
        }
        if let Some(attempts) = operation
            .attempts
            .as_ref()
            .filter(|attempts| !attempts.is_empty())
        {
            details.push(format!("attempts {}", attempts.len()));
        }
        Self {
            title: operation
                .display_name
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&operation.tool_id)
                .to_string(),
            status: work_operation_status_label(operation.status).to_string(),
            detail: (!details.is_empty()).then(|| details.join(" · ")),
        }
    }
}

fn block_body(block: &AgentTimelineBlock) -> String {
    block
        .body_markdown
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            block
                .localized_content
                .as_ref()
                .and_then(|content| content.text.as_deref())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            block
                .structured_projection
                .as_ref()
                .and_then(structured_projection_text)
        })
        .unwrap_or_else(|| block.summary.clone())
}

fn structured_projection_text(readable: &AgentTimelineStructuredProjection) -> Option<String> {
    let rendered = render_readable_projection(readable);
    (!rendered.trim().is_empty()).then_some(rendered)
}

fn render_readable_projection(readable: &AgentTimelineStructuredProjection) -> String {
    let mut lines = Vec::new();
    if let Some(summary) = readable.summary.as_deref() {
        lines.push(summary.to_string());
    } else if let Some(summary_key) = readable.summary_key.as_deref() {
        lines.push(summary_key.to_string());
    }
    for section in &readable.sections {
        lines.push(format!("## {}", section.title_key));
        if section.items.is_empty() {
            if let Some(empty) = section.empty_message_key.as_deref() {
                lines.push(format!("- {empty}"));
            }
        }
        for item in &section.items {
            let text = item
                .text
                .as_deref()
                .or(item.message_key.as_deref())
                .unwrap_or("");
            if !text.is_empty() {
                lines.push(format!("- {text}"));
            }
        }
    }
    lines.join("\n")
}

fn folded_operation_summary(operations: &[AgentTimelineWorkOperation]) -> String {
    if operations.is_empty() {
        return "暂无工具操作".to_string();
    }
    let completed = operations
        .iter()
        .filter(|operation| operation.status == AgentTimelineWorkOperationStatus::Completed)
        .count();
    let active = operations
        .iter()
        .filter(|operation| {
            matches!(
                operation.status,
                AgentTimelineWorkOperationStatus::Preparing
                    | AgentTimelineWorkOperationStatus::Queued
                    | AgentTimelineWorkOperationStatus::Running
            )
        })
        .count();
    let attention = operations.len().saturating_sub(completed + active);
    let mut labels = Vec::new();
    if completed > 0 {
        labels.push(format!("完成 {completed}"));
    }
    if active > 0 {
        labels.push(format!("进行中 {active}"));
    }
    if attention > 0 {
        labels.push(format!("需关注 {attention}"));
    }
    labels.join(" / ")
}

fn current_activity_label(code: AgentTimelineCurrentActivityCode) -> &'static str {
    match code {
        AgentTimelineCurrentActivityCode::SessionAdmitting => "正在接收请求",
        AgentTimelineCurrentActivityCode::ProviderAwaitingFirstByte => "正在等待模型响应",
        AgentTimelineCurrentActivityCode::ProviderReasoning => "正在思考",
        AgentTimelineCurrentActivityCode::ProviderComposing => "正在组织回复",
        AgentTimelineCurrentActivityCode::ResourceResolving => "正在解析资源",
        AgentTimelineCurrentActivityCode::KernelExecuting => "正在执行工具",
        AgentTimelineCurrentActivityCode::SessionValidating => "正在校验结果",
        AgentTimelineCurrentActivityCode::SessionPersisting => "正在保存会话",
        AgentTimelineCurrentActivityCode::RetryBackoff => "等待重试",
    }
}

fn wait_kind_label(kind: AgentTimelineWaitKind) -> &'static str {
    match kind {
        AgentTimelineWaitKind::User => "等待用户决定",
        AgentTimelineWaitKind::External => "等待外部结果",
        AgentTimelineWaitKind::Paused => "已暂停",
    }
}

fn work_segment_lifecycle_label(lifecycle: AgentTimelineWorkSegmentLifecycle) -> &'static str {
    match lifecycle {
        AgentTimelineWorkSegmentLifecycle::Active => "进行中",
        AgentTimelineWorkSegmentLifecycle::Completed => "已完成",
        AgentTimelineWorkSegmentLifecycle::Cancelled => "已取消",
        AgentTimelineWorkSegmentLifecycle::Failed => "失败",
    }
}

fn work_operation_status_label(status: AgentTimelineWorkOperationStatus) -> &'static str {
    match status {
        AgentTimelineWorkOperationStatus::Preparing => "准备中",
        AgentTimelineWorkOperationStatus::Queued => "排队中",
        AgentTimelineWorkOperationStatus::Running => "运行中",
        AgentTimelineWorkOperationStatus::AwaitingCapability => "等待授权",
        AgentTimelineWorkOperationStatus::Completed => "已完成",
        AgentTimelineWorkOperationStatus::Denied => "已拒绝",
        AgentTimelineWorkOperationStatus::Failed => "失败",
        AgentTimelineWorkOperationStatus::FailedAfterObservedEffect => "生效后失败",
        AgentTimelineWorkOperationStatus::Indeterminate => "结果不确定",
        AgentTimelineWorkOperationStatus::Cancelled => "已取消",
        AgentTimelineWorkOperationStatus::Stale => "已失效",
        AgentTimelineWorkOperationStatus::Unexecuted => "未执行",
    }
}

pub fn command_help() -> &'static str {
    "核心命令：\n\
/help                 显示命令列表\n\
/status               检查 Kernel daemon 连接\n\
/workspace            显示当前 workspace 绑定\n\
/workspace <path>     绑定 workspace\n\
/workspace cwd        绑定当前目录\n\
/workspace clear      清除 workspace，普通对话仍可用\n\
/cancel               停止当前 TUI 等待并刷新共享 session 投影\n\
/clear                清理当前可见卡片\n\
/quit                 退出 TUI\n\
\n\
会话命令：\n\
/sessions             列出当前 workspace scope 的 Agent 会话\n\
/new [title]          新建 Agent 会话\n\
/use <id>             激活会话并读取 timeline\n\
/timeline [id]        读取当前或指定会话 timeline\n\
/rename <id> <title>  重命名会话\n\
/delete <id>          删除会话\n\
/archive <id>         归档会话\n\
\n\
权限和决策：\n\
/allow <id>           允许权限请求\n\
/deny <id>            拒绝权限请求\n\
/decision <requirement|plan|review> <accept|reject|revise> [run-id] [target-id] [guidance]\n\
/decision permission <accept|reject> [run-id] [target-id]\n\
/audit                显示审计占位状态\n\
\n\
pending 计划/Review 时，空 Enter 或 1 表示确认；输入文本或 2 <文本> 表示提交 Review 信息；3、end、结束表示结束。\n\
permission accept/reject 与 /allow、/deny 别名都通过共享 Session Runtime 的 canonical decision run；不会回退旧 permission endpoint。\n\
这些命令对应 GUI composer decision / Stop 的终端输入形式；会话事实仍来自共享 daemon Session Runtime projection。\n\
\n\
普通文本会通过共享 daemon Session Runtime 发送；TUI 只负责展示、输入和权限确认，不持有 workflow、permission 或 tool execution 事实。"
}

fn timeline_kind_title(kind: AgentTimelineBlockKind) -> &'static str {
    match kind {
        AgentTimelineBlockKind::User => "你",
        AgentTimelineBlockKind::Assistant => "DeepCode",
        AgentTimelineBlockKind::Permission => "权限",
        AgentTimelineBlockKind::Plan => "计划",
        AgentTimelineBlockKind::Review => "审查",
        AgentTimelineBlockKind::Error => "错误",
    }
}

fn timeline_status_label(status: AgentTimelineStatus) -> &'static str {
    match status {
        AgentTimelineStatus::Queued => "排队中",
        AgentTimelineStatus::Running => "运行中",
        AgentTimelineStatus::Waiting | AgentTimelineStatus::Blocked => "等待确认",
        AgentTimelineStatus::Completed => "完成",
        AgentTimelineStatus::Cancelled => "已取消",
        AgentTimelineStatus::Failed => "失败",
    }
}
