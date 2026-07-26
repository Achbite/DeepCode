use crate::v2::{
    AuthorityError, AuthorityRuntime, CapabilityScope, EffectCompletion, GrantIssueRequest,
    GrantLifecycle, InvocationSubmitRequest, TerminalInvocationOutcome,
};
use deepcode_kernel_abi::v2::{
    ControlEpoch, GrantFactKindV2, InputId, KernelErrorCodeV2, KernelFactPayloadV2, OperationId,
    RunId,
};
use deepcode_kernel_ledger::v2::{CanonicalFactStore, FactQueryV2};

fn scope() -> CapabilityScope {
    CapabilityScope::new(
        "fs.write",
        vec!["workspace:/notes.txt".to_string()],
        vec!["filesystem.write".to_string()],
    )
    .expect("valid exact scope")
}

fn runtime_with_grant() -> (
    AuthorityRuntime,
    CanonicalFactStore,
    RunId,
    ControlEpoch,
    deepcode_kernel_abi::v2::GrantId,
) {
    let store = CanonicalFactStore::open_in_memory().expect("open fact store");
    let mut runtime = AuthorityRuntime::open(store.clone()).expect("open authority runtime");
    let run_id = RunId::new("run-grant");
    let epoch = runtime
        .advance_control_epoch(
            run_id.clone(),
            InputId::new("input-grant"),
            Some("initial input".to_string()),
        )
        .expect("advance epoch")
        .control_epoch;
    let grant = runtime
        .issue_grant(GrantIssueRequest {
            run_id: run_id.clone(),
            operation_id: OperationId::new("operation-grant-issue"),
            control_epoch: epoch,
            scope: scope(),
            request_digest: "sha256:grant-preview".to_string(),
            reason: Some("test decision".to_string()),
        })
        .expect("issue grant");
    (runtime, store, run_id, epoch, grant.grant_id)
}

fn invocation_request(
    run_id: &RunId,
    epoch: ControlEpoch,
    grant_id: &deepcode_kernel_abi::v2::GrantId,
    index: u64,
) -> InvocationSubmitRequest {
    InvocationSubmitRequest {
        run_id: run_id.clone(),
        operation_id: OperationId::new(format!("operation-{index}")),
        control_epoch: epoch,
        grant_id: grant_id.clone(),
        scope: scope(),
        request_digest: format!("sha256:request-{index}"),
        idempotency_key_hash: format!("sha256:idempotency-{index}"),
    }
}

