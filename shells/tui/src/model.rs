use serde_json::Value;

#[derive(Debug, Clone)]
pub enum CardKind {
    User,
    Assistant,
    CommandHelp,
    Stage,
    Tool,
    Permission,
    Plan,
    Review,
    Error,
    BridgeError,
    Final,
    AuditStatus,
}

#[derive(Debug, Clone)]
pub struct CardModel {
    pub kind: CardKind,
    pub title: String,
    pub body: String,
}

impl CardModel {
    pub fn command_help() -> Self {
        Self::new(CardKind::CommandHelp, "帮助", command_help())
    }

    pub fn user(body: impl Into<String>) -> Self {
        Self::new(CardKind::User, "你", body)
    }

    pub fn stage(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self::new(CardKind::Stage, title, body)
    }

    pub fn error(body: impl Into<String>) -> Self {
        Self::new(CardKind::Error, "错误", body)
    }

    pub fn audit_status(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self::new(CardKind::AuditStatus, title, body)
    }

    pub fn from_timeline(timeline: &Value) -> Vec<Self> {
        let is_v2 = timeline.get("schemaVersion").and_then(Value::as_str)
            == Some("deepcode.shared-conversation-projection.v2");
        let turns = timeline
            .get("turns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut cards = Vec::new();
        for turn in turns {
            let blocks = turn
                .get("blocks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for block in blocks {
                if let Some(card) = Self::from_timeline_block(&block, is_v2) {
                    cards.push(card);
                }
            }
        }
        cards
    }

    fn from_timeline_block(block: &Value, is_v2: bool) -> Option<Self> {
        let kind = block.get_str("kind").unwrap_or("stage");
        let narrative_kind = block.get_str("narrativeKind").unwrap_or(kind);
        let entry_role = block.get_str("entryRole");
        if narrative_kind == "thinking"
            || kind == "thinking"
            || (is_v2
                && entry_role == Some("finalAnswer")
                && block.get_str("durability") != Some("committed"))
        {
            return None;
        }
        let status = block.get_str("status").unwrap_or("completed");
        let title = block
            .get_str("title")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| timeline_kind_title(narrative_kind));
        let summary = block.get_str("summary").unwrap_or("");
        let body = block
            .get_str("bodyMarkdown")
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                block
                    .pointer("/localizedContent/text")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string)
            })
            .or_else(|| structured_projection_text(block))
            .unwrap_or_else(|| summary.to_string());
        let card_kind = match entry_role {
            Some("userMessage") => CardKind::User,
            Some("finalAnswer") => CardKind::Final,
            Some("agentUpdate") => CardKind::Assistant,
            Some("activityGroup" | "evidence") => CardKind::Tool,
            Some("diagnostic") => CardKind::Error,
            Some("interaction") => match narrative_kind {
                "permission" => CardKind::Permission,
                "plan" => CardKind::Plan,
                "review" => CardKind::Review,
                _ => CardKind::Stage,
            },
            _ => match narrative_kind {
                "user" => CardKind::User,
                "assistant" | "assistantText" => CardKind::Final,
                "assistantNarration" => CardKind::Assistant,
                "toolBatch" | "operationEvidence" | "verification" => CardKind::Tool,
                "permission" => CardKind::Permission,
                "plan" => CardKind::Plan,
                "review" => CardKind::Review,
                "error" => CardKind::Error,
                "bridgeError" => CardKind::BridgeError,
                _ => match kind {
                    "user" => CardKind::User,
                    "assistant" => CardKind::Final,
                    "toolBatch" => CardKind::Tool,
                    "permission" => CardKind::Permission,
                    "plan" => CardKind::Plan,
                    "review" => CardKind::Review,
                    "error" => CardKind::Error,
                    "bridgeError" => CardKind::BridgeError,
                    _ => CardKind::Stage,
                },
            },
        };
        Some(Self::new(
            card_kind,
            format!("{title} · {}", status_label(status)),
            body,
        ))
    }

    fn new(kind: CardKind, title: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            kind,
            title: title.into(),
            body: body.into(),
        }
    }
}

fn structured_projection_text(block: &Value) -> Option<String> {
    let readable = block.get("structuredProjection")?;
    let rendered = render_readable_projection(readable);
    (!rendered.trim().is_empty()).then_some(rendered)
}

fn render_readable_projection(readable: &Value) -> String {
    let mut lines = Vec::new();
    if let Some(summary) = readable.get("summary").and_then(Value::as_str) {
        lines.push(summary.to_string());
    } else if let Some(summary_key) = readable.get("summaryKey").and_then(Value::as_str) {
        lines.push(summary_key.to_string());
    }
    if let Some(sections) = readable.get("sections").and_then(Value::as_array) {
        for section in sections {
            if let Some(title) = section
                .get("titleKey")
                .or_else(|| section.get("title"))
                .and_then(Value::as_str)
            {
                lines.push(format!("## {title}"));
            }
            let items = section
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if items.is_empty() {
                if let Some(empty) = section.get("emptyMessageKey").and_then(Value::as_str) {
                    lines.push(format!("- {empty}"));
                }
            }
            for item in items {
                let text = item
                    .get("text")
                    .or_else(|| item.get("messageKey"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !text.is_empty() {
                    lines.push(format!("- {text}"));
                }
            }
        }
    }
    lines.join("\n")
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

fn timeline_kind_title(kind: &str) -> &'static str {
    match kind {
        "user" => "你",
        "assistant" => "DeepCode",
        "assistantText" => "DeepCode",
        "assistantNarration" => "DeepCode",
        "thinking" => "思考",
        "stage" => "阶段",
        "toolBatch" => "工具",
        "operationEvidence" => "工具证据",
        "verification" => "验证",
        "permission" => "权限",
        "plan" => "计划",
        "review" => "审查",
        "error" => "错误",
        "turnActions" => "操作",
        _ => "事件",
    }
}

fn status_label(status: &str) -> &'static str {
    match status {
        "queued" => "排队中",
        "running" => "运行中",
        "blocked" | "waiting" => "等待确认",
        "cancelled" => "已取消",
        "failed" => "失败",
        "completed" | "done" => "完成",
        "pending" => "等待中",
        _ => "未知",
    }
}

pub trait ValueExt {
    fn get_str(&self, key: &str) -> Option<&str>;
}

impl ValueExt for Value {
    fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }
}
