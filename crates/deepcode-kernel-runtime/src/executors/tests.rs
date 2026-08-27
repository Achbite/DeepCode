use super::*;
use std::thread;

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

    for descriptor in registry.descriptors() {
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
