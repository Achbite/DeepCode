use deepcode_kernel_abi::{
    AuditEventFact, AuditQueryFilter, AuditQueryResult, ConfigSnapshotRef, DraftAdmissionPolicy,
    DriverRequest, DriverRequestKind, ExternalResourceKind, ExternalResourceLease,
    HostInspectionQuery, HostInspectionResult, HostStatus, KernelCommand, KernelError,
    KernelErrorEnvelope, KernelEvent, KernelEventSummary, KernelPlanAuthorizationContract,
    KernelResult, KernelSnapshot, KernelStateContract, PlanAuthorizationDecisionKind,
    PlanAuthorizationDecisionSubmit, PlanAuthorizationReview, PlanAuthorizationStatus,
    PlanGrantLease, ProfileRef, ProposalEnvelope, ProposalEnvelopeKind, RequestId,
    ResourceResolveRequest, ReviewFacts, RunId, RunStatus, RuntimeLifecycleState, SessionId,
    TaskIntentEnvelope, TemporaryGrantEnvelope, ToolFactEnvelope, UserDecisionSubmit, UserInput,
    WorkUnitFact, WorkspaceBinding,
};
use deepcode_kernel_audit::{
    AuditKeyMaterial, AuditRuntimeMode, AuditVerifier, LocalAuditSigner, SignedAuditEntryV1,
};
use deepcode_kernel_config::{
    ConfigLayer, ConfigResolver, ConfigResolverInput, ConfigScope, ConfigSource, ConfigSourceKind,
    ConfigTrustLevel, DefaultConfigResolver,
};
use deepcode_kernel_ledger::{
    ChangeOperation, ChangeSet, EventLedger, InMemoryEventLedger, KernelResource,
    KernelResourceCleanupPolicy, KernelResourceIdentity, KernelResourceKind, KernelResourceOwner,
    KernelResourceScope, LedgerEvent, NdjsonEventLedger, ValidationKind, ValidationResult,
};
use deepcode_kernel_policy::{PolicyDecisionKind, PolicyProfile, WorkspaceBoundary};
use deepcode_kernel_skills::{
    model_visible_skill_descriptors, InMemorySkillRegistry, SkillExecutionContext,
    SkillExecutorRegistry, SkillInvocation, SkillRegistry, SkillTrustMode, SkillTrustRecord,
};
use deepcode_kernel_tools::{
    derive_plan_authorization, GitOperation, GitOperationKind, KernelToolCatalogSnapshot,
    KernelToolRegistry, OperationCompileError, OperationCompiler, OperationExecutionMode,
    PlanAuthorizationDraft, PlanAuthorizationOperationDraft, PlanTargetMode, PlanTaskIntent,
    PlannedOperation, PlannedOperationKind, ProposalReviewReportV3, ToolFactCategory, ToolFamily,
    ToolPermissionMode, WorkspaceOperation, WorkspaceOperationKind,
};
use serde_json::Value;
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub mod action_batch;
pub mod control;
pub mod dispatch;
pub mod executors;
mod network_policy;
pub mod obligations;
pub mod permissions;
pub mod resources;
pub mod scheduler;
pub mod state;
pub mod tools;
pub mod workspace;

pub(crate) use control::*;
pub(crate) use resources::resource_instance_id;
pub(crate) use state::*;
pub(crate) use tools::*;
pub(crate) use workspace::*;

pub const AGENT_PROTOCOL_VERSION: &str = "deepcode.agent.protocol.v4";
pub const TOOL_CATALOG_VERSION: &str = deepcode_kernel_tools::TOOL_REGISTRY_VERSION;

pub fn kernel_visible_tool_catalog_count() -> usize {
    KernelToolRegistry::default().all().count()
}

pub fn kernel_tool_catalog_snapshot() -> KernelToolCatalogSnapshot {
    KernelToolRegistry::default().snapshot()
}

pub fn kernel_tool_catalog_hash() -> String {
    kernel_tool_catalog_snapshot().catalog_hash
}

pub struct DeepCodeKernelRuntime {
    config_resolver: DefaultConfigResolver,
    policy_profile: PolicyProfile,
    skills: InMemorySkillRegistry,
    tool_executors: SkillExecutorRegistry,
    tool_runtime_config: executors::KernelExecutorConfig,
    ledger: Box<dyn EventLedger>,
    state: RuntimeState,
}

impl Default for DeepCodeKernelRuntime {
    fn default() -> Self {
        Self::with_ledger(Box::new(InMemoryEventLedger::new()))
    }
}

impl DeepCodeKernelRuntime {
    pub fn with_ledger(ledger: Box<dyn EventLedger>) -> Self {
        let next_run_index = ledger
            .list_all()
            .unwrap_or_default()
            .iter()
            .filter_map(|event| event.run_id.as_deref())
            .filter_map(run_index_from_id)
            .max()
            .unwrap_or(0);
        let state = RuntimeState {
            next_run_index,
            ..RuntimeState::default()
        };
        Self {
            config_resolver: DefaultConfigResolver,
            policy_profile: PolicyProfile::developer_defaults(),
            skills: InMemorySkillRegistry::default(),
            tool_executors: SkillExecutorRegistry::from_executors(executors::builtin_executors(
                executors::KernelExecutorConfig::default(),
                Arc::new(executors::EmptySecretProvider),
            )),
            tool_runtime_config: executors::KernelExecutorConfig::default(),
            ledger,
            state,
        }
    }

    pub fn with_ndjson_ledger(path: impl Into<PathBuf>) -> Self {
        Self::with_ledger(Box::new(NdjsonEventLedger::new(path)))
    }

    pub fn new() -> Self {
        Self::default()
    }

    pub fn configure_tool_runtime(
        &mut self,
        config: executors::KernelExecutorConfig,
        secret_provider: Arc<dyn executors::SecretProvider>,
    ) {
        self.tool_runtime_config = config.clone();
        self.tool_executors = SkillExecutorRegistry::from_executors(executors::builtin_executors(
            config,
            secret_provider,
        ));
    }
}

#[cfg(test)]
mod tests;
