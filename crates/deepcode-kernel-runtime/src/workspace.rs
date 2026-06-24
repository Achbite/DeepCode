use super::*;
use deepcode_kernel_skills::file_content::{
    lightweight_file_classification, read_text_file_for_llm,
};

impl DeepCodeKernelRuntime {
    pub(crate) fn workspace_open(
        &mut self,
        request_id: RequestId,
        path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let resolved = resolve_workspace_root(&path).map_err(KernelError::InvalidCommand)?;
        preflight_workspace_root_readable(&resolved.root)?;
        self.state.next_workspace_index += 1;
        let id = format!("ws-{}", self.state.next_workspace_index);
        let name = resolved
            .source_path
            .as_ref()
            .or(Some(&resolved.root))
            .and_then(|path| path.file_stem().or_else(|| path.file_name()))
            .and_then(OsStr::to_str)
            .unwrap_or("workspace")
            .to_string();
        let workspace = RuntimeWorkspace {
            id: id.clone(),
            name,
            source: resolved.source,
            source_path: resolved.source_path,
            root: resolved.root,
            original_folder_path: resolved.original_folder_path,
            folder_is_absolute: resolved.folder_is_absolute,
            settings: resolved.settings,
            unsupported_fields: resolved.unsupported_fields,
            opened_at: now_millis().to_string(),
        };
        let output = workspace_json(&workspace);
        self.state.current_workspace = Some(workspace);
        self.workspace_result(
            request_id,
            "workspace.open",
            Ok(serde_json::json!({ "workspace": output })),
        )
    }

    pub(crate) fn workspace_current(
        &self,
        request_id: RequestId,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.workspace_result(
            request_id,
            "workspace.current",
            Ok(serde_json::json!({
                "current": self.state.current_workspace.as_ref().map(workspace_json),
                "fallbackUsed": false,
                "lastError": null
            })),
        )
    }

