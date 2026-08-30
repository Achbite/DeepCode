use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_tools::file_content::{
    lightweight_file_classification, read_text_file_for_llm,
};
use deepcode_kernel_tools::kernel_internal::KernelExecutorBinding;
use deepcode_kernel_tools::KernelToolRegistry;
use deepcode_kernel_tools::ToolAvailability;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct KernelExecutorConfig {
    pub web_search_endpoint_template: String,
    pub web_search_auth_header_name: String,
    pub web_search_auth_secret_ref: String,
    pub github_api_base_url: String,
    pub github_auth_secret_ref: String,
    pub arxiv_api_base_url: String,
}

impl Default for KernelExecutorConfig {
    fn default() -> Self {
        Self {
            web_search_endpoint_template: String::new(),
            web_search_auth_header_name: String::new(),
            web_search_auth_secret_ref: String::new(),
            github_api_base_url: "https://api.github.com".to_string(),
            github_auth_secret_ref: String::new(),
            arxiv_api_base_url: "https://export.arxiv.org/api".to_string(),
        }
    }
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelToolExecutionContext {
    pub workspace_root: Option<String>,
    pub workspace_id: Option<String>,
    pub private_resolved_targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolExecutionResult {
    pub invocation_id: String,
    pub output: Value,
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
        "github.search" => Ok(Some(web::github_search_target_url(config, input)?)),
        "github.read" => Ok(Some(web::github_read_target_url(config, input)?)),
        "arxiv.search" => Ok(Some(web::arxiv_search_target_url(config, input)?)),
        "arxiv.read" => Ok(Some(web::arxiv_read_target_url(config, input)?)),
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
        KernelExecutorBinding::FsStat => Box::new(FsStatExecutor),
        KernelExecutorBinding::FsList => Box::new(FsListExecutor),
        KernelExecutorBinding::FsGlob => Box::new(FsGlobExecutor),
        KernelExecutorBinding::FsDiff => Box::new(FsDiffExecutor),
        KernelExecutorBinding::FsCreate => Box::new(FsCreateExecutor),
        KernelExecutorBinding::FsWrite => Box::new(FsWriteExecutor),
        KernelExecutorBinding::FsEdit => Box::new(FsEditExecutor),
        KernelExecutorBinding::FsDelete => Box::new(FsDeleteExecutor),
        KernelExecutorBinding::FsEnsureDirectory => Box::new(FsEnsureDirectoryExecutor),
        KernelExecutorBinding::CodeGrep => Box::new(CodeGrepExecutor),
        KernelExecutorBinding::DocumentRead => Box::new(DocumentReadExecutor),
        KernelExecutorBinding::WebSearch => Box::new(WebSearchExecutor {
            config,
            secret_provider,
        }),
        KernelExecutorBinding::WebFetch => Box::new(WebFetchExecutor),
        KernelExecutorBinding::GithubSearch => Box::new(GithubSearchExecutor {
            config,
            secret_provider,
        }),
        KernelExecutorBinding::GithubRead => Box::new(GithubReadExecutor {
            config,
            secret_provider,
        }),
        KernelExecutorBinding::ArxivSearch => Box::new(ArxivSearchExecutor { config }),
        KernelExecutorBinding::ArxivRead => Box::new(ArxivReadExecutor { config }),
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

mod document;
#[path = "executors/fs.rs"]
mod filesystem;
mod process;
mod search;
pub(crate) mod web;

use document::DocumentReadExecutor;
use filesystem::*;
use process::*;
use search::{skip_directory, CodeGrepExecutor, FsGlobExecutor};
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
        output,
    }
}

#[derive(Debug)]
struct TextPatchResult {
    updated: String,
    match_kind: String,
    changed_ranges: Value,
}

fn apply_text_patch(
    original: &str,
    replacement: &str,
    patch_spec: &Value,
) -> KernelResult<TextPatchResult> {
    let matcher = patch_spec
        .get("match")
        .ok_or_else(|| KernelError::InvalidCommand("patchSpec.match is required".to_string()))?;
    let kind = matcher
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("exactBlock");
    match kind {
        "exactBlock" => {
            let needle = required_string(matcher, "text")?;
            let (start, end) = unique_match_range(original, &needle)?;
            Ok(TextPatchResult {
                updated: replace_range(original, start, end, replacement),
                match_kind: kind.to_string(),
                changed_ranges: serde_json::json!([byte_range_json(start, end, replacement.len())]),
            })
        }
        "contextBlock" => {
            let before = get_string(matcher, "before").unwrap_or_default();
            let target = required_string(matcher, "target")?;
            let after = get_string(matcher, "after").unwrap_or_default();
            let combined = format!("{before}{target}{after}");
            let (combined_start, _) = unique_match_range(original, &combined)?;
            let start = combined_start + before.len();
            let end = start + target.len();
            Ok(TextPatchResult {
                updated: replace_range(original, start, end, replacement),
                match_kind: kind.to_string(),
                changed_ranges: serde_json::json!([byte_range_json(start, end, replacement.len())]),
            })
        }
        "lineRange" => apply_line_range_patch(original, replacement, matcher),
        other => Err(KernelError::InvalidCommand(format!(
            "unsupported patchSpec.match.kind: {other}"
        ))),
    }
}

fn apply_line_range_patch(
    original: &str,
    replacement: &str,
    matcher: &Value,
) -> KernelResult<TextPatchResult> {
    let expected_hash = get_string(matcher, "expectedFileHash");
    let expected_before = get_string(matcher, "expectedBeforeBlock");
    if expected_hash.is_none() && expected_before.is_none() {
        return Err(KernelError::InvalidCommand(
            "lineRange patch requires expectedFileHash or expectedBeforeBlock".to_string(),
        ));
    }
    if let Some(expected_hash) = expected_hash {
        let actual_hash = deepcode_kernel_tools::hash_bytes(original.as_bytes());
        if expected_hash != actual_hash {
            return Err(KernelError::InvalidCommand(format!(
                "lineRange patch expectedFileHash mismatch: expected {expected_hash}, actual {actual_hash}"
            )));
        }
    }
    let start_line = matcher
        .get("startLine")
        .and_then(Value::as_u64)
        .ok_or_else(|| KernelError::InvalidCommand("lineRange.startLine is required".to_string()))?
        as usize;
    let end_line = matcher
        .get("endLine")
        .and_then(Value::as_u64)
        .ok_or_else(|| KernelError::InvalidCommand("lineRange.endLine is required".to_string()))?
        as usize;
    if start_line == 0 || end_line < start_line {
        return Err(KernelError::InvalidCommand(
            "lineRange requires 1-based startLine <= endLine".to_string(),
        ));
    }
    let (start, end) = line_range_to_byte_range(original, start_line, end_line)?;
    let before_block = &original[start..end];
    if let Some(expected_before) = expected_before {
        if before_block != expected_before {
            return Err(KernelError::InvalidCommand(
                "lineRange expectedBeforeBlock does not match current file content".to_string(),
            ));
        }
    }
    Ok(TextPatchResult {
        updated: replace_range(original, start, end, replacement),
        match_kind: "lineRange".to_string(),
        changed_ranges: serde_json::json!([{
            "startLine": start_line,
            "endLine": end_line,
            "startByte": start,
            "endByte": end,
            "replacementBytes": replacement.len()
        }]),
    })
}

fn unique_match_range(haystack: &str, needle: &str) -> KernelResult<(usize, usize)> {
    if needle.is_empty() {
        return Err(KernelError::Structured {
            code: "patch_match_empty",
            stage: "execution",
            message: "patch match text must not be empty".to_string(),
            details: serde_json::json!({ "classification": "invalid_patch_match" }),
        });
    }
    let mut matches = haystack.match_indices(needle);
    let Some((start, _)) = matches.next() else {
        return Err(KernelError::Structured {
            code: "patch_match_not_found",
            stage: "execution",
            message: "patch match did not occur in target file".to_string(),
            details: serde_json::json!({ "classification": "stale_or_mismatched_evidence" }),
        });
    };
    if matches.next().is_some() {
        return Err(KernelError::Structured {
            code: "patch_match_ambiguous",
            stage: "execution",
            message: "patch match is ambiguous; expected exactly one match".to_string(),
            details: serde_json::json!({ "classification": "ambiguous_patch_match" }),
        });
    }
    Ok((start, start + needle.len()))
}

fn replace_range(original: &str, start: usize, end: usize, replacement: &str) -> String {
    let mut updated = String::with_capacity(original.len() - (end - start) + replacement.len());
    updated.push_str(&original[..start]);
    updated.push_str(replacement);
    updated.push_str(&original[end..]);
    updated
}

fn byte_range_json(start: usize, end: usize, replacement_bytes: usize) -> Value {
    serde_json::json!({
        "startByte": start,
        "endByte": end,
        "replacementBytes": replacement_bytes
    })
}

fn line_range_to_byte_range(
    content: &str,
    start_line: usize,
    end_line: usize,
) -> KernelResult<(usize, usize)> {
    let mut line_start = 0usize;
    let mut current_line = 1usize;
    let mut start_byte = None;
    let mut end_byte = None;
    for segment in content.split_inclusive('\n') {
        let next = line_start + segment.len();
        if current_line == start_line {
            start_byte = Some(line_start);
        }
        if current_line == end_line {
            end_byte = Some(next);
            break;
        }
        current_line += 1;
        line_start = next;
    }
    if start_byte.is_none() && start_line == current_line && line_start == content.len() {
        start_byte = Some(line_start);
    }
    if end_byte.is_none() && end_line == current_line && line_start == content.len() {
        end_byte = Some(content.len());
    }
    let start = start_byte.ok_or_else(|| {
        KernelError::InvalidCommand(format!("lineRange.startLine {start_line} is outside file"))
    })?;
    let end = end_byte.ok_or_else(|| {
        KernelError::InvalidCommand(format!("lineRange.endLine {end_line} is outside file"))
    })?;
    Ok((start, end))
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
            message: "fs.create executable=true is not supported on native Windows".to_string(),
            details: serde_json::json!({
                "toolId": "fs.create",
                "attribute": "executable",
                "platform": std::env::consts::OS,
            }),
        });
    }
    let parent = target.parent().ok_or_else(|| {
        KernelError::InvalidCommand("create target has no parent directory".to_string())
    })?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let file_name = target
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("create-target");
    let temp_path = parent.join(format!(".{file_name}.deepcode-create-{stamp}.tmp"));
    let mut cleanup = TemporaryPathGuard::new(temp_path.clone());
    fs::write(&temp_path, content)
        .map_err(|error| KernelError::Other(format!("write create temp: {error}")))?;
    #[cfg(unix)]
    if executable {
        fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o755))
            .map_err(|error| KernelError::Other(format!("set executable permissions: {error}")))?;
    }
    fs::hard_link(&temp_path, target)
        .map_err(|error| KernelError::Other(format!("commit create: {error}")))?;
    fs::remove_file(&temp_path)
        .map_err(|error| KernelError::Other(format!("remove create temp: {error}")))?;
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

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .filter(|item| !item.trim().is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn required_string(value: &Value, key: &str) -> KernelResult<String> {
    get_string(value, key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| KernelError::InvalidCommand(format!("{key} is required")))
}

fn glob_regex(pattern: &str) -> KernelResult<Regex> {
    let mut expression = String::from("^");
    let chars = pattern.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    while index < chars.len() {
        match chars[index] {
            '*' if chars.get(index + 1) == Some(&'*') => {
                expression.push_str(".*");
                index += 2;
            }
            '*' => {
                expression.push_str("[^/]*");
                index += 1;
            }
            '?' => {
                expression.push_str("[^/]");
                index += 1;
            }
            character => {
                expression.push_str(&regex::escape(&character.to_string()));
                index += 1;
            }
        }
    }
    expression.push('$');
    Regex::new(&expression)
        .map_err(|error| KernelError::InvalidCommand(format!("invalid glob pattern: {error}")))
}

fn compile_glob_patterns(patterns: &[String]) -> KernelResult<Vec<Regex>> {
    patterns.iter().map(|pattern| glob_regex(pattern)).collect()
}

fn collect_glob_matches(
    root: &Path,
    directory: &Path,
    matcher: &Regex,
    max_results: usize,
    matches: &mut Vec<String>,
    skipped: &mut usize,
) -> KernelResult<()> {
    if matches.len() >= max_results {
        return Ok(());
    }
    let entries = fs::read_dir(directory)
        .map_err(|error| KernelError::Other(format!("fs.glob {}: {error}", directory.display())))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                *skipped += 1;
                continue;
            }
        };
        let path = entry.path();
        if path.is_dir() {
            if !skip_directory(&path) {
                collect_glob_matches(root, &path, matcher, max_results, matches, skipped)?;
            }
            if matches.len() >= max_results {
                break;
            }
            continue;
        }
        if !path.is_file() {
            *skipped += 1;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if matcher.is_match(&relative) {
            matches.push(relative);
            if matches.len() >= max_results {
                break;
            }
        }
    }
    Ok(())
}

