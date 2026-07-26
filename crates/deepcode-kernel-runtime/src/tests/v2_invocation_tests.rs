use crate::v2::{
    AuthorityError, AuthorityRuntime, CapabilityScope, EffectCompletion, GrantIssueRequest,
    InvocationLifecycle, InvocationSubmitRequest, TerminalInvocationOutcome,
};
use deepcode_kernel_abi::v2::{
    ControlEpoch, EffectOutcomeV2, GrantFactKindV2, InputId, InvocationFactKindV2,
    KernelErrorCodeV2, KernelFactEnvelopeV2, KernelFactPayloadV2, OperationId, RunId,
};
use deepcode_kernel_ledger::v2::{CanonicalFactStore, FactQueryV2};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static V2_DB_INDEX: AtomicU64 = AtomicU64::new(1);

struct TempFactDb(PathBuf);

impl TempFactDb {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "deepcode-runtime-v2-{}-{}.sqlite3",
            std::process::id(),
            V2_DB_INDEX.fetch_add(1, Ordering::Relaxed)
        ));
        cleanup_sqlite_files(&path);
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempFactDb {
    fn drop(&mut self) {
        cleanup_sqlite_files(&self.0);
    }
}

fn cleanup_sqlite_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let _ = std::fs::remove_file(PathBuf::from(wal));
    let mut shm = path.as_os_str().to_os_string();
    shm.push("-shm");
    let _ = std::fs::remove_file(PathBuf::from(shm));
}

struct Harness {
    runtime: AuthorityRuntime,
    store: CanonicalFactStore,
    run_id: RunId,
    epoch: ControlEpoch,
    grant_id: deepcode_kernel_abi::v2::GrantId,
    scope: CapabilityScope,
}

impl Harness {
    fn new() -> Self {
        let store = CanonicalFactStore::open_in_memory().expect("open store");
        let mut runtime = AuthorityRuntime::open(store.clone()).expect("open authority runtime");
        let run_id = RunId::new("run-invocation");
        let epoch = runtime
            .advance_control_epoch(run_id.clone(), InputId::new("input-1"), None)
            .expect("advance epoch")
            .control_epoch;
        let scope = CapabilityScope::new(
            "fs.write",
            vec!["workspace:/result.txt".to_string()],
            vec!["filesystem.write".to_string()],
        )
        .expect("scope");
        let grant_id = runtime
            .issue_grant(GrantIssueRequest {
                run_id: run_id.clone(),
                operation_id: OperationId::new("grant-decision"),
                control_epoch: epoch,
                scope: scope.clone(),
                request_digest: "sha256:grant-preview".to_string(),
                reason: None,
            })
            .expect("grant")
            .grant_id;
        Self {
            runtime,
            store,
            run_id,
            epoch,
            grant_id,
            scope,
        }
    }

    fn request(&self, operation: &str, digest: &str) -> InvocationSubmitRequest {
        InvocationSubmitRequest {
            run_id: self.run_id.clone(),
            operation_id: OperationId::new(operation),
            control_epoch: self.epoch,
            grant_id: self.grant_id.clone(),
            scope: self.scope.clone(),
            request_digest: digest.to_string(),
            idempotency_key_hash: format!("sha256:idempotency-{operation}"),
        }
    }
}

fn corrupted_copy_recovery_error(facts: Vec<KernelFactEnvelopeV2>) -> AuthorityError {
    let store = CanonicalFactStore::open_in_memory().expect("open corrupt-copy store");
    store
        .append_batch(
            facts
                .into_iter()
                .map(KernelFactEnvelopeV2::into_draft)
                .collect(),
        )
        .expect("persist structurally valid corrupt facts");
    AuthorityRuntime::open(store).expect_err("corrupt authority chain must fail closed")
}

