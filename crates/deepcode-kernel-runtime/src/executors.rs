use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_tools::file_content::read_text_file_for_llm;
use deepcode_kernel_tools::kernel_internal::KernelExecutorBinding;
use deepcode_kernel_tools::KernelToolRegistry;
use deepcode_kernel_tools::ToolAvailability;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Default)]
pub struct KernelExecutorConfig {
    pub web_search_endpoint_template: String,
    pub web_search_auth_header_name: String,
    pub web_search_auth_secret_ref: String,
    pub cloud_web_search: Option<CloudWebSearchConfig>,
}

/// Frozen, secret-free search transport selected when preparing a run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWebSearchConfig {
    pub provider: CloudWebSearchProvider,
    pub endpoint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloudWebSearchProvider {
    DeepSeek,
    Glm,
    Kimi,
}

pub trait SecretProvider: Send + Sync {
    fn resolve(&self, secret_ref: &str) -> Option<String>;
}

#[derive(Debug, Default)]
pub struct EmptySecretProvider;

impl SecretProvider for EmptySecretProvider {
    fn resolve(&self, _secret_ref: &str) -> Option<String> {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolInvocation {
    pub id: String,
    pub tool_id: String,
    pub input: Value,
}

#[derive(Debug, Clone, Default)]
pub struct KernelCancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl KernelCancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, AtomicOrdering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(AtomicOrdering::Acquire)
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceWriteTarget {
    pub path: PathBuf,
    pub directory: bool,
}

#[derive(Debug, Clone)]
pub struct KernelToolExecutionContext {
    /// Kernel-owned per-attempt archive. Retained output belongs to the Session.
    pub output_directory: Option<PathBuf>,
    pub workspace_root: Option<String>,
    pub workspace_id: Option<String>,
    pub private_resolved_targets: Vec<String>,
    /// None is an explicit unrestricted workspace-write grant; Some limits writes to Plan paths.
    pub workspace_write_targets: Option<Vec<WorkspaceWriteTarget>>,
    pub cancellation: KernelCancellationToken,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelToolExecutionOutcome {
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolExecutionFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolExecutionResult {
    pub invocation_id: String,
    pub outcome: KernelToolExecutionOutcome,
    pub output: Value,
    pub error: Option<KernelToolExecutionFailure>,
}

pub trait KernelToolExecutor: Send + Sync {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult>;
}

#[derive(Default)]
pub struct KernelExecutorRegistry {
    executors: BTreeMap<&'static str, Box<dyn KernelToolExecutor>>,
}

impl KernelExecutorRegistry {
    pub fn from_executors(executors: Vec<(&'static str, Box<dyn KernelToolExecutor>)>) -> Self {
        let mut registry = Self::default();
        for (tool_id, executor) in executors {
            assert!(
                registry.executors.insert(tool_id, executor).is_none(),
                "duplicate executor binding for canonical tool {tool_id}"
            );
        }
        registry
    }

    pub fn invoke(
        &self,
        tool_id: &str,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        if invocation.tool_id != tool_id {
            return Err(KernelError::InvalidCommand(format!(
                "executor lookup for {tool_id} does not match invocation tool {}",
                invocation.tool_id
            )));
        }
        let executor = self.executors.get(tool_id).ok_or_else(|| {
            KernelError::PermissionDenied(format!(
                "Kernel tool {tool_id} has no executable binding"
            ))
        })?;
        if context.cancellation.is_cancelled() {
            return Err(KernelError::Structured {
                code: "tool_execution_cancelled",
                stage: "execution",
                message: format!("Kernel tool {tool_id} was cancelled before execution"),
                details: serde_json::json!({ "toolId": tool_id }),
            });
        }
        executor.invoke(invocation, context)
    }

    pub fn tool_ids(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.executors.keys().copied()
    }
}

pub fn builtin_executors(
    registry: &KernelToolRegistry,
    config: KernelExecutorConfig,
    secret_provider: Arc<dyn SecretProvider>,
) -> Vec<(&'static str, Box<dyn KernelToolExecutor>)> {
    let executors = registry
        .executor_bindings()
        .map(|(tool_id, binding)| {
            (
                tool_id,
                executor_for_binding(binding, config.clone(), Arc::clone(&secret_provider)),
            )
        })
        .collect::<Vec<_>>();
    assert_executor_bindings_match_tool_registry(registry, &executors);
    executors
}

pub fn web_search_availability(config: &KernelExecutorConfig) -> ToolAvailability {
    web::web_search_availability(config)
}

pub fn resolved_network_target(
    tool_id: &str,
    input: &Value,
    config: &KernelExecutorConfig,
) -> KernelResult<Option<String>> {
    match tool_id {
        "web.search" => {
            let query = get_string(input, "query").unwrap_or_default();
            let limit = input
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(5)
                .clamp(1, 10);
            let target = web::web_search_target_url(config, &query, limit)?;
            web::validate_http_url(&target)?;
            Ok(Some(target))
        }
        "web.fetch" => {
            let target = get_string(input, "url").unwrap_or_default();
            web::validate_http_url(&target)?;
            Ok(Some(target))
        }
        _ => Ok(None),
    }
}

fn executor_for_binding(
    binding: KernelExecutorBinding,
    config: KernelExecutorConfig,
    secret_provider: Arc<dyn SecretProvider>,
) -> Box<dyn KernelToolExecutor> {
    match binding {
        KernelExecutorBinding::FsRead => Box::new(FsReadExecutor),
        KernelExecutorBinding::FsWrite => Box::new(FsWriteExecutor),
        KernelExecutorBinding::FsEdit => Box::new(FsEditExecutor),
        KernelExecutorBinding::FsDelete => Box::new(FsDeleteExecutor),
        KernelExecutorBinding::WebSearch => Box::new(WebSearchExecutor {
            config,
            secret_provider,
        }),
        KernelExecutorBinding::WebFetch => Box::new(WebFetchExecutor),
        KernelExecutorBinding::ProcessShell => Box::new(ProcessShellExecutor),
    }
}

fn assert_executor_bindings_match_tool_registry(
    registry: &KernelToolRegistry,
    executors: &[(&'static str, Box<dyn KernelToolExecutor>)],
) {
    let binding_ids = executors
        .iter()
        .map(|(tool_id, _)| *tool_id)
        .collect::<Vec<_>>();
    for descriptor in registry.descriptors() {
        let binding_count = binding_ids
            .iter()
            .filter(|tool_id| **tool_id == descriptor.name)
            .count();
        match descriptor.availability {
            ToolAvailability::Callable => assert_eq!(
                binding_count, 1,
                "callable Kernel tool {} must have exactly one executor binding",
                descriptor.name
            ),
            ToolAvailability::Blocked => assert_eq!(
                binding_count, 0,
                "blocked Kernel tool {} must not have an executor binding",
                descriptor.name
            ),
        }
    }
    for tool_id in binding_ids {
        assert!(
            registry.descriptor(tool_id).is_some(),
            "runtime executor {tool_id} has no canonical ToolRegistration"
        );
    }
}

#[path = "executors/file_changes.rs"]
mod file_changes;
#[path = "executors/fs.rs"]
mod filesystem;
mod process;
pub(crate) mod web;

use filesystem::*;
use process::*;
use web::*;

fn ok(invocation_id: String, output: Value) -> KernelToolExecutionResult {
    let mut affected_resources = ["path", "absolutePath", "from", "to", "destinationPath"]
        .into_iter()
        .filter_map(|field| {
            output
                .get(field)
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    affected_resources.sort();
    affected_resources.dedup();
    let _ = affected_resources;
    KernelToolExecutionResult {
        invocation_id,
        outcome: KernelToolExecutionOutcome::Completed,
        output,
        error: None,
    }
}

fn known_failure(
    invocation_id: String,
    output: Value,
    code: &str,
    message: impl Into<String>,
) -> KernelToolExecutionResult {
    KernelToolExecutionResult {
        invocation_id,
        outcome: KernelToolExecutionOutcome::Failed,
        output,
        error: Some(KernelToolExecutionFailure {
            code: code.to_string(),
            message: message.into(),
        }),
    }
}

#[derive(Debug)]
struct TextEditRange {
    start: usize,
    end: usize,
    new_text: String,
}

#[derive(Debug)]
struct AppliedTextEdits {
    updated: String,
    changed_ranges: Value,
}

fn apply_exact_text_edits(original: &str, edits: &Value) -> KernelResult<AppliedTextEdits> {
    let edits = edits.as_array().ok_or_else(|| {
        KernelError::InvalidCommand("fs.edit requires a non-empty edits array".to_string())
    })?;
    if edits.is_empty() || edits.len() > 128 {
        return Err(KernelError::InvalidCommand(
            "fs.edit requires between 1 and 128 edits".to_string(),
        ));
    }

    let mut ranges = Vec::with_capacity(edits.len());
    for (edit_index, edit) in edits.iter().enumerate() {
        let old_text = required_string(edit, "oldText")?;
        let new_text = get_string_allow_empty(edit, "newText").ok_or_else(|| {
            KernelError::InvalidCommand("fs.edit edit.newText is required".to_string())
        })?;
        let (start, end) = unique_match_range(original, &old_text, edit_index)?;
        ranges.push(TextEditRange {
            start,
            end,
            new_text,
        });
    }
    ranges.sort_by_key(|range| range.start);
    if ranges.windows(2).any(|pair| pair[0].end > pair[1].start) {
        return Err(KernelError::Structured {
            code: "edit_ranges_overlap",
            stage: "execution",
            message: "fs.edit replacement ranges must not overlap".to_string(),
            details: serde_json::json!({ "classification": "overlapping_edits" }),
        });
    }

    let changed_ranges = Value::Array(
        ranges
            .iter()
            .map(|range| byte_range_json(range.start, range.end, range.new_text.len()))
            .collect(),
    );
    let mut updated = original.to_string();
    for range in ranges.iter().rev() {
        updated.replace_range(range.start..range.end, &range.new_text);
    }
    Ok(AppliedTextEdits {
        updated,
        changed_ranges,
    })
}

fn unique_match_range(
    haystack: &str,
    needle: &str,
    edit_index: usize,
) -> KernelResult<(usize, usize)> {
    if needle.is_empty() {
        return Err(KernelError::Structured {
            code: "patch_match_empty",
            stage: "execution",
            message: format!("fs.edit edits[{edit_index}] oldText must not be empty"),
            details: serde_json::json!({
                "classification": "invalid_patch_match",
                "editIndex": edit_index,
            }),
        });
    }
    let needle_lines = needle.lines().count();
    let mut matches = haystack.match_indices(needle);
    let Some((start, _)) = matches.next() else {
        return Err(KernelError::Structured {
            code: "patch_match_not_found",
            stage: "execution",
            message: format!(
                "fs.edit edits[{edit_index}] oldText was not found in the target file ({} bytes, {} lines)",
                needle.len(),
                needle_lines,
            ),
            details: serde_json::json!({
                "classification": "stale_or_mismatched_evidence",
                "editIndex": edit_index,
                "oldTextBytes": needle.len(),
                "oldTextLines": needle_lines,
            }),
        });
    };
    if matches.next().is_some() {
        return Err(KernelError::Structured {
            code: "patch_match_ambiguous",
            stage: "execution",
            message: format!(
                "fs.edit edits[{edit_index}] oldText matches the target file more than once; expected exactly one match"
            ),
            details: serde_json::json!({
                "classification": "ambiguous_patch_match",
                "editIndex": edit_index,
            }),
        });
    }
    Ok((start, start + needle.len()))
}

fn byte_range_json(start: usize, end: usize, replacement_bytes: usize) -> Value {
    serde_json::json!({
        "startByte": start,
        "endByte": end,
        "replacementBytes": replacement_bytes
    })
}

fn atomic_write_text(target: &Path, content: &str) -> KernelResult<()> {
    let parent = target.parent().ok_or_else(|| {
        KernelError::InvalidCommand("patch target has no parent directory".to_string())
    })?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let file_name = target
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("patch-target");
    let temp_path = parent.join(format!(".{file_name}.deepcode-patch-{stamp}.tmp"));
    let mut cleanup = TemporaryPathGuard::new(temp_path.clone());
    let original_permissions = fs::metadata(target)
        .map_err(|error| KernelError::Other(format!("inspect target permissions: {error}")))?
        .permissions();
    fs::write(&temp_path, content)
        .map_err(|error| KernelError::Other(format!("write patch temp: {error}")))?;
    fs::set_permissions(&temp_path, original_permissions)
        .map_err(|error| KernelError::Other(format!("preserve target permissions: {error}")))?;
    fs::rename(&temp_path, target)
        .map_err(|error| KernelError::Other(format!("commit patch: {error}")))?;
    cleanup.disarm();
    Ok(())
}

fn atomic_create_text(target: &Path, content: &str, executable: bool) -> KernelResult<()> {
    if executable && !cfg!(unix) {
        return Err(KernelError::Structured {
            code: "unsupported_file_attribute",
            stage: "tool.execute",
            message: "fs.write executable=true is not supported on native Windows".to_string(),
            details: serde_json::json!({
                "toolId": "fs.write",
                "attribute": "executable",
                "platform": std::env::consts::OS,
            }),
        });
    }
    let parent = target.parent().ok_or_else(|| {
        KernelError::InvalidCommand("fs.write target has no parent directory".to_string())
    })?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let file_name = target
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("write-target");
    let temp_path = parent.join(format!(".{file_name}.deepcode-write-{stamp}.tmp"));
    let mut cleanup = TemporaryPathGuard::new(temp_path.clone());
    fs::write(&temp_path, content)
        .map_err(|error| KernelError::Other(format!("write fs.write temp: {error}")))?;
    #[cfg(unix)]
    if executable {
        fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o755)).map_err(|error| {
            KernelError::Other(format!("set fs.write executable mode: {error}"))
        })?;
    }
    fs::hard_link(&temp_path, target)
        .map_err(|error| KernelError::Other(format!("commit fs.write create: {error}")))?;
    fs::remove_file(&temp_path)
        .map_err(|error| KernelError::Other(format!("remove fs.write temp: {error}")))?;
    cleanup.disarm();
    Ok(())
}

fn file_mode(path: &Path) -> KernelResult<Option<u32>> {
    let metadata = fs::metadata(path)
        .map_err(|error| KernelError::Other(format!("inspect file mode: {error}")))?;
    #[cfg(unix)]
    {
        Ok(Some(metadata.permissions().mode() & 0o7777))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Ok(None)
    }
}

struct TemporaryPathGuard {
    path: PathBuf,
    armed: bool,
}

impl TemporaryPathGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TemporaryPathGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn workspace_root(context: &KernelToolExecutionContext) -> KernelResult<PathBuf> {
    context
        .workspace_root
        .as_ref()
        .map(PathBuf::from)
        .ok_or(KernelError::MissingWorkspaceBinding)
}

fn workspace_id(context: &KernelToolExecutionContext) -> KernelResult<&str> {
    context
        .workspace_id
        .as_deref()
        .ok_or(KernelError::MissingWorkspaceBinding)
}

fn prepared_workspace_target(context: &KernelToolExecutionContext) -> KernelResult<PathBuf> {
    if context.private_resolved_targets.len() != 1 {
        return Err(KernelError::InvalidCommand(
            "workspace executor requires exactly one PreparedEffect target".to_string(),
        ));
    }
    let root = workspace_root(context)?;
    let target = PathBuf::from(&context.private_resolved_targets[0]);
    if !target.is_absolute() || !target.starts_with(&root) {
        return Err(KernelError::PermissionDenied(
            "PreparedEffect target is outside the canonical workspace root".to_string(),
        ));
    }
    Ok(target)
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn get_string_allow_empty(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn required_string(value: &Value, key: &str) -> KernelResult<String> {
    get_string(value, key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| KernelError::InvalidCommand(format!("{key} is required")))
}

fn normalize_relative_path(path: &str) -> String {
    let normalized = path
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string();
    if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

#[cfg(test)]
mod tests;
