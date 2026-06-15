use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn action_batch_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        batch: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let run_id_text = run_id.0.clone();
        let record = self.record_by_run(&run_id_text)?.clone();
        let session_id_text = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let batch_summary = summarize_action_batch(&batch);
        let accepted_sequence = self.ledger.next_sequence(&run_id_text)?;
        self.append_ledger(
            &run_id_text,
            &session_id_text,
            "action_batch.accepted",
            accepted_sequence,
            serde_json::json!({
                "summary": "Action batch accepted for Kernel execution.",
                "batch": &batch_summary
            }),
        )?;

        let mut events = vec![KernelEvent::ActionBatchAccepted {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id_text.clone()),
            session_id: Some(SessionId(session_id_text.clone())),
            batch: batch_summary,
            sequence: Some(accepted_sequence),
        }];

        let action_bundle = action_bundle_value(&batch);
        let actions = action_bundle
            .and_then(|bundle| bundle.get("actions"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let code_blocks = collect_code_blocks(&batch);
        let plan_id = batch
            .get("planId")
            .or_else(|| action_bundle_value(&batch).and_then(|bundle| bundle.get("id")))
            .and_then(Value::as_str)
            .unwrap_or("action-batch")
            .to_string();

        if actions.is_empty() {
            let work_unit_id = format!("work-unit-{}-empty", safe_work_unit_segment(&plan_id));
            events.push(self.work_unit_blocked_event(
                &request_id,
                &run_id_text,
                &session_id_text,
                &work_unit_id,
                "action batch has no actions",
            )?);
            return Ok(events);
        }

        for (index, action) in actions.iter().enumerate() {
            let action_id = action
                .get("actionId")
                .or_else(|| action.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("action-{index}"));
            let work_unit_id = format!(
                "work-unit-{}-{}",
                safe_work_unit_segment(&plan_id),
                safe_work_unit_segment(&action_id)
            );
            let capability = action
                .get("capability")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let kind = action
                .get("kind")
                .and_then(Value::as_str)
                .or_else(|| workspace_kind_from_capability(capability))
                .unwrap_or("write");
            let work_unit = serde_json::json!({
                "id": &work_unit_id,
                "planId": &plan_id,
                "actionId": &action_id,
                "title": action
                    .get("title")
                    .or_else(|| action.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or(&action_id),
                "capability": capability,
                "kind": kind,
                "resourceScope": action.get("resourceScope").cloned().unwrap_or_else(|| serde_json::json!([])),
                "status": "queued"
            });
            events.push(self.work_unit_queued_event(
                &request_id,
                &run_id_text,
                &session_id_text,
                work_unit,
            )?);
            events.push(self.work_unit_started_event(
                &request_id,
                &run_id_text,
                &session_id_text,
                &work_unit_id,
            )?);

            if is_external_capability(capability) {
                events.push(self.work_unit_blocked_event(
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    &work_unit_id,
                    &format!("capability requires Phase 9 permission policy before execution: {capability}"),
                )?);
                continue;
            }

            let compiled = match compile_workspace_action(
                self,
                &record,
                action,
                &code_blocks,
                capability,
                kind,
            ) {
                Ok(compiled) => compiled,
                Err(error) => {
                    events.push(self.work_unit_failed_event(
                        &request_id,
                        &run_id_text,
                        &session_id_text,
                        &work_unit_id,
                        &error,
                    )?);
                    continue;
                }
            };

            if let Some(root) = compiled.workspace_root.as_ref() {
                let mut workspace_events = self.workspace_open(
                    RequestId(format!(
                        "action-batch-workspace-{}",
                        safe_work_unit_segment(&work_unit_id)
                    )),
                    root.to_string_lossy().to_string(),
                )?;
                events.append(&mut workspace_events);
            }

            let tool_event = self.execute_bound_tool(
                &run_id_text,
                &session_id_text,
                format!(
                    "{work_unit_id}-{}",
                    safe_work_unit_segment(&compiled.tool_name)
                ),
                compiled.tool_name,
                compiled.arguments,
            )?;
            let tool_ok = matches!(&tool_event, KernelEvent::ToolCompleted { ok: true, .. });
            let tool_error = match &tool_event {
                KernelEvent::ToolCompleted {
                    error: Some(error), ..
                } => Some(error.clone()),
                _ => None,
            };
            let tool_output = match &tool_event {
                KernelEvent::ToolCompleted { output, .. } => output.clone(),
                _ => None,
            };
            events.push(tool_event);
            if tool_ok {
                events.push(self.work_unit_completed_event(
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    &work_unit_id,
                    tool_output,
                )?);
            } else {
                let error = tool_error.unwrap_or_else(|| KernelErrorEnvelope {
                    code: "workspace_write_failed".to_string(),
                    message: "workspace.write did not produce a successful tool result".to_string(),
                    message_key: None,
                    args: None,
                });
                events.push(self.work_unit_failed_envelope_event(
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    &work_unit_id,
                    error,
                )?);
            }
        }

        events.push(self.enter_phase_event(
            &run_id_text,
            &session_id_text,
            WorkflowPhase::Review,
        )?);
        Ok(events)
    }

    fn work_unit_queued_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit: Value,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.queued",
            sequence,
            serde_json::json!({
                "summary": "Work unit queued.",
                "workUnit": &work_unit
            }),
        )?;
        Ok(KernelEvent::WorkUnitQueued {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit,
            sequence: Some(sequence),
        })
    }

    fn work_unit_started_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.started",
            sequence,
            serde_json::json!({
                "summary": "Work unit started.",
                "workUnitId": work_unit_id
            }),
        )?;
        Ok(KernelEvent::WorkUnitStarted {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            sequence: Some(sequence),
        })
    }

    fn work_unit_completed_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        output: Option<Value>,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.completed",
            sequence,
            serde_json::json!({
                "summary": "Work unit completed.",
                "workUnitId": work_unit_id,
                "output": output
            }),
        )?;
        Ok(KernelEvent::WorkUnitCompleted {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            output,
            sequence: Some(sequence),
        })
    }

    fn work_unit_failed_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        error: &KernelError,
    ) -> KernelResult<KernelEvent> {
        self.work_unit_failed_envelope_event(
            request_id,
            run_id,
            session_id,
            work_unit_id,
            KernelErrorEnvelope::from(error),
        )
    }

    fn work_unit_failed_envelope_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        error: KernelErrorEnvelope,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.failed",
            sequence,
            serde_json::json!({
                "summary": "Work unit failed.",
                "workUnitId": work_unit_id,
                "error": &error
            }),
        )?;
        Ok(KernelEvent::WorkUnitFailed {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            error,
            sequence: Some(sequence),
        })
    }

    fn work_unit_blocked_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        reason: &str,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.blocked",
            sequence,
            serde_json::json!({
                "summary": "Work unit blocked.",
                "workUnitId": work_unit_id,
                "reason": reason
            }),
        )?;
        Ok(KernelEvent::WorkUnitBlocked {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            reason: reason.to_string(),
            sequence: Some(sequence),
        })
    }
}

