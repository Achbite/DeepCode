use super::*;

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "deepcode-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn context_with_target(root: &Path, relative_path: &str) -> KernelToolExecutionContext {
    let canonical_root = root.canonicalize().expect("canonical test workspace");
    KernelToolExecutionContext {
        output_directory: Some(canonical_root.join(format!(
                "kernel-output-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))),
        workspace_root: Some(canonical_root.to_string_lossy().to_string()),
        workspace_id: Some("workspace:test".to_string()),
        private_resolved_targets: vec![canonical_root
            .join(relative_path)
            .to_string_lossy()
            .to_string()],
        cancellation: KernelCancellationToken::default(),
    }
}

#[test]
fn builtin_registry_executes_a_prepared_file_read() {
    let workspace = TempWorkspace::new("registry-read");
    fs::write(workspace.0.join("README.md"), "DeepCode\n").unwrap();
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));

    let result = registry
        .invoke(
            "fs.read",
            KernelToolInvocation {
                id: "invocation:read".to_string(),
                tool_id: "fs.read".to_string(),
                input: serde_json::json!({ "path": "README.md" }),
            },
            context_with_target(&workspace.0, "README.md"),
        )
        .expect("registered fs.read executes against the prepared target");

    assert_eq!(result.output["workspaceId"], "workspace:test");
    assert_eq!(result.output["path"], "README.md");
    assert_eq!(result.output["content"], "DeepCode\n");
}

#[test]
fn builtin_registry_rejects_a_cancelled_attempt_before_execution() {
    let workspace = TempWorkspace::new("registry-cancelled");
    fs::write(workspace.0.join("README.md"), "DeepCode\n").unwrap();
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));
    let context = context_with_target(&workspace.0, "README.md");
    context.cancellation.cancel();

    let error = registry
        .invoke(
            "fs.read",
            KernelToolInvocation {
                id: "invocation:cancelled-read".to_string(),
                tool_id: "fs.read".to_string(),
                input: serde_json::json!({ "path": "README.md" }),
            },
            context,
        )
        .expect_err("cancelled attempt must not enter the executor");
    assert!(matches!(
        error,
        KernelError::Structured {
            code: "tool_execution_cancelled",
            ..
        }
    ));
}

#[test]
fn fs_write_creates_missing_parent_directories_and_replaces_existing_files() {
    let workspace = TempWorkspace::new("write-parents");
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));
    let relative = "src/generated/main.rs";

    let create = tool_registry
        .canonicalize(
            "fs.write",
            serde_json::json!({
                "path": relative,
                "content": "fn main() {}\n"
            }),
        )
        .expect("canonical write");
    let created = registry
        .invoke(
            "fs.write",
            KernelToolInvocation {
                id: "invocation:create-nested".to_string(),
                tool_id: "fs.write".to_string(),
                input: create.arguments,
            },
            context_with_target(&workspace.0, relative),
        )
        .expect("fs.write creates nested parents");
    assert_eq!(created.output["created"], true);
    assert_eq!(
        fs::read_to_string(workspace.0.join(relative)).unwrap(),
        "fn main() {}\n"
    );

    let replace = tool_registry
        .canonicalize(
            "fs.write",
            serde_json::json!({
                "path": relative,
                "content": "fn main() { println!(\"ready\"); }\n"
            }),
        )
        .expect("canonical replacement");
    let replaced = registry
        .invoke(
            "fs.write",
            KernelToolInvocation {
                id: "invocation:replace-existing".to_string(),
                tool_id: "fs.write".to_string(),
                input: replace.arguments,
            },
            context_with_target(&workspace.0, relative),
        )
        .expect("fs.write replaces existing file");
    assert_eq!(replaced.output["created"], false);
    assert_eq!(
        fs::read_to_string(workspace.0.join(relative)).unwrap(),
        "fn main() { println!(\"ready\"); }\n"
    );
}

