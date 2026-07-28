use deepcode_kernel_abi::{
    ArtifactOrigin, AuditEventFact, AuditQueryFilter, AuditQueryResult, CleanupFailureFact,
    CompiledToolSummary, ConfigSnapshotRef, ContractCleanupPolicy, ContractExpiry,
    DraftAdmissionPolicy, DriverRequest, DriverRequestKind, ExternalResourceKind,
    ExternalResourceLease, FileChangeFact, FileChangeKind, GeneratedArtifactFact, HostBrowseEntry,
    HostBrowseResult, HostFileTreeNodeKind, HostInspectionOutput, HostInspectionQuery,
    HostInspectionResult, HostMcpRiskDecisionRecord, HostMcpRiskDecisionSubmit, HostResultSource,
    HostSkillActivationStatus, HostSkillAdapterKind, HostSkillCatalogResult, HostSkillDescriptor,
    HostSkillEffect, HostSkillRiskLevel, HostSkillSource, HostSkillTrustDecisionRecord,
    HostSkillTrustDecisionSubmit, HostStatus, HostUnsupportedWorkspaceField,
    HostWorkspaceBindingResolved, HostWorkspaceCurrent, HostWorkspaceFolder, HostWorkspaceOpened,
    HostWorkspaceOutput, HostWorkspaceResult, HostWorkspaceRootStatus, HostWorkspaceSaved,
    HostWorkspaceSourceKind, HostWorkspaceSpec, KernelCleanupCheckpoint, KernelCleanupScope,
    KernelCleanupState, KernelCommand, KernelError, KernelErrorEnvelope, KernelEvent,
    KernelEventSummary, KernelExecutionContract, KernelFactSource, KernelPlanAuthorizationContract,
    KernelResource, KernelResourceCleanupPolicy, KernelResourceCleanupStateFact,
    KernelResourceIdentity, KernelResourceKind, KernelResourceMetadata, KernelResourceOwner,
    KernelResourceReleaseResult, KernelResourceScope, KernelResourceState, KernelResult,
    KernelSnapshot, KernelStateContract, KernelToolCatalogEntryRef, KernelToolCatalogSnapshotRef,
    KernelToolUsageConstraintsRef, PathNormalizationDiagnostic, PathNormalizationFact,
    PermissionRequestedFact, PermissionResolutionFact, PermissionResourceKind,
    PlanAuthorizationDecisionKind, PlanAuthorizationDecisionSubmit, PlanAuthorizationReview,
    PlanAuthorizationStatus, PlanGrantLease, ProfileRef, ProposalEnvelope, ProposalEnvelopeKind,
    RequestId, ResourceLifecycleFact, ResourceLifecycleKind, ResourcePacket, ResourcePacketItem,
    ResourcePacketStatus, ResourceResolveRequest, ReviewFacts, ReviewGateDecision, RunId,
    RunStatus, RuntimeLifecycleState, SessionId, TaskIntentEnvelope, TemporaryGrantEnvelope,
    TemporaryPermissionGrantKind, ToolCompletionFact, ToolEffectOutcome, ToolEffectReceipt,
    ToolExecutionAttemptFact, ToolFactEnvelope, ToolOutcomeIndeterminateFact, ToolRequestFact,
    ToolTargetKind, UserInput, WorkUnitDescriptor, WorkUnitFact, WorkUnitStatus, WorkspaceBinding,
};
use deepcode_kernel_audit::{
    AuditKeyMaterial, AuditRuntimeMode, AuditVerifier, LocalAuditSigner, SignedAuditEntryV1,
};
use deepcode_kernel_config::{
    ConfigLayer, ConfigResolver, ConfigResolverInput, ConfigScope, ConfigSource, ConfigSourceKind,
    ConfigTrustLevel, DefaultConfigResolver,
};
use deepcode_kernel_ledger::{
    ChangeOperation, ChangeSet, EventLedger, InMemoryEventLedger, LedgerEvent, NdjsonEventLedger,
    ValidationKind, ValidationResult,
};
use deepcode_kernel_policy::{PolicyProfile, WorkspaceBoundary};
use deepcode_kernel_skills::{InMemoryUserSkillRegistry, SkillDescriptor, UserSkillRegistry};
use deepcode_kernel_tools::{
    derive_plan_authorization, GitOperation, GitOperationKind, KernelExecutionContractStatus,
    KernelProposalReviewReport, KernelToolCatalogSnapshot, KernelToolRegistration,
    KernelToolRegistry, OperationCompileError, OperationCompiler, OperationExecutionMode,
    PlanAuthorizationDraft, PlanAuthorizationOperationDraft, PlanTargetMode, PlanTaskIntent,
    PlannedOperation, PlannedOperationKind, ToolChangeKind, ToolFactCategory, ToolFamily,
    ToolOperationKind, ToolPermissionMode, WorkspaceOperation, WorkspaceOperationKind,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
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
pub mod v2;
pub mod workspace;

pub(crate) use control::*;
pub(crate) use resources::resource_instance_id;
pub(crate) use state::*;
pub(crate) use tools::*;
pub(crate) use workspace::*;

pub const AGENT_PROTOCOL_VERSION: &str = "deepcode.agent.protocol.v4";
pub const TOOL_CATALOG_VERSION: &str = deepcode_kernel_tools::TOOL_REGISTRY_VERSION;
pub const KERNEL_ABI_VERSION: &str = deepcode_kernel_abi::KERNEL_ABI_VERSION;

static KERNEL_TOOL_REGISTRY: OnceLock<KernelToolRegistry> = OnceLock::new();
static KERNEL_TOOL_CATALOG: OnceLock<KernelToolCatalogSnapshot> = OnceLock::new();

fn kernel_tool_registry() -> &'static KernelToolRegistry {
    KERNEL_TOOL_REGISTRY.get_or_init(KernelToolRegistry::new)
}

