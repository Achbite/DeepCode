use crate::*;

pub(crate) const EXTERNAL_ENDPOINT_ENV: &str = "DEEPCODE_VERIFY_EXTERNAL_ENDPOINT";

pub(crate) struct VerifyWorkspaceGuard(pub(crate) PathBuf);

impl Drop for VerifyWorkspaceGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) struct VerifyTemplateContext {
    workspace: String,
    random_file: String,
    random_directory: String,
    random_name: String,
    external_endpoint: Option<String>,
}

impl VerifyTemplateContext {
    pub(crate) fn new(workspace: &Path) -> Self {
        let random_name = unique_cli_id();
        Self {
            workspace: workspace.to_string_lossy().to_string(),
            random_file: format!("file-{random_name}.txt"),
            random_directory: format!("directory-{random_name}"),
            external_endpoint: env::var(EXTERNAL_ENDPOINT_ENV)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            random_name,
        }
    }
}

pub(crate) fn expand_verify_case(
    value: Value,
    context: &VerifyTemplateContext,
) -> Result<Value, Value> {
    match value {
        Value::String(value) => expand_verify_string(value, context).map(Value::String),
        Value::Array(values) => values
            .into_iter()
            .map(|value| expand_verify_case(value, context))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(values) => values
            .into_iter()
            .map(|(key, value)| expand_verify_case(value, context).map(|value| (key, value)))
            .collect::<Result<serde_json::Map<_, _>, _>>()
            .map(Value::Object),
        value => Ok(value),
    }
}

fn expand_verify_string(
    mut value: String,
    context: &VerifyTemplateContext,
) -> Result<String, Value> {
    for (placeholder, replacement) in [
        ("${WORKSPACE}", context.workspace.as_str()),
        ("${RANDOM_FILE}", context.random_file.as_str()),
        ("${RANDOM_DIR}", context.random_directory.as_str()),
        ("${RANDOM_NAME}", context.random_name.as_str()),
    ] {
        value = value.replace(placeholder, replacement);
    }
    if value.contains("${EXTERNAL_ENDPOINT}") {
        let Some(endpoint) = context.external_endpoint.as_deref() else {
            return Err(serde_json::json!({
                "outcome": "blocked",
                "code": "external_endpoint_unconfigured",
                "environmentVariable": EXTERNAL_ENDPOINT_ENV
            }));
        };
        value = value.replace("${EXTERNAL_ENDPOINT}", endpoint);
    }
    Ok(value)
}

pub(crate) fn initialize_verify_git_repository(root: &Path) -> Result<(), String> {
    for argv in [
        ["init", "--quiet"].as_slice(),
        ["config", "user.name", "DeepCode CLI Verify"].as_slice(),
        ["config", "user.email", "verify@localhost"].as_slice(),
    ] {
        run_git_setup(root, argv)?;
    }
    Ok(())
}

pub(crate) fn prepare_verify_case_resources(root: &Path, case: &Value) -> Result<(), String> {
    for directory in case
        .get("setupDirectories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = directory
            .as_str()
            .ok_or_else(|| "setupDirectories[] must contain strings".to_string())?;
        let target = verify_resource_path(root, path)?;
        fs::create_dir_all(&target)
            .map_err(|error| format!("create setup directory {}: {error}", target.display()))?;
    }

    prepare_verify_files(root, case, "setupFiles")?;

    for document in case
        .get("setupPdfs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = document
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "setupPdfs[].path is required".to_string())?;
        let text = document
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("Kernel document verification");
        let target = verify_resource_path(root, path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create PDF directory {}: {error}", parent.display()))?;
        }
        fs::write(&target, minimal_pdf(text))
            .map_err(|error| format!("write setup PDF {}: {error}", target.display()))?;
    }

    prepare_verify_symlinks(root, case)?;

    if case
        .get("setupGitSnapshot")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        run_git_setup(root, &["add", "--all"])?;
        run_git_setup(root, &["commit", "--quiet", "-m", "verification snapshot"])?;
    }
    prepare_verify_files(root, case, "setupFilesAfterGitSnapshot")?;
    for path in case
        .get("setupGitStagePaths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = path
            .as_str()
            .ok_or_else(|| "setupGitStagePaths[] must contain strings".to_string())?;
        let _ = verify_resource_path(root, path)?;
        run_git_setup(root, &["add", "--", path])?;
    }
    Ok(())
}

fn prepare_verify_files(root: &Path, case: &Value, field: &str) -> Result<(), String> {
    for file in case
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = file
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{field}[].path is required"))?;
        let target = verify_resource_path(root, path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create setup directory {}: {error}", parent.display()))?;
        }
        let content = setup_file_content(file)?;
        fs::write(&target, content)
            .map_err(|error| format!("write setup file {}: {error}", target.display()))?;
    }
    Ok(())
}

