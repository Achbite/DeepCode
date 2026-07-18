use super::*;

pub(super) fn review_facts_for_run(
    runtime: &DeepCodeKernelRuntime,
    ledger: &dyn EventLedger,
    run_id: &str,
    _record: &RuntimeRunRecord,
) -> KernelResult<ReviewFacts> {
    ledger_review_facts_for_run(runtime.tool_registry, ledger, run_id)
}

pub(super) fn ledger_review_facts_for_run(
    tool_registry: &KernelToolRegistry,
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
    let mut indeterminate_tool_outcomes = Vec::new();
    let mut path_normalization_diagnostics = Vec::new();
    let mut batch_review_ready = false;

    for event in &events {
        match event.kind.as_str() {
            "work_unit.queued"
            | "work_unit.started"
            | "work_unit.completed"
            | "work_unit.failed"
            | "work_unit.blocked" => {
                let fact = work_unit_fact(event)?;
                work_units.push(fact.clone());
                match fact.status {
                    WorkUnitStatus::Queued => queued_work_units.push(fact),
                    WorkUnitStatus::Started => started_work_units.push(fact),
                    WorkUnitStatus::Completed => completed_work_units.push(fact),
                    WorkUnitStatus::Failed => failed_work_units.push(fact),
                    WorkUnitStatus::Blocked => blocked_work_units.push(fact),
                }
            }
            "permission.requested" => {
                let fact: PermissionRequestedFact = decode_fact(event, "permission request")?;
                awaiting_permissions.push(fact.request);
            }
            "permission.resolved" => {
                let fact: PermissionResolutionFact = decode_fact(event, "permission resolution")?;
                awaiting_permissions.retain(|request| request.id != fact.permission_id);
            }
            "batch.review_ready" => batch_review_ready = true,
            "resource.acquired_batch" | "resource.released" | "resource.cleanup_failed" => {
                let (lifecycle, cleanup_failure) = resource_lifecycle_fact(event)?;
                resource_events.push(lifecycle);
                if let Some(cleanup_failure) = cleanup_failure {
                    cleanup_failures.push(cleanup_failure);
                }
            }
            "tool.completed" => {
                let fact = tool_fact(event, tool_registry)?;
                let registration = tool_registry
                    .get(&fact.tool_id)
                    .expect("tool_fact validates the ToolRegistration");
                let fact_contract = &registration.contract.fact;
                let output = fact.output.as_ref();

                if let Some(output) = output {
                    if artifact_origin(output)? == Some(ArtifactOrigin::AgentGenerated) {
                        generated_artifacts.push(generated_artifact_fact(&fact, output));
                    }
                    if let Some(normalization) = path_normalization(output)? {
                        path_normalization_diagnostics.push(PathNormalizationDiagnostic {
                            tool_call_id: fact.tool_call_id.clone(),
                            tool_id: fact.tool_id.clone(),
                            path: optional_string(output, "path"),
                            absolute_path: optional_string(output, "absolutePath"),
                            normalization,
                        });
                    }
                }

                if fact.ok {
                    if let Some(change_kind) = fact_contract.change_operation {
                        let change = file_change_fact(&fact, change_kind, output)?;
                        match change_kind {
                            ToolChangeKind::Create => {
                                written_files.push(change.clone());
                                created_files.push(change);
                            }
                            ToolChangeKind::Write => written_files.push(change),
                            ToolChangeKind::Edit => {
                                written_files.push(change.clone());
                                patch_changed_ranges.push(change);
                            }
                            ToolChangeKind::Delete => deleted_files.push(change),
                            ToolChangeKind::Rename => renamed_files.push(change),
                        }
                    }
                }
                if fact_contract.category == ToolFactCategory::Git {
                    git_facts.push(fact.clone());
                }
                tool_results.push(fact);
            }
            "tool.outcome_indeterminate" => {
                indeterminate_tool_outcomes.push(decode_fact(event, "indeterminate tool outcome")?);
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
        indeterminate_tool_outcomes,
        path_normalization_diagnostics,
        batch_review_ready,
    })
}

pub(super) fn work_unit_fact(event: &LedgerEvent) -> KernelResult<WorkUnitFact> {
    let status = match event.kind.as_str() {
        "work_unit.queued" => WorkUnitStatus::Queued,
        "work_unit.started" => WorkUnitStatus::Started,
        "work_unit.completed" => WorkUnitStatus::Completed,
        "work_unit.failed" => WorkUnitStatus::Failed,
        "work_unit.blocked" => WorkUnitStatus::Blocked,
        kind => {
            return Err(KernelError::InvalidCommand(format!(
                "unsupported WorkUnit fact kind {kind}"
            )))
        }
    };
    let descriptor = event
        .payload
        .get("workUnit")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| invalid_fact(event, "work unit descriptor", error))?;
    let work_unit_id = event
        .payload
        .get("workUnitId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            descriptor
                .as_ref()
                .map(|descriptor: &WorkUnitDescriptor| descriptor.id.clone())
        })
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!("{} fact is missing workUnitId", event.kind))
        })?;
    let error = event
        .payload
        .get("error")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| invalid_fact(event, "work unit error", error))?;
    Ok(WorkUnitFact {
        status,
        sequence: event.sequence,
        work_unit_id,
        descriptor,
        summary: optional_string(&event.payload, "summary"),
        output: event.payload.get("output").cloned(),
        error,
        reason: optional_string(&event.payload, "reason"),
    })
}