pub fn kernel_visible_tool_catalog_count() -> usize {
    kernel_tool_registry().registrations().count()
}

pub fn kernel_tool_catalog_snapshot() -> KernelToolCatalogSnapshot {
    KERNEL_TOOL_CATALOG
        .get_or_init(|| kernel_tool_registry().snapshot())
        .clone()
}

pub fn kernel_tool_catalog_snapshot_ref() -> KernelToolCatalogSnapshotRef {
    let snapshot = kernel_tool_catalog_snapshot();
    KernelToolCatalogSnapshotRef {
        catalog_version: snapshot.catalog_version.to_string(),
        catalog_hash: snapshot.catalog_hash,
        tools: snapshot
            .tools
            .into_iter()
            .map(|tool| KernelToolCatalogEntryRef {
                tool_id: tool.tool_id.to_string(),
                capability: tool.capability.to_string(),
                family: tool.family,
                operation_kind: tool.operation_kind,
                provider_schema: tool.provider_schema,
                planning_schema: tool.planning_schema,
                provider_visible: tool.provider_visible,
                forbidden_fields: tool.forbidden_fields,
                risk: tool.risk,
                permission_mode: tool.permission_mode,
                permission_summary: tool.permission_summary,
                path_scope_policy: tool.path_scope_policy,
                plan_target_mode: tool.plan_target_mode,
                plan_target_source: tool.plan_target_source,
                execution_mode: tool.execution_mode,
                isolation: tool.isolation,
                hard_deny_rules: tool.hard_deny_rules,
                needs_workspace: tool.needs_workspace,
                read_only: tool.read_only,
                usage_constraints: KernelToolUsageConstraintsRef {
                    target_existence: tool.usage_constraints.target_existence,
                    source_existence: tool.usage_constraints.source_existence,
                    destination_existence: tool.usage_constraints.destination_existence,
                    target_kinds: tool.usage_constraints.target_kinds,
                    content_mode: tool.usage_constraints.content_mode,
                    directory_recursive_required: tool
                        .usage_constraints
                        .directory_recursive_required,
                },
            })
            .collect(),
    }
}

pub fn kernel_tool_catalog_hash() -> String {
    kernel_tool_catalog_snapshot().catalog_hash
}

pub struct DeepCodeKernelRuntime {
    config_resolver: DefaultConfigResolver,
    policy_profile: PolicyProfile,
    user_skill_registry: InMemoryUserSkillRegistry,
    tool_registry: &'static KernelToolRegistry,
    tool_executors: executors::KernelExecutorRegistry,
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
        let tool_registry = kernel_tool_registry();
        let tool_executors =
            executors::KernelExecutorRegistry::from_executors(executors::builtin_executors(
                tool_registry,
                executors::KernelExecutorConfig::default(),
                Arc::new(executors::EmptySecretProvider),
            ));
        Self {
            config_resolver: DefaultConfigResolver,
            policy_profile: PolicyProfile::developer_defaults(),
            user_skill_registry: InMemoryUserSkillRegistry::default(),
            tool_registry,
            tool_executors,
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
        self.tool_executors = executors::KernelExecutorRegistry::from_executors(
            executors::builtin_executors(self.tool_registry, config, secret_provider),
        );
    }
}

#[cfg(test)]
mod tests;
