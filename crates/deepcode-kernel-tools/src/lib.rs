use sha2::{Digest, Sha256};

mod catalog;
pub mod file_content;
mod invocation_adapter;
mod invocation_types;
mod registrations;

pub use catalog::{CanonicalToolInvocationV2, KernelToolRegistry, KernelToolRegistryErrorV2};
pub use deepcode_kernel_abi::{
    ToolAvailabilityV2, ToolContextBundleV2, ToolContextRefV2, ToolContextVersionV2,
    ToolDescriptorV2, ToolIdV2, ToolInventoryV2,
};

/// Kernel-private, cross-crate adapter types.
///
/// Agent-facing callers use `ToolIdV2` plus raw JSON arguments through
/// `KernelToolRegistry`; this module exists only because the Rust runtime and
/// executor crates need a typed boundary after canonicalization.
#[doc(hidden)]
pub mod kernel_internal {
    pub use crate::invocation_adapter::{
        canonicalize_invocation, normalize_canonical_platform_path, normalize_workspace_path,
        validate_canonical_invocation, InvocationNormalizationError,
    };
    pub use crate::invocation_types::{
        kernel_tool_output_digest, measure_kernel_output_payload, KernelCanonicalInvocation,
        KernelDeleteTarget, KernelDocumentPages, KernelEditMatcher, KernelFileDigestPrecondition,
        KernelGitDiffScope, KernelLineRange, KernelNetworkPublicTarget, KernelOutputTruncation,
        KernelPathEntry, KernelPathEntrySize, KernelSearchMatch, KernelSearchStrategy,
        KernelTextMediaType, KernelToolKind, KernelToolOutput, KernelToolOutputPayload,
        KernelWebSearchItem, KernelWorkspaceObjectKind, MAX_CANONICAL_INVOCATION_BYTES,
    };
    pub use crate::registrations::{
        KernelAdmissionMetadata, KernelExecutionAdapter, KernelExecutorBinding,
    };
}

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
