use crate::invocation_types::{
    KernelCanonicalInvocation, KernelDeleteTarget, KernelGitDiffScope, KernelToolKind,
};
use deepcode_kernel_abi::v2::{PlatformV2, V2ValidationError};
use serde_json::{json, Value};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Error)]
pub enum InvocationNormalizationError {
    #[error("arguments for `{tool_id}` do not match the canonical input descriptor")]
    InvalidArguments { tool_id: &'static str },
    #[error("canonical invocation for `{tool_id}` contains an implicit or non-normalized value")]
    NotCanonical { tool_id: &'static str },
    #[error(transparent)]
    Validation(#[from] V2ValidationError),
}

fn invalid_arguments(tool_id: &'static str) -> InvocationNormalizationError {
    InvocationNormalizationError::InvalidArguments { tool_id }
}

pub fn canonicalize_invocation(
    tool_id: KernelToolKind,
    mut arguments: Value,
) -> Result<KernelCanonicalInvocation, InvocationNormalizationError> {
    use KernelToolKind as Tool;
    let fields = arguments
        .as_object_mut()
        .ok_or_else(|| invalid_arguments(tool_id.as_str()))?;
    let mut materialize = |name: &str, value: Value| {
        fields.entry(name.to_owned()).or_insert(value);
    };
    match tool_id {
        Tool::FsRead => materialize("range", json!({"kind":"whole","data":{}})),
        Tool::FsList => {
            materialize("depth", json!(2));
            materialize("includeHidden", json!(false));
        }
        Tool::FsGlob => {
            materialize("root", json!("."));
            materialize("maxResults", json!(500));
        }
        Tool::CodeGrep => {
            materialize("root", json!("."));
            materialize("include", json!([]));
            materialize("exclude", json!([]));
            materialize("strategy", json!("literal"));
            materialize("contextLines", json!(0));
            materialize("maxResults", json!(200));
        }
        Tool::FsCreate => materialize("executable", json!(false)),
        Tool::DocumentRead => materialize("pages", json!({"kind":"all","data":{}})),
        Tool::GitDiff => {
            materialize("scope", json!({"kind":"repository","data":{}}));
            materialize("staged", json!(false));
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
    match &mut invocation {
        KernelCanonicalInvocation::FsRead { path, .. }
        | KernelCanonicalInvocation::FsDiff { path, .. }
        | KernelCanonicalInvocation::FsCreate { path, .. }
        | KernelCanonicalInvocation::FsWrite { path, .. }
        | KernelCanonicalInvocation::FsEdit { path, .. }
        | KernelCanonicalInvocation::FsEnsureDirectory { path }
        | KernelCanonicalInvocation::DocumentRead { path, .. } => {
            *path = normalize_workspace_path(path, false)?;
        }
        KernelCanonicalInvocation::FsList { path, .. } => {
            *path = normalize_workspace_path(path, true)?;
        }
        KernelCanonicalInvocation::FsGlob { root, .. } => {
            *root = normalize_workspace_path(root, true)?;
        }
        KernelCanonicalInvocation::CodeGrep {
            root,
            include,
            exclude,
            ..
        } => {
            *root = normalize_workspace_path(root, true)?;
            *include = normalize_string_set(std::mem::take(include))?;
            *exclude = normalize_string_set(std::mem::take(exclude))?;
        }
        KernelCanonicalInvocation::FsRename {
            source_path,
            destination_path,
        } => {
            *source_path = normalize_workspace_path(source_path, false)?;
            *destination_path = normalize_workspace_path(destination_path, false)?;
        }
        KernelCanonicalInvocation::FsDelete(target) => {
            let path = match target {
                KernelDeleteTarget::File { path } | KernelDeleteTarget::DirectoryTree { path } => {
                    path
                }
            };
            *path = normalize_workspace_path(path, false)?;
        }
        KernelCanonicalInvocation::GitDiff {
            scope: KernelGitDiffScope::Paths { paths },
            ..
        } => {
            *paths = normalize_path_set(std::mem::take(paths))?;
        }
        KernelCanonicalInvocation::GitStage { paths }
        | KernelCanonicalInvocation::GitUnstage { paths } => {
            *paths = normalize_path_set(std::mem::take(paths))?;
        }
        _ => {}
    }
    invocation.validate()?;
    Ok(invocation)
}

pub fn validate_canonical_invocation(
    invocation: &KernelCanonicalInvocation,
) -> Result<(), InvocationNormalizationError> {
    invocation.validate()?;
    let encoded = serde_json::to_value(invocation)
        .map_err(|_| invalid_arguments(invocation.tool_id().as_str()))?;
    let arguments = encoded
        .as_object()
        .and_then(|value| value.get("arguments"))
        .cloned()
        .ok_or_else(|| invalid_arguments(invocation.tool_id().as_str()))?;
    let normalized = canonicalize_invocation(invocation.tool_id(), arguments)?;
    if normalized != *invocation {
        return Err(InvocationNormalizationError::NotCanonical {
            tool_id: invocation.tool_id().as_str(),
        });
    }
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
            parts.push(part.nfc().collect::<String>());
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
/// resolver; this helper only materializes separators and NFC.
pub fn normalize_canonical_platform_path(
    platform: PlatformV2,
    value: &str,
) -> Result<String, InvocationNormalizationError> {
    if value.is_empty() || value.contains('\0') {
        return Err(invalid_arguments("canonical-platform-path"));
    }
    let materialized = match platform {
        PlatformV2::Windows => value.replace('\\', "/"),
        PlatformV2::Macos | PlatformV2::Linux => value.to_owned(),
    };
    let prefix_len = match platform {
        PlatformV2::Macos | PlatformV2::Linux if materialized.starts_with('/') => 1,
        PlatformV2::Windows
            if materialized.as_bytes().get(1) == Some(&b':')
                && materialized.as_bytes().get(2) == Some(&b'/')
                && materialized
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphabetic) =>
        {
            3
        }
        PlatformV2::Windows if materialized.starts_with("//") => 2,
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
        components.push(component.nfc().collect::<String>());
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

fn normalize_path_set(paths: Vec<String>) -> Result<Vec<String>, InvocationNormalizationError> {
    if paths.is_empty() || paths.len() > 256 {
        return Err(invalid_arguments("workspace-path-list"));
    }
    let mut normalized = paths
        .iter()
        .map(|path| normalize_workspace_path(path, false))
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn normalize_string_set(
    mut values: Vec<String>,
) -> Result<Vec<String>, InvocationNormalizationError> {
    if values.len() > 256
        || values
            .iter()
            .any(|value| value.trim().is_empty() || value.contains('\0'))
    {
        return Err(invalid_arguments("string-list"));
    }
    values.sort();
    values.dedup();
    Ok(values)
}
