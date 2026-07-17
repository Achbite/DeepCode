use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn record_change_operation_for_tool(
        &self,
        run_id: &str,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<()> {
        let template = self.tool_registry.contract(tool_name).ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "tool.completed references unregistered tool {tool_name}"
            ))
        })?;
        let Some(kind) = template.fact.change_operation else {
            return Ok(());
        };
        let path = get_string(arguments, "path").ok_or_else(|| {
            KernelError::InvalidCommand(format!("{tool_name} change fact requires normalized path"))
        })?;
        let operation = ChangeOperation {
            id: format!("change-{run_id}-{tool_call_id}"),
            work_unit_id: Some(tool_call_id.to_string()),
            kind: kind.wire_name().to_string(),
            file_path: path,
            diff: None,
        };
        let operation_sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "change.operation_recorded",
            operation_sequence,
            serde_json::json!({
                "summary": format!("Change operation recorded for {tool_name}."),
                "operation": &operation
            }),
        )?;

        let operations = self
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
        let change_set =
            ChangeSet::from_operations(format!("changeset-{run_id}"), run_id, operations);
        let change_set_sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "change_set.recorded",
            change_set_sequence,
            serde_json::json!({
                "summary": change_set.diff_summary,
                "changeSet": change_set
            }),
        )
    }

    pub(crate) fn record_validation_for_tool(
        &self,
        run_id: &str,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        output: &Value,
    ) -> KernelResult<()> {
        let template = self.tool_registry.contract(tool_name).ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "tool.completed references unregistered tool {tool_name}"
            ))
        })?;
        let Some(contract_validation_kind) = template.fact.validation_kind else {
            return Ok(());
        };
        let Some(validation_payload) = output.get("validation") else {
            return Ok(());
        };
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
                format!("Tool effect verified for {tool_name}.")
            } else {
                format!("Tool effect verification failed for {tool_name}.")
            },
            evidence_refs: vec![format!("tool.completed:{tool_call_id}")],
        };
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "validation.result",
            sequence,
            serde_json::json!({
                "summary": &validation.summary,
                "validation": &validation,
                "contractValidationKind": contract_validation_kind,
                "toolValidation": validation_payload
            }),
        )
    }
}
