use crate::catalog::fnv1a64_hex;
use crate::input_validation::{validate_action, validate_content_blocks};
use crate::operation_builders::*;
use crate::review::normalized_args_for_operation;
use crate::{
    ContentBlock, FileTargetRef, GitOperation, GitOperationKind, KernelToolRegistration,
    KernelToolRegistry, OperationExecutionMode, PlannedOperation, PlannedOperationKind,
    ToolInputValidationError, ToolOperationKind, WorkspaceOperation, WorkspaceOperationKind,
};
use deepcode_kernel_abi::{
    KernelAction, KernelActionBatch, KernelActionBundle, KernelActionProposal, KernelContentBlock,
};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum OperationCompileError {
    #[error(transparent)]
    InvalidInput(#[from] ToolInputValidationError),
    #[error("action bundle has no actions")]
    EmptyActions,
    #[error("action {action_id} requires a content block reference")]
    MissingSourceBlock { action_id: String },
    #[error("contentBlock {content_block_id} was not provided for action {action_id}")]
    MissingContentBlock {
        action_id: String,
        content_block_id: String,
    },
    #[error("contentBlock {content_block_id} has no contentLines")]
    MissingContentBlockContent { content_block_id: String },
    #[error(
        "contentBlock {content_block_id} has empty content; use allowEmptyContent with createEmpty"
    )]
    EmptyContentBlockContent { content_block_id: String },
    #[error(
        "action {action_id} path {action_path} does not match contentBlock {content_block_id} targetPath {block_path}"
    )]
    ContentBlockTargetMismatch {
        action_id: String,
        content_block_id: String,
        action_path: String,
        block_path: String,
    },
    #[error(
        "contentBlock {content_block_id} operation {operation} is not valid for toolId {tool_id}"
    )]
    ContentBlockOperationMismatch {
        content_block_id: String,
        operation: String,
        tool_id: String,
    },
    #[error("fs action {action_id} requires target path")]
    MissingTargetPath { action_id: String },
    #[error("fs.delete action {action_id} requires args.path")]
    MissingDeleteTarget { action_id: String },
    #[error("fs.delete cannot remove workspace root")]
    DeleteWorkspaceRoot { action_id: String },
    #[error("code.grep action {action_id} requires query")]
    MissingSearchQuery { action_id: String },
    #[error("fs.glob action {action_id} requires pattern")]
    MissingGlobPattern { action_id: String },
    #[error("unsupported toolId {tool_id}")]
    UnsupportedToolId { tool_id: String },
    #[error("unsupported operation kind {kind} for toolId {tool_id}")]
    UnsupportedKind { tool_id: String, kind: String },
}

pub struct OperationCompiler<'a> {
    registry: &'a KernelToolRegistry,
}

impl<'a> OperationCompiler<'a> {
    pub fn new(registry: &'a KernelToolRegistry) -> Self {
        Self { registry }
    }

    pub fn registry(&self) -> &KernelToolRegistry {
        self.registry
    }

    pub fn normalized_args(&self, operation: &PlannedOperation) -> Value {
        normalized_args_for_operation(operation)
    }

    pub fn collect_content_blocks(
        &self,
        blocks: &[KernelContentBlock],
    ) -> Result<BTreeMap<String, ContentBlock>, OperationCompileError> {
        Ok(validate_content_blocks(blocks)?)
    }

    pub fn compile_batch(
        &self,
        batch: &KernelActionBatch,
    ) -> Result<Vec<PlannedOperation>, OperationCompileError> {
        self.compile_payload(&batch.action_bundle, &batch.content_blocks)
    }

    pub fn compile_proposal(
        &self,
        proposal: &KernelActionProposal,
    ) -> Result<Vec<PlannedOperation>, OperationCompileError> {
        self.compile_payload(&proposal.action_bundle, &proposal.content_blocks)
    }

