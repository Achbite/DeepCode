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
use std::process::Command;

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
        Box::new(WebSearchExecutor),
        Box::new(WebFetchExecutor),
        Box::new(GitStatusExecutor),
        Box::new(GitDiffExecutor),
        Box::new(GitStageExecutor),
        Box::new(GitUnstageExecutor),
        Box::new(GitCommitExecutor),
        Box::new(BrowserOpenExecutor),
        Box::new(BrowserReloadExecutor),
        Box::new(BrowserSnapshotExecutor),
        Box::new(BrowserInspectExecutor),
        Box::new(BrowserClickExecutor),
        Box::new(BrowserTypeExecutor),
        Box::new(BrowserScrollExecutor),
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
struct WebSearchExecutor;
struct WebFetchExecutor;
struct GitStatusExecutor;
struct GitDiffExecutor;
struct GitStageExecutor;
struct GitUnstageExecutor;
struct GitCommitExecutor;
struct BrowserOpenExecutor;
struct BrowserReloadExecutor;
struct BrowserSnapshotExecutor;
struct BrowserInspectExecutor;
struct BrowserClickExecutor;
struct BrowserTypeExecutor;
struct BrowserScrollExecutor;

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

impl SkillExecutor for WebSearchExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "web.search",
            "skill.web.search.description",
            Capability::network_egress(),
            RiskLevel::High,
            vec![CapabilityEffect::UsesNetwork],
            vec!["complete"],
            true,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let query = get_string(&invocation.input, "query").unwrap_or_default();
        if query.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "web.search query is required".to_string(),
            ));
        }
        let limit = invocation
            .input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .clamp(1, 10) as usize;
        let url = std::env::var("DEEPCODE_WEB_SEARCH_ENDPOINT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|endpoint| {
                let joiner = if endpoint.contains('?') { '&' } else { '?' };
                format!("{endpoint}{joiner}q={}", percent_encode(&query))
            })
            .unwrap_or_else(|| {
                format!("https://duckduckgo.com/html/?q={}", percent_encode(&query))
            });
        validate_http_url(&url)?;
        let body = http_get_text(&url, 96 * 1024)?;
        let results = parse_search_results(&body, limit);
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "query": query,
                "provider": if std::env::var("DEEPCODE_WEB_SEARCH_ENDPOINT").is_ok() { "configured-endpoint" } else { "duckduckgo-html" },
                "results": results,
                "untrustedEvidence": true,
                "sourceUrl": url,
                "contentHash": crate::hash::hash_bytes(body.as_bytes())
            }),
        ))
    }
}

impl SkillExecutor for WebFetchExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "web.fetch",
            "skill.web.fetch.description",
            Capability::network_egress(),
            RiskLevel::High,
            vec![CapabilityEffect::UsesNetwork],
            vec!["complete"],
            true,
        )
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let url = get_string(&invocation.input, "url").unwrap_or_default();
        validate_http_url(&url)?;
        let max_bytes = invocation
            .input
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(96 * 1024)
            .clamp(1024, 256 * 1024) as usize;
        let body = http_get_text(&url, max_bytes)?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "url": url,
                "content": body,
                "sizeBytes": body.len(),
                "contentHash": crate::hash::hash_bytes(body.as_bytes()),
                "untrustedEvidence": true
            }),
        ))
    }
}

impl SkillExecutor for GitStatusExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "git.status",
            "skill.git.status.description",
            Capability::git_read(),
            RiskLevel::Low,
            vec![CapabilityEffect::ReadsGit],
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
        let output = git_output(&root, &["status", "--porcelain=v1", "-uall"])?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "root": root.to_string_lossy(),
                "changes": parse_git_status(&output),
                "raw": output
            }),
        ))
    }
}

impl SkillExecutor for GitDiffExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "git.diff",
            "skill.git.diff.description",
            Capability::git_read(),
            RiskLevel::Low,
            vec![CapabilityEffect::ReadsGit],
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
        let staged = invocation
            .input
            .get("staged")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let path = get_string(&invocation.input, "path");
        if let Some(path) = path.as_ref() {
            validate_workspace_path_for_git(path)?;
        }
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        let output = if let Some(path) = path.as_ref() {
            args.push("--");
            args.push(path);
            git_output(&root, &args)?
        } else {
            git_output(&root, &args)?
        };
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "staged": staged,
                "path": path,
                "diff": limit_text(&output, 64 * 1024),
                "truncated": output.len() > 64 * 1024
            }),
        ))
    }
}