    pub(crate) fn host_resource_query(
        &self,
        request_id: RequestId,
        query: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let query_kind = query
            .get("kind")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                KernelError::InvalidCommand("host resource query requires kind".to_string())
            })?;
        let output = match query_kind {
            "browse" => host_browse_output(&query),
            "list" => self.host_list_output(&query),
            "read" => self.host_read_output(&query),
            "search" => self.host_search_output(&query),
            other => Err(KernelError::InvalidCommand(format!(
                "unsupported host resource query kind {other}"
            ))),
        }?;
        Ok(vec![KernelEvent::ResourcePacketProduced {
            request_id: Some(request_id),
            run_id: None,
            session_id: None,
            packet: serde_json::json!({
                "source": "hostProjection",
                "queryKind": query_kind,
                "output": output
            }),
            sequence: None,
        }])
    }

    pub(crate) fn workspace_read(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            let target = self.resolve_workspace_path(&path)?;
            if !target.is_file() {
                return Err(KernelError::InvalidCommand(format!("{path} is not a file")));
            }
            let read = read_text_file_for_llm(&target).map_err(|skip| {
                KernelError::InvalidCommand(format!(
                    "unsupported_file_content: {} ({})",
                    skip.message, skip.reason
                ))
            })?;
            let content = read.content;
            let size_bytes = content.len();
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "content": content,
                "sizeBytes": size_bytes,
                "binary": false,
                "fileClassification": read.classification
            }))
        })();
        self.workspace_result(request_id, "fs.read", result)
    }

    pub(crate) fn workspace_search(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        query: String,
        include: Option<Vec<String>>,
        context_lines: Option<u32>,
        max_results: Option<u32>,
        is_regex: bool,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            if is_regex {
                return Err(KernelError::NotImplemented("code.search.regex"));
            }
            if query.trim().is_empty() {
                return Err(KernelError::InvalidCommand(
                    "search query is required".to_string(),
                ));
            }
            let includes = include.unwrap_or_default();
            let context_lines = context_lines.unwrap_or(0);
            let max_results = max_results.unwrap_or(WORKSPACE_SEARCH_DEFAULT_MAX_RESULTS as u32);
            let result = search_workspace_with_options(
                &workspace.root,
                &query,
                &includes,
                context_lines,
                max_results,
            )?;
            let returned_matches = result.matches.len();
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "query": query,
                "include": includes,
                "contextLines": result.context_lines,
                "maxResults": result.max_results,
                "returnedMatches": returned_matches,
                "truncated": result.truncated,
                "visitedFiles": result.visited_files,
                "skippedFiles": result.skipped_files,
                "skippedBinaryFiles": result.skipped_binary_files,
                "skippedExecutableFiles": result.skipped_executable_files,
                "matches": result.matches
            }))
        })();
        self.workspace_result(request_id, "code.search", result)
    }

    pub(crate) fn current_workspace(&self) -> KernelResult<&RuntimeWorkspace> {
        self.state
            .current_workspace
            .as_ref()
            .ok_or(KernelError::MissingWorkspaceBinding)
    }

    pub(crate) fn resolve_workspace_path(&self, relative_path: &str) -> KernelResult<PathBuf> {
        let workspace = self.current_workspace()?;
        WorkspaceBoundary::new(&workspace.root).resolve(relative_path)
    }

    fn host_list_output(&self, query: &Value) -> KernelResult<Value> {
        let workspace = self.current_workspace()?;
        validate_folder_id(query.get("folderId").and_then(Value::as_str))?;
        let path = query
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(".")
            .trim();
        let depth = query
            .get("depth")
            .and_then(Value::as_u64)
            .map(|value| value.min(8) as u32)
            .unwrap_or(2);
        let target = self.resolve_workspace_path(if path.is_empty() { "." } else { path })?;
        if !target.is_dir() {
            return Err(KernelError::InvalidCommand(format!(
                "{} is not a directory",
                target.display()
            )));
        }
        Ok(serde_json::json!({
            "nodes": list_nodes(&target, &workspace.root, depth)?
        }))
    }

    fn host_read_output(&self, query: &Value) -> KernelResult<Value> {
        validate_folder_id(query.get("folderId").and_then(Value::as_str))?;
        let path = query
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::InvalidCommand("host read requires path".to_string()))?;
        let target = self.resolve_workspace_path(path)?;
        if !target.is_file() {
            return Err(KernelError::InvalidCommand(format!("{path} is not a file")));
        }
        let read = read_text_file_for_llm(&target).map_err(|skip| {
            KernelError::InvalidCommand(format!(
                "unsupported_file_content: {} ({})",
                skip.message, skip.reason
            ))
        })?;
        let content = read.content;
        let size_bytes = content.len();
        Ok(serde_json::json!({
            "folderId": "wf-0",
            "path": normalize_relative_path(path),
            "content": content,
            "sizeBytes": size_bytes,
            "binary": false,
            "fileClassification": read.classification
        }))
    }

    fn host_search_output(&self, query: &Value) -> KernelResult<Value> {
        let workspace = self.current_workspace()?;
        validate_folder_id(query.get("folderId").and_then(Value::as_str))?;
        let search = query
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::InvalidCommand("host search requires query".to_string()))?;
        let includes = query
            .get("include")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let context_lines = query
            .get("contextLines")
            .and_then(Value::as_u64)
            .map(|value| value as u32)
            .unwrap_or(0);
        let max_results = query
            .get("maxResults")
            .and_then(Value::as_u64)
            .map(|value| value as u32)
            .unwrap_or(WORKSPACE_SEARCH_DEFAULT_MAX_RESULTS as u32);
        let is_regex = query
            .get("isRegex")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_regex {
            return Err(KernelError::NotImplemented("code.search.regex"));
        }
        let result = search_workspace_with_options(
            &workspace.root,
            search,
            &includes,
            context_lines,
            max_results,
        )?;
        let returned_matches = result.matches.len();
        Ok(serde_json::json!({
            "folderId": "wf-0",
            "query": search,
            "include": includes,
            "contextLines": result.context_lines,
            "maxResults": result.max_results,
            "returnedMatches": returned_matches,
            "truncated": result.truncated,
            "visitedFiles": result.visited_files,
            "skippedFiles": result.skipped_files,
            "skippedBinaryFiles": result.skipped_binary_files,
            "skippedExecutableFiles": result.skipped_executable_files,
            "matches": result.matches
        }))
    }

    pub(crate) fn workspace_result(
        &self,
        request_id: RequestId,
        operation: &str,
        result: KernelResult<Value>,
    ) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::ToolCompleted {
            run_id: None,
            session_id: None,
            turn_id: None,
            tool_call_id: request_id.0,
            tool_name: operation.to_string(),
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
            sequence: None,
        }])
    }
}

