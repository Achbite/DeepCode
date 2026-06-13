use deepcode_kernel_abi::{
    ConfigSnapshotRef, DriverRequest, DriverRequestKind, HostStatus, KernelCommand, KernelError,
    KernelErrorEnvelope, KernelEvent, KernelEventSummary, KernelResult, KernelSnapshot,
    KernelStateContract, ProfileRef, ProposalEnvelope, ProposalEnvelopeKind, RequestId,
    ResourceResolveRequest, RunId, SessionId, StageStatus, UserDecisionSubmit, UserInput,
    WorkflowDecision, WorkflowDecisionAction, WorkflowRef, WorkspaceBinding,
};
use deepcode_kernel_audit::{
    AuditActor, AuditBody, AuditCategory, AuditChain, AuditKeyMaterial, AuditRuntimeMode,
    AuditVerifier, LocalAuditSigner, SignedAuditEntryV1,
};
use deepcode_kernel_config::{
    ConfigLayer, ConfigResolver, ConfigResolverInput, ConfigScope, ConfigSource, ConfigSourceKind,
    ConfigTrustLevel, DefaultConfigResolver,
};
use deepcode_kernel_context::{ContextCandidatePayload, ContextRuntime};
use deepcode_kernel_ledger::{
    ChangeOperation, ChangeSet, EventLedger, InMemoryEventLedger, KernelResource,
    KernelResourceCleanupPolicy, KernelResourceKind, KernelResourceOwner, KernelResourceScope,
    LedgerEvent, NdjsonEventLedger, ReviewGate, ReviewGateStatus, ValidationKind, ValidationResult,
};
use deepcode_kernel_policy::{AutonomyLevel, PolicyDecisionKind, PolicyProfile, WorkspaceBoundary};
use deepcode_kernel_prompt::LayeredPromptCompiler;
use deepcode_kernel_skills::{
    builtin::builtin_executors, model_visible_skill_descriptors, InMemorySkillRegistry,
    SkillExecutionContext, SkillExecutorRegistry, SkillInvocation, SkillRegistry, SkillRuntime,
    SkillTrustMode, SkillTrustRecord,
};
use deepcode_kernel_workflow::{
    ActionBundleDraft, BuiltinWorkflowMachine, CompletionCriteria, DefaultPlanReviewEngine,
    PlanContract, PlanReviewEngine, PlanReviewInput, PlanReviewReport, PlanReviewStatus,
    RunDecisionState, WorkflowMachine, WorkflowPhase,
};
use serde_json::Value;
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod context;
pub mod dispatch;
pub mod llm;
pub mod obligations;
pub mod permissions;
pub mod state;
pub mod temp_artifacts;
pub mod tools;
pub mod workflow;
pub mod workspace;

pub(crate) use llm::*;
pub(crate) use state::*;
pub(crate) use temp_artifacts::*;
pub(crate) use tools::*;
pub(crate) use workflow::*;
pub(crate) use workspace::*;

pub struct DeepCodeKernelRuntime {
    config_resolver: DefaultConfigResolver,
    prompt_compiler: LayeredPromptCompiler,
    workflow: BuiltinWorkflowMachine,
    policy_profile: PolicyProfile,
    skills: InMemorySkillRegistry,
    tool_executors: SkillExecutorRegistry,
    ledger: Box<dyn EventLedger>,
    context_runtime: ContextRuntime,
    state: RuntimeState,
}

impl Default for DeepCodeKernelRuntime {
    fn default() -> Self {
        Self::with_ledger(Box::new(InMemoryEventLedger::new()))
    }
}

impl DeepCodeKernelRuntime {
    pub fn with_ledger(ledger: Box<dyn EventLedger>) -> Self {
        let mut state = RuntimeState::default();
        state.next_run_index = ledger
            .list_all()
            .unwrap_or_default()
            .iter()
            .filter_map(|event| event.run_id.as_deref())
            .filter_map(run_index_from_id)
            .max()
            .unwrap_or(0);
        Self {
            config_resolver: DefaultConfigResolver,
            prompt_compiler: LayeredPromptCompiler::default(),
            workflow: BuiltinWorkflowMachine::default(),
            policy_profile: PolicyProfile::developer_defaults(),
            skills: InMemorySkillRegistry::with_builtin_tools(),
            tool_executors: SkillExecutorRegistry::from_executors(builtin_executors()),
            ledger,
            context_runtime: ContextRuntime::new(),
            state,
        }
    }

    pub fn with_ndjson_ledger(path: impl Into<PathBuf>) -> Self {
        Self::with_ledger(Box::new(NdjsonEventLedger::new(path)))
    }

    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
mod tests;
