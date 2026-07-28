use deepcode_kernel_abi::v2::{
    AttemptId, CancelRequestId, CausalIdentityV2, ControlEpoch, ControlFactKindV2, ControlFactV2,
    CorrelationRefV2, EffectFactV2, EffectId, EffectOutcomeV2, FactId, GrantId, GrantReservationId,
    InputId, InvocationId, KernelFactDraftV2, KernelFactPayloadV2, OperationId, ResourceId, RunId,
};
use deepcode_kernel_ledger::v2::{CanonicalFactStore, FactQueryV2};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_ID: AtomicU64 = AtomicU64::new(1);

struct TestRoot {
    path: PathBuf,
}

impl TestRoot {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "deepcode-kernel-ledger-{label}-{}-{nonce}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create test root");
        Self { path }
    }

    fn database(&self) -> PathBuf {
        self.path.join("kernel-v2.sqlite3")
    }

    fn cleanup(mut self) {
        fs::remove_dir_all(&self.path).expect("remove test root");
        self.path = PathBuf::new();
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn identity(run_id: &str, epoch: u64) -> CausalIdentityV2 {
    CausalIdentityV2 {
        run_id: RunId::from(run_id),
        control_epoch: ControlEpoch::new(epoch).expect("non-zero epoch"),
        operation_id: None,
        capability_grant_id: None,
        grant_reservation_id: None,
        invocation_id: None,
        attempt_id: None,
        causation_id: None,
        correlation_refs: Vec::new(),
        idempotency_key_hash: None,
    }
}

fn control_draft(fact_id: &str, run_id: &str, epoch: u64) -> KernelFactDraftV2 {
    KernelFactDraftV2::new(
        FactId::from(fact_id),
        format!("2026-07-26T04:00:{epoch:02}Z"),
        identity(run_id, epoch),
        KernelFactPayloadV2::Control(ControlFactV2 {
            kind: ControlFactKindV2::EpochAdvanced,
            input_id: Some(InputId::from(format!("input-{fact_id}"))),
            cancel_request_id: None::<CancelRequestId>,
            previous_epoch: (epoch > 1)
                .then(|| ControlEpoch::new(epoch - 1).expect("previous epoch")),
            target_invocation_id: None,
            reason: None,
        }),
    )
}

struct EffectIdentity<'a> {
    run_id: &'a str,
    operation_id: &'a str,
    invocation_id: &'a str,
    attempt_id: &'a str,
    grant_id: &'a str,
    reservation_id: &'a str,
    resource_id: &'a str,
    epoch: u64,
}

fn effect_draft(fact_id: &str, values: EffectIdentity<'_>) -> KernelFactDraftV2 {
    let invocation_id = InvocationId::from(values.invocation_id);
    let attempt_id = AttemptId::from(values.attempt_id);
    let resource_id = ResourceId::from(values.resource_id);
    KernelFactDraftV2::new(
        FactId::from(fact_id),
        format!("2026-07-26T05:00:{:02}Z", values.epoch),
        CausalIdentityV2 {
            run_id: RunId::from(values.run_id),
            control_epoch: ControlEpoch::new(values.epoch).expect("non-zero epoch"),
            operation_id: Some(OperationId::from(values.operation_id)),
            capability_grant_id: Some(GrantId::from(values.grant_id)),
            grant_reservation_id: Some(GrantReservationId::from(values.reservation_id)),
            invocation_id: Some(invocation_id.clone()),
            attempt_id: Some(attempt_id.clone()),
            causation_id: Some(FactId::from(format!("cause-{fact_id}"))),
            correlation_refs: vec![CorrelationRefV2 {
                kind: "source".to_string(),
                value: format!("source-{}", values.operation_id),
            }],
            idempotency_key_hash: Some(format!("hash-{}", values.operation_id)),
        },
        KernelFactPayloadV2::Effect(EffectFactV2 {
            effect_id: EffectId::from(format!("effect-{fact_id}")),
            invocation_id,
            attempt_id,
            outcome: EffectOutcomeV2::Observed,
            affected_resources: vec![resource_id],
            receipt: Some(serde_json::json!({"factId": fact_id})),
        }),
    )
}

