use deepcode_kernel_abi::{
    HostBrowseEntry, HostBrowseResult, HostFileClassification, HostFileReadResult,
    HostFileTreeNode, HostFileTreeNodeKind, HostGitChange, HostGitDiffResult, HostGitStatusResult,
    HostGrepResult, HostInspectionOutput, HostInspectionQuery, HostSearchContextLine,
    HostSearchMatch, KernelErrorEnvelope,
};
use deepcode_kernel_tools::file_content::{
    lightweight_file_classification, read_text_file_for_llm, FileContentClassification,
};
use regex::Regex;
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const HOST_TREE_MAX_ENTRIES: usize = 2_000;
const HOST_SEARCH_DEFAULT_MAX_RESULTS: usize = 200;
const HOST_SEARCH_MAX_RESULTS: usize = 500;
const HOST_SEARCH_MAX_CONTEXT_LINES: usize = 5;
const HOST_SEARCH_MAX_VISITED_FILES: usize = 500;
const HOST_SEARCH_MAX_VISITED_ENTRIES: usize = 5_000;
const HOST_GIT_TIMEOUT: Duration = Duration::from_secs(30);
const HOST_GIT_OUTPUT_LIMIT: u64 = 256 * 1024;
const HOST_GIT_DIFF_LIMIT: usize = 64 * 1024;

#[derive(Clone, Default)]
pub(crate) struct HostInspectionExecutor;

impl HostInspectionExecutor {
    pub(crate) fn execute(
        &self,
        query: HostInspectionQuery,
        workspace_root: Option<&Path>,
    ) -> Result<HostInspectionOutput, KernelErrorEnvelope> {
        match query {
            HostInspectionQuery::Browse { path } => {
                host_browse(path.as_deref()).map(HostInspectionOutput::Browse)
            }
            HostInspectionQuery::List {
                folder_id,
                path,
                depth,
            } => {
                validate_folder_id(folder_id.as_deref())?;
                let root = required_workspace_root(workspace_root)?;
                let target = resolve_workspace_read_path(root, &path)?;
                if !target.is_dir() {
                    return Err(host_error(
                        "host_inspection_invalid_path",
                        format!("{} is not a directory", target.display()),
                    ));
                }
                let mut remaining = HOST_TREE_MAX_ENTRIES;
                list_nodes(&target, root, depth.clamp(1, 16), &mut remaining)
                    .map(HostInspectionOutput::List)
            }
            HostInspectionQuery::Read { folder_id, path } => {
                validate_folder_id(folder_id.as_deref())?;
                let root = required_workspace_root(workspace_root)?;
                host_read(root, &path, folder_id.as_deref()).map(HostInspectionOutput::Read)
            }
            HostInspectionQuery::Grep {
                folder_id,
                query,
                path,
                include,
                exclude,
                strategy,
                context_lines,
                max_results,
            } => {
                validate_folder_id(folder_id.as_deref())?;
                let root = required_workspace_root(workspace_root)?;
                host_grep(
                    root,
                    HostGrepRequest {
                        query,
                        path,
                        include,
                        exclude,
                        strategy,
                        context_lines,
                        max_results,
                    },
                )
                .map(HostInspectionOutput::Grep)
            }
            HostInspectionQuery::GitStatus => {
                let root = required_workspace_root(workspace_root)?;
                host_git_status(root).map(HostInspectionOutput::GitStatus)
            }
            HostInspectionQuery::GitDiff { path, staged } => {
                let root = required_workspace_root(workspace_root)?;
                host_git_diff(root, path, staged).map(HostInspectionOutput::GitDiff)
            }
        }
    }
}

fn required_workspace_root(workspace_root: Option<&Path>) -> Result<&Path, KernelErrorEnvelope> {
    workspace_root.ok_or_else(|| {
        host_error(
            "host_workspace_missing",
            "Host inspection requires an open workspace",
        )
    })
}

