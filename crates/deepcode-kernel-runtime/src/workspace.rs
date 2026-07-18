use super::*;
use deepcode_kernel_tools::file_content::lightweight_file_classification;

impl DeepCodeKernelRuntime {
    pub(crate) fn host_workspace_binding_resolve(
        &self,
        request_id: RequestId,
        path: String,
    ) -> KernelResult<Vec<KernelEvent>> {
        let requested = PathBuf::from(path.trim());
        if !requested.is_dir() {
            return Err(KernelError::InvalidCommand(format!(
                "workspace binding path is not a directory: {}",
                requested.display()
            )));
        }
        let resolved = resolve_workspace_root(&path).map_err(KernelError::InvalidCommand)?;
        preflight_workspace_root_readable(&resolved.root)?;
        let binding = workspace_binding_from_root(&resolved.root);
        self.host_workspace_result(
            request_id,
            HostWorkspaceOutput::BindingResolved(HostWorkspaceBindingResolved {
                workspace_binding: binding,
                root_status: HostWorkspaceRootStatus::Ready,
            }),
        )
    }

    pub(crate) fn host_workspace_open(
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
        let output = workspace_spec(&workspace);
        self.state.current_workspace = Some(workspace);
        self.host_workspace_result(
            request_id,
            HostWorkspaceOutput::Opened(HostWorkspaceOpened { workspace: output }),
        )
    }

    pub(crate) fn host_workspace_current(
        &self,
        request_id: RequestId,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.host_workspace_result(
            request_id,
            HostWorkspaceOutput::Current(HostWorkspaceCurrent {
                current: self.state.current_workspace.as_ref().map(workspace_spec),
                fallback_used: false,
                last_error: None,
            }),
        )
    }

    pub(crate) fn host_workspace_save(
        &mut self,
        request_id: RequestId,
        file_name: Option<String>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let workspace = self.current_workspace()?.clone();
        let file_name =
            normalize_workspace_file_name(file_name.as_deref().unwrap_or(workspace.name.as_str()))?;
        let workspace_file_path = workspace.root.join(&file_name);
        let overwritten = workspace_file_path.exists();
        let content = serde_json::json!({
            "folders": [{ "path": "." }],
            "settings": workspace.settings
        });
        atomic_write_workspace_json(&workspace_file_path, &content)?;

        let open_events = self.host_workspace_open(
            request_id.clone(),
            workspace_file_path.to_string_lossy().to_string(),
        )?;
        let reopened = open_events.into_iter().find_map(|event| match event {
            KernelEvent::HostWorkspaceCompleted {
                result:
                    HostWorkspaceResult {
                        output: HostWorkspaceOutput::Opened(opened),
                        ..
                    },
                ..
            } => Some(opened.workspace),
            _ => None,
        });
        let reopened = reopened.ok_or_else(|| {
            KernelError::Other("host workspace save did not reopen the workspace".to_string())
        })?;
        self.host_workspace_result(
            request_id,
            HostWorkspaceOutput::Saved(HostWorkspaceSaved {
                workspace_file_path: workspace_file_path.to_string_lossy().to_string(),
                workspace: reopened,
                created: !overwritten,
                overwritten,
            }),
        )
    }

    pub(crate) fn host_resource_query(
        &self,
        request_id: RequestId,
        query: HostInspectionQuery,
    ) -> KernelResult<Vec<KernelEvent>> {
        let output = match query {
            HostInspectionQuery::Browse { path } => {
                HostInspectionOutput::Browse(host_browse_output(path.as_deref())?)
            }
            HostInspectionQuery::List {
                folder_id,
                path,
                depth,
            } => {
                validate_folder_id(folder_id.as_deref())?;
                let output = self.execute_host_projection_operation(
                    ToolOperationKind::FsList,
                    serde_json::json!({
                        "path": path,
                        "depth": depth,
                        "includeHidden": false
                    }),
                )?;
                HostInspectionOutput::List(decode_host_output_field(
                    &output,
                    "nodes",
                    "fs.list nodes",
                )?)
            }
            HostInspectionQuery::Read { folder_id, path } => {
                validate_folder_id(folder_id.as_deref())?;
                HostInspectionOutput::Read(decode_host_output(
                    self.execute_host_projection_operation(
                        ToolOperationKind::FsRead,
                        serde_json::json!({ "path": path }),
                    )?,
                    "fs.read",
                )?)
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
                HostInspectionOutput::Grep(decode_host_output(
                    self.execute_host_projection_operation(
                        ToolOperationKind::CodeGrep,
                        serde_json::json!({
                            "query": query,
                            "path": path,
                            "include": include,
                            "exclude": exclude,
                            "strategy": strategy,
                            "contextLines": context_lines,
                            "maxResults": max_results
                        }),
                    )?,
                    "code.grep",
                )?)
            }
            HostInspectionQuery::GitStatus => HostInspectionOutput::GitStatus(decode_host_output(
                self.execute_host_projection_operation(
                    ToolOperationKind::GitStatus,
                    serde_json::json!({}),
                )?,
                "git.status",
            )?),
            HostInspectionQuery::GitDiff { path, staged } => {
                HostInspectionOutput::GitDiff(decode_host_output(
                    self.execute_host_projection_operation(
                        ToolOperationKind::GitDiff,
                        serde_json::json!({ "path": path, "staged": staged }),
                    )?,
                    "git.diff",
                )?)
            }
        };
        Ok(vec![KernelEvent::HostInspectionCompleted {
            request_id,
            result: HostInspectionResult {
                source: HostResultSource::HostProjection,
                output,
            },
        }])
    }