#[test]
fn grant_reservation_is_bound_to_run_operation_and_epoch() {
    let (mut runtime, store, run_id, epoch, grant_id) = runtime_with_grant();
    let request = invocation_request(&run_id, epoch, &grant_id, 1);
    let admission = runtime
        .submit_invocation(request.clone())
        .expect("submit invocation");
    assert!(admission.admitted);

    let grant = runtime.grant_snapshot(&grant_id).expect("grant snapshot");
    assert_eq!(grant.run_id, run_id);
    assert_eq!(grant.control_epoch, epoch);
    assert_eq!(grant.scope, request.scope);
    assert_eq!(grant.reservations.len(), 1);

    let facts = store
        .query(&FactQueryV2 {
            invocation_id: Some(admission.invocation_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query invocation facts");
    let reservation = facts
        .iter()
        .find(|fact| {
            matches!(
                fact.payload,
                KernelFactPayloadV2::Grant(ref grant)
                    if grant.kind == GrantFactKindV2::Reserved
            )
        })
        .expect("reservation fact");
    assert_eq!(reservation.identity.run_id, request.run_id);
    assert_eq!(
        reservation.identity.operation_id.as_ref(),
        Some(&request.operation_id)
    );
    assert_eq!(reservation.identity.control_epoch, request.control_epoch);
    assert_eq!(
        reservation.identity.capability_grant_id.as_ref(),
        Some(&grant_id)
    );
    assert!(reservation.identity.grant_reservation_id.is_some());
}

#[test]
fn grant_is_consumed_at_each_effect_boundary_without_hidden_use_cap() {
    let (mut runtime, _store, run_id, epoch, grant_id) = runtime_with_grant();

    for index in 1..=5 {
        let admission = runtime
            .submit_invocation(invocation_request(&run_id, epoch, &grant_id, index))
            .expect("submit");
        runtime
            .prepare_attempt(&admission.invocation_id)
            .expect("prepare");
        runtime
            .begin_effect(&admission.invocation_id)
            .expect("begin effect");
        runtime
            .finalize_effect(
                &admission.invocation_id,
                EffectCompletion {
                    receipt: serde_json::json!({"index": index}),
                    affected_resource_ids: Vec::new(),
                    terminal_outcome: TerminalInvocationOutcome::Completed,
                    error_code: None,
                },
            )
            .expect("finalize");
    }

    let grant = runtime.grant_snapshot(&grant_id).expect("grant snapshot");
    assert_eq!(grant.observed_use_count, 5);
    assert_eq!(grant.reservations.len(), 5);
    assert!(grant
        .reservations
        .iter()
        .all(|(_, lifecycle)| *lifecycle == crate::v2::GrantReservationLifecycle::Consumed));
}

#[test]
fn pre_effect_failure_releases_reservation_without_fake_effect() {
    let (mut runtime, store, run_id, epoch, grant_id) = runtime_with_grant();
    let admission = runtime
        .submit_invocation(invocation_request(&run_id, epoch, &grant_id, 1))
        .expect("submit");
    runtime
        .prepare_attempt(&admission.invocation_id)
        .expect("prepare");
    runtime
        .finalize_pre_effect_failure(&admission.invocation_id, "TargetRevalidationFailed")
        .expect("finalize pre-effect failure");

    let facts = store
        .query(&FactQueryV2 {
            invocation_id: Some(admission.invocation_id.to_string()),
            ..FactQueryV2::default()
        })
        .expect("query facts");
    assert!(!facts
        .iter()
        .any(|fact| matches!(fact.payload, KernelFactPayloadV2::Effect(_))));
    assert!(facts.iter().any(|fact| {
        matches!(
            fact.payload,
            KernelFactPayloadV2::Grant(ref grant)
                if grant.kind == GrantFactKindV2::ReservationReleased
        )
    }));
}

#[test]
fn revoked_or_superseded_grant_fails_closed() {
    let (mut runtime, _store, run_id, epoch, grant_id) = runtime_with_grant();
    runtime
        .revoke_grant(&run_id, &grant_id, Some("user revoked".to_string()))
        .expect("revoke grant");
    let rejected = runtime
        .submit_invocation(invocation_request(&run_id, epoch, &grant_id, 1))
        .expect("typed rejection");
    assert!(!rejected.admitted);
    assert_eq!(
        rejected.rejection_code,
        Some(KernelErrorCodeV2::GrantRequired)
    );

    let second_grant = runtime
        .issue_grant(GrantIssueRequest {
            run_id: run_id.clone(),
            operation_id: OperationId::new("operation-second-grant"),
            control_epoch: epoch,
            scope: scope(),
            request_digest: "sha256:second-grant-preview".to_string(),
            reason: None,
        })
        .expect("issue second grant");
    let advanced = runtime
        .advance_control_epoch(
            run_id.clone(),
            InputId::new("input-next"),
            Some("new user input".to_string()),
        )
        .expect("advance epoch");
    assert_eq!(
        runtime
            .grant_snapshot(&second_grant.grant_id)
            .expect("second grant")
            .lifecycle,
        GrantLifecycle::Superseded
    );
    let rejected = runtime
        .submit_invocation(invocation_request(
            &run_id,
            advanced.control_epoch,
            &second_grant.grant_id,
            2,
        ))
        .expect("typed rejection");
    assert_eq!(
        rejected.rejection_code,
        Some(KernelErrorCodeV2::GrantRequired)
    );
}

#[test]
fn operation_id_digest_binding_is_shared_by_grants_and_invocations() {
    let (mut runtime, store, run_id, epoch, grant_id) = runtime_with_grant();
    let high_water = store
        .ledger_sequence_high_water()
        .expect("high water before collision");
    let mut colliding_invocation = invocation_request(&run_id, epoch, &grant_id, 1);
    colliding_invocation.operation_id = OperationId::new("operation-grant-issue");
    assert!(matches!(
        runtime.submit_invocation(colliding_invocation),
        Err(AuthorityError::DuplicateOperationDigestMismatch { .. })
    ));
    assert_eq!(
        store
            .ledger_sequence_high_water()
            .expect("high water after rejected collision"),
        high_water
    );

    let admitted = runtime
        .submit_invocation(invocation_request(&run_id, epoch, &grant_id, 2))
        .expect("admit distinct operation");
    assert!(admitted.admitted);
    let high_water = store
        .ledger_sequence_high_water()
        .expect("high water after admission");
    assert!(matches!(
        runtime.issue_grant(GrantIssueRequest {
            run_id,
            operation_id: OperationId::new("operation-2"),
            control_epoch: epoch,
            scope: scope(),
            request_digest: "sha256:different-grant-request".to_string(),
            reason: None,
        }),
        Err(AuthorityError::DuplicateOperationDigestMismatch { .. })
    ));
    assert_eq!(
        store
            .ledger_sequence_high_water()
            .expect("high water after reverse collision"),
        high_water
    );
}
