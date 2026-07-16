use super::*;
use deepcode_kernel_skills::SkillExecutorRegistry;
use deepcode_kernel_tools::OperationExecutionMode;

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

fn context(root: &Path) -> SkillExecutionContext {
    SkillExecutionContext {
        run_id: Some("run-test".to_string()),
        session_id: Some("session-test".to_string()),
        trust_mode: deepcode_kernel_skills::SkillTrustMode::Declarative,
        approved_capabilities: Vec::new(),
        workspace_root: Some(root.to_string_lossy().to_string()),
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
fn blocked_tools_have_no_runtime_executor_binding() {
    let registry = SkillExecutorRegistry::from_executors(builtin_executors(
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    ));
    let error = registry
        .invoke(
            SkillInvocation {
                id: "blocked-browser".to_string(),
                run_id: None,
                session_id: None,
                skill_id: "browser.open".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({ "url": "https://example.invalid" }),
            },
            context(Path::new(".")),
        )
        .expect_err("blocked tools must not have executable bindings");
    assert!(format!("{error}").contains("unknown skill"));
}

#[test]
fn executable_tool_contracts_have_exactly_one_runtime_binding() {
    let executors = builtin_executors(
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    );
    let binding_ids = executors
        .iter()
        .map(|executor| executor.descriptor().id)
        .collect::<Vec<_>>();
    let unique_binding_ids = binding_ids
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(binding_ids.len(), unique_binding_ids.len());

    for template in KernelToolRegistry::default().templates() {
        let binding_count = binding_ids
            .iter()
            .filter(|tool_id| tool_id.as_str() == template.tool_id)
            .count();
        match template.execution.execution_mode {
            OperationExecutionMode::Execute => assert_eq!(
                binding_count, 1,
                "executable tool {} requires exactly one runtime binding",
                template.tool_id
            ),
            OperationExecutionMode::PreviewOnly | OperationExecutionMode::Blocked => {
                assert_eq!(
                    binding_count, 0,
                    "non-executable tool {} must not have a runtime binding",
                    template.tool_id
                );
            }
        }
    }
}

#[test]
fn web_urls_reject_credentials_and_metadata_endpoints() {
    assert!(format!(
        "{}",
        validate_http_url("https://user:secret@example.invalid").unwrap_err()
    )
    .contains("credential-bearing"));
    assert!(format!(
        "{}",
        validate_http_url("http://169.254.169.254/latest/meta-data").unwrap_err()
    )
    .contains("metadata"));
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
        SkillInvocation {
            id: "web-search-test".to_string(),
            run_id: None,
            session_id: None,
            skill_id: "web.search".to_string(),
            phase: Some("complete".to_string()),
            input: serde_json::json!({
                "query": "generic",
                "limit": 1,
                "kernelReviewedTarget": crate::network_policy::review_http_target(
                    &format!("{search_url}/?q=generic&limit=1")
                ).expect("review temporary search endpoint")
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
            SkillInvocation {
                id: "web-fetch-test".to_string(),
                run_id: None,
                session_id: None,
                skill_id: "web.fetch".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({
                    "url": fetch_url,
                    "kernelReviewedTarget": crate::network_policy::review_http_target(&fetch_url)
                        .expect("review temporary fetch endpoint")
                }),
            },
            context(Path::new(".")),
        )
        .expect("web fetch succeeds against temporary endpoint");
    fetch_server.join().expect("fetch endpoint exits");
    assert_eq!(fetch.output["untrustedEvidence"], true);
    assert_eq!(fetch.output["content"], "temporary evidence");
}

#[tokio::test(flavor = "current_thread")]
async fn controlled_http_backend_is_safe_inside_tokio_runtime() {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind temporary endpoint");
    let address = listener.local_addr().expect("temporary endpoint address");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept temporary request");
        let mut request = [0_u8; 2048];
        let _ = stream.read(&mut request);
        let body = "runtime-safe evidence";
        write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("write temporary response");
    });

    let result = WebFetchExecutor
        .invoke(
            SkillInvocation {
                id: "web-fetch-runtime-test".to_string(),
                run_id: None,
                session_id: None,
                skill_id: "web.fetch".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({
                    "url": format!("http://{address}"),
                    "kernelReviewedTarget": crate::network_policy::review_http_target(
                        &format!("http://{address}")
                    ).expect("review temporary runtime endpoint")
                }),
            },
            context(Path::new(".")),
        )
        .expect("web fetch succeeds from a Tokio runtime context");

    server.join().expect("temporary endpoint exits");
    assert_eq!(result.output["untrustedEvidence"], true);
    assert_eq!(result.output["content"], "runtime-safe evidence");
}

#[test]
fn supervised_git_backend_reports_real_repository_status() {
    let workspace = TempWorkspace::new("git-status");
    git_output(&workspace.0, &["init"]).expect("initialize repository");
    git_output(&workspace.0, &["config", "user.name", "DeepCode Test"])
        .expect("set repository identity");
    git_output(
        &workspace.0,
        &["config", "user.email", "test@example.invalid"],
    )
    .expect("set repository identity email");
    fs::write(workspace.0.join("tracked.txt"), "content\n").unwrap();

    let result = GitStatusExecutor
        .invoke(
            SkillInvocation {
                id: "git-status-test".to_string(),
                run_id: Some("run-test".to_string()),
                session_id: Some("session-test".to_string()),
                skill_id: "git.status".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({}),
            },
            context(&workspace.0),
        )
        .expect("git status executor succeeds");
    assert!(result.output["changes"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));
}

#[test]
fn supervised_git_backend_runs_v1_write_workflow() {
    let workspace = TempWorkspace::new("git-write-workflow");
    git_output(&workspace.0, &["init"]).expect("initialize repository");
    git_output(&workspace.0, &["config", "user.name", "DeepCode Test"])
        .expect("set repository identity");
    git_output(
        &workspace.0,
        &["config", "user.email", "test@example.invalid"],
    )
    .expect("set repository identity email");
    fs::write(workspace.0.join("tracked.txt"), "initial\n").unwrap();
    git_output(&workspace.0, &["add", "--", "tracked.txt"]).expect("stage initial file");
    git_output(&workspace.0, &["commit", "-m", "initial"]).expect("commit initial file");
    fs::write(workspace.0.join("tracked.txt"), "updated\n").unwrap();
    let context = context(&workspace.0);

    let diff = GitDiffExecutor
        .invoke(
            SkillInvocation {
                id: "git-diff-test".to_string(),
                run_id: None,
                session_id: None,
                skill_id: "git.diff".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({ "path": "tracked.txt" }),
            },
            context.clone(),
        )
        .expect("git diff succeeds");
    assert!(diff.output["diff"]
        .as_str()
        .is_some_and(|value| value.contains("updated")));

    GitStageExecutor
        .invoke(
            SkillInvocation {
                id: "git-stage-test".to_string(),
                run_id: None,
                session_id: None,
                skill_id: "git.stage".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({ "paths": ["tracked.txt"] }),
            },
            context.clone(),
        )
        .expect("git stage succeeds");
    GitUnstageExecutor
        .invoke(
            SkillInvocation {
                id: "git-unstage-test".to_string(),
                run_id: None,
                session_id: None,
                skill_id: "git.unstage".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({ "paths": ["tracked.txt"] }),
            },
            context.clone(),
        )
        .expect("git unstage succeeds");
    GitStageExecutor
        .invoke(
            SkillInvocation {
                id: "git-restage-test".to_string(),
                run_id: None,
                session_id: None,
                skill_id: "git.stage".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({ "paths": ["tracked.txt"] }),
            },
            context.clone(),
        )
        .expect("git restage succeeds");
    let commit = GitCommitExecutor
        .invoke(
            SkillInvocation {
                id: "git-commit-test".to_string(),
                run_id: None,
                session_id: None,
                skill_id: "git.commit".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({ "message": "update tracked content" }),
            },
            context,
        )
        .expect("git commit succeeds");
    assert_eq!(commit.output["committed"], true);
    assert!(commit.output["commitSha"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
}

#[test]
fn document_read_extracts_text_from_generated_pdf() {
    let workspace = TempWorkspace::new("pdf-read");
    let path = workspace.0.join("sample.pdf");
    fs::write(&path, minimal_pdf("Kernel document fact")).unwrap();
    let result = DocumentReadExecutor
        .invoke(
            SkillInvocation {
                id: "document-read-test".to_string(),
                run_id: Some("run-test".to_string()),
                session_id: Some("session-test".to_string()),
                skill_id: "document.read".to_string(),
                phase: Some("complete".to_string()),
                input: serde_json::json!({ "path": "sample.pdf", "startPage": 1, "endPage": 1 }),
            },
            context(&workspace.0),
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
