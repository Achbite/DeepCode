use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn tool_obligation_ledger_events(
        &self,
        run_id: &str,
        session_id: &str,
        tool_call_id: &str,
        tool_id: &str,
        arguments: &Value,
        output: &Value,
        first_sequence: u64,
    ) -> KernelResult<Vec<LedgerEvent>> {
        let template = self.tool_registry.contract(tool_id).ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "tool.completed references unregistered tool {tool_id}"
            ))
        })?;
        let mut events = Vec::new();
        let mut next_sequence = first_sequence;
        if let Some(kind) = template.fact.change_operation {
            let path = get_string(arguments, "path").ok_or_else(|| {
                KernelError::InvalidCommand(format!(
                    "{tool_id} change fact requires normalized path"
                ))
            })?;
            let operation = ChangeOperation {
                id: format!("change-{run_id}-{tool_call_id}"),
                work_unit_id: arguments
                    .get("kernelContext")
                    .and_then(|value| value.get("workUnitId"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                kind: kind.wire_name().to_string(),
                file_path: path,
                diff: None,
            };
            events.push(LedgerEvent {
                id: format!("evt-{run_id}-{next_sequence}"),
                run_id: Some(run_id.to_string()),
                session_id: Some(session_id.to_string()),
                kind: "change.operation_recorded".to_string(),
                sequence: Some(next_sequence),
                payload: serde_json::json!({
                    "summary": format!("Change operation recorded for {tool_id}."),
                    "operation": &operation
                }),
                created_at: None,
            });
            next_sequence += 1;
            let mut operations = self
                .ledger
                .list_by_run(run_id)?
                .into_iter()
                .filter(|event| event.kind == "change.operation_recorded")
                .map(|event| {
                    event
                        .payload
                        .get("operation")
                        .cloned()
                        .ok_or_else(|| {
                            KernelError::InvalidCommand(format!(
                                "change operation fact at sequence {:?} is missing operation",
                                event.sequence
                            ))
                        })
                        .and_then(|value| {
                            serde_json::from_value(value).map_err(|error| {
                                KernelError::InvalidCommand(format!(
                                    "decode change operation fact at sequence {:?}: {error}",
                                    event.sequence
                                ))
                            })
                        })
                })
                .collect::<KernelResult<Vec<ChangeOperation>>>()?;
            operations.push(operation);
            let change_set =
                ChangeSet::from_operations(format!("changeset-{run_id}"), run_id, operations);
            events.push(LedgerEvent {
                id: format!("evt-{run_id}-{next_sequence}"),
                run_id: Some(run_id.to_string()),
                session_id: Some(session_id.to_string()),
                kind: "change_set.recorded".to_string(),
                sequence: Some(next_sequence),
                payload: serde_json::json!({
                    "summary": change_set.diff_summary,
                    "changeSet": change_set
                }),
                created_at: None,
            });
            next_sequence += 1;
        }

        if let (Some(contract_validation_kind), Some(validation_payload)) =
            (template.fact.validation_kind, output.get("validation"))
        {
            let passed = validation_payload
                .get("passed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let validation = ValidationResult {
                id: format!("validation-{run_id}-{tool_call_id}"),
                run_id: run_id.to_string(),
                kind: ValidationKind::ManualReview,
                passed,
                summary: if passed {
                    format!("Tool effect verified for {tool_id}.")
                } else {
                    format!("Tool effect verification failed for {tool_id}.")
                },
                evidence_refs: vec![format!("tool.completed:{tool_call_id}")],
            };
            events.push(LedgerEvent {
                id: format!("evt-{run_id}-{next_sequence}"),
                run_id: Some(run_id.to_string()),
                session_id: Some(session_id.to_string()),
                kind: "validation.result".to_string(),
                sequence: Some(next_sequence),
                payload: serde_json::json!({
                    "summary": &validation.summary,
                    "validation": &validation,
                    "contractValidationKind": contract_validation_kind,
                    "toolValidation": validation_payload
                }),
                created_at: None,
            });
        }
        Ok(events)
    }
}
