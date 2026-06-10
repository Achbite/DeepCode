#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;
use std::path::PathBuf;
use std::process::Command;

pub(crate) async fn git_status(State(state): State<AppState>) -> Json<ApiResponse> {
    match current_workspace_root(&state).and_then(|root| git_status_payload(root)) {
        Ok(payload) => ApiResponse::ok(payload),
        Err(error) => ApiResponse::error("git_status_failed", error),
    }
}

pub(crate) async fn git_diff(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<ApiResponse> {
    let staged = query
        .get("staged")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let path = query.get("path").cloned();
    match current_workspace_root(&state).and_then(|root| git_diff_payload(root, path, staged)) {
        Ok(payload) => ApiResponse::ok(payload),
        Err(error) => ApiResponse::error("git_diff_failed", error),
    }
}

fn current_workspace_root(state: &AppState) -> Result<PathBuf, String> {
    let current = current_workspace_json(&state.runtime).map_err(|error| error.message)?;
    let workspace = current
        .get("current")
        .filter(|value| !value.is_null())
        .ok_or_else(|| "No workspace is open.".to_string())?;
    workspace
        .get("sourcePath")
        .and_then(Value::as_str)
        .or_else(|| {
            workspace
                .get("folders")
                .and_then(Value::as_array)
                .and_then(|folders| folders.first())
                .and_then(|folder| folder.get("absolutePath"))
                .and_then(Value::as_str)
        })
        .map(PathBuf::from)
        .ok_or_else(|| "Current workspace has no local root.".to_string())
}

fn git_status_payload(root: PathBuf) -> Result<Value, String> {
    let raw = git_output(&root, &["status", "--porcelain=v1", "-uall"])?;
    Ok(json!({
        "root": root.to_string_lossy(),
        "changes": parse_porcelain_status(&raw),
        "raw": raw
    }))
}

fn git_diff_payload(root: PathBuf, path: Option<String>, staged: bool) -> Result<Value, String> {
    if let Some(path) = path.as_ref() {
        validate_workspace_relative(path)?;
    }
    let mut args = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    if let Some(path) = path.as_ref() {
        args.push("--");
        args.push(path);
    }
    let diff = git_output(&root, &args)?;
    Ok(json!({
        "root": root.to_string_lossy(),
        "path": path,
        "staged": staged,
        "diff": diff
    }))
}

fn git_output(root: &PathBuf, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| format!("start git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_porcelain_status(raw: &str) -> Vec<Value> {
    raw.lines()
        .filter(|line| line.len() >= 3)
        .map(|line| {
            let status = &line[0..2];
            let path = line[3..].trim();
            json!({
                "path": path,
                "index": &status[0..1],
                "worktree": &status[1..2],
                "group": status_group(status),
                "raw": line
            })
        })
        .collect()
}

fn status_group(status: &str) -> &'static str {
    if status.starts_with("??") {
        return "untracked";
    }
    if status.chars().next().map(|ch| ch != ' ').unwrap_or(false) {
        return "staged";
    }
    "changed"
}

fn validate_workspace_relative(path: &str) -> Result<(), String> {
    if path.trim().is_empty()
        || path.starts_with('/')
        || path.get(1..3) == Some(":/")
        || path == ".."
        || path.starts_with("../")
        || path.contains("/../")
        || path.ends_with("/..")
    {
        return Err("Git path must be workspace-relative and must not contain ..".to_string());
    }
    Ok(())
}