pub(super) fn tool_fact(
    event: &LedgerEvent,
    registry: &KernelToolRegistry,
) -> KernelResult<ToolFactEnvelope> {
    let completion: ToolCompletionFact = decode_fact(event, "tool completion")?;
    let registration = registry.get(&completion.tool_id).ok_or_else(|| {
        KernelError::InvalidCommand(format!(
            "tool.completed fact references unregistered tool {}",
            completion.tool_id
        ))
    })?;
    if registration.operation_kind() != completion.operation_kind {
        return Err(KernelError::InvalidCommand(format!(
            "tool.completed operationKind mismatch for {}",
            completion.tool_id
        )));
    }
    let fact_contract = &registration.contract.fact;
    Ok(ToolFactEnvelope {
        sequence: event.sequence,
        tool_call_id: completion.tool_call_id,
        tool_id: completion.tool_id,
        operation_kind: completion.operation_kind,
        fact_kind: fact_contract.evidence_kind,
        untrusted_evidence: fact_contract.untrusted_evidence,
        ok: completion.ok,
        output: completion.output,
        error: completion.error,
        source: KernelFactSource::OperationalTool,
    })
}

fn file_change_fact(
    fact: &ToolFactEnvelope,
    change_kind: ToolChangeKind,
    output: Option<&Value>,
) -> KernelResult<FileChangeFact> {
    let output = output.unwrap_or(&Value::Null);
    Ok(FileChangeFact {
        tool_call_id: fact.tool_call_id.clone(),
        tool_id: fact.tool_id.clone(),
        operation_kind: fact.operation_kind,
        change_kind: match change_kind {
            ToolChangeKind::Create => FileChangeKind::Create,
            ToolChangeKind::Write => FileChangeKind::Write,
            ToolChangeKind::Edit => FileChangeKind::Edit,
            ToolChangeKind::Delete => FileChangeKind::Delete,
            ToolChangeKind::Rename => FileChangeKind::Rename,
        },
        path: optional_string(output, "path"),
        absolute_path: optional_string(output, "absolutePath"),
        from: optional_string(output, "from"),
        to: optional_string(output, "to"),
        content_hash: optional_string(output, "contentHash"),
        old_content_hash: optional_string(output, "oldContentHash"),
        new_content_hash: optional_string(output, "newContentHash"),
        changed_ranges: changed_ranges(output)?,
        artifact_origin: artifact_origin(output)?,
        path_normalization: path_normalization(output)?,
    })
}

fn changed_ranges(output: &Value) -> KernelResult<Vec<deepcode_kernel_abi::FileChangedRange>> {
    let Some(value) = output.get("changedRanges") else {
        return Ok(Vec::new());
    };
    serde_json::from_value(value.clone()).map_err(|error| {
        KernelError::InvalidCommand(format!("decode typed file changed ranges: {error}"))
    })
}

fn generated_artifact_fact(fact: &ToolFactEnvelope, output: &Value) -> GeneratedArtifactFact {
    GeneratedArtifactFact {
        tool_call_id: fact.tool_call_id.clone(),
        tool_id: fact.tool_id.clone(),
        operation_kind: fact.operation_kind,
        path: optional_string(output, "path"),
        absolute_path: optional_string(output, "absolutePath"),
        plan_id: optional_string(output, "planId"),
        work_unit_id: optional_string(output, "workUnitId"),
        content_hash: optional_string(output, "contentHash"),
        origin: ArtifactOrigin::AgentGenerated,
    }
}