fn host_browse_output(query: &Value) -> KernelResult<Value> {
    let path = query
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(host_home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    let target = if path.is_dir() {
        path
    } else {
        path.parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    };
    let mut entries = fs::read_dir(&target)
        .map_err(|error| KernelError::Other(format!("browse {}: {error}", target.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| KernelError::Other(format!("browse {}: {error}", target.display())))?;
    entries.sort_by(compare_dir_entries);
    let entries = entries
        .into_iter()
        .take(500)
        .map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = path.is_dir();
            serde_json::json!({
                "name": name,
                "absolutePath": path.to_string_lossy(),
                "type": if is_dir { "directory" } else { "file" },
                "isCodeWorkspace": path.extension().and_then(|ext| ext.to_str()) == Some("code-workspace"),
                "hidden": name.starts_with('.')
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "absolutePath": target.to_string_lossy(),
        "parentPath": target.parent().map(|path| path.to_string_lossy().to_string()),
        "entries": entries
    }))
}

fn host_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

#[derive(Debug)]
pub(crate) struct ResolvedWorkspaceRoot {
    pub(crate) source: WorkspaceSource,
    pub(crate) source_path: Option<PathBuf>,
    pub(crate) root: PathBuf,
    pub(crate) original_folder_path: String,
    pub(crate) folder_is_absolute: bool,
    pub(crate) settings: Value,
    pub(crate) unsupported_fields: Vec<Value>,
}

pub(crate) fn resolve_workspace_root(path: &str) -> Result<ResolvedWorkspaceRoot, String> {
    let source = PathBuf::from(path);
    if source.is_dir() {
        let root = source
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace {path}: {error}"))?;
        return Ok(ResolvedWorkspaceRoot {
            source: WorkspaceSource::Directory,
            source_path: None,
            original_folder_path: root.to_string_lossy().to_string(),
            folder_is_absolute: true,
            root,
            settings: serde_json::json!({}),
            unsupported_fields: Vec::new(),
        });
    }
    if source.is_file() && source.extension().and_then(OsStr::to_str) == Some("code-workspace") {
        let text = fs::read_to_string(&source)
            .map_err(|error| format!("read workspace file {path}: {error}"))?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("parse workspace file: {error}"))?;
        let folder_path = value
            .get("folders")
            .and_then(Value::as_array)
            .and_then(|folders| folders.first())
            .and_then(|folder| folder.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(|| "workspace file has no folders[0].path".to_string())?;
        let source_path = source
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace file {path}: {error}"))?;
        let base = source.parent().unwrap_or_else(|| Path::new("."));
        let root = base
            .join(folder_path)
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace folder {folder_path}: {error}"))?;
        return Ok(ResolvedWorkspaceRoot {
            source: WorkspaceSource::CodeWorkspace,
            source_path: Some(source_path),
            root,
            original_folder_path: folder_path.to_string(),
            folder_is_absolute: Path::new(folder_path).is_absolute(),
            settings: value
                .get("settings")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
            unsupported_fields: unsupported_workspace_fields(&value),
        });
    }
    Err(format!("{path} is not a directory or .code-workspace file"))
}

pub(crate) fn workspace_json(workspace: &RuntimeWorkspace) -> Value {
    serde_json::json!({
        "id": &workspace.id,
        "name": &workspace.name,
        "source": match workspace.source {
            WorkspaceSource::Directory => "directory",
            WorkspaceSource::CodeWorkspace => "code-workspace",
        },
        "sourcePath": workspace.source_path.as_ref().map(|path| path.to_string_lossy().to_string()),
        "rootPath": workspace.root.to_string_lossy(),
        "folders": [
            {
                "id": "wf-0",
                "name": &workspace.name,
                "path": workspace.root.to_string_lossy(),
                "absolutePath": workspace.root.to_string_lossy(),
                "originalPath": &workspace.original_folder_path,
                "isAbsolute": workspace.folder_is_absolute
            }
        ],
        "settings": &workspace.settings,
        "unsupportedFields": &workspace.unsupported_fields,
        "openedAt": &workspace.opened_at
    })
}

pub(crate) fn unsupported_workspace_fields(value: &Value) -> Vec<Value> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .filter(|(key, _)| key.as_str() != "folders" && key.as_str() != "settings")
        .map(|(key, value)| {
            serde_json::json!({
                "key": key,
                "kind": value_kind(value)
            })
        })
        .collect()
}

pub(crate) fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(crate) fn validate_folder_id(folder_id: Option<&str>) -> KernelResult<()> {
    if let Some(folder_id) = folder_id {
        if folder_id != "wf-0" {
            return Err(KernelError::InvalidCommand(format!(
                "unknown workspace folder {folder_id}"
            )));
        }
    }
    Ok(())
}

pub(crate) fn normalize_relative_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

fn preflight_workspace_root_readable(root: &Path) -> KernelResult<()> {
    list_nodes(root, root, 1).map(|_| ()).map_err(|error| {
        KernelError::WorkspaceRootUnreadable(format!(
            "{} cannot be listed for read-only workspace access: {error}",
            root.display()
        ))
    })
}

pub(crate) fn list_nodes(path: &Path, root: &Path, depth: u32) -> KernelResult<Vec<Value>> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| KernelError::Other(format!("list {}: {error}", path.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| KernelError::Other(format!("list {}: {error}", path.display())))?;
    entries.sort_by(compare_dir_entries);

    entries
        .into_iter()
        .take(200)
        .map(|entry| {
            let entry_path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                KernelError::Other(format!("stat {}: {error}", entry_path.display()))
            })?;
            let relative = entry_path
                .strip_prefix(root)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .replace('\\', "/");
            let children = if file_type.is_dir() && depth > 1 && !skip_directory(&entry_path) {
                Some(list_nodes(&entry_path, root, depth - 1)?)
            } else if file_type.is_dir() {
                Some(Vec::new())
            } else {
                None
            };
            let mut node = serde_json::json!({
                "name": entry.file_name().to_string_lossy(),
                "path": relative,
                "type": if file_type.is_dir() { "directory" } else { "file" },
                "children": children
            });
            if file_type.is_file() {
                let metadata = entry.metadata().map_err(|error| {
                    KernelError::Other(format!("metadata {}: {error}", entry_path.display()))
                })?;
                node["fileClassification"] =
                    serde_json::to_value(lightweight_file_classification(&entry_path, &metadata))
                        .unwrap_or(Value::Null);
            }
            Ok(node)
        })
        .collect()
}

