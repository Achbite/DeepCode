use serde_json::Value;

#[derive(Debug, Clone)]
pub enum CardKind {
    User,
    Assistant,
    CommandHelp,
    Stage,
    Tool,
    Permission,
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
        Self::new(CardKind::User, "user", body)
    }

    pub fn assistant(body: impl Into<String>) -> Self {
        Self::new(CardKind::Assistant, "assistant", body)
    }

    pub fn command_help() -> Self {
        Self::new(CardKind::CommandHelp, "commands", command_help())
    }

    pub fn stage(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self::new(CardKind::Stage, title, body)
    }

    pub fn error(body: impl Into<String>) -> Self {
        Self::new(CardKind::Error, "error", body)
    }

    pub fn final_answer(body: impl Into<String>) -> Self {
        Self::new(CardKind::Final, "final", body)
    }

    pub fn audit_status(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self::new(CardKind::AuditStatus, title, body)
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

pub fn command_summary() -> &'static str {
    "Welcome to DeepCode TUI Host Shell MVP.\n\
This terminal layout follows the Claude/pi/claw style: status header, conversation cards, command guide, and input footer.\n\
Type /help to list commands, /status to check daemon, /ask <prompt> to run one prompt, or /quit to exit."
}

pub fn command_help() -> &'static str {
    "Available commands:\n\
/help          Show this command list\n\
/status        Check Kernel daemon connection and base URL\n\
/ask <prompt>  Send one prompt through KernelClient\n\
/audit         Show audit verify status placeholder\n\
/clear         Clear the visible card buffer\n\
/quit          Exit the TUI\n\
\n\
Plain text without a slash is treated like /ask <prompt>.\n\
\n\
Current limitations:\n\
- Stage 10.0 is a Host Shell MVP, not the full stage 17 TUI product.\n\
- KernelClient still wraps daemon HTTP compatibility routes.\n\
- Full Slash Command popup, file picker, focus navigation, and history stay in stage 17."
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