    pub(crate) fn current_workspace(&self) -> KernelResult<&RuntimeWorkspace> {
        self.state
            .current_workspace
            .as_ref()
            .ok_or(KernelError::MissingWorkspaceBinding)
    }

    pub(crate) fn host_workspace_result(
        &self,
        request_id: RequestId,
        output: HostWorkspaceOutput,
    ) -> KernelResult<Vec<KernelEvent>> {
        Ok(vec![KernelEvent::HostWorkspaceCompleted {
            request_id,
            result: HostWorkspaceResult {
                source: HostResultSource::HostManagement,
                output,
            },
        }])
    }
}

fn normalize_workspace_file_name(name: &str) -> KernelResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(KernelError::InvalidCommand(
            "workspace file name is required".to_string(),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || matches!(trimmed, "." | "..") {
        return Err(KernelError::InvalidCommand(
            "workspace file name must not contain path separators".to_string(),
        ));
    }
    let sanitized = trimmed
        .chars()
        .map(|ch| {
            if matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                ch
            }
        })
        .collect::<String>();
    if sanitized.ends_with(".code-workspace") {
        Ok(sanitized)
    } else {
        Ok(format!("{sanitized}.code-workspace"))
    }
}

fn atomic_write_workspace_json(path: &Path, value: &Value) -> KernelResult<()> {
    let parent = path.parent().ok_or_else(|| {
        KernelError::InvalidCommand("workspace file path has no parent".to_string())
    })?;
    let content = serde_json::to_vec_pretty(value)
        .map_err(|error| KernelError::Other(format!("encode workspace file: {error}")))?;
    let temp_path = parent.join(format!(
        ".deepcode-workspace-{}-{}.tmp",
        std::process::id(),
        now_millis()
    ));
    let cleanup = HostTemporaryPath::new(temp_path.clone());
    fs::write(&temp_path, content)
        .map_err(|error| KernelError::Other(format!("write {}: {error}", temp_path.display())))?;
    fs::rename(&temp_path, path)
        .map_err(|error| KernelError::Other(format!("rename {}: {error}", path.display())))?;
    cleanup.disarm();
    Ok(())
}

struct HostTemporaryPath {
    path: PathBuf,
    armed: std::cell::Cell<bool>,
}

impl HostTemporaryPath {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            armed: std::cell::Cell::new(true),
        }
    }

    fn disarm(&self) {
        self.armed.set(false);
    }
}

impl Drop for HostTemporaryPath {
    fn drop(&mut self) {
        if self.armed.get() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn host_browse_output(path: Option<&str>) -> KernelResult<HostBrowseResult> {
    let path = path
        .map(PathBuf::from)
        .or_else(host_home_dir)
        .ok_or_else(|| {
            KernelError::Other(
                "host browse requires an explicit path when no home directory is available"
                    .to_string(),
            )
        })?;
    let target = if path.is_dir() {
        path
    } else {
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                KernelError::Other(format!(
                    "host browse target {} is not a directory and has no parent directory",
                    path.display()
                ))
            })?
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
            HostBrowseEntry {
                hidden: name.starts_with('.'),
                name,
                absolute_path: path.to_string_lossy().to_string(),
                kind: if is_dir {
                    HostFileTreeNodeKind::Directory
                } else {
                    HostFileTreeNodeKind::File
                },
                is_code_workspace: path.extension().and_then(|ext| ext.to_str())
                    == Some("code-workspace"),
            }
        })
        .collect::<Vec<_>>();
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

#[derive(Debug)]
pub(crate) struct ResolvedWorkspaceRoot {
    pub(crate) source: HostWorkspaceSourceKind,
    pub(crate) source_path: Option<PathBuf>,
    pub(crate) root: PathBuf,
    pub(crate) original_folder_path: String,
    pub(crate) folder_is_absolute: bool,
    pub(crate) settings: Value,
    pub(crate) unsupported_fields: Vec<HostUnsupportedWorkspaceField>,
}