#[test]
fn fs_edit_validates_every_range_before_the_atomic_write() {
    let workspace = TempWorkspace::new("exact-edit");
    let path = workspace.0.join("README.md");
    fs::write(&path, "alpha beta gamma\n").unwrap();
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));

    let overlapping = tool_registry
        .canonicalize(
            "fs.edit",
            serde_json::json!({
                "path": "README.md",
                "edits": [
                    { "oldText": "alpha beta", "newText": "first" },
                    { "oldText": "beta gamma", "newText": "second" }
                ]
            }),
        )
        .expect("canonical edit");
    let error = registry
        .invoke(
            "fs.edit",
            KernelToolInvocation {
                id: "invocation:overlapping-edit".to_string(),
                tool_id: "fs.edit".to_string(),
                input: overlapping.arguments,
            },
            context_with_target(&workspace.0, "README.md"),
        )
        .expect_err("overlapping edits must fail before writing");
    assert!(matches!(
        error,
        KernelError::Structured {
            code: "edit_ranges_overlap",
            ..
        }
    ));
    assert_eq!(fs::read_to_string(&path).unwrap(), "alpha beta gamma\n");

    let exact = tool_registry
        .canonicalize(
            "fs.edit",
            serde_json::json!({
                "path": "README.md",
                "edits": [
                    { "oldText": "alpha", "newText": "first" },
                    { "oldText": "gamma", "newText": "third" }
                ]
            }),
        )
        .expect("canonical exact edit");
    registry
        .invoke(
            "fs.edit",
            KernelToolInvocation {
                id: "invocation:exact-edit".to_string(),
                tool_id: "fs.edit".to_string(),
                input: exact.arguments,
            },
            context_with_target(&workspace.0, "README.md"),
        )
        .expect("non-overlapping exact edits execute");
    assert_eq!(fs::read_to_string(path).unwrap(), "first beta third\n");
}

#[cfg(unix)]
#[test]
fn cancelled_child_is_reaped_before_wait_returns() {
    use std::os::unix::process::CommandExt as _;

    let mut command = std::process::Command::new("/bin/sh");
    command.arg("-c").arg("sleep 30").process_group(0);
    let mut child = command.spawn().expect("spawn cancellable process group");
    let cancellation = KernelCancellationToken::default();
    cancellation.cancel();

    let (_status, timed_out, cancelled) = wait_for_bounded_child(
        &mut child,
        std::time::Duration::from_secs(30),
        &cancellation,
    )
    .expect("cancel and reap child");
    assert!(!timed_out);
    assert!(cancelled);
    assert!(child.try_wait().expect("poll reaped child").is_some());
}

