use super::*;
use std::thread;

struct StaticSecretProvider {
    secret_ref: &'static str,
    value: &'static str,
}

impl SecretProvider for StaticSecretProvider {
    fn resolve(&self, secret_ref: &str) -> Option<String> {
        (secret_ref == self.secret_ref).then(|| self.value.to_string())
    }
}

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

fn context(root: &Path) -> KernelToolExecutionContext {
    KernelToolExecutionContext {
        workspace_root: Some(root.to_string_lossy().to_string()),
        workspace_id: Some("workspace:test".to_string()),
        private_resolved_targets: Vec::new(),
    }
}

fn context_with_target(root: &Path, relative_path: &str) -> KernelToolExecutionContext {
    let canonical_root = root.canonicalize().expect("canonical test workspace");
    KernelToolExecutionContext {
        workspace_root: Some(canonical_root.to_string_lossy().to_string()),
        workspace_id: Some("workspace:test".to_string()),
        private_resolved_targets: vec![canonical_root
            .join(relative_path)
            .to_string_lossy()
            .to_string()],
    }
}

fn context_with_resolved_target(root: &Path, target: &Path) -> KernelToolExecutionContext {
    let canonical_root = root.canonicalize().expect("canonical test workspace");
    KernelToolExecutionContext {
        workspace_root: Some(canonical_root.to_string_lossy().to_string()),
        workspace_id: Some("workspace:test".to_string()),
        private_resolved_targets: vec![target.to_string_lossy().to_string()],
    }
}

#[test]
fn exact_block_patch_replaces_unique_match() {
    let original = "alpha\nold block\nomega\n";
    let patch = apply_text_patch(
        original,
        "new block\n",
        &serde_json::json!({
            "match": {
                "kind": "exactBlock",
                "text": "old block\n"
            }
        }),
    )
    .expect("unique exact block patch succeeds");

    assert_eq!(patch.updated, "alpha\nnew block\nomega\n");
    assert_eq!(patch.match_kind, "exactBlock");
}

#[test]
fn exact_block_patch_fails_without_match() {
    let error = apply_text_patch(
        "alpha\nold block\nomega\n",
        "new block\n",
        &serde_json::json!({
            "match": {
                "kind": "exactBlock",
                "text": "missing block\n"
            }
        }),
    )
    .expect_err("missing exact block must fail closed");

    assert!(format!("{error}").contains("did not occur"));
}

#[test]
fn exact_block_patch_fails_when_ambiguous() {
    let error = apply_text_patch(
        "alpha\nold block\nmiddle\nold block\nomega\n",
        "new block\n",
        &serde_json::json!({
            "match": {
                "kind": "exactBlock",
                "text": "old block\n"
            }
        }),
    )
    .expect_err("ambiguous exact block must fail closed");

    assert!(format!("{error}").contains("ambiguous"));
}

#[test]
fn line_range_patch_requires_matching_hash_or_before_block() {
    let original = "alpha\nold block\nomega\n";
    let error = apply_text_patch(
        original,
        "new block\n",
        &serde_json::json!({
            "match": {
                "kind": "lineRange",
                "startLine": 2,
                "endLine": 2,
                "expectedFileHash": "sha256:does-not-match"
            }
        }),
    )
    .expect_err("line range hash mismatch must fail closed");

    assert!(format!("{error}").contains("expectedFileHash mismatch"));
}

#[cfg(unix)]
#[test]
fn atomic_create_sets_executable_mode_and_atomic_write_preserves_it() {
    use std::os::unix::fs::PermissionsExt;

    let workspace = TempWorkspace::new("file-mode");
    let target = workspace.0.join("entry");
    atomic_create_text(&target, "initial\n", true).expect("create executable file");
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o755
    );

    atomic_write_text(&target, "updated\n").expect("replace content atomically");
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "updated\n");
}