fn changed_line_ranges(old: &str, new: &str) -> Value {
    let old_lines = old.lines().collect::<Vec<_>>();
    let new_lines = new.lines().collect::<Vec<_>>();
    let prefix = old_lines
        .iter()
        .zip(new_lines.iter())
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = old_lines[prefix..]
        .iter()
        .rev()
        .zip(new_lines[prefix..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    serde_json::json!([{
        "oldStartLine": prefix + 1,
        "oldEndLine": old_lines.len().saturating_sub(suffix),
        "newStartLine": prefix + 1,
        "newEndLine": new_lines.len().saturating_sub(suffix)
    }])
}

fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let mut output = format!("--- a/{path}\n+++ b/{path}\n");
    let old_lines = old.lines().collect::<Vec<_>>();
    let new_lines = new.lines().collect::<Vec<_>>();
    output.push_str(&format!(
        "@@ -1,{} +1,{} @@\n",
        old_lines.len(),
        new_lines.len()
    ));
    for line in old_lines {
        output.push('-');
        output.push_str(line);
        output.push('\n');
    }
    for line in new_lines {
        output.push('+');
        output.push_str(line);
        output.push('\n');
    }
    output
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

fn list_nodes(
    path: &Path,
    root: &Path,
    depth: u32,
    include_hidden: bool,
) -> KernelResult<Vec<Value>> {
    if depth == 0 {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| KernelError::Other(format!("list {}: {error}", path.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| KernelError::Other(format!("read dir entry: {error}")))?;
    entries.sort_by(compare_dir_entries);

    let mut nodes = Vec::new();
    for entry in entries {
        if !include_hidden && entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let entry_path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| KernelError::Other(format!("metadata: {error}")))?;
        let kind = if metadata.is_dir() {
            "directory"
        } else {
            "file"
        };
        let relative = entry_path
            .strip_prefix(root)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .replace('\\', "/");
        let mut node = serde_json::json!({
            "id": relative,
            "name": entry.file_name().to_string_lossy(),
            "path": relative,
            "type": kind,
            "sizeBytes": metadata.len()
        });
        if metadata.is_file() {
            node["fileClassification"] =
                serde_json::to_value(lightweight_file_classification(&entry_path, &metadata))
                    .unwrap_or(Value::Null);
        }
        if metadata.is_dir() && depth > 1 {
            node["children"] =
                Value::Array(list_nodes(&entry_path, root, depth - 1, include_hidden)?);
        }
        nodes.push(node);
    }
    Ok(nodes)
}

fn compare_dir_entries(left: &fs::DirEntry, right: &fs::DirEntry) -> Ordering {
    let left_is_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    let right_is_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    match (left_is_dir, right_is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => left
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&right.file_name().to_string_lossy().to_ascii_lowercase()),
    }
}

pub(crate) const CODE_SEARCH_DEFAULT_MAX_RESULTS: usize = 200;
const CODE_SEARCH_MAX_RESULTS: usize = 500;
const CODE_SEARCH_MAX_CONTEXT_LINES: usize = 5;
const CODE_SEARCH_MAX_VISITED_FILES: usize = 500;

fn limit_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &value[..end])
}

#[cfg(test)]
mod tests;