    fn compile_payload(
        &self,
        action_bundle: &KernelActionBundle,
        content_blocks: &[KernelContentBlock],
    ) -> Result<Vec<PlannedOperation>, OperationCompileError> {
        if action_bundle.actions.is_empty() {
            return Err(OperationCompileError::EmptyActions);
        }
        let content_blocks = self.collect_content_blocks(content_blocks)?;
        let operations = action_bundle
            .actions
            .iter()
            .enumerate()
            .map(|(index, action)| self.compile_action(action, &content_blocks, index))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(self.expand_internal_operations(operations))
    }

    fn expand_internal_operations(
        &self,
        operations: Vec<PlannedOperation>,
    ) -> Vec<PlannedOperation> {
        let mut expanded = Vec::new();
        let mut ensured_directories = BTreeMap::<String, String>::new();
        for mut operation in operations {
            let parent = match &operation.operation {
                PlannedOperationKind::Workspace(workspace)
                    if workspace.kind == WorkspaceOperationKind::Create =>
                {
                    workspace
                        .target_path
                        .as_deref()
                        .and_then(|path| std::path::Path::new(path).parent())
                        .map(|path| path.to_string_lossy().replace('\\', "/"))
                        .filter(|path| !path.is_empty() && path != ".")
                }
                _ => None,
            };
            if let Some(parent) = parent {
                let ensure_id = ensured_directories
                    .entry(parent.clone())
                    .or_insert_with(|| format!("ensure-dir-{}", fnv1a64_hex(&parent)))
                    .clone();
                if !expanded
                    .iter()
                    .any(|item: &PlannedOperation| item.id == ensure_id)
                {
                    expanded.push(internal_ensure_directory_operation(
                        self.registry,
                        ensure_id.clone(),
                        parent,
                    ));
                }
                if !operation.depends_on.contains(&ensure_id) {
                    operation.depends_on.push(ensure_id);
                }
            }
            expanded.push(operation);
        }
        expanded
    }

    pub fn compile_action(
        &self,
        action: &KernelAction,
        content_blocks: &BTreeMap<String, ContentBlock>,
        index: usize,
    ) -> Result<PlannedOperation, OperationCompileError> {
        let id = action.action_id.trim().to_string();
        let tool_id = action.tool_id.trim().to_string();
        let descriptor = self.registry.get(&tool_id).ok_or_else(|| {
            OperationCompileError::UnsupportedToolId {
                tool_id: tool_id.clone(),
            }
        })?;
        if !self
            .registry
            .contract(&tool_id)
            .is_some_and(|template| template.provider_visible)
        {
            return Err(OperationCompileError::UnsupportedToolId { tool_id });
        }
        validate_action(self.registry, action, index)?;
        let capability = descriptor.capability().to_string();
        let operation_kind = descriptor.operation_kind();
        let title = action.description.trim().to_string();
        let permission_labels = Vec::new();
        let depends_on = action.depends_on.clone();
        let metadata = OperationMetadata {
            id,
            title,
            tool_id,
            operation_kind,
            capability,
            permission_labels,
        };
        let mut operation = match operation_kind {
            ToolOperationKind::FsRead
            | ToolOperationKind::FsList
            | ToolOperationKind::FsGlob
            | ToolOperationKind::FsDiff
            | ToolOperationKind::CodeGrep
            | ToolOperationKind::FsCreate
            | ToolOperationKind::FsWrite
            | ToolOperationKind::FsEdit
            | ToolOperationKind::FsRename
            | ToolOperationKind::FsDelete
            | ToolOperationKind::DocumentRead => {
                self.compile_workspace_action(&action.args, content_blocks, metadata)
            }
            ToolOperationKind::GitStatus
            | ToolOperationKind::GitDiff
            | ToolOperationKind::GitStage
            | ToolOperationKind::GitUnstage
            | ToolOperationKind::GitCommit
            | ToolOperationKind::GitPush => self.compile_git_action(&action.args, metadata),
            ToolOperationKind::ProcessExec => Ok(external_process_operation(
                self.registry,
                &action.args,
                metadata,
            )),
            ToolOperationKind::WebSearch | ToolOperationKind::WebFetch => Ok(
                external_network_operation(self.registry, &action.args, metadata),
            ),
            ToolOperationKind::BrowserOpen
            | ToolOperationKind::BrowserReload
            | ToolOperationKind::BrowserSnapshot
            | ToolOperationKind::BrowserInspect
            | ToolOperationKind::BrowserClick
            | ToolOperationKind::BrowserType
            | ToolOperationKind::BrowserScroll => Ok(external_browser_operation(
                self.registry,
                &action.args,
                metadata,
            )),
            ToolOperationKind::ProviderCall => Ok(external_provider_operation(
                self.registry,
                &action.args,
                metadata,
            )),
            ToolOperationKind::FsEnsureDirectory => Err(OperationCompileError::UnsupportedToolId {
                tool_id: metadata.tool_id,
            }),
        }?;
        operation.depends_on = depends_on;
        Ok(operation)
    }

