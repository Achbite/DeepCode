use crate::invocation_types::{KernelCanonicalInvocation, KernelDeleteTarget, KernelToolKind};
use crate::types::{Platform, ToolValidationError};
use serde_json::{json, Map, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum InvocationNormalizationError {
    #[error("arguments for `{tool_id}` do not match the canonical input descriptor")]
    InvalidArguments { tool_id: &'static str },
    #[error("canonical invocation for `{tool_id}` contains an implicit or non-normalized value")]
    NotCanonical { tool_id: &'static str },
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
    use KernelToolKind as Tool;
    let mut arguments = adapt_public_arguments(tool_id, arguments)?;
    let fields = arguments
        .as_object_mut()
        .ok_or_else(|| invalid_arguments(tool_id.as_str()))?;
    let mut materialize = |name: &str, value: Value| {
        fields.entry(name.to_owned()).or_insert(value);
    };
    match tool_id {
        Tool::FsRead => {
            materialize("startLine", json!(1));
            materialize("maxLines", json!(2_000));
            materialize("maxBytes", json!(262_144));
        }
        Tool::ProcessShell => {
            materialize("timeout", json!(120));
            materialize("workspaceMode", json!("read"));
            materialize("executionScope", json!("workspace"));
        }
        Tool::WebSearch => materialize("limit", json!(5)),
        Tool::WebFetch => materialize("maxBytes", json!(98_304)),
        _ => {}
    }
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

pub fn validate_canonical_invocation(
    invocation: &KernelCanonicalInvocation,
) -> Result<(), InvocationNormalizationError> {
    let mut normalized = invocation.clone();
    normalize_invocation(&mut normalized)?;
    if normalized != *invocation {
        return Err(InvocationNormalizationError::NotCanonical {
            tool_id: invocation.tool_id().as_str(),
        });
    }
    Ok(())
}

fn adapt_public_arguments(
    tool_id: KernelToolKind,
    mut arguments: Value,
) -> Result<Value, InvocationNormalizationError> {
    use KernelToolKind as Tool;
    if tool_id == Tool::FsDelete {
        return canonicalize_delete_arguments(&arguments);
    }
    let fields = arguments
        .as_object_mut()
        .ok_or_else(|| invalid_arguments(tool_id.as_str()))?;
    match tool_id {
        Tool::FsRead => {
            ensure_allowed_fields(
                fields,
                &["path", "startLine", "startByte", "maxLines", "maxBytes"],
                tool_id,
            )?;
        }
        Tool::FsWrite => {
            ensure_allowed_fields(fields, &["path", "content", "executable"], tool_id)?;
        }
        Tool::FsEdit => {
            ensure_allowed_fields(fields, &["path", "edits"], tool_id)?;
        }
        Tool::ProcessShell => {
            ensure_allowed_fields(
                fields,
                &[
                    "command",
                    "workspaceMode",
                    "executionScope",
                    "timeout",
                    "terminal",
                ],
                tool_id,
            )?;
        }
        Tool::WebSearch => {
            ensure_allowed_fields(fields, &["query", "limit"], tool_id)?;
        }
        Tool::WebFetch => {
            ensure_allowed_fields(fields, &["url", "maxBytes"], tool_id)?;
        }
        Tool::FsDelete => unreachable!("fs.delete is canonicalized before field adaptation"),
    }
    Ok(arguments)
}

fn ensure_allowed_fields(
    fields: &Map<String, Value>,
    allowed: &[&str],
    tool_id: KernelToolKind,
) -> Result<(), InvocationNormalizationError> {
    if fields
        .keys()
        .any(|field| !allowed.contains(&field.as_str()))
    {
        return Err(invalid_arguments(tool_id.as_str()));
    }
    Ok(())
}

fn canonicalize_delete_arguments(arguments: &Value) -> Result<Value, InvocationNormalizationError> {
    let tool_id = KernelToolKind::FsDelete.as_str();
    let fields = arguments
        .as_object()
        .ok_or_else(|| invalid_arguments(tool_id))?;
    let path = fields
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_arguments(tool_id))?;
    let target_kind = fields
        .get("targetKind")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_arguments(tool_id))?;
    match target_kind {
        "file" if fields.len() == 2 => Ok(json!({"kind":"file","data":{"path":path}})),
        "directoryTree" if fields.len() == 2 => {
            Ok(json!({"kind":"directoryTree","data":{"path":path}}))
        }
        _ => Err(invalid_arguments(tool_id)),
    }
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

/// Normalizes a resolver-produced absolute path for Kernel-private digesting.
///
/// The caller must first obtain the value from the platform filesystem
/// resolver; this helper only materializes separators and preserves filename spelling.
pub fn normalize_canonical_platform_path(
    platform: Platform,
    value: &str,
) -> Result<String, InvocationNormalizationError> {
    if value.is_empty() || value.contains('\0') {
        return Err(invalid_arguments("canonical-platform-path"));
    }
    let materialized = match platform {
        Platform::Windows => value.replace('\\', "/"),
        Platform::Macos | Platform::Linux => value.to_owned(),
    };
    let prefix_len = match platform {
        Platform::Macos | Platform::Linux if materialized.starts_with('/') => 1,
        Platform::Windows
            if materialized.as_bytes().get(1) == Some(&b':')
                && materialized.as_bytes().get(2) == Some(&b'/')
                && materialized
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphabetic) =>
        {
            3
        }
        Platform::Windows if materialized.starts_with("//") => 2,
        _ => return Err(invalid_arguments("canonical-platform-path")),
    };
    let mut components = Vec::new();
    for component in materialized[prefix_len..].split('/') {
        if component.is_empty() {
            continue;
        }
        if component == "." || component == ".." {
            return Err(invalid_arguments("canonical-platform-path"));
        }
        components.push(component.to_owned());
    }
    let prefix = &materialized[..prefix_len];
    let normalized = if components.is_empty() {
        prefix.to_owned()
    } else if prefix.ends_with('/') {
        format!("{prefix}{}", components.join("/"))
    } else {
        format!("{prefix}/{}", components.join("/"))
    };
    Ok(normalized)
}