struct CompiledWorkspaceAction {
    tool_name: String,
    arguments: Value,
    workspace_root: Option<PathBuf>,
}

fn is_external_capability(capability: &str) -> bool {
    matches!(
        capability,
        "process.exec"
            | "network.egress"
            | "git.write"
            | "git.read"
            | "browser.control"
            | "provider.egress"
    )
}

fn workspace_kind_from_capability(capability: &str) -> Option<&'static str> {
    match capability {
        "workspace.read" => Some("read"),
        "workspace.list" => Some("list"),
        "workspace.search" => Some("search"),
        "workspace.diff" | "workspace.preview_diff" => Some("diff"),
        "workspace.write" => Some("write"),
        "workspace.create" => Some("create"),
        "workspace.delete" => Some("delete"),
        "workspace.rename" => Some("rename"),
        _ => None,
    }
}

fn action_bundle_value(batch: &Value) -> Option<&Value> {
    batch.get("actionBundle").or_else(|| {
        if batch.get("actions").is_some() {
            Some(batch)
        } else {
            None
        }
    })
}

fn collect_code_blocks(batch: &Value) -> std::collections::BTreeMap<String, Value> {
    batch
        .get("codeBlocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            block
                .get("id")
                .or_else(|| block.get("blockId"))
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(|id| (id.to_string(), block.clone()))
        })
        .collect()
}

fn compile_workspace_action(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
    code_blocks: &std::collections::BTreeMap<String, Value>,
    capability: &str,
    kind: &str,
) -> KernelResult<CompiledWorkspaceAction> {
    if !capability.starts_with("workspace.") {
        return Err(KernelError::InvalidCommand(format!(
            "unsupported action capability: {capability}"
        )));
    }
    match kind {
        "write" | "create" => workspace_write_from_action(runtime, record, action, code_blocks),
        "read" => workspace_path_tool_action(runtime, record, action, "fs.read"),
        "list" => workspace_path_tool_action(runtime, record, action, "fs.list"),
        "diff" => workspace_path_tool_action(runtime, record, action, "fs.diff"),
        "delete" => workspace_path_tool_action(runtime, record, action, "fs.delete"),
        "search" => workspace_search_tool_action(action),
        "rename" => Err(KernelError::NotImplemented("workspace.rename.work_unit")),
        other => Err(KernelError::InvalidCommand(format!(
            "unsupported workspace action kind: {other}"
        ))),
    }
}

