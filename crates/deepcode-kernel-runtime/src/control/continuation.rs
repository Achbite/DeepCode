use super::*;
use deepcode_kernel_abi::{ArtifactDraftLedgerFrame, ArtifactDraftPartKind, ArtifactDraftStatus};

impl DeepCodeKernelRuntime {
    pub(crate) fn run_resume(
        &mut self,
        request_id: RequestId,
        session_id: SessionId,
    ) -> KernelResult<Vec<KernelEvent>> {
        self.ensure_session_restored(&session_id.0)?;
        let initial_record = self
            .state
            .records_by_session
            .get(&session_id.0)
            .cloned()
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!(
                    "session {} has no resumable run",
                    session_id.0
                ))
            })?;
        let mut events = Vec::new();
        if initial_record.lifecycle_state == RuntimeLifecycleState::Terminating
            && matches!(
                self.state.cleanup_state_by_run.get(&initial_record.run_id),
                Some(
                    KernelCleanupState::Pending
                        | KernelCleanupState::Failed
                        | KernelCleanupState::Completed
                )
            )
        {
            events.extend(
                self.run_cleanup_retry(request_id.clone(), RunId(initial_record.run_id.clone()))?,
            );
        } else if initial_record.lifecycle_state == RuntimeLifecycleState::Terminating {
            return Err(KernelError::Structured {
                code: "run_recovery_schema_invalid",
                stage: "run.resume",
                message: "terminating run has no recoverable cleanup state".to_string(),
                details: serde_json::json!({
                    "runId": initial_record.run_id,
                    "sessionId": initial_record.session_id,
                }),
            });
        }
        let record = self
            .state
            .records_by_session
            .get(&session_id.0)
            .cloned()
            .ok_or_else(|| KernelError::Structured {
                code: "run_recovery_schema_invalid",
                stage: "run.resume",
                message: "resumed session lost its runtime record".to_string(),
                details: serde_json::json!({ "sessionId": session_id.0 }),
            })?;
        if record.lifecycle_state == RuntimeLifecycleState::Terminal {
            events.push(KernelEvent::SnapshotReady {
                request_id,
                snapshot: self.snapshot(Some(&record.session_id)),
            });
            return Ok(events);
        }
        events
            .extend(self.recover_indeterminate_tool_attempts(&record.run_id, &record.session_id)?);
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
        events.extend([
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
        ]);
        Ok(events)
    }

    pub(crate) fn restore_artifact_drafts_from_ledger(&mut self, run_id: &str) -> KernelResult<()> {
        if self
            .state
            .artifact_drafts
            .values()
            .any(|draft| draft.run_id == run_id)
            || self
                .state
                .terminal_artifact_draft_keys
                .iter()
                .any(|key| key.starts_with(&format!("{run_id}:")))
        {
            return Err(draft_recovery_error(
                run_id,
                "draft cache is already populated before ledger replay",
            ));
        }
        let events = self.ledger.list_by_run(run_id)?;
        let mut opened = std::collections::BTreeSet::new();
        let mut replayed = std::collections::BTreeSet::new();
        let mut previous_sequence = None;
        for event in events.iter().filter(|event| {
            matches!(
                event.kind.as_str(),
                "draft.open" | "draft.chunk" | "draft.batch_completed" | "draft.discarded"
            )
        }) {
            let sequence = event.sequence.ok_or_else(|| {
                draft_recovery_error(run_id, format!("{} event is missing sequence", event.kind))
            })?;
            if previous_sequence.is_some_and(|previous| sequence <= previous) {
                return Err(draft_recovery_error(
                    run_id,
                    "draft ledger sequence is not strictly increasing",
                ));
            }
            previous_sequence = Some(sequence);
            let fact: deepcode_kernel_abi::ArtifactDraftEvent =
                serde_json::from_value(event.payload.clone()).map_err(|error| {
                    draft_recovery_error(run_id, format!("decode {} event: {error}", event.kind))
                })?;
            let base = fact.frame.base();
            if fact.draft_id != base.draft_id
                || base.run_id != run_id
                || event.session_id.as_deref() != Some(base.session_id.as_str())
            {
                return Err(draft_recovery_error(
                    run_id,
                    "draft event binding does not match its ledger envelope",
                ));
            }
            if event.kind == "draft.open" {
                if fact.status != ArtifactDraftStatus::Open || !opened.insert(fact.draft_id.clone())
                {
                    return Err(draft_recovery_error(
                        run_id,
                        "draft open event is duplicated or has an invalid status",
                    ));
                }
                continue;
            }
            let shape_matches = matches!(
                (&event.kind[..], fact.status, fact.frame.part_kind()),
                (
                    "draft.chunk",
                    ArtifactDraftStatus::Chunk,
                    ArtifactDraftPartKind::ArtifactChunk
                ) | (
                    "draft.batch_completed",
                    ArtifactDraftStatus::BatchCompleted,
                    ArtifactDraftPartKind::BatchDone
                ) | (
                    "draft.discarded",
                    ArtifactDraftStatus::Discarded,
                    ArtifactDraftPartKind::Diagnostic
                )
            );
            if !shape_matches || !opened.contains(&fact.draft_id) {
                return Err(draft_recovery_error(
                    run_id,
                    "draft event has no matching open event or uses the wrong frame kind",
                ));
            }
            let admission =
                admit_artifact_draft_frame(&self.state, run_id, &base.session_id, &fact.frame)
                    .map_err(|error| {
                        draft_recovery_error(run_id, format!("replay draft frame: {error}"))
                    })?;
            replayed.insert(fact.draft_id);
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
        }
        if opened != replayed {
            return Err(draft_recovery_error(
                run_id,
                "draft open event has no persisted frame",
            ));
        }
        Ok(())
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

fn draft_recovery_error(run_id: &str, message: impl Into<String>) -> KernelError {
    KernelError::Structured {
        code: "run_recovery_schema_invalid",
        stage: "draft.restore",
        message: message.into(),
        details: serde_json::json!({ "runId": run_id }),
    }
}

fn runtime_transition_allowed(
    previous: RuntimeLifecycleState,
    current: RuntimeLifecycleState,
) -> bool {
    use RuntimeLifecycleState::{
        AwaitingPermission, Created, Executing, Ready, ReviewReady, Terminal, Terminating,
    };
    matches!(
        (previous, current),
        (Created, Ready | Terminal)
            | (Ready, Executing | Terminating | Terminal)
            | (Executing, AwaitingPermission | Terminating | Terminal)
            | (
                AwaitingPermission,
                Ready | Executing | Terminating | Terminal
            )
            | (ReviewReady, Ready | Executing | Terminating | Terminal)
            | (Terminating, Ready | ReviewReady | Terminal)
    )
}