impl SkillExecutor for GitStageExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "git.stage",
            "skill.git.stage.description",
            Capability::git_write(),
            RiskLevel::High,
            vec![CapabilityEffect::ModifiesGit],
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
        let paths = git_paths(&invocation.input)?;
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        git_output(&root, &args)?;
        Ok(ok(invocation.id, serde_json::json!({ "staged": paths })))
    }
}

impl SkillExecutor for GitUnstageExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "git.unstage",
            "skill.git.unstage.description",
            Capability::git_write(),
            RiskLevel::High,
            vec![CapabilityEffect::ModifiesGit],
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
        let paths = git_paths(&invocation.input)?;
        let mut args = vec!["restore", "--staged", "--"];
        args.extend(paths.iter().map(String::as_str));
        git_output(&root, &args)?;
        Ok(ok(invocation.id, serde_json::json!({ "unstaged": paths })))
    }
}

impl SkillExecutor for GitCommitExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        descriptor(
            "git.commit",
            "skill.git.commit.description",
            Capability::git_write(),
            RiskLevel::High,
            vec![CapabilityEffect::ModifiesGit],
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
        let message = get_string(&invocation.input, "message").unwrap_or_default();
        if message.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "git.commit message is required".to_string(),
            ));
        }
        let output = git_output(&root, &["commit", "-m", &message])?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "committed": true,
                "message": message,
                "output": output
            }),
        ))
    }
}

impl SkillExecutor for BrowserOpenExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        browser_descriptor("browser.open", "skill.browser.open.description")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        let url = get_string(&invocation.input, "url").unwrap_or_default();
        validate_http_url(&url)?;
        Ok(browser_action_result(
            invocation.id,
            "open",
            serde_json::json!({ "url": url }),
        ))
    }
}

impl SkillExecutor for BrowserReloadExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        browser_descriptor("browser.reload", "skill.browser.reload.description")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        Ok(browser_action_result(
            invocation.id,
            "reload",
            serde_json::json!({}),
        ))
    }
}

impl SkillExecutor for BrowserSnapshotExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        browser_descriptor("browser.snapshot", "skill.browser.snapshot.description")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        Ok(browser_action_result(
            invocation.id,
            "snapshot",
            serde_json::json!({
                "selector": get_string(&invocation.input, "selector").unwrap_or_else(|| "body".to_string())
            }),
        ))
    }
}

impl SkillExecutor for BrowserInspectExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        browser_descriptor("browser.inspect", "skill.browser.inspect.description")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        Ok(browser_action_result(
            invocation.id,
            "inspect",
            serde_json::json!({
                "inspectState": get_string(&invocation.input, "inspectState").unwrap_or_else(|| "selecting".to_string())
            }),
        ))
    }
}

impl SkillExecutor for BrowserClickExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        browser_descriptor("browser.click", "skill.browser.click.description")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        Ok(browser_action_result(
            invocation.id,
            "click",
            serde_json::json!({ "selector": required_string(&invocation.input, "selector")? }),
        ))
    }
}

impl SkillExecutor for BrowserTypeExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        browser_descriptor("browser.type", "skill.browser.type.description")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        Ok(browser_action_result(
            invocation.id,
            "type",
            serde_json::json!({
                "selector": required_string(&invocation.input, "selector")?,
                "textPreview": get_string(&invocation.input, "text").map(|value| limit_text(&value, 256)).unwrap_or_default(),
                "textBytes": get_string(&invocation.input, "text").map(|value| value.len()).unwrap_or(0)
            }),
        ))
    }
}

impl SkillExecutor for BrowserScrollExecutor {
    fn descriptor(&self) -> SkillDescriptor {
        browser_descriptor("browser.scroll", "skill.browser.scroll.description")
    }

