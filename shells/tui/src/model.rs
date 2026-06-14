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
    pub fn user(body: impl Into<String>) -> Self {
        Self::new(CardKind::User, "你", body)
    }

    pub fn command_help() -> Self {
        Self::new(CardKind::CommandHelp, "帮助", command_help())
    }

    pub fn stage(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self::new(CardKind::Stage, title, body)
    }

    pub fn error(body: impl Into<String>) -> Self {
        Self::new(CardKind::Error, "错误", body)
    }

    pub fn final_answer(body: impl Into<String>) -> Self {
        Self::new(CardKind::Final, "最终回答", body)
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
                if block.get_str("kind") == Some("user") {
                    continue;
                }
                cards.push(Self::from_timeline_block(&block));
            }
        }
        cards
    }

    fn from_timeline_block(block: &Value) -> Self {
        let kind = block.get_str("kind").unwrap_or("stage");
        let status = block.get_str("status").unwrap_or("completed");
        let title = block
            .get_str("title")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| timeline_kind_title(kind));
        let summary = block.get_str("summary").unwrap_or("");
        let body = block
            .get_str("bodyMarkdown")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(summary);
        let card_kind = match kind {
            "assistant" => CardKind::Final,
            "thinking" => CardKind::Thinking,
            "toolBatch" => CardKind::Tool,
            "permission" => CardKind::Permission,
            "plan" => CardKind::Plan,
            "review" => CardKind::Review,
            "error" => CardKind::Error,
            _ => CardKind::Stage,
        };
        Self::new(
            card_kind,
            format!("{title} · {}", status_label(status)),
            body,
        )
    }

    pub fn from_event(event: &Value) -> Self {
        let kind = event.get_str("kind").unwrap_or("event");
        let body = event
            .get_path_str(&["payload", "content"])
            .or_else(|| event.get_path_str(&["payload", "message"]))
            .or_else(|| event.get_path_str(&["payload", "text"]))
            .unwrap_or("");
        if kind.contains("permission") {
            Self::new(CardKind::Permission, kind, body)
        } else if kind.contains("tool") {
            Self::new(CardKind::Tool, kind, body)
        } else if kind.contains("stage") || kind.contains("workflow") {
            Self::new(CardKind::Stage, kind, body)
        } else if kind.contains("error") {
            Self::new(CardKind::Error, kind, body)
        } else if kind.contains("final") {
            Self::new(CardKind::Final, kind, body)
        } else {
            Self::new(CardKind::Assistant, kind, body)
        }
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
/audit         显示审计占位状态\n\
/clear         清理当前可见卡片\n\
/quit          退出 TUI\n\
\n\
边界：TUI 只负责展示和输入，不暴露旧会话发送入口；会话输入后续通过同一 SessionDriverLoop / Kernel 边界重接。"
}

fn timeline_kind_title(kind: &str) -> &'static str {
    match kind {
        "assistant" => "DeepCode",
        "thinking" => "思考",
        "stage" => "阶段",
        "toolBatch" => "工具",
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
    fn get_path_str(&self, path: &[&str]) -> Option<&str>;
}

impl ValueExt for Value {
    fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    fn get_path_str(&self, path: &[&str]) -> Option<&str> {
        let mut current = self;
        for key in path {
            current = current.get(*key)?;
        }
        current.as_str()
    }
}