pub(crate) fn compare_dir_entries(left: &fs::DirEntry, right: &fs::DirEntry) -> Ordering {
    let left_name = left.file_name().to_string_lossy().to_string();
    let right_name = right.file_name().to_string_lossy().to_string();
    let left_is_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    let right_is_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    (
        if left_is_dir { 0_u8 } else { 1_u8 },
        if left_name.starts_with('.') {
            1_u8
        } else {
            0_u8
        },
        left_name.to_lowercase(),
        left_name,
    )
        .cmp(&(
            if right_is_dir { 0_u8 } else { 1_u8 },
            if right_name.starts_with('.') {
                1_u8
            } else {
                0_u8
            },
            right_name.to_lowercase(),
            right_name,
        ))
}

pub(crate) const WORKSPACE_SEARCH_DEFAULT_MAX_RESULTS: usize = 200;
const WORKSPACE_SEARCH_MAX_RESULTS: usize = 500;
const WORKSPACE_SEARCH_MAX_VISITED_FILES: usize = 500;
const WORKSPACE_SEARCH_MAX_CONTEXT_LINES: usize = 5;

pub(crate) struct CodeSearchResult {
    pub(crate) matches: Vec<Value>,
    pub(crate) truncated: bool,
    pub(crate) visited_files: usize,
    pub(crate) context_lines: usize,
    pub(crate) max_results: usize,
    pub(crate) skipped_files: usize,
    pub(crate) skipped_binary_files: usize,
    pub(crate) skipped_executable_files: usize,
}

