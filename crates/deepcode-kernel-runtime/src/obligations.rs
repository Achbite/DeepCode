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
        if tool_name != "shell.exec" {
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

    pub(crate) fn change_set_for_run(&self, run_id: &str) -> KernelResult<Option<ChangeSet>> {
        if let Some(operations) = self.state.change_operations_by_run.get(run_id) {
            if !operations.is_empty() {
                return Ok(Some(ChangeSet::from_operations(
                    format!("changeset-{run_id}"),
                    run_id,
                    operations.clone(),
                )));
            }
        }
        let operations = self
            .ledger
            .list_by_run(run_id)?
            .into_iter()
            .filter(|event| event.kind == "change.operation_recorded")
            .filter_map(|event| {
                serde_json::from_value::<ChangeOperation>(event.payload.get("operation")?.clone())
                    .ok()
            })
            .collect::<Vec<_>>();
        if operations.is_empty() {
            Ok(None)
        } else {
            Ok(Some(ChangeSet::from_operations(
                format!("changeset-{run_id}"),
                run_id,
                operations,
            )))
        }
    }

    pub(crate) fn validations_for_run(&self, run_id: &str) -> KernelResult<Vec<ValidationResult>> {
        if let Some(validations) = self.state.validations_by_run.get(run_id) {
            return Ok(validations.clone());
        }
        Ok(self
            .ledger
            .list_by_run(run_id)?
            .into_iter()
            .filter(|event| event.kind == "validation.result")
            .filter_map(|event| {
                serde_json::from_value::<ValidationResult>(event.payload.get("validation")?.clone())
                    .ok()
            })
            .collect())
    }

    pub(crate) fn evidence_refs_for_run(&self, run_id: &str) -> KernelResult<Vec<String>> {
        Ok(self
            .ledger
            .list_by_run(run_id)?
            .into_iter()
            .filter_map(|event| match event.kind.as_str() {
                "tool.completed" => event
                    .payload
                    .get("ok")
                    .and_then(Value::as_bool)
                    .filter(|ok| *ok)
                    .map(|_| format!("tool.completed:{}", event.sequence.unwrap_or_default())),
                "workspace.result" => event
                    .payload
                    .get("ok")
                    .and_then(Value::as_bool)
                    .filter(|ok| *ok)
                    .map(|_| format!("workspace.result:{}", event.sequence.unwrap_or_default())),
                "message.appended" => event
                    .payload
                    .get("channel")
                    .and_then(Value::as_str)
                    .filter(|channel| *channel == "final")
                    .map(|_| format!("message.appended:{}", event.sequence.unwrap_or_default())),
                _ => None,
            })
            .collect())
    }
}

pub(crate) fn change_operation_for_tool(
    tool_id: &str,
    arguments: &Value,
) -> Option<(&'static str, String)> {
    match tool_id {
        "fs.write" => get_string(arguments, "path").map(|path| ("write", path)),
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