fn setup_file_content(file: &Value) -> Result<Vec<u8>, String> {
    if let Some(lines) = file.get("contentLines").and_then(Value::as_array) {
        return lines
            .iter()
            .map(|line| {
                line.as_str()
                    .ok_or_else(|| "setup file contentLines must contain strings".to_string())
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|lines| lines.join("\n").into_bytes());
    }
    if let Some(bytes) = file.get("contentBytes").and_then(Value::as_array) {
        return bytes
            .iter()
            .map(|byte| {
                byte.as_u64()
                    .filter(|value| *value <= u8::MAX as u64)
                    .map(|value| value as u8)
                    .ok_or_else(|| {
                        "setup file contentBytes must contain integers from 0 through 255"
                            .to_string()
                    })
            })
            .collect();
    }
    Err("setupFiles[] requires contentLines or contentBytes".to_string())
}

#[cfg(unix)]
fn prepare_verify_symlinks(root: &Path, case: &Value) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    for link in case
        .get("setupSymlinks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = link
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "setupSymlinks[].path is required".to_string())?;
        let target = link
            .get("target")
            .and_then(Value::as_str)
            .ok_or_else(|| "setupSymlinks[].target is required".to_string())?;
        let link_path = verify_resource_path(root, path)?;
        let target_path = verify_resource_path(root, target)?;
        if let Some(parent) = link_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("create symlink directory {}: {error}", parent.display())
            })?;
        }
        symlink(&target_path, &link_path).map_err(|error| {
            format!(
                "create setup symlink {} -> {}: {error}",
                link_path.display(),
                target_path.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn prepare_verify_symlinks(_root: &Path, case: &Value) -> Result<(), String> {
    if case
        .get("setupSymlinks")
        .and_then(Value::as_array)
        .is_some_and(|links| !links.is_empty())
    {
        return Err("setupSymlinks is unsupported on this platform".to_string());
    }
    Ok(())
}

fn verify_resource_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(format!(
            "setup resource path must stay inside verify workspace: {path}"
        ));
    }
    Ok(root.join(relative))
}

fn run_git_setup(root: &Path, argv: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .args(argv)
        .current_dir(root)
        .output()
        .map_err(|error| format!("start git {}: {error}", argv.join(" ")))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "git {} failed: {}",
        argv.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn minimal_pdf(text: &str) -> Vec<u8> {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)");
    let stream = format!("BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated_root() -> VerifyWorkspaceGuard {
        let path = env::temp_dir().join(format!("deepcode-cli-verify-{}", unique_cli_id()));
        fs::create_dir(&path).expect("create isolated verification root");
        VerifyWorkspaceGuard(path)
    }

    #[test]
    fn expands_runtime_placeholders_without_project_specific_values() {
        let root = isolated_root();
        let context = VerifyTemplateContext {
            workspace: root.0.to_string_lossy().to_string(),
            random_file: "generated-file.txt".to_string(),
            random_directory: "generated-directory".to_string(),
            random_name: "generated-name".to_string(),
            external_endpoint: Some("http://127.0.0.1:34567".to_string()),
        };
        let expanded = expand_verify_case(
            serde_json::json!({
                "workspace": "${WORKSPACE}",
                "file": "${RANDOM_FILE}",
                "directory": "${RANDOM_DIR}",
                "name": "${RANDOM_NAME}",
                "url": "${EXTERNAL_ENDPOINT}/resource"
            }),
            &context,
        )
        .expect("expand verification template");
        assert_eq!(expanded["workspace"], context.workspace);
        assert_eq!(expanded["file"], context.random_file);
        assert_eq!(expanded["directory"], context.random_directory);
        assert_eq!(expanded["name"], context.random_name);
        assert_eq!(expanded["url"], "http://127.0.0.1:34567/resource");
    }

    #[test]
    fn missing_external_endpoint_is_a_structured_blocked_result() {
        let root = isolated_root();
        let context = VerifyTemplateContext {
            workspace: root.0.to_string_lossy().to_string(),
            random_file: "file.txt".to_string(),
            random_directory: "directory".to_string(),
            random_name: "name".to_string(),
            external_endpoint: None,
        };
        let blocked = expand_verify_case(
            serde_json::json!({ "url": "${EXTERNAL_ENDPOINT}/resource" }),
            &context,
        )
        .expect_err("missing endpoint must block verification case");
        assert_eq!(blocked["outcome"], "blocked");
        assert_eq!(blocked["code"], "external_endpoint_unconfigured");
    }

    #[test]
    fn prepares_dynamic_pdf_and_rejects_parent_traversal() {
        let root = isolated_root();
        prepare_verify_case_resources(
            &root.0,
            &serde_json::json!({
                "setupDirectories": ["documents"],
                "setupPdfs": [{"path": "documents/input.pdf", "text": "runtime fact"}]
            }),
        )
        .expect("prepare dynamic PDF");
        assert!(fs::read(root.0.join("documents/input.pdf"))
            .expect("read generated PDF")
            .starts_with(b"%PDF-1.4"));
        let error = prepare_verify_case_resources(
            &root.0,
            &serde_json::json!({
                "setupFiles": [{"path": "../outside.txt", "contentLines": ["blocked"]}]
            }),
        )
        .expect_err("parent traversal must fail");
        assert!(error.contains("inside verify workspace"));
    }
}
