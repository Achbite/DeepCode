use crate::{
    builtin, SkillDescriptor, SkillExecutionContext, SkillExecutor, SkillInvocation, SkillResult,
};
use deepcode_kernel_abi::{KernelError, KernelResult};
use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel, WorkspaceBoundary};
use serde_json::Value;
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

pub fn builtin_executors() -> Vec<Box<dyn SkillExecutor>> {
    vec![
        Box::new(FsListExecutor),
        Box::new(FsReadExecutor),
        Box::new(FsDiffExecutor),
        Box::new(FsWriteExecutor),
        Box::new(FsDeleteExecutor),
        Box::new(CodeSearchExecutor),
        Box::new(ShellProposeExecutor),
        Box::new(ShellExecExecutor),
    ]
}

struct FsListExecutor;
struct FsReadExecutor;
struct FsDiffExecutor;
struct FsWriteExecutor;
struct FsDeleteExecutor;
struct CodeSearchExecutor;
struct ShellProposeExecutor;
struct ShellExecExecutor;

impl SkillExecutor for FsListExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "fs.list",
            "skill.fs.list.description",
            Capability::workspace_list(),
            RiskLevel::Low,
            vec![CapabilityEffect::ReadsWorkspace],
            vec!["plan", "check", "complete", "review"],
            true,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let root = workspace_root(&context)?;
        let relative = get_string(&invocation.input, "path").unwrap_or_else(|| ".".to_string());
        let target = resolve_workspace_path(&root, &relative)?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&relative),
                "nodes": list_nodes(&target, &root, 2)?
            }),
        ))
    }
}

impl SkillExecutor for FsReadExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "fs.read",
            "skill.fs.read.description",
            Capability::workspace_read(),
            RiskLevel::Low,
            vec![CapabilityEffect::ReadsWorkspace],
            vec!["plan", "check", "complete", "review"],
            true,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let root = workspace_root(&context)?;
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        let target = resolve_workspace_path(&root, &path)?;
        if !target.is_file() {
            return Err(KernelError::InvalidCommand(format!("{path} is not a file")));
        }
        let content = fs::read_to_string(&target)
            .map_err(|error| KernelError::Other(format!("read {path}: {error}")))?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "content": content,
                "sizeBytes": content.len(),
                "binary": false
            }),
        ))
    }
}

impl SkillExecutor for FsWriteExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "fs.write",
            "skill.fs.write.description",
            Capability::workspace_write(),
            RiskLevel::High,
            vec![CapabilityEffect::WritesWorkspace],
            vec!["complete"],
            true,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let root = workspace_root(&context)?;
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        WorkspaceBoundary::assert_mutable_config_asset(&path)?;
        let target = resolve_workspace_path(&root, &path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| KernelError::Other(format!("create parent: {error}")))?;
        }
        let content = get_string(&invocation.input, "content").unwrap_or_default();
        fs::write(&target, content)
            .map_err(|error| KernelError::Other(format!("write {path}: {error}")))?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "saved": true,
                "sizeBytes": fs::metadata(&target).map(|metadata| metadata.len()).unwrap_or(0)
            }),
        ))
    }
}

impl SkillExecutor for FsDeleteExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "fs.delete",
            "skill.fs.delete.description",
            Capability::workspace_delete(),
            RiskLevel::Critical,
            vec![CapabilityEffect::DeletesWorkspace],
            vec!["complete"],
            false,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let root = workspace_root(&context)?;
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        WorkspaceBoundary::assert_mutable_config_asset(&path)?;
        let target = resolve_workspace_path(&root, &path)?;
        if target.is_dir() {
            return Err(KernelError::PermissionDenied(
                "fs.delete only accepts files".to_string(),
            ));
        }
        fs::remove_file(&target)
            .map_err(|error| KernelError::Other(format!("delete {path}: {error}")))?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "deleted": true,
                "kind": "file"
            }),
        ))
    }
}

impl SkillExecutor for FsDiffExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "fs.diff",
            "skill.fs.diff.description",
            Capability::workspace_preview_diff(),
            RiskLevel::Low,
            vec![CapabilityEffect::ReadsWorkspace],
            vec!["plan", "check", "complete", "review"],
            true,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let root = workspace_root(&context)?;
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        let target = resolve_workspace_path(&root, &path)?;
        let old_content = fs::read_to_string(&target).unwrap_or_default();
        let new_content = get_string(&invocation.input, "newContent").unwrap_or_default();
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "path": path,
                "diff": format!("--- old\n+++ new\n-{}\n+{}", old_content, new_content)
            }),
        ))
    }
}

impl SkillExecutor for CodeSearchExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "code.search",
            "skill.code.search.description",
            Capability::workspace_search(),
            RiskLevel::Low,
            vec![CapabilityEffect::ReadsWorkspace],
            vec!["plan", "check", "complete", "review"],
            true,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let root = workspace_root(&context)?;
        let query = get_string(&invocation.input, "query").unwrap_or_default();
        if query.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "search query is required".to_string(),
            ));
        }
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "folderId": "wf-0",
                "query": query,
                "matches": search_workspace(&root, &query, &[])?
            }),
        ))
    }
}

