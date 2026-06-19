use super::*;

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
        Ok(vec![KernelEvent::WorkspaceResult {
            request_id,
            operation: "workspace.open".to_string(),
            ok: true,
            output: Some(serde_json::json!({ "workspace": output })),
            error: None,
            sequence: None,
        }])
    }

    pub(crate) fn workspace_current(
        &self,
        request_id: RequestId,
    ) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::WorkspaceResult {
            request_id,
            operation: "workspace.current".to_string(),
            ok: true,
            output: Some(serde_json::json!({
                "current": self.state.current_workspace.as_ref().map(workspace_json),
                "fallbackUsed": false,
                "lastError": null
            })),
            error: None,
            sequence: None,
        }])
    }

    pub(crate) fn workspace_list(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: Option<String>,
        depth: Option<u32>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            let relative = path.unwrap_or_else(|| ".".to_string());
            let target = self.resolve_workspace_path(&relative)?;
            let nodes = list_nodes(&target, &workspace.root, depth.unwrap_or(2).min(5))?;
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&relative),
                "nodes": nodes
            }))
        })();
        self.workspace_result(request_id, "workspace.list", result)
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
            let content = fs::read_to_string(&target)
                .map_err(|error| KernelError::Other(format!("read {path}: {error}")))?;
            let size_bytes = content.len();
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "content": content,
                "sizeBytes": size_bytes,
                "binary": false
            }))
        })();
        self.workspace_result(request_id, "workspace.read", result)
    }

    pub(crate) fn workspace_write(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
        content: String,
        create: bool,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            deny_protected_deepcode_mutation(&path)?;
            let target = self.resolve_workspace_path(&path)?;
            if !create && !target.exists() {
                return Err(KernelError::InvalidCommand(format!(
                    "{path} does not exist"
                )));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| KernelError::Other(format!("create parent: {error}")))?;
            }
            fs::write(&target, content)
                .map_err(|error| KernelError::Other(format!("write {path}: {error}")))?;
            let size_bytes = fs::metadata(&target)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "saved": true,
                "sizeBytes": size_bytes
            }))
        })();
        self.workspace_result(request_id, "workspace.write", result)
    }

    pub(crate) fn workspace_create(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
        content: Option<String>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            deny_protected_deepcode_mutation(&path)?;
            let target = self.resolve_workspace_path(&path)?;
            if target.exists() {
                return Err(KernelError::InvalidCommand(format!(
                    "{path} already exists"
                )));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| KernelError::Other(format!("create parent: {error}")))?;
            }
            fs::write(&target, content.unwrap_or_default())
                .map_err(|error| KernelError::Other(format!("create {path}: {error}")))?;
            let size_bytes = fs::metadata(&target)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "created": true,
                "saved": true,
                "sizeBytes": size_bytes
            }))
        })();
        self.workspace_result(request_id, "workspace.create", result)
    }

    pub(crate) fn workspace_create_folder(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            deny_protected_deepcode_mutation(&path)?;
            let target = self.resolve_workspace_path(&path)?;
            if target.exists() && !target.is_dir() {
                return Err(KernelError::InvalidCommand(format!(
                    "{path} already exists and is not a directory"
                )));
            }
            fs::create_dir_all(&target)
                .map_err(|error| KernelError::Other(format!("create folder {path}: {error}")))?;
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "created": true
            }))
        })();
        self.workspace_result(request_id, "workspace.create_folder", result)
    }

    pub(crate) fn workspace_rename(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        old_path: String,
        new_path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let _workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            deny_protected_deepcode_mutation(&old_path)?;
            deny_protected_deepcode_mutation(&new_path)?;
            let old_target = self.resolve_workspace_path(&old_path)?;
            let new_target = self.resolve_workspace_path(&new_path)?;
            if let Some(parent) = new_target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| KernelError::Other(format!("create parent: {error}")))?;
            }
            fs::rename(&old_target, &new_target)
                .map_err(|error| KernelError::Other(format!("rename {old_path}: {error}")))?;
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "oldPath": normalize_relative_path(&old_path),
                "newPath": normalize_relative_path(&new_path),
                "renamed": true
            }))
        })();
        self.workspace_result(request_id, "workspace.rename", result)
    }

    pub(crate) fn workspace_delete(
        &self,
        request_id: RequestId,
        folder_id: Option<String>,
        path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let result = (|| {
            let workspace = self.current_workspace()?;
            validate_folder_id(folder_id.as_deref())?;
            if normalize_relative_path(&path) == "." {
                return Err(KernelError::PermissionDenied(
                    "workspace.delete cannot remove the workspace root".to_string(),
                ));
            }
            deny_protected_deepcode_mutation(&path)?;
            let target = self.resolve_workspace_path(&path)?;
            if target == workspace.root {
                return Err(KernelError::PermissionDenied(
                    "workspace.delete cannot remove the workspace root".to_string(),
                ));
            }
            let metadata = fs::symlink_metadata(&target)
                .map_err(|error| KernelError::Other(format!("stat {path}: {error}")))?;
            let kind = if metadata.file_type().is_dir() {
                "directory"
            } else {
                "file"
            };
            if metadata.file_type().is_dir() {
                fs::remove_dir_all(&target).map_err(|error| {
                    KernelError::Other(format!("delete directory {path}: {error}"))
                })?;
            } else {
                fs::remove_file(&target)
                    .map_err(|error| KernelError::Other(format!("delete file {path}: {error}")))?;
            }
            Ok(serde_json::json!({
                "folderId": "wf-0",
                "path": normalize_relative_path(&path),
                "deleted": true,
                "kind": kind
            }))
        })();
        self.workspace_result(request_id, "workspace.delete", result)
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
                return Err(KernelError::NotImplemented("workspace.search.regex"));
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
                "matches": result.matches
            }))
        })();
        self.workspace_result(request_id, "workspace.search", result)
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

    pub(crate) fn workspace_result(
        &self,
        request_id: RequestId,
        operation: &str,
        result: KernelResult<Value>,
    ) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::WorkspaceResult {
            request_id,
            operation: operation.to_string(),
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
            sequence: None,
        }])
    }
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

