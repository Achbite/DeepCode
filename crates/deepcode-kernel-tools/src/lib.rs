use sha2::{Digest, Sha256};

mod admission;
mod authority_v4;
mod authorization;
mod catalog;
mod contracts;
pub mod file_content;
mod graph;
mod input_validation;
mod operation_builders;
mod operation_model;
mod registrations;
mod review;
mod runtime_adapter_v4;
mod sandbox;

pub use admission::*;
pub use authority_v4::*;
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
pub use operation_model::*;
pub use registrations::{
    KernelAdmissionMetadataV2, KernelExecutionAdapterV2, KernelToolRegistration,
};
pub use runtime_adapter_v4::*;
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
