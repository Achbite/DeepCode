use super::*;

impl DeepCodeKernelRuntime {
    fn signed_audit_entries(&self) -> KernelResult<Vec<SignedAuditEntryV1>> {
        self.ledger
            .list_all()?
            .into_iter()
            .filter(|event| event.kind == "audit.signed_entry_created")
            .filter_map(|event| event.payload.get("signedEntry").cloned())
            .map(|value| {
                serde_json::from_value::<SignedAuditEntryV1>(value).map_err(|error| {
                    KernelError::Other(format!("decode signed audit entry: {error}"))
                })
            })
            .collect()
    }

    pub(crate) fn audit_verify(
        &self,
        request_id: RequestId,
        scope: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let entries = self.signed_audit_entries()?;
        let verifier = AuditVerifier::new(runtime_audit_signer()?);
        let (ok, report) = match verifier.verify_entries(&entries) {
            Ok(report) => (true, serde_json::to_value(report).unwrap_or(Value::Null)),
            Err(error) => (
                false,
                serde_json::json!({
                    "ok": false,
                    "entriesVerified": 0,
                    "message": error.to_string()
                }),
            ),
        };
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        Ok(vec![
            KernelEvent::AuditVerifyStarted {
                request_id: Some(request_id.clone()),
                scope,
                sequence: Some(sequence),
            },
            KernelEvent::AuditVerifyCompleted {
                request_id: Some(request_id),
                ok,
                report,
                sequence: Some(sequence + 1),
            },
        ])
    }

    pub(crate) fn audit_query(
        &self,
        request_id: RequestId,
        filter: AuditQueryFilter,
    ) -> KernelResult<Vec<KernelEvent>> {
        let limit = filter.limit.clamp(1, 1_000) as usize;
        let mut events = self
            .ledger
            .list_all()?
            .into_iter()
            .filter(|event| {
                filter
                    .run_id
                    .as_ref()
                    .is_none_or(|run_id| event.run_id.as_deref() == Some(run_id.0.as_str()))
                    && filter.session_id.as_ref().is_none_or(|session_id| {
                        event.session_id.as_deref() == Some(session_id.0.as_str())
                    })
                    && filter
                        .after_sequence
                        .is_none_or(|sequence| event.sequence.is_some_and(|value| value > sequence))
                    && filter
                        .before_sequence
                        .is_none_or(|sequence| event.sequence.is_some_and(|value| value < sequence))
                    && filter.contract_id.as_ref().is_none_or(|contract_id| {
                        value_contains_string(&event.payload, "contractId", contract_id)
                    })
                    && filter.tool_id.as_ref().is_none_or(|tool_id| {
                        value_contains_string(&event.payload, "toolId", tool_id)
                    })
            })
            .collect::<Vec<_>>();
        events.sort_by_key(|event| event.sequence.unwrap_or(0));
        let truncated = events.len() > limit;
        events.truncate(limit);
        let returned = events.len();
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        Ok(vec![KernelEvent::AuditQueryCompleted {
            request_id: Some(request_id),
            result: AuditQueryResult {
                filter,
                events: events
                    .into_iter()
                    .map(|event| AuditEventFact {
                        id: event.id,
                        run_id: event.run_id,
                        session_id: event.session_id,
                        kind: event.kind,
                        sequence: event.sequence,
                        payload: event.payload,
                        created_at: event.created_at,
                    })
                    .collect(),
                truncated,
                returned,
            },
            sequence: Some(sequence),
        }])
    }
}
fn runtime_audit_signer() -> KernelResult<LocalAuditSigner> {
    let key = AuditKeyMaterial::load_or_degraded(
        AuditRuntimeMode::Development,
        "deepcode-runtime-v1",
        None,
    )
    .map_err(|error| KernelError::Other(format!("load runtime audit key: {error}")))?;
    Ok(LocalAuditSigner::new(key))
}

fn value_contains_string(value: &Value, key: &str, expected: &str) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(field, value)| {
            (field == key && value.as_str() == Some(expected))
                || value_contains_string(value, key, expected)
        }),
        Value::Array(items) => items
            .iter()
            .any(|item| value_contains_string(item, key, expected)),
        _ => false,
    }
}