fn workspace_write_from_action(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
    code_blocks: &std::collections::BTreeMap<String, Value>,
) -> KernelResult<CompiledWorkspaceAction> {
    let source_block_id = action
        .get("sourceBlockId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand("workspace.write action requires sourceBlockId".to_string())
        })?;
    let block = code_blocks.get(source_block_id).ok_or_else(|| {
        KernelError::InvalidCommand(format!("codeBlock {source_block_id} was not provided"))
    })?;
    let content = block
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!("codeBlock {source_block_id} has no content"))
        })?
        .to_string();
    let raw_path = block
        .get("path")
        .or_else(|| block.get("targetPath"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            action
                .get("targetPath")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!("codeBlock {source_block_id} has no write path"))
        })?;
    let (relative_path, workspace_root) = workspace_relative_write_path(runtime, record, raw_path)?;
    Ok(CompiledWorkspaceAction {
        tool_name: "fs.write".to_string(),
        arguments: serde_json::json!({
            "path": relative_path,
            "content": content,
            "create": true
        }),
        workspace_root,
    })
}

fn workspace_path_tool_action(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
    tool_name: &str,
) -> KernelResult<CompiledWorkspaceAction> {
    let raw_path = action
        .get("targetPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or(".");
    let (relative_path, workspace_root) = workspace_relative_write_path(runtime, record, raw_path)?;
    Ok(CompiledWorkspaceAction {
        tool_name: tool_name.to_string(),
        arguments: serde_json::json!({ "path": relative_path }),
        workspace_root,
    })
}

fn workspace_search_tool_action(action: &Value) -> KernelResult<CompiledWorkspaceAction> {
    let query = action
        .get("query")
        .or_else(|| action.get("targetPath"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| {
            KernelError::InvalidCommand("workspace.search action requires query".to_string())
        })?;
    Ok(CompiledWorkspaceAction {
        tool_name: "code.search".to_string(),
        arguments: serde_json::json!({ "query": query }),
        workspace_root: None,
    })
}

fn workspace_relative_write_path(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    raw_path: &str,
) -> KernelResult<(String, Option<PathBuf>)> {
    let raw_path = raw_path.trim();
    let path = Path::new(raw_path);
    if !path.is_absolute() {
        if let Some((root, relative_path)) =
            single_directory_attachment_write_target(record, raw_path)?
        {
            return Ok((relative_path, Some(root)));
        }
        if runtime.state.current_workspace.is_none() {
            if let Some(open_path) = record.workspace_binding.open_path.as_ref() {
                return Ok((
                    normalize_write_relative_path(raw_path)?,
                    Some(PathBuf::from(open_path)),
                ));
            }
        }
        return Ok((normalize_write_relative_path(raw_path)?, None));
    }

    let target = path.components().collect::<PathBuf>();
    if let Some(root) = runtime
        .state
        .current_workspace
        .as_ref()
        .map(|workspace| workspace.root.clone())
    {
        if let Some(relative) = strip_root(&target, &root) {
            return Ok((relative, None));
        }
    }
    if let Some(open_path) = record.workspace_binding.open_path.as_ref() {
        let root = PathBuf::from(open_path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(open_path));
        if let Some(relative) = strip_root(&target, &root) {
            return Ok((relative, Some(root)));
        }
    }
    if let Some((root, relative)) = attachment_root_for_target(record, &target)? {
        return Ok((relative, Some(root)));
    }
    Err(KernelError::PermissionDenied(format!(
        "workspace.write target is outside workspace binding and explicit attachments: {raw_path}"
    )))
}

fn strip_root(target: &Path, root: &Path) -> Option<String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if !target.starts_with(&root) {
        return None;
    }
    let relative = target.strip_prefix(root).ok()?;
    let value = relative.to_string_lossy().replace('\\', "/");
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn attachment_root_for_target(
    record: &RuntimeRunRecord,
    target: &Path,
) -> KernelResult<Option<(PathBuf, String)>> {
    for attachment in &record.attachments {
        let Some(root) = explicit_attachment_root(attachment) else {
            continue;
        };
        let kind = attachment
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("file");
        let allowed = if kind == "directory" {
            target.starts_with(&root)
        } else {
            target == root
        };
        if allowed {
            let write_root = if kind == "directory" {
                root
            } else {
                root.parent().map(Path::to_path_buf).ok_or_else(|| {
                    KernelError::InvalidCommand("file attachment has no parent".to_string())
                })?
            };
            if let Some(relative) = strip_root(target, &write_root) {
                return Ok(Some((write_root, relative)));
            }
        }
    }
    Ok(None)
}

fn single_directory_attachment_write_target(
    record: &RuntimeRunRecord,
    raw_path: &str,
) -> KernelResult<Option<(PathBuf, String)>> {
    let mut roots = Vec::new();
    for attachment in record
        .attachments
        .iter()
        .filter(|attachment| attachment.get("kind").and_then(Value::as_str) == Some("directory"))
    {
        let Some(root) = explicit_attachment_root(attachment) else {
            continue;
        };
        let display_path = attachment
            .get("path")
            .and_then(Value::as_str)
            .map(normalize_write_relative_path)
            .transpose()?;
        roots.push((root, display_path));
    }
    if roots.len() == 1 {
        let (root, display_path) = roots.into_iter().next().expect("single root");
        return Ok(Some((
            root,
            normalize_attachment_relative_write_path(raw_path, display_path.as_deref())?,
        )));
    }
    if roots.is_empty() {
        Ok(None)
    } else {
        Err(KernelError::InvalidCommand(
            "workspace.write has a relative path but multiple attachment roots are available"
                .to_string(),
        ))
    }
}

fn normalize_attachment_relative_write_path(
    raw_path: &str,
    display_path: Option<&str>,
) -> KernelResult<String> {
    let normalized = normalize_write_relative_path(raw_path)?;
    if let Some(display_path) = display_path.filter(|value| !value.trim().is_empty()) {
        if normalized == display_path {
            return Err(KernelError::InvalidCommand(
                "workspace.write target resolves to an attachment directory, not a file"
                    .to_string(),
            ));
        }
        if let Some(relative) = normalized.strip_prefix(&format!("{display_path}/")) {
            return normalize_write_relative_path(relative);
        }
    }
    Ok(normalized)
}

fn normalize_write_relative_path(raw_path: &str) -> KernelResult<String> {
    let normalized = raw_path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err(KernelError::InvalidCommand(
            "workspace.write target path is empty".to_string(),
        ));
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err(KernelError::InvalidCommand(format!(
            "workspace.write target must be relative: {raw_path}"
        )));
    }

    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => {
                let value = value.to_string_lossy();
                if !value.is_empty() {
                    parts.push(value.to_string());
                }
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                return Err(KernelError::PermissionDenied(format!(
                    "workspace.write target cannot contain parent traversal: {raw_path}"
                )));
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(KernelError::InvalidCommand(format!(
                    "workspace.write target must be relative: {raw_path}"
                )));
            }
        }
    }
    if parts.is_empty() {
        return Err(KernelError::InvalidCommand(
            "workspace.write target path is empty".to_string(),
        ));
    }
    Ok(parts.join("/"))
}