    fn compile_workspace_action(
        &self,
        args: &Value,
        content_blocks: &BTreeMap<String, ContentBlock>,
        metadata: OperationMetadata,
    ) -> Result<PlannedOperation, OperationCompileError> {
        let OperationMetadata {
            id,
            title,
            tool_id,
            operation_kind,
            capability,
            permission_labels,
        } = metadata;
        let kind = workspace_kind_for_operation(operation_kind)?;
        let target_kind = get_string(args, &["targetKind"]);
        let recursive = get_bool(args, "recursive");
        let mut target_path = get_string(args, &["path"]);
        let mut target_ref = target_path
            .as_ref()
            .map(|path| FileTargetRef::from_path(path.clone()));
        let mut content_block_id = get_string(args, &["contentBlockId"]);
        let mut replacement_block_id = get_string(args, &["replacementBlockId"]);
        let mut content = None;
        let mut allow_empty_content = false;

        if matches!(
            kind,
            WorkspaceOperationKind::Write
                | WorkspaceOperationKind::Create
                | WorkspaceOperationKind::Patch
                | WorkspaceOperationKind::Diff
        ) {
            let block_id = if kind == WorkspaceOperationKind::Patch {
                replacement_block_id
                    .clone()
                    .or_else(|| content_block_id.clone())
            } else {
                content_block_id.clone()
            }
            .ok_or_else(|| OperationCompileError::MissingSourceBlock {
                action_id: id.clone(),
            })?;
            let block = content_blocks.get(&block_id).ok_or_else(|| {
                OperationCompileError::MissingContentBlock {
                    action_id: id.clone(),
                    content_block_id: block_id.clone(),
                }
            })?;
            let block_content = block.content.clone().ok_or_else(|| {
                OperationCompileError::MissingContentBlockContent {
                    content_block_id: block_id.clone(),
                }
            })?;
            if block_content.is_empty() && !block_allows_empty_content(block) {
                return Err(OperationCompileError::EmptyContentBlockContent {
                    content_block_id: block_id.clone(),
                });
            }
            validate_content_block_binding(operation_kind, &tool_id, &id, args, block)?;
            content = Some(block_content);
            allow_empty_content = block_allows_empty_content(block);
            target_path = target_path.or_else(|| block.target_path.clone());
            target_ref = target_path
                .as_ref()
                .map(|path| FileTargetRef::from_path(path.clone()));
            if kind == WorkspaceOperationKind::Patch {
                replacement_block_id = Some(block_id.clone());
            } else {
                content_block_id = Some(block_id);
            }
        }

        let query = get_string(args, &["query"]);
        if kind == WorkspaceOperationKind::Search && query.is_none() {
            return Err(OperationCompileError::MissingSearchQuery {
                action_id: id.clone(),
            });
        }
        let pattern = get_string(args, &["pattern"]);
        if kind == WorkspaceOperationKind::Glob && pattern.is_none() {
            return Err(OperationCompileError::MissingGlobPattern {
                action_id: id.clone(),
            });
        }
        if kind == WorkspaceOperationKind::Delete {
            let path = target_path
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| OperationCompileError::MissingDeleteTarget {
                    action_id: id.clone(),
                })?;
            if path == "." || path == "./" {
                return Err(OperationCompileError::DeleteWorkspaceRoot {
                    action_id: id.clone(),
                });
            }
        }
        if matches!(
            kind,
            WorkspaceOperationKind::Read
                | WorkspaceOperationKind::List
                | WorkspaceOperationKind::Diff
                | WorkspaceOperationKind::Write
                | WorkspaceOperationKind::Create
                | WorkspaceOperationKind::Patch
                | WorkspaceOperationKind::Rename
                | WorkspaceOperationKind::DocumentRead
        ) && target_path.is_none()
        {
            return Err(OperationCompileError::MissingTargetPath {
                action_id: id.clone(),
            });
        }