fn path_normalization(output: &Value) -> KernelResult<Option<PathNormalizationFact>> {
    output
        .get("pathNormalization")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| {
            KernelError::InvalidCommand(format!(
                "decode path normalization fact from tool output: {error}"
            ))
        })
}

fn artifact_origin(output: &Value) -> KernelResult<Option<ArtifactOrigin>> {
    match output.get("artifactOrigin").and_then(Value::as_str) {
        None => Ok(None),
        Some("agentGenerated") => Ok(Some(ArtifactOrigin::AgentGenerated)),
        Some("userProvided") => Ok(Some(ArtifactOrigin::UserProvided)),
        Some("externalEvidence") => Ok(Some(ArtifactOrigin::ExternalEvidence)),
        Some(value) => Err(KernelError::InvalidCommand(format!(
            "tool output contains unknown artifactOrigin {value}"
        ))),
    }
}

fn resource_lifecycle_fact(
    event: &LedgerEvent,
) -> KernelResult<(ResourceLifecycleFact, Option<CleanupFailureFact>)> {
    match event.kind.as_str() {
        "resource.acquired_batch" => {
            let resources: Vec<KernelResource> = event
                .payload
                .get("resources")
                .cloned()
                .ok_or_else(|| {
                    KernelError::InvalidCommand(
                        "resource acquisition fact is missing resources".to_string(),
                    )
                })
                .and_then(|value| {
                    serde_json::from_value(value)
                        .map_err(|error| invalid_fact(event, "resource acquisition", error))
                })?;
            Ok((
                ResourceLifecycleFact {
                    kind: ResourceLifecycleKind::AcquiredBatch,
                    sequence: event.sequence,
                    resources,
                    reason: optional_string(&event.payload, "summary"),
                    released: None,
                    error: None,
                },
                None,
            ))
        }
        "resource.released" => {
            let resource: KernelResource = serde_json::from_value(
                event.payload.get("resource").cloned().ok_or_else(|| {
                    KernelError::InvalidCommand(
                        "resource release fact is missing resource".to_string(),
                    )
                })?,
            )
            .map_err(|error| invalid_fact(event, "resource release", error))?;
            Ok((
                ResourceLifecycleFact {
                    kind: ResourceLifecycleKind::Released,
                    sequence: event.sequence,
                    resources: vec![resource],
                    reason: optional_string(&event.payload, "reason"),
                    released: event.payload.get("released").and_then(Value::as_bool),
                    error: optional_string(&event.payload, "error"),
                },
                None,
            ))
        }
        "resource.cleanup_failed" => {
            let resource_id = required_string(&event.payload, "resourceId")?;
            let resource_kind = event
                .payload
                .get("kind")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| invalid_fact(event, "cleanup resource kind", error))?;
            let error = required_string(&event.payload, "error")?;
            let reason = optional_string(&event.payload, "reason");
            let failure = CleanupFailureFact {
                sequence: event.sequence,
                resource_id,
                resource_kind,
                reason: reason.clone(),
                error: error.clone(),
            };
            Ok((
                ResourceLifecycleFact {
                    kind: ResourceLifecycleKind::CleanupFailed,
                    sequence: event.sequence,
                    resources: Vec::new(),
                    reason,
                    released: Some(false),
                    error: Some(error),
                },
                Some(failure),
            ))
        }
        kind => Err(KernelError::InvalidCommand(format!(
            "unsupported resource lifecycle fact kind {kind}"
        ))),
    }
}

fn decode_fact<T: serde::de::DeserializeOwned>(
    event: &LedgerEvent,
    label: &str,
) -> KernelResult<T> {
    serde_json::from_value(event.payload.clone()).map_err(|error| invalid_fact(event, label, error))
}

fn invalid_fact(event: &LedgerEvent, label: &str, error: serde_json::Error) -> KernelError {
    KernelError::InvalidCommand(format!(
        "decode {label} at {} sequence {:?}: {error}",
        event.kind, event.sequence
    ))
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn required_string(value: &Value, key: &str) -> KernelResult<String> {
    optional_string(value, key)
        .ok_or_else(|| KernelError::InvalidCommand(format!("fact is missing required field {key}")))
}
