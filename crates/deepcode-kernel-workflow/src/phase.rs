use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowPhase {
    Plan,
    Check,
    Complete,
    AwaitingApproval,
    Review,
    Done,
    Aborted,
}

impl WorkflowPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Check => "check",
            Self::Complete => "complete",
            Self::AwaitingApproval => "awaitingApproval",
            Self::Review => "review",
            Self::Done => "done",
            Self::Aborted => "aborted",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Aborted)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowRunStatus {
    Running,
    Waiting,
    Succeeded,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplanReason {
    InvalidPlan,
    MissingContext,
    ToolError,
    TestFailed,
    PlanMismatch,
    ScopeChanged,
    UnsafeOperation,
    PermissionRequired,
    UserRejectedPermission,
    InsufficientEvidence,
    BudgetExceeded,
}

impl ReplanReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::InvalidPlan => "invalid_plan",
            Self::MissingContext => "missing_context",
            Self::ToolError => "tool_error",
            Self::TestFailed => "test_failed",
            Self::PlanMismatch => "plan_mismatch",
            Self::ScopeChanged => "scope_changed",
            Self::UnsafeOperation => "unsafe_operation",
            Self::PermissionRequired => "permission_required",
            Self::UserRejectedPermission => "user_rejected_permission",
            Self::InsufficientEvidence => "insufficient_evidence",
            Self::BudgetExceeded => "budget_exceeded",
        }
    }

    pub(crate) fn returns_to_plan(&self) -> bool {
        matches!(
            self,
            Self::InvalidPlan
                | Self::MissingContext
                | Self::ToolError
                | Self::TestFailed
                | Self::PlanMismatch
                | Self::ScopeChanged
                | Self::UserRejectedPermission
                | Self::InsufficientEvidence
        )
    }

    pub(crate) fn enters_review(&self) -> bool {
        matches!(self, Self::UnsafeOperation)
    }
}