fn host_browse(path: Option<&str>) -> Result<HostBrowseResult, KernelErrorEnvelope> {
    let path = path
        .map(PathBuf::from)
        .or_else(host_home_dir)
        .ok_or_else(|| {
            host_error(
                "host_browse_path_required",
                "Host browse requires a path when no home directory is available",
            )
        })?;
    let target = if path.is_dir() {
        path
    } else {
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                host_error(
                    "host_browse_invalid_path",
                    format!(
                        "{} is not a directory and has no parent directory",
                        path.display()
                    ),
                )
            })?
    };
    let target = target.canonicalize().map_err(|error| {
        host_error(
            "host_browse_unavailable",
            format!("canonicalize {}: {error}", target.display()),
        )
    })?;
    let mut entries = fs::read_dir(&target)
        .map_err(|error| {
            host_error(
                "host_browse_unavailable",
                format!("browse {}: {error}", target.display()),
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| host_error("host_browse_unavailable", error.to_string()))?;
    entries.sort_by(compare_dir_entries);
    let entries = entries
        .into_iter()
        .take(500)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if file_type.is_symlink() {
                return None;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            Some(HostBrowseEntry {
                hidden: name.starts_with('.'),
                name,
                absolute_path: path.to_string_lossy().to_string(),
                kind: if file_type.is_dir() {
                    HostFileTreeNodeKind::Directory
                } else {
                    HostFileTreeNodeKind::File
                },
                is_code_workspace: path.extension().and_then(OsStr::to_str)
                    == Some("code-workspace"),
            })
        })
        .collect();
    Ok(HostBrowseResult {
        absolute_path: target.to_string_lossy().to_string(),
        parent_path: target
            .parent()
            .map(|path| path.to_string_lossy().to_string()),
        entries,
    })
}

fn host_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn validate_folder_id(folder_id: Option<&str>) -> Result<(), KernelErrorEnvelope> {
    if folder_id.is_some_and(|folder_id| {
        folder_id.is_empty()
            || folder_id.len() > 128
            || folder_id.chars().any(|character| character.is_control())
    }) {
        return Err(host_error(
            "host_inspection_unknown_folder",
            "invalid workspace folder identity",
        ));
    }
    Ok(())
}

fn resolve_workspace_read_path(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, KernelErrorEnvelope> {
    let relative = relative.trim();
    let relative = if relative.is_empty() { "." } else { relative };
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(host_error(
            "host_inspection_path_outside_workspace",
            "Host inspection paths must be workspace-relative and cannot contain '..'",
        ));
    }
    let target = root.join(path).canonicalize().map_err(|error| {
        host_error(
            "host_inspection_path_unavailable",
            format!("canonicalize {}: {error}", root.join(path).display()),
        )
    })?;
    if !target.starts_with(root) {
        return Err(host_error(
            "host_inspection_path_outside_workspace",
            format!(
                "{} resolves outside workspace {}",
                target.display(),
                root.display()
            ),
        ));
    }
    Ok(target)
}

