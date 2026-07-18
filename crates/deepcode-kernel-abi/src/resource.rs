use crate::{
    ExternalResourceLease, PlanGrantLease, ReviewGateDecision, RunStatus, RuntimeLifecycleState,
    TemporaryGrantEnvelope,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceKind {
    PermissionGrant,
    WorkspaceReadLease,
    ExternalResourceLease,
    TerminalSession,
    TempArtifact,
    Artifact,
    RedirectOutput,
    CacheFile,
    ProcessHandle,
    GitHandle,
    BrowserHandle,
    NetworkHandle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceOwnerKind {
    UserSession,
    AgentRun,
    KernelInternal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelResourceOwner {
    pub kind: KernelResourceOwnerKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

impl KernelResourceOwner {
    pub fn user_session(session_id: impl Into<String>) -> Self {
        Self {
            kind: KernelResourceOwnerKind::UserSession,
            session_id: Some(session_id.into()),
            run_id: None,
        }
    }

    pub fn agent_run(session_id: Option<impl Into<String>>, run_id: impl Into<String>) -> Self {
        Self {
            kind: KernelResourceOwnerKind::AgentRun,
            session_id: session_id.map(Into::into),
            run_id: Some(run_id.into()),
        }
    }

    pub fn kernel_internal(run_id: Option<impl Into<String>>) -> Self {
        Self {
            kind: KernelResourceOwnerKind::KernelInternal,
            session_id: None,
            run_id: run_id.map(Into::into),
        }
    }

    pub fn matches(&self, other: &Self) -> bool {
        self.kind == other.kind
            && optional_match(self.session_id.as_deref(), other.session_id.as_deref())
            && optional_match(self.run_id.as_deref(), other.run_id.as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceScope {
    Run,
    Session,
    Persistent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceState {
    Active,
    CleanupPending,
    CleanupFailed,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelCleanupState {
    Idle,
    Pending,
    Failed,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelCleanupScope {
    Batch,
    Plan,
    Run,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelCleanupCheckpoint {
    pub run_id: String,
    pub scope: KernelCleanupScope,
    pub trigger: String,
    pub resource_ids: Vec<String>,
    pub intended_lifecycle: RuntimeLifecycleState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intended_run_status: Option<RunStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_decision: Option<ReviewGateDecision>,
    pub attempt: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelResourceCleanupPolicy {
    OnBatchReviewReady,
    OnRunEnd,
    OnSessionEnd,
    OnRuntimeDrop,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TemporaryPermissionGrantKind {
    PlanExecution,
    RuntimePermission,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KernelResourceMetadata {
    PlanAuthorizationGrant {
        lease: PlanGrantLease,
    },
    TemporaryPermissionGrant {
        grant_kind: TemporaryPermissionGrantKind,
        grant: TemporaryGrantEnvelope,
    },
    WorkspaceReadLease {
        workspace_id: Option<String>,
        workspace_hash: Option<String>,
        open_path: String,
    },
    ExternalResourceLease {
        lease: ExternalResourceLease,
    },
    TempArtifact {
        path: String,
        absolute_path: Option<String>,
        source_tool: String,
        tool_call_id: String,
    },
    TerminalSession {
        terminal_id: String,
        cwd: String,
        shell_kind: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelResource {
    pub resource_id: String,
    pub logical_key: String,
    pub idempotency_key: String,
    pub kind: KernelResourceKind,
    pub owner: KernelResourceOwner,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub scope: KernelResourceScope,
    pub state: KernelResourceState,
    pub cleanup_policy: KernelResourceCleanupPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_at: Option<String>,
    pub metadata: KernelResourceMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelResourceIdentity {
    pub resource_id: String,
    pub logical_key: String,
    pub idempotency_key: String,
}

impl KernelResourceIdentity {
    pub fn new(
        resource_id: impl Into<String>,
        logical_key: impl Into<String>,
        idempotency_key: impl Into<String>,
    ) -> Self {
        Self {
            resource_id: resource_id.into(),
            logical_key: logical_key.into(),
            idempotency_key: idempotency_key.into(),
        }
    }
}

impl KernelResource {
    pub fn active(
        identity: KernelResourceIdentity,
        kind: KernelResourceKind,
        owner: KernelResourceOwner,
        scope: KernelResourceScope,
        cleanup_policy: KernelResourceCleanupPolicy,
        metadata: KernelResourceMetadata,
    ) -> Self {
        let session_id = owner.session_id.clone();
        let run_id = owner.run_id.clone();
        Self {
            resource_id: identity.resource_id,
            logical_key: identity.logical_key,
            idempotency_key: identity.idempotency_key,
            kind,
            owner,
            session_id,
            run_id,
            scope,
            state: KernelResourceState::Active,
            cleanup_policy,
            created_at: None,
            released_at: None,
            metadata,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelResourceReleaseResult {
    pub resource_id: String,
    pub released: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelResourceCleanupStateFact {
    pub run_id: String,
    pub scope: KernelCleanupScope,
    pub state: KernelCleanupState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_state: Option<KernelResourceState>,
    pub attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn optional_match(actual: Option<&str>, expected: Option<&str>) -> bool {
    expected
        .map(|expected| Some(expected) == actual)
        .unwrap_or(true)
}