impl SkillExecutor for ShellProposeExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "shell.propose",
            "skill.shell.propose.description",
            Capability::process_propose(),
            RiskLevel::Medium,
            vec![CapabilityEffect::RunsProcess],
            vec!["plan", "complete"],
            true,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "dryRun": true,
                "executed": false,
                "command": get_string(&invocation.input, "command")
            }),
        ))
    }
}

impl SkillExecutor for ShellExecExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "shell.exec",
            "skill.shell.exec.description",
            Capability::process_exec(),
            RiskLevel::High,
            vec![CapabilityEffect::RunsProcess],
            vec!["complete"],
            true,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let root = workspace_root(&context)?;
        let command = get_string(&invocation.input, "command").unwrap_or_default();
        if command.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "shell.exec command is required".to_string(),
            ));
        }
        if command.contains("rm -rf") || command.contains("git reset --hard") {
            return Err(KernelError::PermissionDenied(
                "destructive shell command is blocked by Kernel policy".to_string(),
            ));
        }
        let started = now_millis();
        let output = if cfg!(windows) {
            std::process::Command::new("wsl.exe")
                .arg("sh")
                .arg("-lc")
                .arg(&command)
                .current_dir(&root)
                .output()
        } else {
            std::process::Command::new("bash")
                .arg("-lc")
                .arg(&command)
                .current_dir(&root)
                .output()
        }
        .map_err(|error| {
            KernelError::Other(format!("failed to start kernel controlled shell: {error}"))
        })?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "command": command,
                "cwd": root.to_string_lossy(),
                "executed": true,
                "exitCode": output.status.code(),
                "stdout": limit_text(&String::from_utf8_lossy(&output.stdout), 16 * 1024),
                "stderr": limit_text(&String::from_utf8_lossy(&output.stderr), 16 * 1024),
                "durationMs": now_millis().saturating_sub(started),
                "truncated": output.stdout.len() > 16 * 1024 || output.stderr.len() > 16 * 1024,
                "tempSessionId": format!("kernel-shell-{}", started),
                "cleanupStatus": "alreadyExited"
            }),
        ))
    }
}

fn descriptor(
    id: &str,
    description_key: &str,
    capability: Capability,
    risk_level: RiskLevel,
    effects: Vec<CapabilityEffect>,
    allowed_phases: Vec<&str>,
    model_visible: bool,
) -> SkillDescriptor {
    builtin(
        id,
        description_key,
        capability,
        risk_level,
        effects,
        allowed_phases,
        model_visible,
    )
}

fn ok(invocation_id: String, output: Value) -> SkillResult {
    SkillResult {
        invocation_id,
        ok: true,
        output,
        error: None,
    }
}

fn workspace_root(context: &SkillExecutionContext) -> KernelResult<PathBuf> {
    context
        .workspace_root
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| KernelError::MissingWorkspaceBinding)
}

fn resolve_workspace_path(root: &Path, relative_path: &str) -> KernelResult<PathBuf> {
    WorkspaceBoundary::new(root.to_path_buf()).resolve(relative_path)
}

fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn normalize_relative_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string()
}

fn list_nodes(path: &Path, root: &Path, depth: u32) -> KernelResult<Vec<Value>> {
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
            "kind": kind,
            "sizeBytes": metadata.len()
        });
        if metadata.is_dir() && depth > 1 {
            node["children"] = Value::Array(list_nodes(&entry_path, root, depth - 1)?);
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

fn search_workspace(root: &Path, query: &str, includes: &[String]) -> KernelResult<Vec<Value>> {
    let mut matches = Vec::new();
    search_dir(root, root, query, includes, &mut matches)?;
    Ok(matches)
}

fn search_dir(
    root: &Path,
    dir: &Path,
    query: &str,
    includes: &[String],
    matches: &mut Vec<Value>,
) -> KernelResult<()> {
    for entry in fs::read_dir(dir)
        .map_err(|error| KernelError::Other(format!("search {}: {error}", dir.display())))?
    {
        let entry = entry.map_err(|error| KernelError::Other(format!("search entry: {error}")))?;
        let path = entry.path();
        if path.is_dir() {
            if skip_directory(&path) {
                continue;
            }
            search_dir(root, &path, query, includes, matches)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if !includes.is_empty() && !includes.iter().any(|pattern| relative.contains(pattern)) {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for (line_index, line) in content.lines().enumerate() {
            if line.contains(query) {
                matches.push(serde_json::json!({
                    "path": relative,
                    "line": line_index + 1,
                    "preview": line
                }));
            }
        }
    }
    Ok(())
}

fn skip_directory(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(OsStr::to_str),
        Some(".git" | "node_modules" | "target" | ".pnpm-store")
    )
}

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

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}