#[test]
fn v2_append_batch_is_atomic_and_monotonic_per_run() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    let committed = store
        .append_batch(vec![
            control_draft("fact-a1", "run-a", 1),
            control_draft("fact-b1", "run-b", 1),
            control_draft("fact-a2", "run-a", 2),
        ])
        .expect("append mixed-run batch");

    assert_eq!(
        committed
            .iter()
            .map(|fact| fact.ledger_sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(
        committed
            .iter()
            .map(|fact| fact.run_sequence)
            .collect::<Vec<_>>(),
        vec![1, 1, 2]
    );

    let duplicate = control_draft("duplicate", "run-a", 3);
    assert!(store
        .append_batch(vec![duplicate.clone(), duplicate])
        .is_err());
    assert_eq!(store.ledger_sequence_high_water().unwrap(), 3);

    let next = store
        .append(control_draft("fact-a3", "run-a", 3))
        .expect("append after rolled-back batch");
    assert_eq!(next.ledger_sequence, 4);
    assert_eq!(next.run_sequence, 3);
}

#[test]
fn v2_concurrent_append_allocates_unique_sequences() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    let participants = 64;
    let barrier = Arc::new(Barrier::new(participants));
    let mut handles = Vec::new();
    for index in 0..participants {
        let store = store.clone();
        let barrier = barrier.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            store
                .append(control_draft(
                    &format!("fact-{index}"),
                    &format!("run-{}", index % 4),
                    u64::try_from(index / 4 + 1).expect("epoch fits u64"),
                ))
                .expect("concurrent append")
        }));
    }

    let facts = handles
        .into_iter()
        .map(|handle| handle.join().expect("append thread"))
        .collect::<Vec<_>>();
    let ledger_sequences = facts
        .iter()
        .map(|fact| fact.ledger_sequence)
        .collect::<BTreeSet<_>>();
    assert_eq!(ledger_sequences.len(), participants);
    assert_eq!(
        ledger_sequences,
        (1..=u64::try_from(participants).unwrap()).collect()
    );

    let mut per_run = BTreeMap::<String, BTreeSet<u64>>::new();
    for fact in facts {
        per_run
            .entry(fact.identity.run_id.as_str().to_string())
            .or_default()
            .insert(fact.run_sequence);
    }
    assert_eq!(per_run.len(), 4);
    for sequences in per_run.values() {
        assert_eq!(sequences, &(1..=16).collect());
    }
}

#[test]
fn v2_identity_query_filters_are_exact_and_composable() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    store
        .append_batch(vec![
            effect_draft(
                "fact-1",
                EffectIdentity {
                    run_id: "run-1",
                    operation_id: "operation-1",
                    invocation_id: "invocation-1",
                    attempt_id: "attempt-1",
                    grant_id: "grant-1",
                    reservation_id: "reservation-1",
                    resource_id: "resource-1",
                    epoch: 1,
                },
            ),
            effect_draft(
                "fact-2",
                EffectIdentity {
                    run_id: "run-1",
                    operation_id: "operation-2",
                    invocation_id: "invocation-2",
                    attempt_id: "attempt-2",
                    grant_id: "grant-2",
                    reservation_id: "reservation-2",
                    resource_id: "resource-2",
                    epoch: 2,
                },
            ),
        ])
        .expect("append effect facts");

    let matched = store
        .query(&FactQueryV2 {
            run_id: Some("run-1".to_string()),
            operation_id: Some("operation-2".to_string()),
            invocation_id: Some("invocation-2".to_string()),
            attempt_id: Some("attempt-2".to_string()),
            capability_grant_id: Some("grant-2".to_string()),
            grant_reservation_id: Some("reservation-2".to_string()),
            causation_id: Some("cause-fact-2".to_string()),
            idempotency_key_hash: Some("hash-operation-2".to_string()),
            correlation_ref: Some(("source".to_string(), "source-operation-2".to_string())),
            control_epoch: Some(2),
            resource_id: Some("resource-2".to_string()),
            ..FactQueryV2::default()
        })
        .expect("query exact causal identity");
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].fact_id.as_str(), "fact-2");

    assert!(store
        .query(&FactQueryV2 {
            invocation_id: Some("invocation-2".to_string()),
            resource_id: Some("resource-1".to_string()),
            ..FactQueryV2::default()
        })
        .expect("query mismatched composition")
        .is_empty());
}