    fn invoke(
        &self,
        invocation: SkillInvocation,
        _context: SkillExecutionContext,
    ) -> KernelResult<SkillResult> {
        Ok(browser_action_result(
            invocation.id,
            "scroll",
            serde_json::json!({
                "deltaY": invocation.input.get("deltaY").and_then(Value::as_i64).unwrap_or(0)
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

fn required_string(value: &Value, key: &str) -> KernelResult<String> {
    get_string(value, key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| KernelError::InvalidCommand(format!("{key} is required")))
}

fn browser_descriptor(id: &str, description_key: &str) -> SkillDescriptor {
    descriptor(
        id,
        description_key,
        Capability::browser_control(),
        RiskLevel::High,
        vec![CapabilityEffect::ControlsBrowser],
        vec!["complete"],
        true,
    )
}

fn browser_action_result(invocation_id: String, action: &str, input: Value) -> SkillResult {
    ok(
        invocation_id,
        serde_json::json!({
            "action": action,
            "input": input,
            "requiresHostBridge": true,
            "untrustedPageEvidence": action == "snapshot",
            "message": "Browser action is authorized by Kernel and must be applied by the Editor Host browser bridge."
        }),
    )
}

fn validate_http_url(url: &str) -> KernelResult<()> {
    let url = url.trim();
    if url.is_empty() {
        return Err(KernelError::InvalidCommand("url is required".to_string()));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(KernelError::PermissionDenied(
            "network tools only accept http/https URLs".to_string(),
        ));
    }
    Ok(())
}

fn http_get_text(url: &str, max_bytes: usize) -> KernelResult<String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("DeepCode-Kernel/0.1 (+untrusted-evidence-fetch)")
        .build()
        .map_err(|error| KernelError::Other(format!("create HTTP client: {error}")))?
        .get(url)
        .send()
        .map_err(|error| KernelError::Other(format!("HTTP GET {url}: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(KernelError::Other(format!(
            "HTTP GET {url} returned {}",
            status.as_u16()
        )));
    }
    let bytes = response
        .bytes()
        .map_err(|error| KernelError::Other(format!("read HTTP body: {error}")))?;
    Ok(clip_bytes_to_string(&bytes, max_bytes))
}

fn clip_bytes_to_string(bytes: &[u8], max_bytes: usize) -> String {
    let clipped = if bytes.len() <= max_bytes {
        bytes
    } else {
        &bytes[..max_bytes]
    };
    let text = String::from_utf8_lossy(clipped);
    if bytes.len() <= max_bytes {
        text.to_string()
    } else {
        format!("{text}\n[truncated]")
    }
}

fn parse_search_results(html_or_json: &str, limit: usize) -> Vec<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(html_or_json) {
        if let Some(items) = value.get("results").and_then(Value::as_array) {
            return items.iter().take(limit).cloned().collect();
        }
        if let Some(items) = value.as_array() {
            return items.iter().take(limit).cloned().collect();
        }
    }

    let mut results = Vec::new();
    for segment in html_or_json.split("<a ").skip(1) {
        if results.len() >= limit {
            break;
        }
        let Some(href_start) = segment.find("href=\"") else {
            continue;
        };
        let href = &segment[href_start + 6..];
        let Some(href_end) = href.find('"') else {
            continue;
        };
        let url = html_unescape_basic(&href[..href_end]);
        if !url.starts_with("http") || url.contains("duckduckgo.com/y.js") {
            continue;
        }
        let title = segment
            .find('>')
            .and_then(|start| segment[start + 1..].find("</a>").map(|end| (start, end)))
            .map(|(start, end)| strip_html_tags(&segment[start + 1..start + 1 + end]))
            .map(|value| html_unescape_basic(&value))
            .unwrap_or_else(|| url.clone());
        results.push(serde_json::json!({
            "title": title.trim(),
            "url": url,
            "snippet": "",
            "untrustedEvidence": true
        }));
    }
    results
}

fn strip_html_tags(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    output
}

fn html_unescape_basic(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x2F;", "/")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(char::from(*byte));
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn git_paths(input: &Value) -> KernelResult<Vec<String>> {
    let paths = input
        .get("paths")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .or_else(|| get_string(input, "path").map(|path| vec![path]))
        .unwrap_or_default();
    if paths.is_empty() {
        return Err(KernelError::InvalidCommand(
            "git path or paths is required".to_string(),
        ));
    }
    for path in &paths {
        validate_workspace_path_for_git(path)?;
    }
    Ok(paths)
}

fn validate_workspace_path_for_git(path: &str) -> KernelResult<()> {
    if path.trim().is_empty()
        || path.starts_with('/')
        || path.get(1..3) == Some(":/")
        || path == ".."
        || path.starts_with("../")
        || path.contains("/../")
        || path.ends_with("/..")
    {
        return Err(KernelError::PermissionDenied(
            "git paths must be workspace-relative and must not contain ..".to_string(),
        ));
    }
    Ok(())
}

fn git_output(root: &Path, args: &[&str]) -> KernelResult<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| KernelError::Other(format!("start git: {error}")))?;
    if !output.status.success() {
        return Err(KernelError::Other(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_git_status(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter(|line| line.len() >= 3)
        .map(|line| {
            serde_json::json!({
                "index": &line[0..1],
                "worktree": &line[1..2],
                "path": line[3..].trim(),
                "raw": line
            })
        })
        .collect()
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