#[test]
fn executor_registry_rejects_invocation_identity_mismatch() {
    let tool_registry = KernelToolRegistry::default();
    let registry = KernelExecutorRegistry::from_executors(builtin_executors(
        &tool_registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));
    let error = registry
        .invoke(
            "fs.read",
            KernelToolInvocation {
                id: "mismatched-invocation".to_string(),
                tool_id: "fs.list".to_string(),
                input: serde_json::json!({ "path": "." }),
            },
            context(Path::new(".")),
        )
        .expect_err("executor lookup and invocation identity must match");
    assert!(format!("{error}").contains("does not match invocation tool"));
}

#[cfg(unix)]
#[test]
fn executor_uses_the_prepared_target_without_resolving_the_logical_path_again() {
    use std::os::unix::fs::symlink;

    let workspace = TempWorkspace::new("prepared-target");
    let first = workspace.0.join("first.txt");
    let second = workspace.0.join("second.txt");
    let alias = workspace.0.join("selected.txt");
    fs::write(&first, "first\n").unwrap();
    fs::write(&second, "second\n").unwrap();
    symlink(&first, &alias).unwrap();
    let prepared = crate::workspace_boundary::WorkspaceBoundary::new(workspace.0.clone())
        .resolve_read("selected.txt")
        .expect("prepare canonical target");

    fs::remove_file(&alias).unwrap();
    symlink(&second, &alias).unwrap();

    let result = FsReadExecutor
        .invoke(
            KernelToolInvocation {
                id: "prepared-target-test".to_string(),
                tool_id: "fs.read".to_string(),
                input: serde_json::json!({ "path": "selected.txt" }),
            },
            context_with_resolved_target(&workspace.0, &prepared),
        )
        .expect("executor consumes the PreparedEffect target");
    assert_eq!(result.output["content"], "first\n");
    assert_eq!(result.output["workspaceId"], "workspace:test");
    assert!(result.output.get("folderId").is_none());
}

#[test]
fn fs_delete_requires_the_closed_target_kind_and_deletes_the_exact_tree() {
    let workspace = TempWorkspace::new("delete-target-kind");
    let directory = workspace.0.join("build/cache");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("entry.txt"), "cache\n").unwrap();

    for input in [
        serde_json::json!({ "path": "build/cache" }),
        serde_json::json!({ "path": "build/cache", "targetKind": "directory" }),
    ] {
        FsDeleteExecutor
            .invoke(
                KernelToolInvocation {
                    id: "delete-invalid-kind".to_string(),
                    tool_id: "fs.delete".to_string(),
                    input,
                },
                context_with_target(&workspace.0, "build/cache"),
            )
            .expect_err("missing or unsupported delete targetKind must fail closed");
        assert!(directory.is_dir());
    }

    let result = FsDeleteExecutor
        .invoke(
            KernelToolInvocation {
                id: "delete-directory-tree".to_string(),
                tool_id: "fs.delete".to_string(),
                input: serde_json::json!({
                    "path": "build/cache",
                    "targetKind": "directoryTree"
                }),
            },
            context_with_target(&workspace.0, "build/cache"),
        )
        .expect("directoryTree deletes the exact PreparedEffect tree");
    assert_eq!(result.output["kind"], "directoryTree");
    assert_eq!(result.output["path"], "build/cache");
    assert!(!directory.exists());
}

