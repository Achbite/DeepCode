use crate::invocation_types::{KernelCanonicalInvocation, KernelDeleteTarget, KernelToolKind};
use crate::types::ToolValidationError;
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum InvocationNormalizationError {
    #[error("arguments for `{tool_id}` do not match the canonical input descriptor")]
    InvalidArguments { tool_id: &'static str },
    #[error(transparent)]
    Validation(#[from] ToolValidationError),
}

fn invalid_arguments(tool_id: &'static str) -> InvocationNormalizationError {
    InvocationNormalizationError::InvalidArguments { tool_id }
}

pub fn canonicalize_invocation(
    tool_id: KernelToolKind,
    arguments: Value,
) -> Result<KernelCanonicalInvocation, InvocationNormalizationError> {
    let mut invocation = serde_json::from_value::<KernelCanonicalInvocation>(json!({
        "toolId":tool_id,
        "arguments":arguments,
    }))
    .map_err(|_| invalid_arguments(tool_id.as_str()))?;
    normalize_invocation(&mut invocation)?;
    Ok(invocation)
}

fn normalize_invocation(
    invocation: &mut KernelCanonicalInvocation,
) -> Result<(), InvocationNormalizationError> {
    match invocation {
        KernelCanonicalInvocation::FsRead { path, .. }
        | KernelCanonicalInvocation::FsWrite { path, .. }
        | KernelCanonicalInvocation::FsEdit { path, .. } => {
            *path = normalize_workspace_path(path, false)?;
        }
        KernelCanonicalInvocation::FsDelete(target) => {
            let path = match target {
                KernelDeleteTarget::File { path } | KernelDeleteTarget::DirectoryTree { path } => {
                    path
                }
            };
            *path = normalize_workspace_path(path, false)?;
        }
        _ => {}
    }
    invocation.validate()?;
    Ok(())
}

pub fn normalize_workspace_path(
    value: &str,
    allow_dot: bool,
) -> Result<String, InvocationNormalizationError> {
    if value.trim().is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || value.starts_with('/')
        || value.as_bytes().get(1) == Some(&b':')
    {
        return Err(invalid_arguments("workspace-path"));
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        if part.is_empty() || part == ".." {
            return Err(invalid_arguments("workspace-path"));
        }
        if part != "." {
            parts.push(part.to_owned());
        }
    }
    let normalized = if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    };
    if normalized == "." && !allow_dot {
        return Err(invalid_arguments("workspace-path"));
    }
    Ok(normalized)
}