pub(crate) fn resolve_workspace_root(path: &str) -> Result<ResolvedWorkspaceRoot, String> {
    let source = PathBuf::from(path);
    if source.is_dir() {
        let root = source
            .canonicalize()
            .map_err(|error| format!("canonicalize workspace {path}: {error}"))?;
        return Ok(ResolvedWorkspaceRoot {
            source: HostWorkspaceSourceKind::Directory,
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
            source: HostWorkspaceSourceKind::CodeWorkspace,
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

pub(crate) fn workspace_spec(workspace: &RuntimeWorkspace) -> HostWorkspaceSpec {
    let root_path = workspace.root.to_string_lossy().to_string();
    HostWorkspaceSpec {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        source: workspace.source,
        source_path: workspace
            .source_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        root_path: root_path.clone(),
        folders: vec![HostWorkspaceFolder {
            id: "wf-0".to_string(),
            name: workspace.name.clone(),
            path: root_path.clone(),
            absolute_path: root_path,
            original_path: workspace.original_folder_path.clone(),
            is_absolute: workspace.folder_is_absolute,
        }],
        settings: workspace.settings.clone(),
        unsupported_fields: workspace.unsupported_fields.clone(),
        opened_at: workspace.opened_at.clone(),
    }
}

pub(crate) fn workspace_binding_from_root(root: &Path) -> WorkspaceBinding {
    let canonical = root.to_string_lossy().to_string();
    let digest = deepcode_kernel_tools::hash_bytes(canonical.as_bytes());
    WorkspaceBinding {
        workspace_id: Some(format!("workspace-{}", &digest[..16])),
        workspace_hash: Some(digest.clone()),
        open_path: Some(canonical),
        active_folder_id: Some("wf-0".to_string()),
        folder_hash: Some(digest),
    }
}

pub(crate) fn unsupported_workspace_fields(value: &Value) -> Vec<HostUnsupportedWorkspaceField> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .filter(|(key, _)| key.as_str() != "folders" && key.as_str() != "settings")
        .map(|(key, value)| HostUnsupportedWorkspaceField {
            key: key.clone(),
            kind: value_kind(value).to_string(),
        })
        .collect()
}

fn decode_host_output<T: DeserializeOwned>(output: Value, label: &str) -> KernelResult<T> {
    serde_json::from_value(output)
        .map_err(|error| KernelError::Other(format!("decode typed {label} host output: {error}")))
}

fn decode_host_output_field<T: DeserializeOwned>(
    output: &Value,
    field: &str,
    label: &str,
) -> KernelResult<T> {
    let value = output.get(field).cloned().ok_or_else(|| {
        KernelError::Other(format!("typed {label} host output is missing {field}"))
    })?;
    decode_host_output(value, label)
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

pub(crate) fn preflight_workspace_root_readable(root: &Path) -> KernelResult<()> {
    list_nodes(root, root, 1).map(|_| ()).map_err(|error| {
        KernelError::WorkspaceRootUnreadable(format!(
            "{} cannot be listed for read-only workspace access: {error}",
            root.display()
        ))
    })
}

pub(crate) struct DirectoryListing {
    pub(crate) nodes: Vec<Value>,
    pub(crate) returned_count: usize,
    pub(crate) truncated: bool,
}

pub(crate) fn list_nodes(path: &Path, root: &Path, depth: u32) -> KernelResult<Vec<Value>> {
    Ok(list_nodes_bounded(path, root, depth, 200)?.nodes)
}

pub(crate) fn list_nodes_bounded(
    path: &Path,
    root: &Path,
    depth: u32,
    max_entries: usize,
) -> KernelResult<DirectoryListing> {
    let mut remaining = max_entries.max(1);
    let mut truncated = false;
    let nodes = collect_nodes_bounded(path, root, depth, &mut remaining, &mut truncated)?;
    Ok(DirectoryListing {
        returned_count: max_entries.max(1) - remaining,
        nodes,
        truncated,
    })
}

fn collect_nodes_bounded(
    path: &Path,
    root: &Path,
    depth: u32,
    remaining: &mut usize,
    truncated: &mut bool,
) -> KernelResult<Vec<Value>> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| KernelError::Other(format!("list {}: {error}", path.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| KernelError::Other(format!("list {}: {error}", path.display())))?;
    entries.sort_by(compare_dir_entries);

    let mut nodes = Vec::new();
    for entry in entries {
        if *remaining == 0 {
            *truncated = true;
            break;
        }
        *remaining -= 1;
        let node = (|| {
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
                Some(collect_nodes_bounded(
                    &entry_path,
                    root,
                    depth - 1,
                    remaining,
                    truncated,
                )?)
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
        })()?;
        nodes.push(node);
    }
    Ok(nodes)
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

pub(crate) fn skip_directory(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(OsStr::to_str),
        Some(".git" | "node_modules" | "target" | "dist" | ".build-cache")
    )
}