pub(crate) fn search_workspace_with_options(
    root: &Path,
    query: &str,
    includes: &[String],
    context_lines: u32,
    max_results: u32,
) -> KernelResult<CodeSearchResult> {
    let mut matches = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited_files = 0_usize;
    let mut skipped_files = 0_usize;
    let mut skipped_binary_files = 0_usize;
    let mut skipped_executable_files = 0_usize;
    let context_lines = (context_lines as usize).min(WORKSPACE_SEARCH_MAX_CONTEXT_LINES);
    let max_results = (max_results as usize).clamp(1, WORKSPACE_SEARCH_MAX_RESULTS);
    let mut truncated = false;

    while let Some(path) = stack.pop() {
        if skip_directory(&path) {
            continue;
        }
        let entries = fs::read_dir(&path)
            .map_err(|error| KernelError::Other(format!("search {}: {error}", path.display())))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| KernelError::Other(format!("search entry: {error}")))?;
            let entry_path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                KernelError::Other(format!("stat {}: {error}", entry_path.display()))
            })?;
            if file_type.is_dir() {
                stack.push(entry_path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let relative = entry_path
                .strip_prefix(root)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .replace('\\', "/");
            if !includes.is_empty() && !includes.iter().any(|pattern| relative.contains(pattern)) {
                continue;
            }
            visited_files += 1;
            if visited_files > WORKSPACE_SEARCH_MAX_VISITED_FILES {
                truncated = true;
                break;
            }
            let content = match read_text_file_for_llm(&entry_path) {
                Ok(read) => read.content,
                Err(skip) => {
                    skipped_files += 1;
                    if skip.classification.binary {
                        skipped_binary_files += 1;
                    }
                    if skip.classification.executable {
                        skipped_executable_files += 1;
                    }
                    continue;
                }
            };
            let lines = content.lines().collect::<Vec<_>>();
            for (index, line) in lines.iter().enumerate() {
                if line.contains(query) {
                    let mut item = serde_json::json!({
                        "path": relative,
                        "line": index + 1,
                        "preview": line
                    });
                    if context_lines > 0 {
                        if let Some(record) = item.as_object_mut() {
                            let before_start = index.saturating_sub(context_lines);
                            let before = (before_start..index)
                                .map(|line_index| {
                                    serde_json::json!({
                                        "line": line_index + 1,
                                        "text": lines[line_index]
                                    })
                                })
                                .collect::<Vec<_>>();
                            let after_end = (index + 1 + context_lines).min(lines.len());
                            let after = (index + 1..after_end)
                                .map(|line_index| {
                                    serde_json::json!({
                                        "line": line_index + 1,
                                        "text": lines[line_index]
                                    })
                                })
                                .collect::<Vec<_>>();
                            record.insert("before".to_string(), Value::Array(before));
                            record.insert("after".to_string(), Value::Array(after));
                        }
                    }
                    matches.push(item);
                    if matches.len() >= max_results {
                        truncated = true;
                        return Ok(CodeSearchResult {
                            matches,
                            truncated,
                            visited_files,
                            context_lines,
                            max_results,
                            skipped_files,
                            skipped_binary_files,
                            skipped_executable_files,
                        });
                    }
                }
            }
        }
    }
    Ok(CodeSearchResult {
        matches,
        truncated,
        visited_files,
        context_lines,
        max_results,
        skipped_files,
        skipped_binary_files,
        skipped_executable_files,
    })
}

pub(crate) fn skip_directory(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(OsStr::to_str),
        Some(".git" | "node_modules" | "target" | "dist" | ".build-cache")
    )
}
