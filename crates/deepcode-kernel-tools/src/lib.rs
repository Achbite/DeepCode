use sha2::{Digest, Sha256};

mod admission;
mod authorization;
mod catalog;
mod contracts;
pub mod file_content;
mod graph;
mod input_validation;
mod invocation_adapter;
mod invocation_types;
mod operation_builders;
mod operation_model;
mod registrations;
mod review;
mod sandbox;

pub use admission::*;
pub use authorization::*;
pub use catalog::*;
pub use contracts::*;
pub use deepcode_kernel_abi::{
    CleanupContract, CleanupFailurePolicy, CleanupLeasePolicy, ContractCleanupPolicy,
    ContractExpiry, FileTargetRef, FileTargetRefKind, IsolationContract, IsolationFallbackPolicy,
    IsolationLevel, KernelExecutionContract, KernelExecutionContractStatus,
    KernelExecutionOperation, KernelGateIntervention, KernelGateInterventionKind,
    KernelGateInterventionStatus, KernelPermissionBundle, KernelProposalReviewReport,
    OperationExecutionMode, PathScopePolicy, PermissionResourceKind, PlanTargetMode,
    PlanTargetSource, SandboxSupportState, TargetExistence, ToolChangeKind, ToolContentMode,
    ToolFactCategory, ToolFactKind, ToolFamily, ToolOperationKind, ToolOutputTrust,
    ToolPermissionMode, ToolRiskLevel, ToolTargetKind, ToolValidationKind,
};
pub use graph::*;
pub use input_validation::ToolInputValidationError;
pub use invocation_adapter::{
    canonicalize_invocation, normalize_canonical_platform_path, normalize_workspace_path,
    validate_canonical_invocation, InvocationNormalizationError,
};
pub use invocation_types::{
    output_payload_measure_v4, tool_output_digest_v4, AuthorityToolIdV4, DeleteTargetV4,
    DocumentPagesV4, EditMatcherV4, FileDigestPreconditionV4, GitDiffScopeV4, LineRangeV4,
    NetworkPublicTargetV4, OutputTruncationV4, PathEntrySizeV4, PathEntryV4, SearchMatchV4,
    SearchStrategyV4, TextMediaTypeV4, ToolInvocationInputV4, ToolOutputPayloadV4, ToolOutputV4,
    WebSearchItemV4, WorkspaceObjectKindV4, MAX_CANONICAL_INVOCATION_BYTES,
};
pub use operation_model::*;
pub use registrations::{
    KernelAdmissionMetadataV2, KernelExecutionAdapterV2, KernelInvocationCanonicalizer,
    KernelToolRegistration,
};
pub use sandbox::{
    CandidateSandboxSpec, SandboxCapabilitySnapshot, SealedSandboxPlan,
    SANDBOX_CAPABILITY_SCHEMA_VERSION, SANDBOX_SPEC_SCHEMA_VERSION,
};

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2 + 7);
    output.push_str("sha256:");
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[cfg(test)]
mod tests;