#[test]
fn fs_stat_reports_exact_existence_and_fs_list_reports_coverage() {
    let workspace = TempWorkspace::new("stat-and-list-coverage");
    fs::write(workspace.0.join("visible.txt"), "visible\n").unwrap();
    fs::write(workspace.0.join(".hidden.txt"), "hidden\n").unwrap();

    let existing = FsStatExecutor
        .invoke(
            KernelToolInvocation {
                id: "fs-stat-existing".to_string(),
                tool_id: "fs.stat".to_string(),
                input: serde_json::json!({ "path": "visible.txt" }),
            },
            context_with_target(&workspace.0, "visible.txt"),
        )
        .expect("existing path is stat-able");
    assert_eq!(existing.output["exists"], true);
    assert_eq!(existing.output["type"], "file");

    let missing = FsStatExecutor
        .invoke(
            KernelToolInvocation {
                id: "fs-stat-missing".to_string(),
                tool_id: "fs.stat".to_string(),
                input: serde_json::json!({ "path": "missing.txt" }),
            },
            context_with_target(&workspace.0, "missing.txt"),
        )
        .expect("missing path is an exact negative fact");
    assert_eq!(missing.output["exists"], false);

    let list = FsListExecutor
        .invoke(
            KernelToolInvocation {
                id: "fs-list-coverage".to_string(),
                tool_id: "fs.list".to_string(),
                input: serde_json::json!({
                    "path": ".",
                    "depth": 1,
                    "includeHidden": false
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("list reports its enumeration contract");
    assert_eq!(list.output["path"], ".");
    assert_eq!(list.output["requestedDepth"], 1);
    assert_eq!(list.output["includeHidden"], false);
    assert_eq!(list.output["completeAtRequestedDepth"], true);
    assert_eq!(list.output["truncated"], false);
    assert_eq!(list.output["nodes"].as_array().map(Vec::len), Some(1));
}

#[cfg(target_os = "macos")]
#[test]
fn process_shell_runs_in_the_prepared_workspace_cwd_and_writes_workspace() {
    let workspace = TempWorkspace::new("process-shell-cwd");
    fs::create_dir_all(workspace.0.join("build")).unwrap();
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "process-shell-cwd".to_string(),
                tool_id: "process.shell".to_string(),
                input: serde_json::json!({
                    "command": "printf 'stdout-value'; printf 'stderr-value' >&2; printf 'generated' > generated.txt",
                    "cwd": "build",
                    "timeoutMs": 5000,
                    "maxOutputBytes": 4096
                }),
            },
            context_with_target(&workspace.0, "build"),
        )
        .expect("bounded shell command runs in its prepared workspace cwd");

    assert_eq!(result.output["workspaceId"], "workspace:test");
    assert_eq!(result.output["cwd"], "build");
    assert_eq!(result.output["stdout"], "stdout-value");
    assert_eq!(result.output["stderr"], "stderr-value");
    assert_eq!(result.output["exitCode"], 0);
    assert_eq!(result.output["success"], true);
    assert_eq!(result.output["timedOut"], false);
    assert_eq!(result.output["truncated"], false);
    assert_eq!(result.output["environment"]["shell"], "/bin/sh");
    assert_eq!(result.output["environment"]["interactive"], false);
    assert_eq!(
        result.output["environment"]["pathSource"],
        "hostPlusStandardDeveloperPaths"
    );
    assert_eq!(
        result.output["environment"]["writeScope"],
        "workspaceAndKernelTemporary"
    );
    assert_eq!(result.output["environment"]["homeWritable"], false);
    assert_eq!(
        fs::read_to_string(workspace.0.join("build/generated.txt")).unwrap(),
        "generated"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn process_shell_uses_and_cleans_a_kernel_owned_temporary_directory() {
    let workspace = TempWorkspace::new("process-shell-temporary");
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "process-shell-temporary".to_string(),
                tool_id: "process.shell".to_string(),
                input: serde_json::json!({
                    "command": "printf '%s' \"$TMPDIR\"; printf temporary > \"$TMPDIR/owned.txt\"",
                    "cwd": ".",
                    "timeoutMs": 5000,
                    "maxOutputBytes": 4096
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("process shell temporary directory is writable");

    let temporary = result.output["stdout"]
        .as_str()
        .expect("temporary directory is reported");
    assert!(temporary.contains("deepcode-agent-shell-"));
    assert!(!Path::new(temporary).exists());
    assert!(!workspace.0.join("owned.txt").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn process_shell_denies_file_writes_outside_the_bound_workspace() {
    let workspace = TempWorkspace::new("process-shell-write-boundary");
    let outside = TempWorkspace::new("process-shell-write-outside");
    let outside_target = outside.0.join("denied.txt");
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "process-shell-write-boundary".to_string(),
                tool_id: "process.shell".to_string(),
                input: serde_json::json!({
                    "command": format!("printf denied > '{}'", outside_target.display()),
                    "cwd": ".",
                    "timeoutMs": 5000,
                    "maxOutputBytes": 4096
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("workspace sandbox reports command denial as a bounded process result");

    assert_eq!(result.output["success"], false);
    assert_ne!(result.output["exitCode"], 0);
    assert!(!outside_target.exists());
}

#[cfg(unix)]
#[test]
fn process_shell_rejects_a_prepared_cwd_outside_the_workspace() {
    use std::os::unix::fs::symlink;

    let workspace = TempWorkspace::new("process-shell-boundary");
    let outside = TempWorkspace::new("process-shell-outside");
    symlink(&outside.0, workspace.0.join("escape")).unwrap();
    let error = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "process-shell-outside".to_string(),
                tool_id: "process.shell".to_string(),
                input: serde_json::json!({
                    "command": "printf should-not-run",
                    "cwd": "escape",
                    "timeoutMs": 5000,
                    "maxOutputBytes": 4096
                }),
            },
            context_with_resolved_target(&workspace.0, &outside.0),
        )
        .expect_err("prepared cwd outside the workspace must be rejected");
    assert!(format!("{error}").contains("outside workspace"));
}

#[cfg(unix)]
#[test]
fn process_shell_requires_the_workspace_identity_before_spawn() {
    let workspace = TempWorkspace::new("process-shell-workspace-identity");
    let mut execution_context = context_with_target(&workspace.0, ".");
    execution_context.workspace_id = None;
    let error = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "process-shell-workspace-identity".to_string(),
                tool_id: "process.shell".to_string(),
                input: serde_json::json!({
                    "command": "printf ran > marker.txt",
                    "cwd": ".",
                    "timeoutMs": 5000,
                    "maxOutputBytes": 4096
                }),
            },
            execution_context,
        )
        .expect_err("missing workspace identity must fail before process spawn");

    assert!(matches!(error, KernelError::MissingWorkspaceBinding));
    assert!(!workspace.0.join("marker.txt").exists());
}

#[test]
fn process_shell_environment_excludes_credentials_and_host_control_channels() {
    for key in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "SSH_AUTH_SOCK",
        "DOCKER_HOST",
    ] {
        assert!(!process::agent_shell_environment_key_allowed(key), "{key}");
    }
    for key in ["PATH", "HOME", "CARGO_HOME", "PNPM_HOME", "TMPDIR"] {
        assert!(process::agent_shell_environment_key_allowed(key), "{key}");
    }
}

#[cfg(unix)]
#[test]
fn process_shell_path_adds_existing_user_tools_without_losing_host_path() {
    let home = TempWorkspace::new("process-shell-path-home");
    fs::create_dir_all(home.0.join("bin")).unwrap();
    let path =
        process::composed_agent_shell_path_for_test(&home.0, std::ffi::OsStr::new("/usr/bin:/bin"));
    let entries = std::env::split_paths(&path).collect::<Vec<_>>();
    assert_eq!(entries.first(), Some(&home.0.join("bin")));
    assert!(entries.contains(&PathBuf::from("/usr/bin")));
    assert!(entries.contains(&PathBuf::from("/bin")));
}

#[cfg(target_os = "macos")]
#[test]
fn process_shell_bounds_time_and_combined_output() {
    let workspace = TempWorkspace::new("process-shell-bounds");
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "process-shell-bounds".to_string(),
                tool_id: "process.shell".to_string(),
                input: serde_json::json!({
                    "command": "i=0; while [ \"$i\" -lt 500 ]; do printf 1234567890; i=$((i+1)); done; sleep 1; printf late > late.txt",
                    "cwd": ".",
                    "timeoutMs": 100,
                    "maxOutputBytes": 1024
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("timeout is a completed bounded process result");

    assert_eq!(result.output["timedOut"], true);
    assert_eq!(result.output["success"], false);
    assert_eq!(result.output["truncated"], true);
    assert!(result.output["capturedBytes"].as_u64().unwrap() <= 1024);
    assert!(!workspace.0.join("late.txt").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn process_shell_terminates_detached_descendant_without_waiting_for_its_pipe() {
    let workspace = TempWorkspace::new("process-shell-detached-pipe");
    let started = std::time::Instant::now();
    let result = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "process-shell-detached-pipe".to_string(),
                tool_id: "process.shell".to_string(),
                input: serde_json::json!({
                    "command": "/usr/bin/python3 -c 'import os,pathlib,time; r,w=os.pipe(); p=os.fork(); (os.close(r), os.setsid(), os.environ.clear(), pathlib.Path(\"detached.pid\").write_text(str(os.getpid())), os.write(w,b\"1\"), time.sleep(3)) if p == 0 else (os.close(w), os.read(r,1))'",
                    "cwd": ".",
                    "timeoutMs": 500,
                    "maxOutputBytes": 4096
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect("a detached descendant holding the pipe cannot retain the tool call");

    assert_eq!(result.output["success"], true);
    assert_eq!(result.output["timedOut"], false);
    assert!(
        started.elapsed() < std::time::Duration::from_millis(1_500),
        "output readers remained attached to a detached descendant"
    );
    let detached_pid: i32 = fs::read_to_string(workspace.0.join("detached.pid"))
        .expect("detached descendant reports its exact pid")
        .parse()
        .expect("detached pid is numeric");
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    let disappeared = loop {
        let result = unsafe { libc::kill(detached_pid, 0) };
        if result < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            break true;
        }
        if std::time::Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    if !disappeared {
        unsafe {
            libc::kill(detached_pid, libc::SIGKILL);
        }
    }
    assert!(
        disappeared,
        "process.shell returned while detached pid {detached_pid} was still alive"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn process_shell_scope_requires_the_unique_deny_delta() {
    assert!(process::scope_membership_from_checks(1, 0));
    assert!(!process::scope_membership_from_checks(0, 0));
    assert!(!process::scope_membership_from_checks(1, 1));
}

#[test]
fn process_shell_rechecks_the_narrow_hard_deny_at_execution() {
    let workspace = TempWorkspace::new("process-shell-hard-deny");
    let error = ProcessShellExecutor
        .invoke(
            KernelToolInvocation {
                id: "process-shell-hard-deny".to_string(),
                tool_id: "process.shell".to_string(),
                input: serde_json::json!({
                    "command": "rm -rf /",
                    "cwd": ".",
                    "timeoutMs": 5000,
                    "maxOutputBytes": 4096
                }),
            },
            context_with_target(&workspace.0, "."),
        )
        .expect_err("system-root cleanup must be rejected before spawn");
    assert!(matches!(
        error,
        KernelError::Structured {
            code: "process_shell_hard_denied",
            ..
        }
    ));
}

#[test]
fn catalog_tools_have_exactly_one_runtime_binding() {
    let registry = KernelToolRegistry::default();
    let executors = builtin_executors(
        &registry,
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    );
    let binding_ids = executors
        .iter()
        .map(|(tool_id, _)| (*tool_id).to_string())
        .collect::<Vec<_>>();
    let unique_binding_ids = binding_ids
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(binding_ids.len(), unique_binding_ids.len());

    for descriptor in registry.descriptors().filter(|descriptor| {
        descriptor.availability == deepcode_kernel_tools::ToolAvailability::Callable
    }) {
        let binding_count = binding_ids
            .iter()
            .filter(|tool_id| tool_id.as_str() == descriptor.name)
            .count();
        assert_eq!(
            binding_count, 1,
            "tool {} has {binding_count} runtime binding(s)",
            descriptor.name
        );
    }
}

#[test]
fn web_urls_reject_embedded_credentials() {
    assert!(format!(
        "{}",
        validate_http_url("https://user:secret@example.invalid").unwrap_err()
    )
    .contains("credential-bearing"));
}

#[test]
fn controlled_http_backend_returns_untrusted_evidence() {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    fn endpoint(
        body: &'static str,
        content_type: &'static str,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind temporary endpoint");
        let address = listener.local_addr().expect("temporary endpoint address");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept temporary request");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .expect("write temporary response");
        });
        (format!("http://{address}"), handle)
    }

    let (search_url, search_server) = endpoint(
        r#"{"results":[{"title":"Result","url":"https://example.invalid/item","snippet":"Summary"}]}"#,
        "application/json",
    );
    let search = WebSearchExecutor {
        config: KernelExecutorConfig {
            web_search_endpoint_template: format!("{search_url}/?q={{query}}&limit={{limit}}"),
            ..KernelExecutorConfig::default()
        },
        secret_provider: Arc::new(EmptySecretProvider),
    }
    .invoke(
        KernelToolInvocation {
            id: "web-search-test".to_string(),
            tool_id: "web.search".to_string(),
            input: serde_json::json!({
                "query": "generic",
                "limit": 1
            }),
        },
        context(Path::new(".")),
    )
    .expect("web search succeeds against temporary endpoint");
    search_server.join().expect("search endpoint exits");
    assert_eq!(search.output["untrustedEvidence"], true);
    assert_eq!(search.output["results"].as_array().map(Vec::len), Some(1));

    let (fetch_url, fetch_server) = endpoint("temporary evidence", "text/plain");
    let fetch = WebFetchExecutor
        .invoke(
            KernelToolInvocation {
                id: "web-fetch-test".to_string(),
                tool_id: "web.fetch".to_string(),
                input: serde_json::json!({
                    "url": fetch_url
                }),
            },
            context(Path::new(".")),
        )
        .expect("web fetch succeeds against temporary endpoint");
    fetch_server.join().expect("fetch endpoint exits");
    assert_eq!(fetch.output["untrustedEvidence"], true);
    assert_eq!(fetch.output["content"], "temporary evidence");
}

#[test]
fn default_web_search_uses_builtin_rss_backend_and_typed_results() {
    let target = web_search_target_url(&KernelExecutorConfig::default(), "AI news", 3)
        .expect("default web search target");
    assert_eq!(
        target,
        "https://www.bing.com/search?format=rss&q=AI+news&count=3"
    );

    let results = parse_bing_rss_results(
        r#"<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0"><channel>
          <item>
            <title>First result</title>
            <link>https://example.com/first</link>
            <description>First summary</description>
            <pubDate>Fri, 28 Aug 2026 18:42:00 GMT</pubDate>
          </item>
          <item>
            <title>Second result</title>
            <link>https://example.com/second</link>
            <description>Second summary</description>
          </item>
        </channel></rss>"#,
        1,
    )
    .expect("parse built-in RSS result");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["backendId"], "bingRss");
    assert_eq!(results[0]["title"], "First result");
    assert_eq!(results[0]["url"], "https://example.com/first");
    assert_eq!(results[0]["untrustedEvidence"], true);
}

#[test]
fn github_and_arxiv_adapters_return_typed_source_facts() {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    fn endpoint(body: String, content_type: &'static str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind temporary endpoint");
        let address = listener.local_addr().expect("temporary endpoint address");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept temporary request");
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nX-RateLimit-Limit: 60\r\nX-RateLimit-Remaining: 59\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("write temporary response");
        });
        (format!("http://{address}"), handle)
    }

    let (github_search_base, github_search_server) = endpoint(
        serde_json::json!({
            "total_count": 1,
            "incomplete_results": false,
            "items": [{
                "full_name": "deepcode/project",
                "html_url": "https://github.com/deepcode/project",
                "description": "Project source",
                "updated_at": "2026-08-29T00:00:00Z"
            }]
        })
        .to_string(),
        "application/json",
    );
    let github_search = GithubSearchExecutor {
        config: KernelExecutorConfig {
            github_api_base_url: github_search_base,
            ..KernelExecutorConfig::default()
        },
        secret_provider: Arc::new(EmptySecretProvider),
    }
    .invoke(
        KernelToolInvocation {
            id: "github-search-test".to_string(),
            tool_id: "github.search".to_string(),
            input: serde_json::json!({
                "query": "deepcode",
                "kind": "repositories",
                "page": 1,
                "limit": 10
            }),
        },
        context(Path::new(".")),
    )
    .expect("GitHub search adapter parses typed results");
    github_search_server
        .join()
        .expect("GitHub search endpoint exits");
    assert_eq!(github_search.output["backendId"], "github");
    assert_eq!(
        github_search.output["results"][0]["repository"],
        "deepcode/project"
    );
    assert_eq!(github_search.output["rateLimit"]["remaining"], 59);

    let (github_read_base, github_read_server) = endpoint(
        serde_json::json!({
            "type": "file",
            "name": "README.md",
            "path": "README.md",
            "sha": "abc",
            "size": 6,
            "encoding": "base64",
            "content": "aGVsbG8K",
            "html_url": "https://github.com/deepcode/project/blob/main/README.md",
            "download_url": "https://raw.githubusercontent.com/deepcode/project/main/README.md"
        })
        .to_string(),
        "application/json",
    );
    let github_read = GithubReadExecutor {
        config: KernelExecutorConfig {
            github_api_base_url: github_read_base,
            ..KernelExecutorConfig::default()
        },
        secret_provider: Arc::new(EmptySecretProvider),
    }
    .invoke(
        KernelToolInvocation {
            id: "github-read-test".to_string(),
            tool_id: "github.read".to_string(),
            input: serde_json::json!({
                "repository": "deepcode/project",
                "path": "README.md",
                "maxBytes": 4096
            }),
        },
        context(Path::new(".")),
    )
    .expect("GitHub read adapter decodes text content");
    github_read_server
        .join()
        .expect("GitHub read endpoint exits");
    assert_eq!(github_read.output["content"], "hello\n");
    assert_eq!(github_read.output["type"], "file");

    let atom = r#"<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom"
            xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
            xmlns:arxiv="http://arxiv.org/schemas/atom">
        <opensearch:totalResults>1</opensearch:totalResults>
        <entry>
          <id>https://arxiv.org/abs/2608.00001v1</id>
          <updated>2026-08-29T00:00:00Z</updated>
          <published>2026-08-29T00:00:00Z</published>
          <title>  Typed   Agent Tools </title>
          <summary> Source grounded tool contracts. </summary>
          <author><name>Example Author</name></author>
          <arxiv:primary_category term="cs.SE" />
          <category term="cs.SE" />
          <link title="pdf" href="https://arxiv.org/pdf/2608.00001v1" type="application/pdf" />
        </entry>
      </feed>"#;
    let (arxiv_base, arxiv_server) = endpoint(atom.to_string(), "application/atom+xml");
    let arxiv = ArxivSearchExecutor {
        config: KernelExecutorConfig {
            arxiv_api_base_url: arxiv_base,
            ..KernelExecutorConfig::default()
        },
    }
    .invoke(
        KernelToolInvocation {
            id: "arxiv-search-test".to_string(),
            tool_id: "arxiv.search".to_string(),
            input: serde_json::json!({
                "query": "agent tools",
                "field": "all",
                "start": 0,
                "limit": 10,
                "sortBy": "relevance",
                "sortOrder": "descending"
            }),
        },
        context(Path::new(".")),
    )
    .expect("arXiv adapter parses Atom metadata");
    arxiv_server.join().expect("arXiv endpoint exits");
    assert_eq!(arxiv.output["backendId"], "arxiv");
    assert_eq!(arxiv.output["results"][0]["arxivId"], "2608.00001v1");
    assert_eq!(arxiv.output["results"][0]["title"], "Typed Agent Tools");
}

#[test]
fn github_code_search_requires_and_uses_the_runtime_credential() {
    let missing = GithubSearchExecutor {
        config: KernelExecutorConfig::default(),
        secret_provider: Arc::new(EmptySecretProvider),
    }
    .invoke(
        KernelToolInvocation {
            id: "github-code-auth-missing".to_string(),
            tool_id: "github.search".to_string(),
            input: serde_json::json!({
                "query": "KernelToolRegistry",
                "kind": "code"
            }),
        },
        context(Path::new(".")),
    )
    .expect_err("code search without the startup credential must be explicit");
    assert!(matches!(
        missing,
        KernelError::Structured {
            code: "github_code_search_auth_required",
            ..
        }
    ));

    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::mpsc;
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind GitHub code fixture");
    let address = listener.local_addr().expect("GitHub code fixture address");
    let (request_tx, request_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept GitHub code request");
        let mut request = [0_u8; 8192];
        let read = stream.read(&mut request).expect("read GitHub code request");
        request_tx
            .send(String::from_utf8_lossy(&request[..read]).to_string())
            .expect("capture GitHub code request");
        let body = serde_json::json!({
            "total_count": 1,
            "incomplete_results": false,
            "items": [{
                "name": "catalog.rs",
                "path": "src/catalog.rs",
                "html_url": "https://github.com/deepcode/project/blob/main/src/catalog.rs",
                "repository": { "full_name": "deepcode/project" }
            }]
        })
        .to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .expect("write GitHub code response");
    });
    let result = GithubSearchExecutor {
        config: KernelExecutorConfig {
            github_api_base_url: format!("http://{address}"),
            github_auth_secret_ref: "runtime:github-token".to_string(),
            ..KernelExecutorConfig::default()
        },
        secret_provider: Arc::new(StaticSecretProvider {
            secret_ref: "runtime:github-token",
            value: "test-token",
        }),
    }
    .invoke(
        KernelToolInvocation {
            id: "github-code-auth".to_string(),
            tool_id: "github.search".to_string(),
            input: serde_json::json!({
                "query": "KernelToolRegistry",
                "kind": "code"
            }),
        },
        context(Path::new(".")),
    )
    .expect("authenticated code search succeeds");
    server.join().expect("GitHub code fixture exits");
    let request = request_rx.recv().expect("GitHub request was captured");
    assert!(request
        .to_ascii_lowercase()
        .contains("authorization: bearer test-token\r\n"));
    assert_eq!(result.output["results"][0]["path"], "src/catalog.rs");
}

#[test]
fn document_read_extracts_text_from_generated_pdf() {
    let workspace = TempWorkspace::new("pdf-read");
    let path = workspace.0.join("sample.pdf");
    fs::write(&path, minimal_pdf("Kernel document fact")).unwrap();
    let result = DocumentReadExecutor
        .invoke(
            KernelToolInvocation {
                id: "document-read-test".to_string(),
                tool_id: "document.read".to_string(),
                input: serde_json::json!({ "path": "sample.pdf", "startPage": 1, "endPage": 1 }),
            },
            context_with_target(&workspace.0, "sample.pdf"),
        )
        .expect("generated PDF is readable");
    assert!(result.output["text"]
        .as_str()
        .is_some_and(|value| value.contains("Kernel document fact")));
}

fn minimal_pdf(text: &str) -> Vec<u8> {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)");
    let content = format!("BT\n/F1 12 Tf\n72 720 Td\n({escaped}) Tj\nET\n");
    let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            format!("<< /Length {} >>\nstream\n{content}endstream", content.len()),
        ];

    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
    }

    let xref = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    pdf.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    pdf
}