fn explicit_attachment_root(attachment: &Value) -> Option<PathBuf> {
    let source = attachment
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(source, "userSelected" | "contextMenu" | "mention") {
        return None;
    }
    attachment
        .get("absolutePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|path| PathBuf::from(path).canonicalize().ok())
}

fn summarize_action_batch(batch: &Value) -> Value {
    let action_bundle = action_bundle_value(batch);
    let actions = action_bundle
        .and_then(|bundle| bundle.get("actions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let code_blocks = batch
        .get("codeBlocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    serde_json::json!({
        "planId": batch.get("planId").and_then(Value::as_str),
        "actionBundleId": action_bundle.and_then(|bundle| bundle.get("id")).and_then(Value::as_str),
        "goal": action_bundle.and_then(|bundle| bundle.get("goal")).and_then(Value::as_str),
        "actionCount": actions.len(),
        "actions": actions.iter().map(summarize_action).collect::<Vec<_>>(),
        "codeBlocks": code_blocks.iter().map(summarize_code_block).collect::<Vec<_>>()
    })
}

fn summarize_action(action: &Value) -> Value {
    serde_json::json!({
        "id": action.get("id").and_then(Value::as_str),
        "title": action.get("title").and_then(Value::as_str),
        "capability": action.get("capability").and_then(Value::as_str),
        "kind": action.get("kind").and_then(Value::as_str),
        "resourceScope": action.get("resourceScope").cloned().unwrap_or_else(|| serde_json::json!([])),
        "sourceBlockId": action.get("sourceBlockId").and_then(Value::as_str)
    })
}

fn summarize_code_block(block: &Value) -> Value {
    let content = block
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    serde_json::json!({
        "id": block.get("id").and_then(Value::as_str),
        "path": block.get("path").and_then(Value::as_str),
        "language": block.get("language").and_then(Value::as_str),
        "contentBytes": content.len(),
        "contentHash": deepcode_kernel_skills::hash::hash_bytes(content.as_bytes())
    })
}

fn safe_work_unit_segment(value: &str) -> String {
    let mut out = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(80).collect::<String>()
}