fn list_nodes(
    path: &Path,
    root: &Path,
    depth: u32,
    remaining: &mut usize,
) -> Result<Vec<HostFileTreeNode>, KernelErrorEnvelope> {
    if depth == 0 || *remaining == 0 {
        return Ok(Vec::new());
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| {
            host_error(
                "host_inspection_list_failed",
                format!("list {}: {error}", path.display()),
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| host_error("host_inspection_list_failed", error.to_string()))?;
    entries.sort_by(compare_dir_entries);
    let mut nodes = Vec::new();
    for entry in entries {
        if *remaining == 0 {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| {
            host_error(
                "host_inspection_list_failed",
                format!("inspect {}: {error}", entry.path().display()),
            )
        })?;
        if file_type.is_symlink() {
            continue;
        }
        *remaining -= 1;
        let entry_path = entry.path();
        let metadata = entry.metadata().map_err(|error| {
            host_error(
                "host_inspection_list_failed",
                format!("metadata {}: {error}", entry_path.display()),
            )
        })?;
        let relative = normalized_relative_path(root, &entry_path);
        if file_type.is_dir() {
            let children = if depth > 1 && !skip_directory(&entry_path) {
                list_nodes(&entry_path, root, depth - 1, remaining)?
            } else {
                Vec::new()
            };
            nodes.push(HostFileTreeNode {
                name,
                path: relative,
                kind: HostFileTreeNodeKind::Directory,
                children: Some(children),
                size_bytes: None,
                file_classification: None,
            });
        } else if file_type.is_file() {
            nodes.push(HostFileTreeNode {
                name,
                path: relative,
                kind: HostFileTreeNodeKind::File,
                children: None,
                size_bytes: Some(metadata.len()),
                file_classification: Some(host_file_classification(
                    lightweight_file_classification(&entry_path, &metadata),
                )),
            });
        }
    }
    Ok(nodes)
}

fn host_read(
    root: &Path,
    path: &str,
    folder_id: Option<&str>,
) -> Result<HostFileReadResult, KernelErrorEnvelope> {
    let target = resolve_workspace_read_path(root, path)?;
    if !target.is_file() {
        return Err(host_error(
            "host_inspection_read_failed",
            format!("{} is not a file", target.display()),
        ));
    }
    let read = read_text_file_for_llm(&target).map_err(|skip| {
        host_error(
            "host_inspection_unsupported_content",
            format!("{} ({})", skip.message, skip.reason),
        )
    })?;
    let content = read.content;
    let end_line = content.lines().count();
    let file_size_bytes = read.classification.size_bytes as usize;
    Ok(HostFileReadResult {
        folder_id: folder_id.unwrap_or("wf-0").to_string(),
        path: normalized_relative_path(root, &target),
        size_bytes: content.len(),
        file_size_bytes,
        start_line: 1,
        end_line,
        content_hash: deepcode_kernel_tools::hash_bytes(content.as_bytes()),
        binary: false,
        file_classification: host_file_classification(read.classification),
        content,
    })
}

fn host_file_classification(classification: FileContentClassification) -> HostFileClassification {
    HostFileClassification {
        kind: classification.kind,
        readable_text: classification.readable_text,
        binary: classification.binary,
        executable: classification.executable,
        size_bytes: classification.size_bytes,
        extension: classification.extension,
        magic: classification.magic,
        reason: classification.reason,
    }
}

struct HostGrepRequest {
    query: String,
    path: String,
    include: Vec<String>,
    exclude: Vec<String>,
    strategy: String,
    context_lines: u32,
    max_results: u32,
}

fn host_grep(root: &Path, request: HostGrepRequest) -> Result<HostGrepResult, KernelErrorEnvelope> {
    if request.query.trim().is_empty() {
        return Err(host_error(
            "host_inspection_invalid_query",
            "search query is required",
        ));
    }
    let target = resolve_workspace_read_path(root, &request.path)?;
    if !target.is_dir() {
        return Err(host_error(
            "host_inspection_invalid_path",
            format!("{} is not a directory", target.display()),
        ));
    }
    let matcher = match request.strategy.as_str() {
        "literal" => TextMatcher::Literal(request.query.clone()),
        "regex" => TextMatcher::Regex(Regex::new(&request.query).map_err(|error| {
            host_error(
                "host_inspection_invalid_query",
                format!("invalid regular expression: {error}"),
            )
        })?),
        other => {
            return Err(host_error(
                "host_inspection_invalid_query",
                format!("unsupported search strategy: {other}"),
            ))
        }
    };
    let include_patterns = compile_glob_patterns(&request.include)?;
    let exclude_patterns = compile_glob_patterns(&request.exclude)?;
    let context_lines = (request.context_lines as usize).min(HOST_SEARCH_MAX_CONTEXT_LINES);
    let max_results = if request.max_results == 0 {
        HOST_SEARCH_DEFAULT_MAX_RESULTS
    } else {
        (request.max_results as usize).clamp(1, HOST_SEARCH_MAX_RESULTS)
    };
    let mut traversal = HostSearchTraversal {
        root,
        matcher: &matcher,
        includes: &include_patterns,
        excludes: &exclude_patterns,
        context_lines,
        max_results,
        visited_entries: 0,
        visited_files: 0,
        skipped_files: 0,
        skipped_binary_files: 0,
        skipped_executable_files: 0,
        matches: Vec::new(),
    };
    let truncated = traversal.search_dir(&target)?;
    Ok(HostGrepResult {
        folder_id: "wf-0".to_string(),
        query: request.query,
        path: normalized_relative_path(root, &target),
        strategy: request.strategy,
        include: request.include,
        exclude: request.exclude,
        context_lines,
        max_results,
        returned_matches: traversal.matches.len(),
        truncated,
        visited_files: traversal.visited_files,
        skipped_files: traversal.skipped_files,
        skipped_binary_files: traversal.skipped_binary_files,
        skipped_executable_files: traversal.skipped_executable_files,
        matches: traversal.matches,
    })
}

enum TextMatcher {
    Literal(String),
    Regex(Regex),
}

impl TextMatcher {
    fn is_match(&self, value: &str) -> bool {
        match self {
            Self::Literal(needle) => value.contains(needle),
            Self::Regex(regex) => regex.is_match(value),
        }
    }
}

struct HostSearchTraversal<'a> {
    root: &'a Path,
    matcher: &'a TextMatcher,
    includes: &'a [Regex],
    excludes: &'a [Regex],
    context_lines: usize,
    max_results: usize,
    visited_entries: usize,
    visited_files: usize,
    skipped_files: usize,
    skipped_binary_files: usize,
    skipped_executable_files: usize,
    matches: Vec<HostSearchMatch>,
}

impl HostSearchTraversal<'_> {
    fn search_dir(&mut self, directory: &Path) -> Result<bool, KernelErrorEnvelope> {
        let entries = fs::read_dir(directory).map_err(|error| {
            host_error(
                "host_inspection_search_failed",
                format!("search {}: {error}", directory.display()),
            )
        })?;
        for entry in entries {
            self.visited_entries += 1;
            if self.visited_entries > HOST_SEARCH_MAX_VISITED_ENTRIES {
                return Ok(true);
            }
            let entry = entry
                .map_err(|error| host_error("host_inspection_search_failed", error.to_string()))?;
            let file_type = entry.file_type().map_err(|error| {
                host_error(
                    "host_inspection_search_failed",
                    format!("inspect {}: {error}", entry.path().display()),
                )
            })?;
            if file_type.is_symlink() {
                self.skipped_files += 1;
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                if !skip_directory(&path) && self.search_dir(&path)? {
                    return Ok(true);
                }
                continue;
            }
            if !file_type.is_file() {
                self.skipped_files += 1;
                continue;
            }
            let relative = normalized_relative_path(self.root, &path);
            if !self.includes.is_empty()
                && !self
                    .includes
                    .iter()
                    .any(|pattern| pattern.is_match(&relative))
            {
                continue;
            }
            if self
                .excludes
                .iter()
                .any(|pattern| pattern.is_match(&relative))
            {
                continue;
            }
            self.visited_files += 1;
            if self.visited_files > HOST_SEARCH_MAX_VISITED_FILES {
                return Ok(true);
            }
            let content = match read_text_file_for_llm(&path) {
                Ok(read) => read.content,
                Err(skip) => {
                    self.skipped_files += 1;
                    if skip.classification.binary {
                        self.skipped_binary_files += 1;
                    }
                    if skip.classification.executable {
                        self.skipped_executable_files += 1;
                    }
                    continue;
                }
            };
            let lines = content.lines().collect::<Vec<_>>();
            for (line_index, line) in lines.iter().enumerate() {
                if !self.matcher.is_match(line) {
                    continue;
                }
                let before_start = line_index.saturating_sub(self.context_lines);
                let before = (before_start..line_index)
                    .map(|index| HostSearchContextLine {
                        line: index + 1,
                        text: lines[index].to_string(),
                    })
                    .collect();
                let after_end = (line_index + 1 + self.context_lines).min(lines.len());
                let after = (line_index + 1..after_end)
                    .map(|index| HostSearchContextLine {
                        line: index + 1,
                        text: lines[index].to_string(),
                    })
                    .collect();
                self.matches.push(HostSearchMatch {
                    path: relative.clone(),
                    line: line_index + 1,
                    preview: (*line).to_string(),
                    before,
                    after,
                });
                if self.matches.len() >= self.max_results {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

fn compile_glob_patterns(patterns: &[String]) -> Result<Vec<Regex>, KernelErrorEnvelope> {
    patterns.iter().map(|pattern| glob_regex(pattern)).collect()
}

fn glob_regex(pattern: &str) -> Result<Regex, KernelErrorEnvelope> {
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
    Regex::new(&expression).map_err(|error| {
        host_error(
            "host_inspection_invalid_glob",
            format!("invalid glob pattern: {error}"),
        )
    })
}

fn host_git_status(root: &Path) -> Result<HostGitStatusResult, KernelErrorEnvelope> {
    let output = host_git_output(root, &["status", "--porcelain=v1", "-uall", "--", "."])?;
    Ok(HostGitStatusResult {
        root: root.to_string_lossy().to_string(),
        changes: parse_git_status(&output),
        raw: output,
    })
}

fn host_git_diff(
    root: &Path,
    path: Option<String>,
    staged: bool,
) -> Result<HostGitDiffResult, KernelErrorEnvelope> {
    if let Some(path) = path.as_deref() {
        validate_git_path(path)?;
    }
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv"];
    if staged {
        args.push("--cached");
    }
    if let Some(path) = path.as_deref() {
        args.push("--");
        args.push(path);
    } else {
        args.push("--");
        args.push(".");
    }
    let output = host_git_output(root, &args)?;
    Ok(HostGitDiffResult {
        root: root.to_string_lossy().to_string(),
        staged,
        path,
        diff: limit_text(&output, HOST_GIT_DIFF_LIMIT),
        truncated: output.len() > HOST_GIT_DIFF_LIMIT,
    })
}

fn validate_git_path(path: &str) -> Result<(), KernelErrorEnvelope> {
    let path = Path::new(path.trim());
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(host_error(
            "host_inspection_git_path_invalid",
            "Git paths must be workspace-relative and cannot contain '..'",
        ));
    }
    Ok(())
}

fn host_git_output(root: &Path, args: &[&str]) -> Result<String, KernelErrorEnvelope> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in ["PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = HostChildOwner::spawn(command)
        .map_err(|error| host_error("host_inspection_git_failed", format!("start git: {error}")))?;
    let stdout = child.take_stdout().ok_or_else(|| {
        host_error(
            "host_inspection_git_failed",
            "Git supervisor could not capture stdout",
        )
    })?;
    let stderr = child.take_stderr().ok_or_else(|| {
        host_error(
            "host_inspection_git_failed",
            "Git supervisor could not capture stderr",
        )
    })?;
    let stdout_reader = thread::Builder::new()
        .name("host-git-stdout".to_string())
        .spawn(move || read_limited_output(stdout, HOST_GIT_OUTPUT_LIMIT))
        .map_err(|error| {
            host_error(
                "host_inspection_git_failed",
                format!("spawn git stdout reader: {error}"),
            )
        })?;
    let stderr_reader = match thread::Builder::new()
        .name("host-git-stderr".to_string())
        .spawn(move || read_limited_output(stderr, HOST_GIT_OUTPUT_LIMIT))
    {
        Ok(reader) => reader,
        Err(error) => {
            child.terminate_and_wait();
            let _ = stdout_reader.join();
            return Err(host_error(
                "host_inspection_git_failed",
                format!("spawn git stderr reader: {error}"),
            ));
        }
    };
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                child.mark_reaped();
                break status;
            }
            Ok(None) if started.elapsed() < HOST_GIT_TIMEOUT => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                child.terminate_and_wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(host_error(
                    "host_inspection_git_timeout",
                    format!(
                        "git {} timed out after {} ms",
                        args.join(" "),
                        HOST_GIT_TIMEOUT.as_millis()
                    ),
                ));
            }
            Err(error) => {
                child.terminate_and_wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(host_error(
                    "host_inspection_git_failed",
                    format!("wait for git: {error}"),
                ));
            }
        }
    };
    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| host_error("host_inspection_git_failed", "Git stdout reader failed"))?
        .map_err(|error| host_error("host_inspection_git_failed", error.to_string()))?;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| host_error("host_inspection_git_failed", "Git stderr reader failed"))?
        .map_err(|error| host_error("host_inspection_git_failed", error.to_string()))?;
    if !status.success() {
        return Err(host_error(
            "host_inspection_git_failed",
            format!(
                "git {} failed{}: {}",
                args.join(" "),
                if stderr_truncated {
                    " (stderr truncated)"
                } else {
                    ""
                },
                String::from_utf8_lossy(&stderr).trim()
            ),
        ));
    }
    let mut output = String::from_utf8_lossy(&stdout).to_string();
    if stdout_truncated {
        output.push_str("\n[git stdout truncated]");
    }
    Ok(output)
}

