use super::*;

pub(super) fn review_facts_for_run(
    _runtime: &DeepCodeKernelRuntime,
    ledger: &dyn EventLedger,
    run_id: &str,
    _record: &RuntimeRunRecord,
) -> KernelResult<ReviewFacts> {
    ledger_review_facts_for_run(ledger, run_id)
}

pub(super) fn ledger_review_facts_for_run(
    ledger: &dyn EventLedger,
    run_id: &str,
) -> KernelResult<ReviewFacts> {
    let events = ledger.list_by_run(run_id)?;
    let mut work_units = Vec::new();
    let mut queued_work_units = Vec::new();
    let mut started_work_units = Vec::new();
    let mut completed_work_units = Vec::new();
    let mut failed_work_units = Vec::new();
    let mut blocked_work_units = Vec::new();
    let mut awaiting_permissions = Vec::new();
    let mut tool_results = Vec::new();
    let mut git_facts = Vec::new();
    let mut written_files = Vec::new();
    let mut created_files = Vec::new();
    let mut deleted_files = Vec::new();
    let mut renamed_files = Vec::new();
    let mut patch_changed_ranges = Vec::new();
    let mut generated_artifacts = Vec::new();
    let mut resource_events = Vec::new();
    let mut cleanup_failures = Vec::new();
    let mut path_normalization_diagnostics = Vec::new();
    let mut batch_review_ready = false;
    let tool_registry = KernelToolRegistry::default();

    for event in &events {
        match event.kind.as_str() {
            "work_unit.queued"
            | "work_unit.started"
            | "work_unit.completed"
            | "work_unit.failed"
            | "work_unit.blocked" => {
                let fact = work_unit_fact(event);
                work_units.push(fact.clone());
                match event.kind.as_str() {
                    "work_unit.queued" => queued_work_units.push(fact),
                    "work_unit.started" => started_work_units.push(fact),
                    "work_unit.completed" => completed_work_units.push(fact),
                    "work_unit.failed" => failed_work_units.push(fact),
                    "work_unit.blocked" => blocked_work_units.push(fact),
                    _ => {}
                }
            }
            "permission.requested" => awaiting_permissions.push(event.payload.clone()),
            "permission.resolved" => {
                let permission_id = event.payload.get("permissionId").and_then(Value::as_str);
                if let Some(permission_id) = permission_id {
                    awaiting_permissions.retain(|request| {
                        request.get("permissionId").and_then(Value::as_str) != Some(permission_id)
                    });
                }
            }
            "batch.review_ready" => batch_review_ready = true,
            "resource.acquired_batch" | "resource.released" | "resource.cleanup_failed" => {
                if event.kind == "resource.cleanup_failed" {
                    cleanup_failures.push(event.payload.clone());
                }
                resource_events.push(serde_json::json!({
                    "kind": event.kind,
                    "sequence": event.sequence,
                    "payload": event.payload
                }));
            }
            "tool.completed" => {
                let fact = tool_fact(event, &tool_registry)?;
                let fact_contract = tool_registry
                    .template(&fact.tool_id)
                    .expect("tool_fact validated the ToolRegistration")
                    .fact;
                let tool_name = fact.tool_id.as_str();
                let output = fact.output.as_ref();
                if let Some(output) = output {
                    if output.get("artifactOrigin").and_then(Value::as_str)
                        == Some("agentGenerated")
                    {
                        generated_artifacts.push(serde_json::json!({
                            "toolName": tool_name,
                            "toolCallId": fact.tool_call_id.clone(),
                            "path": output.get("path").cloned().unwrap_or(Value::Null),
                            "absolutePath": output.get("absolutePath").cloned().unwrap_or(Value::Null),
                            "operation": output.get("operation").cloned().unwrap_or(Value::Null),
                            "planId": output.get("planId").cloned().unwrap_or(Value::Null),
                            "workUnitId": output.get("workUnitId").cloned().unwrap_or(Value::Null),
                            "contentHash": output.get("contentHash").cloned().unwrap_or(Value::Null),
                            "artifactOrigin": "agentGenerated"
                        }));
                    }
                    if let Some(path_normalization) = output.get("pathNormalization") {
                        path_normalization_diagnostics.push(serde_json::json!({
                            "toolName": tool_name,
                            "toolCallId": fact.tool_call_id.clone(),
                            "path": output.get("path").cloned().unwrap_or(Value::Null),
                            "absolutePath": output.get("absolutePath").cloned().unwrap_or(Value::Null),
                            "pathNormalization": path_normalization,
                            "duplicateRootPathDetected": output.get("duplicateRootPathDetected").cloned().unwrap_or(Value::Bool(false))
                        }));
                    }
                }
                if fact.ok
                    && matches!(
                        fact_contract.change_operation,
                        Some("create" | "write" | "patch")
                    )
                {
                    if let Some(path) = output
                        .and_then(|value| value.get("path"))
                        .and_then(Value::as_str)
                    {
                        let file = serde_json::json!({
                            "path": path,
                            "absolutePath": output.and_then(|value| value.get("absolutePath")).cloned().unwrap_or(Value::Null),
                            "contentHash": output.and_then(|value| value.get("contentHash")).cloned().unwrap_or(Value::Null),
                            "artifactOrigin": output.and_then(|value| value.get("artifactOrigin")).cloned().unwrap_or(Value::Null),
                            "pathNormalization": output.and_then(|value| value.get("pathNormalization")).cloned().unwrap_or(Value::Null),
                            "toolCallId": fact.tool_call_id.clone()
                        });
                        written_files.push(file.clone());
                        if fact_contract.change_operation == Some("create") {
                            created_files.push(file);
                        }
                    }
                }
                if fact.ok && fact_contract.change_operation == Some("patch") {
                    if let Some(output) = output {
                        patch_changed_ranges.push(serde_json::json!({
                            "path": output.get("path").cloned().unwrap_or(Value::Null),
                            "toolCallId": fact.tool_call_id.clone(),
                            "changedRanges": output.get("changedRanges").cloned().unwrap_or(Value::Null),
                            "oldContentHash": output.get("oldContentHash").cloned().unwrap_or(Value::Null),
                            "newContentHash": output.get("newContentHash").cloned().unwrap_or(Value::Null)
                        }));
                    }
                }
                if fact.ok && fact_contract.change_operation == Some("delete") {
                    deleted_files.push(serde_json::json!({
                        "path": output.and_then(|value| value.get("path")).cloned().unwrap_or(Value::Null),
                        "toolCallId": fact.tool_call_id.clone()
                    }));
                }
                if fact.ok && fact_contract.change_operation == Some("rename") {
                    renamed_files.push(serde_json::json!({
                        "from": output.and_then(|value| value.get("from")).cloned().unwrap_or(Value::Null),
                        "to": output.and_then(|value| value.get("to")).cloned().unwrap_or(Value::Null),
                        "toolCallId": fact.tool_call_id.clone()
                    }));
                }
                if fact_contract.category == ToolFactCategory::Git {
                    git_facts.push(fact.clone());
                }
                tool_results.push(fact);
            }
            _ => {}
        }
    }

    Ok(ReviewFacts {
        facts_ref: format!("review-facts-{run_id}"),
        run_id: run_id.to_string(),
        event_count: events.len(),
        work_units,
        queued_work_units,
        started_work_units,
        completed_work_units,
        failed_work_units,
        blocked_work_units,
        awaiting_permissions,
        tool_results,
        git_facts,
        written_files,
        created_files,
        deleted_files,
        renamed_files,
        patch_changed_ranges,
        generated_artifacts,
        resource_events,
        cleanup_failures,
        path_normalization_diagnostics,
        batch_review_ready,
    })
}

