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
        let Some((kind, path)) = change_operation_for_tool(tool_name, arguments) else {
            return Ok(());
        };
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
        if let Some(validation_payload) = output.get("validation") {
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
                    "toolValidation": validation_payload
                }),
            )?;
            return Ok(());
        }
        if tool_name != "process.exec" {
            return Ok(());
        }
        let command = output
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(kind) = validation_kind_for_command(command) else {
            return Ok(());
        };
        let exit_code = output.get("exitCode").and_then(Value::as_i64);
        let passed = exit_code == Some(0);
        let validation = ValidationResult {
            id: format!("validation-{run_id}-{tool_call_id}"),
            run_id: run_id.to_string(),
            kind,
            passed,
            summary: if passed {
                format!("Validation command passed: {command}")
            } else {
                format!("Validation command failed with {exit_code:?}: {command}")
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
                "summary": if validation.passed { "Validation passed." } else { "Validation failed." },
                "validation": validation
            }),
        )
    }
}

pub(crate) fn change_operation_for_tool(
    tool_id: &str,
    arguments: &Value,
) -> Option<(&'static str, String)> {
    match tool_id {
        "fs.write" => get_string(arguments, "path").map(|path| ("write", path)),
        "fs.patch" => get_string(arguments, "path").map(|path| ("patch", path)),
        "fs.delete" => get_string(arguments, "path").map(|path| ("delete", path)),
        _ => None,
    }
}

pub(crate) fn validation_kind_for_command(command: &str) -> Option<ValidationKind> {
    let lowered = command.to_ascii_lowercase();
    if lowered.contains("test") {
        Some(ValidationKind::Test)
    } else if lowered.contains("typecheck") || lowered.contains("tsc") {
        Some(ValidationKind::Typecheck)
    } else if lowered.contains("lint") {
        Some(ValidationKind::Lint)
    } else if lowered.contains("fmt") || lowered.contains("format") {
        Some(ValidationKind::Format)
    } else {
        None
    }
}