struct HostChildOwner {
    child: Option<Child>,
}

impl HostChildOwner {
    fn spawn(mut command: Command) -> std::io::Result<Self> {
        command.spawn().map(|child| Self { child: Some(child) })
    }

    fn child_mut(&mut self) -> Option<&mut Child> {
        self.child.as_mut()
    }

    fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child_mut()?.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child_mut()?.stderr.take()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child_mut().map(Child::try_wait).unwrap_or(Ok(None))
    }

    fn mark_reaped(&mut self) {
        self.child.take();
    }

    fn terminate_and_wait(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for HostChildOwner {
    fn drop(&mut self) {
        self.terminate_and_wait();
    }
}

fn read_limited_output(mut reader: impl Read, limit: u64) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer)?;
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

fn parse_git_status(output: &str) -> Vec<HostGitChange> {
    output
        .lines()
        .filter(|line| line.len() >= 3)
        .map(|line| HostGitChange {
            index: line[0..1].to_string(),
            worktree: line[1..2].to_string(),
            path: line[3..].trim().to_string(),
            group: git_status_group(&line[0..2]).to_string(),
            raw: line.to_string(),
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

fn normalized_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_matches('/')
        .to_string()
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

fn skip_directory(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(OsStr::to_str),
        Some(".git" | "node_modules" | "target" | ".pnpm-store" | "dist")
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

fn host_error(code: impl Into<String>, message: impl Into<String>) -> KernelErrorEnvelope {
    KernelErrorEnvelope {
        code: code.into(),
        message: message.into(),
        message_key: None,
        args: None,
    }
}