        let mut read_set = Vec::new();
        let mut write_set = Vec::new();
        match kind {
            WorkspaceOperationKind::Read
            | WorkspaceOperationKind::List
            | WorkspaceOperationKind::Glob
            | WorkspaceOperationKind::Search
            | WorkspaceOperationKind::Diff
            | WorkspaceOperationKind::DocumentRead => {
                read_set.push(
                    target_path
                        .clone()
                        .or_else(|| query.clone())
                        .or_else(|| pattern.clone())
                        .unwrap_or_else(|| ".".to_string()),
                );
            }
            WorkspaceOperationKind::Write
            | WorkspaceOperationKind::Create
            | WorkspaceOperationKind::Delete
            | WorkspaceOperationKind::EnsureDirectory => {
                let path = target_path.clone().ok_or_else(|| {
                    OperationCompileError::MissingTargetPath {
                        action_id: id.clone(),
                    }
                })?;
                write_set.push(path);
            }
            WorkspaceOperationKind::Patch => {
                let path = target_path.clone().ok_or_else(|| {
                    OperationCompileError::MissingTargetPath {
                        action_id: id.clone(),
                    }
                })?;
                read_set.push(path.clone());
                write_set.push(path);
            }
            WorkspaceOperationKind::Rename => {
                let source = target_path.clone().ok_or_else(|| {
                    OperationCompileError::MissingTargetPath {
                        action_id: id.clone(),
                    }
                })?;
                let destination = get_string(args, &["destinationPath"]).ok_or_else(|| {
                    OperationCompileError::MissingTargetPath {
                        action_id: id.clone(),
                    }
                })?;
                write_set.push(source);
                write_set.push(destination);
            }
        }
        let conflict_keys = conflict_keys_for_action(&read_set, &write_set);
        let execution_mode = operation_execution_mode(self.registry, &tool_id, kind)?;

