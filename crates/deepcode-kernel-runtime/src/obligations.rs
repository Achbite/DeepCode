use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn record_change_operation_for_tool(
        &mut self,
        run_id: &str,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<()> {
        let registry = KernelToolRegistry::default();
        let template = registry.template(tool_name).ok_or_else(|| {
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
            kind: kind.to_string(),
            file_path: path,
            diff: None,
        };
        self.state
            .change_operations_by_run
            .entry(run_id.to_string())
            .or_default()
            .push(operation.clone());

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
            .state
            .change_operations_by_run
            .get(run_id)
            .cloned()
            .unwrap_or_default();
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
        &mut self,
        run_id: &str,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        output: &Value,
    ) -> KernelResult<()> {
        let registry = KernelToolRegistry::default();
        let template = registry.template(tool_name).ok_or_else(|| {
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
        self.state
            .validations_by_run
            .entry(run_id.to_string())
            .or_default()
            .push(validation.clone());
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
