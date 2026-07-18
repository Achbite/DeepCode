use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeLifecycleState {
    Created,
    Ready,
    Executing,
    AwaitingPermission,
    ReviewReady,
    Terminating,
    Terminal,
}

impl RuntimeLifecycleState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Ready => "ready",
            Self::Executing => "executing",
            Self::AwaitingPermission => "awaitingPermission",
            Self::ReviewReady => "reviewReady",
            Self::Terminating => "terminating",
            Self::Terminal => "terminal",
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Terminal)
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "created" => Some(Self::Created),
            "ready" => Some(Self::Ready),
            "executing" => Some(Self::Executing),
            "awaitingPermission" => Some(Self::AwaitingPermission),
            "reviewReady" => Some(Self::ReviewReady),
            "terminating" => Some(Self::Terminating),
            "terminal" => Some(Self::Terminal),
            _ => None,
        }
    }
}
