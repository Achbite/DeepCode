use super::*;
use deepcode_kernel_abi::{ArtifactDraftLedgerFrame, ArtifactDraftPartKind, ArtifactDraftStatus};

impl DeepCodeKernelRuntime {
    pub(crate) fn run_resume(
        &mut self,
        request_id: RequestId,
        session_id: SessionId,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.ensure_session_restored(&session_id.0)?;
        let record = self
            .state
            .records_by_session
            .get(&session_id.0)
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!(
                    "session {} has no resumable run",
                    session_id.0
                ))
            })?;
        let next_sequence = self.ledger.next_sequence(&record.run_id)?;
        let checkpoint_id = format!("runtime-checkpoint-{}-resume", record.run_id);
        self.append_ledger(
            &record.run_id,
            &record.session_id,
            "runtime.resumed",
            next_sequence,
            serde_json::json!({
                "summary": "Kernel runtime resumed from its persisted record.",
                "checkpointId": &checkpoint_id,
                "lifecycleState": record.lifecycle_state
            }),
        )?;
        Ok(vec![
            KernelEvent::RuntimeResumed {
                run_id: RunId(record.run_id.clone()),
                session_id: Some(SessionId(record.session_id.clone())),
                checkpoint_id,
                lifecycle_state: record.lifecycle_state,
                sequence: Some(next_sequence),
            },
            KernelEvent::SnapshotReady {
                request_id,
                snapshot: self.snapshot(Some(&record.session_id)),
            },
        ])
    }

    pub(crate) fn draft_ledger_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        frame: ArtifactDraftLedgerFrame,
    ) -> KernelResult<Vec<KernelEvent>> {
        let session_id = session_id
            .map(|value| value.0)
            .or_else(|| {
                self.record_by_run(&run_id.0)
                    .ok()
                    .map(|record| record.session_id)
            })
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!("run {} has no active session", run_id.0))
            })?;
        self.strong_artifact_draft_submit(request_id, run_id, session_id, frame)
    }

    fn strong_artifact_draft_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: String,
        frame: ArtifactDraftLedgerFrame,
    ) -> KernelResult<Vec<KernelEvent>> {
        let admission = admit_artifact_draft_frame(&self.state, &run_id.0, &session_id, &frame)?;
        let mut events = Vec::new();
        let mut ledger_events = Vec::new();
        let first_sequence = self.ledger.next_sequence(&run_id.0)?;
        let frame_sequence = if admission.opened {
            first_sequence + 1
        } else {
            first_sequence
        };
        if admission.opened {
            let draft = draft_payload(&admission.draft_id, ArtifactDraftStatus::Open, &frame);
            ledger_events.push(LedgerEvent {
                id: format!("evt-{}-{first_sequence}", run_id.0),
                run_id: Some(run_id.0.clone()),
                session_id: Some(session_id.clone()),
                kind: "draft.open".to_string(),
                sequence: Some(first_sequence),
                payload: serde_json::to_value(&draft).map_err(|error| {
                    KernelError::InvalidCommand(format!("encode typed draft event: {error}"))
                })?,
                created_at: None,
            });
            events.push(KernelEvent::DraftOpen {
                request_id: Some(request_id.clone()),
                run_id: run_id.clone(),
                session_id: Some(SessionId(session_id.clone())),
                draft,
                sequence: Some(first_sequence),
            });
        }
        let (event_kind, status) = match admission.part_kind {
            ArtifactDraftPartKind::ArtifactChunk => ("draft.chunk", ArtifactDraftStatus::Chunk),
            ArtifactDraftPartKind::BatchDone => {
                ("draft.batch_completed", ArtifactDraftStatus::BatchCompleted)
            }
            ArtifactDraftPartKind::Diagnostic => {
                ("draft.discarded", ArtifactDraftStatus::Discarded)
            }
        };
        let draft = draft_payload(&admission.draft_id, status, &frame);
        let event = match admission.part_kind {
            ArtifactDraftPartKind::ArtifactChunk => KernelEvent::DraftChunk {
                request_id: Some(request_id),
                run_id: run_id.clone(),
                session_id: Some(SessionId(session_id.clone())),
                draft: draft.clone(),
                sequence: Some(frame_sequence),
            },
            ArtifactDraftPartKind::BatchDone => KernelEvent::DraftBatchCompleted {
                request_id: Some(request_id),
                run_id: run_id.clone(),
                session_id: Some(SessionId(session_id.clone())),
                draft: draft.clone(),
                sequence: Some(frame_sequence),
            },
            ArtifactDraftPartKind::Diagnostic => KernelEvent::DraftDiscarded {
                request_id: Some(request_id),
                run_id: run_id.clone(),
                session_id: Some(SessionId(session_id.clone())),
                draft: draft.clone(),
                sequence: Some(frame_sequence),
            },
        };
        ledger_events.push(LedgerEvent {
            id: format!("evt-{}-{frame_sequence}", run_id.0),
            run_id: Some(run_id.0.clone()),
            session_id: Some(session_id.clone()),
            kind: event_kind.to_string(),
            sequence: Some(frame_sequence),
            payload: serde_json::to_value(&draft).map_err(|error| {
                KernelError::InvalidCommand(format!("encode typed draft event: {error}"))
            })?,
            created_at: None,
        });
        self.append_ledger_batch(ledger_events)?;
        events.push(event);
        if admission.terminal {
            self.state.artifact_drafts.remove(&admission.draft_key);
            self.state
                .terminal_artifact_draft_keys
                .insert(admission.draft_key);
        } else {
            self.state
                .artifact_drafts
                .insert(admission.draft_key, admission.record);
        }
        Ok(events)
    }

    pub(crate) fn transition_runtime_lifecycle(
        &mut self,
        request_id: Option<RequestId>,
        run_id: &str,
        session_id: &str,
        current_state: RuntimeLifecycleState,
        reason: impl Into<String>,
    ) -> KernelResult<Option<KernelEvent>> {
        let previous_state = self.record_by_run(run_id)?.lifecycle_state;
        if previous_state == current_state {
            return Ok(None);
        }
        if !runtime_transition_allowed(previous_state, current_state) {
            return Err(KernelError::InvalidCommand(format!(
                "invalid Kernel runtime lifecycle transition: {} -> {}",
                previous_state.as_str(),
                current_state.as_str()
            )));
        }
        let reason = reason.into();
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "runtime.lifecycle_changed",
            sequence,
            serde_json::json!({
                "summary": format!("Kernel runtime entered {}.", current_state.as_str()),
                "previousState": previous_state,
                "currentState": current_state,
                "reason": reason
            }),
        )?;
        self.record_by_run_mut(run_id)?.lifecycle_state = current_state;
        Ok(Some(KernelEvent::RuntimeLifecycleChanged {
            request_id,
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            previous_state: Some(previous_state),
            current_state,
            reason: Some(reason),
            sequence: Some(sequence),
        }))
    }
}

fn runtime_transition_allowed(
    previous: RuntimeLifecycleState,
    current: RuntimeLifecycleState,
) -> bool {
    use RuntimeLifecycleState::{
        AwaitingPermission, Created, Executing, Ready, ReviewReady, Terminal,
    };
    matches!(
        (previous, current),
        (Created, Ready | Terminal)
            | (Ready, Executing | Terminal)
            | (Executing, AwaitingPermission | ReviewReady | Terminal)
            | (
                AwaitingPermission,
                Ready | Executing | ReviewReady | Terminal
            )
            | (ReviewReady, Ready | Executing | Terminal)
    )
}
