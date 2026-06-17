use serde_json::Value;

#[derive(Debug, Clone)]
pub enum CardKind {
    User,
    Assistant,
    Thinking,
    CommandHelp,
    Stage,
    Tool,
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

impl CardModel {
    pub fn command_help() -> Self {
        Self::new(CardKind::CommandHelp, "帮助", command_help())
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
        let turns = timeline
            .get("turns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut cards = Vec::new();
        for turn in turns {
            let status = turn.get_str("status").unwrap_or("unknown");
            if !matches!(status, "completed" | "done") {
                cards.push(Self::new(
                    CardKind::Stage,
                    "回合状态",
                    format!("timeline turn status: {status}"),
                ));
            }
            let blocks = turn
                .get("blocks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for block in blocks {
                cards.push(Self::from_timeline_block(&block));
            }
        }
        cards
    }

    fn from_timeline_block(block: &Value) -> Self {
        let kind = block.get_str("kind").unwrap_or("stage");
        let narrative_kind = block.get_str("narrativeKind").unwrap_or(kind);
        let status = block.get_str("status").unwrap_or("completed");
        let title = block
            .get_str("title")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| timeline_kind_title(narrative_kind));
        let summary = block.get_str("summary").unwrap_or("");
        let body = block
            .get_str("bodyMarkdown")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(summary);
        let card_kind = match narrative_kind {
            "user" => CardKind::User,
            "assistant" | "assistantText" => CardKind::Final,
            "assistantNarration" => CardKind::Assistant,
            "thinking" => CardKind::Thinking,
            "toolBatch" | "operationEvidence" | "verification" => CardKind::Tool,
            "permission" => CardKind::Permission,
            "plan" => CardKind::Plan,
            "review" => CardKind::Review,
            "error" => CardKind::Error,
            _ => match kind {
                "user" => CardKind::User,
                "assistant" => CardKind::Final,
                "toolBatch" => CardKind::Tool,
                "permission" => CardKind::Permission,
                "plan" => CardKind::Plan,
                "review" => CardKind::Review,
                "error" => CardKind::Error,
                _ => CardKind::Stage,
            },
        };
        Self::new(
            card_kind,
            format!("{title} · {}", status_label(status)),
            body,
        )
    }

    fn new(kind: CardKind, title: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            kind,
            title: title.into(),
            body: body.into(),
        }
    }
}

pub fn command_help() -> &'static str {
    "可用命令：\n\
/help          显示命令列表\n\
/status        检查 Kernel daemon 连接\n\
/sessions      列出 Agent 会话\n\
/new [title]   新建 Agent 会话\n\
/use <id>      激活会话并读取 timeline\n\
/timeline [id] 读取当前或指定会话 timeline\n\
/rename <id> <title>  重命名会话\n\
/delete <id>   删除会话\n\
/archive <id>  归档会话\n\
/allow <id>    允许权限请求\n\
/deny <id>     拒绝权限请求\n\
/decision <requirement|plan|review> <accept|reject|revise> [run-id] [target-id] [guidance]\n\
/audit         显示审计占位状态\n\
/clear         清理当前可见卡片\n\
/quit          退出 TUI\n\
\n\
普通文本会通过共享 SessionDriverLoop 发送；TUI 只负责展示、输入和权限确认，不持有 workflow、permission 或 tool execution 事实。"
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
        "running" => "运行中",
        "blocked" => "等待确认",
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