pub(crate) fn deny_protected_deepcode_mutation(path: &str) -> KernelResult<()> {
    WorkspaceBoundary::assert_mutable_config_asset(path)?;
    let normalized = path.replace('\\', "/").trim_matches('/').to_string();
    if normalized.is_empty() || normalized == "." {
        return Ok(());
    }
    let protected_prefixes = [
        "bin/macos-arm64/config",
        "bin/macos-arm64/sessions",
        "bin/macos-arm64/conversation-archives",
        "bin/macos-arm64/kernel",
    ];
    if protected_prefixes.iter().any(|prefix| {
        normalized == *prefix
            || normalized.starts_with(&format!("{prefix}/"))
            || prefix.starts_with(&format!("{normalized}/"))
    }) {
        return Err(KernelError::PermissionDenied(
            "workspace mutation cannot modify package-local DeepCode runtime data".to_string(),
        ));
    }
    Ok(())
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
            Ok(serde_json::json!({
                "name": entry.file_name().to_string_lossy(),
                "path": relative,
                "type": if file_type.is_dir() { "directory" } else { "file" },
                "children": children
            }))
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

pub(crate) struct WorkspaceSearchResult {
    pub(crate) matches: Vec<Value>,
    pub(crate) truncated: bool,
    pub(crate) visited_files: usize,
    pub(crate) context_lines: usize,
    pub(crate) max_results: usize,
}

pub(crate) fn search_workspace_with_options(
    root: &Path,
    query: &str,
    includes: &[String],
    context_lines: u32,
    max_results: u32,
) -> KernelResult<WorkspaceSearchResult> {
    let mut matches = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited_files = 0_usize;
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
            let Ok(content) = fs::read_to_string(&entry_path) else {
                continue;
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
                        return Ok(WorkspaceSearchResult {
                            matches,
                            truncated,
                            visited_files,
                            context_lines,
                            max_results,
                        });
                    }
                }
            }
        }
    }
    Ok(WorkspaceSearchResult {
        matches,
        truncated,
        visited_files,
        context_lines,
        max_results,
    })
}

pub(crate) fn skip_directory(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(OsStr::to_str),
        Some(".git" | "node_modules" | "target" | "dist" | ".build-cache")
    )
}