        Ok(PlannedOperation {
            id,
            title,
            tool_id,
            operation_kind,
            depends_on: Vec::new(),
            capability,
            permission_labels,
            target_ref,
            read_set,
            write_set,
            conflict_keys,
            execution_mode,
            operation: PlannedOperationKind::Workspace(Box::new(WorkspaceOperation {
                kind,
                target_path,
                target_kind,
                recursive,
                content_block_id,
                replacement_block_id,
                content,
                patch_spec: args.get("patchSpec").cloned(),
                allow_empty_content,
                temporary: args
                    .get("temporary")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                executable: args
                    .get("executable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                query,
                pattern,
                depth: args.get("depth").and_then(Value::as_u64),
                include_hidden: args
                    .get("includeHidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                include: get_string_array(args, "include").unwrap_or_default(),
                exclude: get_string_array(args, "exclude").unwrap_or_default(),
                strategy: get_string(args, &["strategy"]),
                context_lines: args.get("contextLines").and_then(Value::as_u64),
                max_results: args.get("maxResults").and_then(Value::as_u64),
                rename_to: get_string(args, &["destinationPath"]),
                start_line: args.get("startLine").and_then(Value::as_u64),
                end_line: args.get("endLine").and_then(Value::as_u64),
                start_page: args.get("startPage").and_then(Value::as_u64),
                end_page: args.get("endPage").and_then(Value::as_u64),
            })),
        })
    }

    fn compile_git_action(
        &self,
        args: &Value,
        metadata: OperationMetadata,
    ) -> Result<PlannedOperation, OperationCompileError> {
        let OperationMetadata {
            id,
            title,
            tool_id,
            operation_kind,
            capability,
            permission_labels,
        } = metadata;
        let kind = git_kind_for_operation(operation_kind)?;
        let mut paths = get_string_array(args, "paths").unwrap_or_default();
        if paths.is_empty() {
            if let Some(path) = get_string(args, &["path"]) {
                paths.push(path);
            }
        }
        let staged = args.get("staged").and_then(Value::as_bool).unwrap_or(false);
        let message = get_string(args, &["message"]);
        let remote = get_string(args, &["remote"]);
        let branch = get_string(args, &["branch"]);
        let read_set = if matches!(kind, GitOperationKind::Status | GitOperationKind::Diff) {
            if paths.is_empty() {
                vec!["git:workspace".to_string()]
            } else {
                paths.iter().map(|path| format!("git:{path}")).collect()
            }
        } else {
            Vec::new()
        };
        let write_set = if matches!(
            kind,
            GitOperationKind::Stage
                | GitOperationKind::Unstage
                | GitOperationKind::Commit
                | GitOperationKind::Push
        ) {
            if paths.is_empty() {
                vec!["git:index".to_string()]
            } else {
                paths.iter().map(|path| format!("git:{path}")).collect()
            }
        } else {
            Vec::new()
        };
        let conflict_keys = conflict_keys_for_action(&read_set, &write_set);
        let execution_mode = self
            .registry
            .get(&tool_id)
            .map(KernelToolRegistration::execution_mode)
            .unwrap_or(OperationExecutionMode::Blocked);
        Ok(PlannedOperation {
            id,
            title,
            tool_id,
            operation_kind,
            depends_on: Vec::new(),
            capability,
            permission_labels,
            target_ref: None,
            read_set,
            write_set,
            conflict_keys,
            execution_mode,
            operation: PlannedOperationKind::Git(GitOperation {
                kind,
                paths,
                message,
                staged,
                remote,
                branch,
            }),
        })
    }
}

fn validate_content_block_binding(
    operation_kind: ToolOperationKind,
    tool_id: &str,
    action_id: &str,
    args: &Value,
    block: &ContentBlock,
) -> Result<(), OperationCompileError> {
    if let (Some(action_path), Some(block_path)) =
        (get_string(args, &["path"]), block.target_path.clone())
    {
        if action_path != block_path {
            return Err(OperationCompileError::ContentBlockTargetMismatch {
                action_id: action_id.to_string(),
                content_block_id: block.id.clone(),
                action_path,
                block_path,
            });
        }
    }

    let operation = block.operation.as_deref().unwrap_or_default();
    let valid = match operation_kind {
        ToolOperationKind::FsCreate => matches!(operation, "create" | "createEmpty"),
        ToolOperationKind::FsWrite => operation == "overwrite",
        ToolOperationKind::FsEdit => matches!(
            operation,
            "patch" | "replaceBlock" | "insertBefore" | "insertAfter"
        ),
        ToolOperationKind::FsDiff => true,
        _ => false,
    };
    if !valid {
        return Err(OperationCompileError::ContentBlockOperationMismatch {
            content_block_id: block.id.clone(),
            operation: operation.to_string(),
            tool_id: tool_id.to_string(),
        });
    }
    Ok(())
}