#[test]
fn v2_replay_rebuilds_indexes_without_rewriting_legacy_bytes() {
    let root = TestRoot::new("replay");
    let database = root.database();
    let legacy = root.path.join("ledger.ndjson");
    let legacy_bytes = b"{\"abiVersion\":\"deepcode.kernel.abi.v1\"}\n";
    fs::write(&legacy, legacy_bytes).expect("write legacy ledger");
    set_legacy_mode(&legacy, 0o640);
    let initial_mode = legacy_mode(&legacy);

    {
        let store = CanonicalFactStore::open(&database).expect("open file store");
        store
            .append_batch(vec![
                control_draft("fact-a1", "run-a", 1),
                control_draft("fact-a2", "run-a", 2),
                control_draft("fact-b1", "run-b", 1),
            ])
            .expect("append durable facts");
    }

    {
        let store = CanonicalFactStore::open(&database).expect("reopen file store");
        store
            .rebuild_materialized_state()
            .expect("rebuild materialized indexes");
        let snapshot = store.snapshot().expect("snapshot after replay");
        assert_eq!(snapshot.ledger_sequence_high_water, 3);
        assert_eq!(snapshot.facts.len(), 3);
        let high_waters = snapshot
            .run_sequence_high_water
            .into_iter()
            .map(|entry| {
                (
                    entry.run_id.as_str().to_string(),
                    entry.run_sequence_high_water,
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(high_waters.get("run-a"), Some(&2));
        assert_eq!(high_waters.get("run-b"), Some(&1));
    }

    assert_eq!(fs::read(&legacy).expect("read legacy ledger"), legacy_bytes);
    assert_eq!(legacy_mode(&legacy), initial_mode);
    root.cleanup();
}

#[test]
fn failed_append_is_not_visible_to_queries() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    let duplicate = control_draft("same-fact", "run-1", 1);
    assert!(store
        .append_batch(vec![duplicate.clone(), duplicate])
        .is_err());
    assert!(store
        .query(&FactQueryV2::default())
        .expect("query after rollback")
        .is_empty());
    assert!(store
        .pending_outbox(0, None)
        .expect("outbox after rollback")
        .is_empty());

    let committed = store
        .append(control_draft("first-visible", "run-1", 1))
        .expect("append after rollback");
    assert_eq!(committed.ledger_sequence, 1);
    assert_eq!(committed.run_sequence, 1);
}

#[test]
fn exact_outbox_ack_does_not_hide_an_earlier_failure() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    let facts = store
        .append_batch(vec![
            control_draft("fact-1", "run-1", 1),
            control_draft("fact-2", "run-1", 2),
        ])
        .expect("append outbox facts");
    store
        .record_outbox_publish_failure(facts[0].ledger_sequence, "transport unavailable")
        .expect("record publish failure");
    store
        .mark_outbox_published(facts[1].ledger_sequence, facts[1].fact_id.as_str())
        .expect("ack exact later fact");

    let pending = store.pending_outbox(0, None).expect("pending outbox");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].fact_id, "fact-1");
    assert_eq!(pending[0].publish_attempts, 1);
    assert_eq!(
        pending[0].last_error.as_deref(),
        Some("transport unavailable")
    );
    assert!(store
        .mark_outbox_published(facts[0].ledger_sequence, "wrong-fact")
        .is_err());
}

#[test]
fn file_store_uses_wal_and_the_frozen_schema_family() {
    let root = TestRoot::new("schema");
    let database = root.database();
    let store = CanonicalFactStore::open(&database).expect("open file store");
    store
        .append(control_draft("fact-1", "run-1", 1))
        .expect("append fact");

    let connection = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("open independent reader");
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("read journal mode");
    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    assert_private_database_mode(&database);
    let tables = connection
        .prepare(
            "SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .expect("prepare schema query")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query schema")
        .collect::<Result<BTreeSet<_>, _>>()
        .expect("collect schema");
    assert_eq!(
        tables,
        [
            "grant_state",
            "invocation_state",
            "kernel_facts",
            "outbox",
            "resource_state",
            "run_state",
            "schema_meta",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    );
    drop(connection);
    let mutator = rusqlite::Connection::open(&database).expect("open mutation probe");
    assert!(mutator
        .execute(
            "UPDATE kernel_facts SET fact_kind = 'tampered' WHERE fact_id = 'fact-1'",
            [],
        )
        .is_err());
    drop(mutator);
    drop(store);
    root.cleanup();
}

#[test]
fn schema_mismatch_fails_closed_without_an_in_memory_fallback() {
    let root = TestRoot::new("schema-mismatch");
    let database = root.database();
    {
        let connection = rusqlite::Connection::open(&database).expect("create incompatible DB");
        connection
            .execute_batch(
                "CREATE TABLE schema_meta (
                     key TEXT PRIMARY KEY NOT NULL,
                     value TEXT NOT NULL
                 ) WITHOUT ROWID;
                 INSERT INTO schema_meta (key, value)
                 VALUES ('schema_version', 'incompatible');",
            )
            .expect("write incompatible schema marker");
    }
    assert!(CanonicalFactStore::open(&database).is_err());
    let connection = rusqlite::Connection::open(&database).expect("reopen incompatible DB");
    let marker: String = connection
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .expect("read incompatible marker");
    assert_eq!(marker, "incompatible");
    drop(connection);
    root.cleanup();
}

#[cfg(unix)]
fn set_legacy_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set legacy mode");
}

#[cfg(not(unix))]
fn set_legacy_mode(_path: &Path, _mode: u32) {}

#[cfg(unix)]
fn legacy_mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .expect("legacy metadata")
        .permissions()
        .mode()
        & 0o777
}

#[cfg(not(unix))]
fn legacy_mode(_path: &Path) -> u32 {
    0
}

#[cfg(unix)]
fn assert_private_database_mode(path: &Path) {
    assert_eq!(legacy_mode(path), 0o600);
}

#[cfg(not(unix))]
fn assert_private_database_mode(_path: &Path) {}