#[test]
fn prepare_failure_emits_no_attempt_or_effect() {
    let mut harness = Harness::new();
    let admission = harness
        .runtime
        .submit_invocation(harness.request("operation-revoked", "sha256:revoked"))
        .expect("admit");
    harness
        .runtime
        .revoke_grant(
            &harness.run_id,
            &harness.grant_id,
            Some("revoked before attempt".to_string()),
        )
        .expect("revoke");
    assert!(matches!(
        harness.runtime.prepare_attempt(&admission.invocation_id),
        Err(AuthorityError::InvalidInvocationState { .. })
    ));

    let facts = harness
        .store
        .query(&FactQueryV2 {
            invocation_id: Some(admission.invocation_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query closed invocation");
    assert!(facts.iter().any(|fact| {
        matches!(
            fact.payload,
            KernelFactPayloadV2::Invocation(ref invocation)
                if invocation.kind == InvocationFactKindV2::FailedBeforeAttempt
        )
    }));
    assert!(!facts.iter().any(|fact| {
        matches!(
            fact.payload,
            KernelFactPayloadV2::Invocation(ref invocation)
                if invocation.attempt_id.is_some()
        ) || matches!(fact.payload, KernelFactPayloadV2::Effect(_))
    }));
}

#[test]
fn attempt_is_durable_before_effect_and_completion_follows_effect() {
    let mut harness = Harness::new();
    let admission = harness
        .runtime
        .submit_invocation(harness.request("operation-success", "sha256:success"))
        .expect("submit");
    let attempt_id = harness
        .runtime
        .prepare_attempt(&admission.invocation_id)
        .expect("prepare");

    let before_effect = harness
        .store
        .query(&FactQueryV2 {
            attempt_id: Some(attempt_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query prepared attempt");
    assert!(before_effect.iter().any(|fact| {
        matches!(
            fact.payload,
            KernelFactPayloadV2::Invocation(ref invocation)
                if invocation.kind == InvocationFactKindV2::AttemptPrepared
        )
    }));
    assert!(!before_effect
        .iter()
        .any(|fact| matches!(fact.payload, KernelFactPayloadV2::Effect(_))));

    harness
        .runtime
        .begin_effect(&admission.invocation_id)
        .expect("begin effect");
    harness
        .runtime
        .finalize_effect(
            &admission.invocation_id,
            EffectCompletion {
                receipt: serde_json::json!({"verified": true}),
                affected_resource_ids: Vec::new(),
                terminal_outcome: TerminalInvocationOutcome::Completed,
                error_code: None,
            },
        )
        .expect("finalize");

    let facts = harness
        .store
        .query(&FactQueryV2 {
            invocation_id: Some(admission.invocation_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query invocation");
    assert!(facts
        .first()
        .expect("submitted fact")
        .identity
        .causation_id
        .is_none());
    for pair in facts.windows(2) {
        assert_eq!(
            pair[1].identity.causation_id.as_ref(),
            Some(&pair[0].fact_id),
            "every authority transition must causally follow the prior fact"
        );
    }
    let effect_position = facts
        .iter()
        .position(|fact| matches!(fact.payload, KernelFactPayloadV2::Effect(_)))
        .expect("effect fact");
    let completion_position = facts
        .iter()
        .position(|fact| {
            matches!(
                fact.payload,
                KernelFactPayloadV2::Invocation(ref invocation)
                    if invocation.kind == InvocationFactKindV2::Completed
            )
        })
        .expect("completion fact");
    assert!(effect_position < completion_position);
    assert_eq!(
        harness
            .runtime
            .invocation_snapshot(&admission.invocation_id)
            .expect("snapshot")
            .lifecycle,
        InvocationLifecycle::Completed
    );
}

#[test]
fn stale_epoch_is_rejected_before_effect() {
    let mut harness = Harness::new();
    let stale_request = harness.request("operation-stale", "sha256:stale");
    harness
        .runtime
        .advance_control_epoch(
            harness.run_id.clone(),
            InputId::new("input-new"),
            Some("new input".to_string()),
        )
        .expect("advance");
    assert_ne!(
        harness.runtime.current_epoch(&harness.run_id),
        Some(stale_request.control_epoch)
    );
    let error = harness
        .runtime
        .submit_invocation(stale_request)
        .expect_err("stale epoch must fail closed");
    assert!(matches!(error, AuthorityError::StaleControlEpoch { .. }));
    assert_eq!(error.code(), KernelErrorCodeV2::StaleControlEpoch);
    let facts = harness.store.snapshot().expect("snapshot").facts;
    assert!(!facts
        .iter()
        .any(|fact| matches!(fact.payload, KernelFactPayloadV2::Effect(_))));
}

#[test]
fn indeterminate_invocation_is_not_automatically_replayed() {
    let mut harness = Harness::new();
    let request = harness.request("operation-indeterminate", "sha256:indeterminate");
    let admission = harness
        .runtime
        .submit_invocation(request.clone())
        .expect("submit");
    harness
        .runtime
        .prepare_attempt(&admission.invocation_id)
        .expect("prepare");
    harness
        .runtime
        .begin_effect(&admission.invocation_id)
        .expect("begin");
    harness
        .runtime
        .finalize_indeterminate(
            &admission.invocation_id,
            serde_json::json!({"reason": "executor result unavailable"}),
        )
        .expect("indeterminate");
    let high_water = harness
        .store
        .ledger_sequence_high_water()
        .expect("high water");

    let replay = harness
        .runtime
        .submit_invocation(request)
        .expect("idempotent replay");
    assert!(replay.replayed);
    assert_eq!(replay.invocation_id, admission.invocation_id);
    assert_eq!(
        harness
            .store
            .ledger_sequence_high_water()
            .expect("high water after replay"),
        high_water
    );

    let mismatched = harness
        .runtime
        .submit_invocation(harness.request("operation-indeterminate", "sha256:different-request"))
        .expect_err("same operation with another digest must fail");
    assert!(matches!(
        mismatched,
        AuthorityError::DuplicateOperationDigestMismatch { .. }
    ));
}

#[test]
fn rejected_operation_is_digest_bound_without_duplicate_facts() {
    let mut harness = Harness::new();
    let mut request = harness.request("operation-rejected", "sha256:rejected");
    request.scope = CapabilityScope::new(
        "fs.write",
        vec!["workspace:/not-authorized.txt".to_string()],
        vec!["filesystem.write".to_string()],
    )
    .expect("alternate scope");
    let first = harness
        .runtime
        .submit_invocation(request.clone())
        .expect("typed rejection");
    assert!(!first.admitted);
    let high_water = harness
        .runtime
        .fact_store()
        .ledger_sequence_high_water()
        .expect("high water");

    let replay = harness
        .runtime
        .submit_invocation(request.clone())
        .expect("replay rejection");
    assert!(replay.replayed);
    assert_eq!(replay.invocation_id, first.invocation_id);
    assert_eq!(
        harness
            .store
            .ledger_sequence_high_water()
            .expect("high water after replay"),
        high_water
    );

    request.request_digest = "sha256:changed".to_string();
    assert!(matches!(
        harness.runtime.submit_invocation(request),
        Err(AuthorityError::DuplicateOperationDigestMismatch { .. })
    ));
}

#[test]
fn epoch_advance_releases_and_closes_unstarted_authority_atomically() {
    let mut harness = Harness::new();
    let admission = harness
        .runtime
        .submit_invocation(harness.request("operation-old-epoch", "sha256:old-epoch"))
        .expect("admit");
    let advance = harness
        .runtime
        .advance_control_epoch(
            harness.run_id.clone(),
            InputId::new("input-supersede"),
            Some("new user input".to_string()),
        )
        .expect("advance");
    assert_ne!(advance.control_epoch, harness.epoch);
    assert_eq!(
        harness
            .runtime
            .invocation_snapshot(&admission.invocation_id)
            .expect("invocation")
            .lifecycle,
        InvocationLifecycle::Failed
    );
    let grant = harness
        .runtime
        .grant_snapshot(&harness.grant_id)
        .expect("grant");
    assert_eq!(grant.lifecycle, crate::v2::GrantLifecycle::Superseded);
    assert_eq!(
        grant.reservations[0].1,
        crate::v2::GrantReservationLifecycle::Released
    );
    assert!(matches!(
        harness.runtime.begin_effect(&admission.invocation_id),
        Err(AuthorityError::InvalidInvocationState { .. })
    ));

    let facts = harness
        .store
        .query(&FactQueryV2 {
            invocation_id: Some(admission.invocation_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query closed authority");
    assert!(facts.iter().any(|fact| {
        matches!(
            fact.payload,
            KernelFactPayloadV2::Invocation(ref invocation)
                if invocation.kind == InvocationFactKindV2::FailedBeforeAttempt
        )
    }));
    assert!(!facts
        .iter()
        .any(|fact| matches!(fact.payload, KernelFactPayloadV2::Effect(_))));
}

#[test]
fn restart_closes_admitted_authority_before_effect() {
    let database = TempFactDb::new();
    let (invocation_id, run_id) = {
        let store = CanonicalFactStore::open(database.path()).expect("open file store");
        let mut runtime = AuthorityRuntime::open(store.clone()).expect("open runtime");
        let run_id = RunId::new("run-recovery-admitted");
        let epoch = runtime
            .advance_control_epoch(run_id.clone(), InputId::new("input-recovery"), None)
            .expect("advance")
            .control_epoch;
        let scope = CapabilityScope::new(
            "fs.write",
            vec!["workspace:/recovery.txt".to_string()],
            vec!["filesystem.write".to_string()],
        )
        .expect("scope");
        let grant_id = runtime
            .issue_grant(GrantIssueRequest {
                run_id: run_id.clone(),
                operation_id: OperationId::new("grant-recovery"),
                control_epoch: epoch,
                scope: scope.clone(),
                request_digest: "sha256:grant-recovery".to_string(),
                reason: None,
            })
            .expect("grant")
            .grant_id;
        let admission = runtime
            .submit_invocation(InvocationSubmitRequest {
                run_id: run_id.clone(),
                operation_id: OperationId::new("operation-recovery-admitted"),
                control_epoch: epoch,
                grant_id,
                scope,
                request_digest: "sha256:recovery-admitted".to_string(),
                idempotency_key_hash: "sha256:recovery-admitted-idem".to_string(),
            })
            .expect("admit");
        (admission.invocation_id, run_id)
    };

    let store = CanonicalFactStore::open(database.path()).expect("reopen file store");
    let runtime = AuthorityRuntime::open(store.clone()).expect("recover runtime");
    assert_eq!(
        runtime
            .invocation_snapshot(&invocation_id)
            .expect("recovered invocation")
            .lifecycle,
        InvocationLifecycle::Failed
    );
    let facts = store
        .query(&FactQueryV2 {
            run_id: Some(run_id.to_string()),
            invocation_id: Some(invocation_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query recovery facts");
    assert!(facts.iter().any(|fact| {
        matches!(
            fact.payload,
            KernelFactPayloadV2::Invocation(ref invocation)
                if invocation.kind == InvocationFactKindV2::FailedBeforeAttempt
        )
    }));
    assert!(!facts
        .iter()
        .any(|fact| matches!(fact.payload, KernelFactPayloadV2::Effect(_))));
}

#[test]
fn crash_after_effect_before_finalize_becomes_indeterminate() {
    let database = TempFactDb::new();
    let (invocation_id, request) = {
        let store = CanonicalFactStore::open(database.path()).expect("open file store");
        let mut runtime = AuthorityRuntime::open(store.clone()).expect("open runtime");
        let run_id = RunId::new("run-recovery-effect");
        let epoch = runtime
            .advance_control_epoch(run_id.clone(), InputId::new("input-effect"), None)
            .expect("advance")
            .control_epoch;
        let scope = CapabilityScope::new(
            "fs.write",
            vec!["workspace:/effect.txt".to_string()],
            vec!["filesystem.write".to_string()],
        )
        .expect("scope");
        let grant_id = runtime
            .issue_grant(GrantIssueRequest {
                run_id: run_id.clone(),
                operation_id: OperationId::new("grant-effect"),
                control_epoch: epoch,
                scope: scope.clone(),
                request_digest: "sha256:grant-effect".to_string(),
                reason: None,
            })
            .expect("grant")
            .grant_id;
        let request = InvocationSubmitRequest {
            run_id,
            operation_id: OperationId::new("operation-recovery-effect"),
            control_epoch: epoch,
            grant_id,
            scope,
            request_digest: "sha256:recovery-effect".to_string(),
            idempotency_key_hash: "sha256:recovery-effect-idem".to_string(),
        };
        let admission = runtime.submit_invocation(request.clone()).expect("admit");
        runtime
            .prepare_attempt(&admission.invocation_id)
            .expect("prepare");
        runtime
            .begin_effect(&admission.invocation_id)
            .expect("cross durable effect boundary");
        (admission.invocation_id, request)
    };

    let store = CanonicalFactStore::open(database.path()).expect("reopen file store");
    let mut runtime = AuthorityRuntime::open(store.clone()).expect("recover runtime");
    assert!(!runtime.is_storage_faulted_after_effect());
    assert_eq!(
        runtime
            .invocation_snapshot(&invocation_id)
            .expect("recovered invocation")
            .lifecycle,
        InvocationLifecycle::Indeterminate
    );
    let facts = store
        .query(&FactQueryV2 {
            invocation_id: Some(invocation_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query recovery");
    assert!(facts.iter().any(|fact| {
        matches!(
            fact.payload,
            KernelFactPayloadV2::Invocation(ref invocation)
                if invocation.kind == InvocationFactKindV2::Indeterminate
        )
    }));
    assert!(facts.iter().any(|fact| {
        matches!(
            fact.payload,
            KernelFactPayloadV2::Effect(ref effect)
                if effect.outcome == deepcode_kernel_abi::v2::EffectOutcomeV2::Indeterminate
        )
    }));

    let high_water = store.ledger_sequence_high_water().expect("high water");
    let replay = runtime
        .submit_invocation(request)
        .expect("same operation is an idempotent status replay");
    assert!(replay.replayed);
    assert_eq!(replay.invocation_id, invocation_id);
    assert_eq!(
        store.ledger_sequence_high_water().expect("post replay"),
        high_water
    );
}

#[test]
fn observed_effect_can_finalize_as_failed_without_losing_receipt() {
    let mut harness = Harness::new();
    let admission = harness
        .runtime
        .submit_invocation(harness.request("operation-effect-failed", "sha256:effect-failed"))
        .expect("admit");
    harness
        .runtime
        .prepare_attempt(&admission.invocation_id)
        .expect("prepare");
    harness
        .runtime
        .begin_effect(&admission.invocation_id)
        .expect("begin");
    harness
        .runtime
        .finalize_effect(
            &admission.invocation_id,
            EffectCompletion {
                receipt: serde_json::json!({"observed": true, "verified": false}),
                affected_resource_ids: Vec::new(),
                terminal_outcome: TerminalInvocationOutcome::Failed,
                error_code: Some("VerificationFailed".to_string()),
            },
        )
        .expect("finalize failed effect");
    assert_eq!(
        harness
            .runtime
            .invocation_snapshot(&admission.invocation_id)
            .expect("snapshot")
            .lifecycle,
        InvocationLifecycle::Failed
    );
}

#[test]
fn replay_requires_exact_submission_reservation_admission_causal_chain() {
    let mut harness = Harness::new();
    let admission = harness
        .runtime
        .submit_invocation(harness.request("operation-chain", "sha256:chain"))
        .expect("admit");
    let healthy = harness.store.snapshot().expect("snapshot").facts;
    let unrelated_prior_fact = healthy
        .iter()
        .find(|envelope| {
            matches!(
                envelope.payload,
                KernelFactPayloadV2::Grant(ref grant)
                    if grant.kind == GrantFactKindV2::Issued
            )
        })
        .expect("grant issuance")
        .fact_id
        .clone();

    let mut wrong_reservation_cause = healthy.clone();
    wrong_reservation_cause
        .iter_mut()
        .find(|envelope| {
            matches!(
                envelope.payload,
                KernelFactPayloadV2::Grant(ref grant)
                    if grant.kind == GrantFactKindV2::Reserved
                        && envelope.identity.invocation_id.as_ref()
                            == Some(&admission.invocation_id)
            )
        })
        .expect("reservation")
        .identity
        .causation_id = Some(unrelated_prior_fact);
    assert!(matches!(
        corrupted_copy_recovery_error(wrong_reservation_cause),
        AuthorityError::FactStoreUnavailable {
            operation: "restore_authority_state",
            ..
        }
    ));

    let submitted_fact_id = healthy
        .iter()
        .find(|envelope| {
            matches!(
                envelope.payload,
                KernelFactPayloadV2::Invocation(ref invocation)
                    if invocation.kind == InvocationFactKindV2::Submitted
                        && invocation.invocation_id == admission.invocation_id
            )
        })
        .expect("submission")
        .fact_id
        .clone();
    let mut wrong_admission_cause = healthy;
    wrong_admission_cause
        .iter_mut()
        .find(|envelope| {
            matches!(
                envelope.payload,
                KernelFactPayloadV2::Invocation(ref invocation)
                    if invocation.kind == InvocationFactKindV2::Admitted
                        && invocation.invocation_id == admission.invocation_id
            )
        })
        .expect("admission")
        .identity
        .causation_id = Some(submitted_fact_id);
    assert!(matches!(
        corrupted_copy_recovery_error(wrong_admission_cause),
        AuthorityError::FactStoreUnavailable {
            operation: "restore_authority_state",
            ..
        }
    ));
}

#[test]
fn replay_rejects_terminal_state_that_contradicts_effect_outcome() {
    let mut harness = Harness::new();
    let admission = harness
        .runtime
        .submit_invocation(harness.request("operation-outcome", "sha256:outcome"))
        .expect("admit");
    harness
        .runtime
        .prepare_attempt(&admission.invocation_id)
        .expect("prepare");
    harness
        .runtime
        .begin_effect(&admission.invocation_id)
        .expect("begin");
    harness
        .runtime
        .finalize_effect(
            &admission.invocation_id,
            EffectCompletion {
                receipt: serde_json::json!({"observed": true}),
                affected_resource_ids: Vec::new(),
                terminal_outcome: TerminalInvocationOutcome::Completed,
                error_code: None,
            },
        )
        .expect("complete");

    let mut contradictory = harness.store.snapshot().expect("snapshot").facts;
    let effect = contradictory
        .iter_mut()
        .find_map(|envelope| match &mut envelope.payload {
            KernelFactPayloadV2::Effect(effect)
                if effect.invocation_id == admission.invocation_id =>
            {
                Some(effect)
            }
            _ => None,
        })
        .expect("effect");
    effect.outcome = EffectOutcomeV2::Indeterminate;
    assert!(matches!(
        corrupted_copy_recovery_error(contradictory),
        AuthorityError::FactStoreUnavailable {
            operation: "restore_authority_state",
            ..
        }
    ));
}
