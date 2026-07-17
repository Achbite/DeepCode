use super::*;

pub(super) struct GitStatusExecutor;
pub(super) struct GitDiffExecutor;
pub(super) struct GitStageExecutor;
pub(super) struct GitUnstageExecutor;
pub(super) struct GitCommitExecutor;

impl KernelToolExecutor for GitStatusExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
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

impl KernelToolExecutor for GitDiffExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
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
                "root": root.to_string_lossy(),
                "staged": staged,
                "path": path,
                "diff": limit_text(&output, 64 * 1024),
                "truncated": output.len() > 64 * 1024
            }),
        ))
    }
}

impl KernelToolExecutor for GitStageExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let root = workspace_root(&context)?;
        let paths = git_paths(&invocation.input)?;
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        git_output(&root, &args)?;
        Ok(ok(invocation.id, serde_json::json!({ "staged": paths })))
    }
}

impl KernelToolExecutor for GitUnstageExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let root = workspace_root(&context)?;
        let paths = git_paths(&invocation.input)?;
        let mut args = vec!["restore", "--staged", "--"];
        args.extend(paths.iter().map(String::as_str));
        git_output(&root, &args)?;
        Ok(ok(invocation.id, serde_json::json!({ "unstaged": paths })))
    }
}

impl KernelToolExecutor for GitCommitExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let root = workspace_root(&context)?;
        let message = get_string(&invocation.input, "message").unwrap_or_default();
        if message.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "git.commit message is required".to_string(),
            ));
        }
        let status_before = git_output(&root, &["status", "--porcelain=v1", "-uall"])?;
        let diff_before = git_output(&root, &["diff", "--cached"])?;
        let output = git_output(&root, &["commit", "-m", &message])?;
        let status_after = git_output(&root, &["status", "--porcelain=v1", "-uall"])?;
        let commit_sha = git_output(&root, &["rev-parse", "HEAD"])
            .map(|value| value.trim().to_string())
            .unwrap_or_default();
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "committed": true,
                "message": message,
                "commitSha": commit_sha,
                "output": output,
                "statusBefore": parse_git_status(&status_before),
                "statusAfter": parse_git_status(&status_after),
                "stagedDiff": limit_text(&diff_before, 64 * 1024),
                "stagedDiffTruncated": diff_before.len() > 64 * 1024
            }),
        ))
    }
}

pub(super) fn git_paths(input: &Value) -> KernelResult<Vec<String>> {
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

pub(super) fn validate_workspace_path_for_git(path: &str) -> KernelResult<()> {
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

pub(super) fn git_output(root: &Path, args: &[&str]) -> KernelResult<String> {
    const GIT_TIMEOUT: Duration = Duration::from_secs(30);
    const GIT_OUTPUT_LIMIT: u64 = 256 * 1024;
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .env_clear()
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in [
        "PATH",
        "HOME",
        "TMPDIR",
        "XDG_CONFIG_HOME",
        "GIT_CONFIG_NOSYSTEM",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = command
        .spawn()
        .map_err(|error| KernelError::Other(format!("start git: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| KernelError::Other("git supervisor could not capture stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| KernelError::Other("git supervisor could not capture stderr".to_string()))?;
    let stdout_reader = thread::spawn(move || read_limited_output(stdout, GIT_OUTPUT_LIMIT));
    let stderr_reader = thread::spawn(move || read_limited_output(stderr, GIT_OUTPUT_LIMIT));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| KernelError::Other(format!("wait for git: {error}")))?
        {
            break status;
        }
        if started.elapsed() >= GIT_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(KernelError::Other(format!(
                "git {} timed out after {} ms",
                args.join(" "),
                GIT_TIMEOUT.as_millis()
            )));
        }
        thread::sleep(Duration::from_millis(10));
    };
    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| KernelError::Other("git stdout reader failed".to_string()))??;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| KernelError::Other("git stderr reader failed".to_string()))??;
    if !status.success() {
        return Err(KernelError::Other(format!(
            "git {} failed{}: {}",
            args.join(" "),
            if stderr_truncated {
                " (stderr truncated)"
            } else {
                ""
            },
            String::from_utf8_lossy(&stderr).trim()
        )));
    }
    let mut output = String::from_utf8_lossy(&stdout).to_string();
    if stdout_truncated {
        output.push_str("\n[git stdout truncated]");
    }
    Ok(output)
}

pub(super) fn read_limited_output(
    mut reader: impl Read,
    limit: u64,
) -> KernelResult<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| KernelError::Other(format!("read supervised git output: {error}")))?;
        if read == 0 {
            break;
        }
        let remaining = (limit as usize).saturating_sub(bytes.len());
        let retained = read.min(remaining);
        bytes.extend_from_slice(&buffer[..retained]);
        truncated |= retained < read;
    }
    Ok((bytes, truncated))
}

pub(super) fn parse_git_status(output: &str) -> Vec<Value> {
    output
        .lines()
        .filter(|line| line.len() >= 3)
        .map(|line| {
            serde_json::json!({
                "index": &line[0..1],
                "worktree": &line[1..2],
                "path": line[3..].trim(),
                "group": git_status_group(&line[0..2]),
                "raw": line
            })
        })
        .collect()
}

fn git_status_group(status: &str) -> &'static str {
    if status == "??" {
        "untracked"
    } else if status
        .as_bytes()
        .first()
        .is_some_and(|value| *value != b' ')
    {
        "staged"
    } else {
        "changed"
    }
}