pub(super) fn work_unit_fact(event: &LedgerEvent) -> WorkUnitFact {
    WorkUnitFact {
        kind: event.kind.clone(),
        sequence: event.sequence,
        work_unit_id: event
            .payload
            .get("workUnitId")
            .and_then(Value::as_str)
            .or_else(|| {
                event
                    .payload
                    .get("workUnit")
                    .and_then(|work_unit| work_unit.get("id"))
                    .and_then(Value::as_str)
            })
            .map(str::to_string),
        work_unit: event.payload.get("workUnit").cloned(),
        summary: event
            .payload
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string),
        error: event.payload.get("error").cloned(),
        reason: event.payload.get("reason").cloned(),
    }
}

pub(super) fn tool_fact(
    event: &LedgerEvent,
    registry: &KernelToolRegistry,
) -> KernelResult<ToolFactEnvelope> {
    let tool_id = event
        .payload
        .get("toolName")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KernelError::InvalidCommand("tool.completed fact is missing toolName".to_string())
        })?
        .to_string();
    let fact_contract = registry
        .template(&tool_id)
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "tool.completed fact references unregistered tool {tool_id}"
            ))
        })?
        .fact;
    Ok(ToolFactEnvelope {
        kind: event.kind.clone(),
        sequence: event.sequence,
        tool_call_id: event
            .payload
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string),
        tool_id,
        fact_kind: fact_contract.evidence_kind.to_string(),
        untrusted_evidence: fact_contract.untrusted_evidence,
        ok: event
            .payload
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        output: event.payload.get("output").cloned(),
        error: event.payload.get("error").cloned(),
        source: "operationalTool".to_string(),
    })
}