#[cfg(target_os = "macos")]
#[test]
fn bash_executes_in_the_bound_workspace_and_reports_environment() {
    let workspace = TempWorkspace::new("bash-workspace");
    fs::create_dir_all(workspace.0.join("build")).unwrap();
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "bash-workspace".to_string(),
                tool_id: "bash".to_string(),
                input: serde_json::json!({
                    "command": "cd build && printf 'stdout-value' && printf 'generated' > generated.txt",
                    "workspaceMode": "write",
                    "executionScope": "workspace",
                    "timeout": 5
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("bash command executes in its bound workspace");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
    assert_eq!(result.output["workspaceId"], "workspace:test");
    assert_eq!(result.output["cwd"], ".");
    assert_eq!(result.output["workspaceMode"], "write");
    assert_eq!(result.output["executionScope"], "workspace");
    assert_eq!(result.output["terminal"], false);
    assert_eq!(result.output["exitCode"], 0, "{:?}", result.output);
    assert_eq!(result.output["success"], true, "{:?}", result.output);
    assert_eq!(
        result.output["stdout"], "stdout-value",
        "{:?}",
        result.output
    );
    assert_eq!(result.output["environment"]["shell"], "/bin/bash");
    assert_eq!(result.output["environment"]["interactive"], false);
    assert_eq!(result.output["environment"]["executionScope"], "workspace");
    assert_eq!(result.output["environment"]["terminal"], false);
    assert_eq!(
        result.output["environment"]["pathSource"],
        "hostPlusStandardDeveloperPaths"
    );
    assert_eq!(
        result.output["environment"]["writeScope"],
        "workspaceAndKernelTemporary"
    );
    assert_eq!(result.output["environment"]["homeWritable"], false);
    assert_eq!(result.output["environment"]["networkAccess"], false);
    assert_eq!(
        fs::read_to_string(workspace.0.join("build/generated.txt")).unwrap(),
        "generated"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn bash_cleans_its_owned_temporary_directory() {
    let workspace = TempWorkspace::new("bash-temporary");
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "bash-temporary".to_string(),
                tool_id: "bash".to_string(),
                input: serde_json::json!({
                    "command": "printf '%s' \"$TMPDIR\"; printf temporary > \"$TMPDIR/owned.txt\"",
                    "workspaceMode": "read",
                    "executionScope": "workspace",
                    "timeout": 5
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("process shell temporary directory is writable");

    assert_eq!(result.output["exitCode"], 0, "{:?}", result.output);
    assert_eq!(result.output["success"], true, "{:?}", result.output);
    assert_eq!(result.output["workspaceMode"], "read");
    assert_eq!(
        result.output["environment"]["writeScope"],
        "kernelTemporaryOnly"
    );
    assert_eq!(result.output["environment"]["networkAccess"], false);
    let temporary = result.output["stdout"]
        .as_str()
        .expect("temporary directory is reported");
    assert!(temporary.contains("deepcode-agent-shell-"));
    assert!(!Path::new(temporary).exists());
}

#[cfg(target_os = "macos")]
#[test]
fn bash_nonzero_exit_is_a_known_failure_with_structured_output() {
    let workspace = TempWorkspace::new("bash-nonzero");
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "bash-nonzero".to_string(),
                tool_id: "bash".to_string(),
                input: serde_json::json!({
                    "command": "printf 'stdout-value'; printf 'stderr-value' >&2; exit 7",
                    "workspaceMode": "read",
                    "executionScope": "workspace",
                    "timeout": 5
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("known Bash failure retains its execution result");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Failed);
    assert_eq!(result.output["exitCode"], 7);
    assert_eq!(result.output["success"], false);
    assert_eq!(result.output["stdout"], "stdout-value");
    assert_eq!(result.output["stderr"], "stderr-value");
    assert_eq!(
        result.error.as_ref().map(|error| error.code.as_str()),
        Some("bash_exit_nonzero")
    );
}

#[cfg(target_os = "macos")]
#[test]
fn bash_timeout_is_a_known_failure_and_releases_its_temporary_directory() {
    let workspace = TempWorkspace::new("bash-timeout");
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "bash-timeout".to_string(),
                tool_id: "bash".to_string(),
                input: serde_json::json!({
                    "command": "printf '%s' \"$TMPDIR\"; sleep 2",
                    "workspaceMode": "read",
                    "executionScope": "workspace",
                    "timeout": 1
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("timed-out Bash call retains its known execution result");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Failed);
    assert_eq!(result.output["success"], false);
    assert_eq!(result.output["timedOut"], true);
    assert_eq!(
        result.error.as_ref().map(|error| error.code.as_str()),
        Some("bash_timed_out")
    );
    let temporary = result.output["stdout"]
        .as_str()
        .expect("temporary directory is reported before timeout");
    assert!(temporary.contains("deepcode-agent-shell-"));
    assert!(!Path::new(temporary).exists());
}

#[cfg(unix)]
#[test]
fn bash_host_scope_reports_the_host_execution_boundary() {
    let workspace = TempWorkspace::new("bash-host");
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "bash-host".to_string(),
                tool_id: "bash".to_string(),
                input: serde_json::json!({
                    "command": "printf 'host-scope'",
                    "workspaceMode": "read",
                    "executionScope": "host",
                    "timeout": 5
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("host Bash executes from the bound workspace");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
    assert_eq!(result.output["stdout"], "host-scope");
    assert_eq!(result.output["executionScope"], "host");
    assert_eq!(result.output["terminal"], false);
    assert_eq!(result.output["environment"]["interactive"], false);
    assert_eq!(result.output["environment"]["executionScope"], "host");
    assert_eq!(result.output["environment"]["terminal"], false);
    assert_eq!(result.output["environment"]["writeScope"], "hostUser");
    assert_eq!(result.output["environment"]["homeWritable"], true);
    assert_eq!(result.output["environment"]["networkAccess"], true);
}

#[cfg(unix)]
#[test]
fn bash_terminal_writes_exact_bounded_input_to_one_call_pty() {
    let workspace = TempWorkspace::new("bash-terminal");
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "bash-terminal".to_string(),
                tool_id: "bash".to_string(),
                input: serde_json::json!({
                    "command": "IFS= read -r value; if [ -t 0 ]; then tty=yes; else tty=no; fi; printf 'value=%s tty=%s\\n' \"$value\" \"$tty\"",
                    "workspaceMode": "read",
                    "executionScope": "host",
                    "timeout": 5,
                    "terminal": { "stdin": "ready\n" }
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("one-call PTY accepts exact input and exits");

    assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
    assert_eq!(result.output["executionScope"], "host");
    assert_eq!(result.output["terminal"], true);
    assert_eq!(result.output["environment"]["interactive"], true);
    assert_eq!(result.output["environment"]["terminal"], true);
    assert!(
        result.output["stdout"]
            .as_str()
            .expect("PTY output")
            .contains("value=ready tty=yes"),
        "{:?}",
        result.output
    );
}

#[test]
fn bash_capture_keeps_bounded_stream_tails_deterministically() {
    let mut stdout = CapturedOutput {
        bytes: b"stdout".to_vec(),
        truncated: false,
    };
    let mut stderr = CapturedOutput {
        bytes: b"stderr".to_vec(),
        truncated: false,
    };

    bound_combined_output(&mut stdout, &mut stderr, 8);

    assert_eq!(stdout.bytes, b"dout");
    assert_eq!(stderr.bytes, b"derr");
    assert!(stdout.truncated);
    assert!(stderr.truncated);
}

#[cfg(unix)]
#[test]
fn bash_limits_preview_and_preserves_complete_output_for_bounded_reads() {
    for line in ["中文🙂", &format!("中文🙂{}", "x".repeat(80))] {
        let workspace = TempWorkspace::new("bash-output-archive");
        let command = format!("i=0; while [ $i -lt 4500 ]; do printf '{line}\\n'; i=$((i+1)); done; printf 'diagnostic\\n' >&2");
        let result = ProcessShellExecutor.invoke(KernelToolInvocation {
            id: "archive".into(), tool_id: "bash".into(), input: serde_json::json!({
                "command": command, "workspaceMode": "read", "executionScope": "host", "timeout": 5,
            }),
        }, context_with_target(&workspace.0, ".")).unwrap();
        assert_eq!(result.outcome, KernelToolExecutionOutcome::Completed);
        assert_eq!(result.output["truncated"], true);
        let stdout = result.output["stdout"].as_str().unwrap();
        let stderr = result.output["stderr"].as_str().unwrap();
        assert!(stdout.len() + stderr.len() <= 50 * 1024);
        assert!(stdout.lines().count() + stderr.lines().count() <= 2000);
        assert!(!stdout.contains('\u{fffd}'));
        assert_eq!(stderr, "diagnostic\n");
        let full_path = result.output["fullOutput"]["stdout"]["path"]
            .as_str()
            .unwrap();
        let full = fs::read_to_string(full_path).unwrap();
        assert_eq!(full, format!("{line}\n").repeat(4500));
        assert_eq!(result.output["fullOutput"]["stdout"]["bytes"], full.len());
        assert_eq!(
            fs::read_to_string(
                result.output["fullOutput"]["stderr"]["path"]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
            stderr
        );
    }
}

#[test]
fn file_changes_retain_each_operations_before_and_after_and_deleted_tree_files() {
    let workspace = TempWorkspace::new("stable-changes");
    fs::create_dir_all(workspace.0.join("docs")).unwrap();
    fs::write(workspace.0.join("docs/readme.txt"), "before\n").unwrap();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &KernelToolRegistry::default(),
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));
    let invoke = |tool: &str, input: Value| {
        registry
            .invoke(
                tool,
                KernelToolInvocation {
                    id: format!("invocation:{tool}"),
                    tool_id: tool.into(),
                    input: input.clone(),
                },
                context_with_target(&workspace.0, input["path"].as_str().unwrap()),
            )
            .unwrap()
    };
    let write = invoke(
        "fs.write",
        serde_json::json!({ "path": "docs/readme.txt", "content": "after\n" }),
    );
    let change = &write.output["fileChanges"][0];
    assert_eq!(change["kind"], "modify");
    assert_eq!(
        fs::read_to_string(change["before"]["contentRef"].as_str().unwrap()).unwrap(),
        "before\n"
    );
    let edit = invoke(
        "fs.edit",
        serde_json::json!({ "path": "docs/readme.txt", "edits": [{ "oldText": "after", "newText": "later" }] }),
    );
    assert_eq!(edit.output["fileChanges"][0]["kind"], "modify");
    let unchanged = invoke(
        "fs.write",
        serde_json::json!({ "path": "docs/readme.txt", "content": "later\n" }),
    );
    assert_eq!(unchanged.output["fileChanges"], serde_json::json!([]));
    fs::write(workspace.0.join("docs/empty.txt"), "").unwrap();
    let delete = invoke(
        "fs.delete",
        serde_json::json!({ "path": "docs", "targetKind": "directoryTree" }),
    );
    let deleted = delete.output["fileChanges"].as_array().unwrap();
    assert_eq!(deleted.len(), 2);
    assert!(deleted.iter().all(|change| change["kind"] == "delete"
        && change["before"]["exists"] == true
        && change["after"]["exists"] == false));
    assert_eq!(
        fs::read_to_string(change["after"]["contentRef"].as_str().unwrap()).unwrap(),
        "after\n"
    );
}
