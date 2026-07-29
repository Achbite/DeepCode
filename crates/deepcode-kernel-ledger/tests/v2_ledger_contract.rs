use deepcode_kernel_abi::v2::{
    CancelRequestId, CancellationIdentityV2, CancellationReasonCodeV2, CancellationSourceV2,
    CommandEpochContextV2, CommandReceiptIdentityV2, CommandRequestDigestV2, CommandRequestId,
    CommandRequestIdentityV2, ControlEpoch, ControlFactV2, FactId, InvocationId, KernelFactDraftV2,
    KernelFactEnvelopeV2, KernelFactPayloadV2, MutationCommandResultV2, OperationId, RunId,
    MAX_CROSS_LANGUAGE_SAFE_INTEGER_V2,
};
use deepcode_kernel_abi::v2_command::{
    KernelReplyV2, MutationCommandKindV2, ToolIntentRejectionReasonV2, ToolIntentSubmitReplyV2,
};
use deepcode_kernel_abi::KernelError;
use deepcode_kernel_ledger::v2::{CanonicalFactStore, FactQueryV2, PublicCommandReceiptV2};
use rusqlite::{params, Connection, OptionalExtension};
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

fn fact_id(value: impl Into<String>) -> FactId {
    FactId::new(value).expect("valid fact id")
}

fn run_id(value: impl Into<String>) -> RunId {
    RunId::new(value).expect("valid run id")
}

fn recover(store: &CanonicalFactStore) {
    let mut recovery = store
        .claim_recovery_admin()
        .expect("claim startup recovery");
    recovery
        .rebuild_materialized_state()
        .expect("complete startup recovery");
}

fn control_draft(fact: &str, run: &str, epoch: u64) -> KernelFactDraftV2 {
    KernelFactDraftV2 {
        fact_id: fact_id(fact),
        payload: KernelFactPayloadV2::Control(ControlFactV2::RunTransportRebound {
            run_id: run_id(run),
            control_epoch: ControlEpoch::new(epoch).expect("non-zero epoch"),
            transport_generation: epoch + 1,
            causation_fact_id: fact_id(format!("cause-{fact}")),
        }),
    }
}

fn seed_sequence_boundary(root: &TestRoot, run: &str, ledger_sequence: u64, run_sequence: u64) {
    let database = root.database();
    {
        let store = CanonicalFactStore::open(&database).expect("create boundary store");
        recover(&store);
        store
            .claim_authority_writer()
            .expect("claim boundary writer")
            .append(control_draft("fact-sequence-boundary", run, 1))
            .expect("seed boundary fact");
    }

    let mut connection = Connection::open(&database).expect("open boundary database");
    connection
        .pragma_update(None, "foreign_keys", false)
        .expect("disable foreign keys while rewriting the boundary fixture");
    let trigger_sql = connection
        .query_row(
            "SELECT sql FROM sqlite_schema
             WHERE type = 'trigger' AND name = 'kernel_facts_reject_update'",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("read append-only trigger");
    let encoded = connection
        .query_row(
            "SELECT envelope_json FROM kernel_facts
             WHERE fact_id = 'fact-sequence-boundary'",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("read boundary envelope");
    let mut envelope: KernelFactEnvelopeV2 =
        serde_json::from_str(&encoded).expect("decode boundary envelope");
    envelope.ledger_sequence = ledger_sequence;
    envelope.run_sequence = run_sequence;
    envelope.validate().expect("validate boundary envelope");
    let encoded = serde_json::to_string(&envelope).expect("encode boundary envelope");
    let ledger_sequence = i64::try_from(ledger_sequence).expect("ledger sequence fits SQLite");
    let run_sequence = i64::try_from(run_sequence).expect("run sequence fits SQLite");

    let transaction = connection.transaction().expect("begin boundary rewrite");
    transaction
        .execute_batch("DROP TRIGGER kernel_facts_reject_update")
        .expect("temporarily remove append-only update trigger");
    assert_eq!(
        transaction
            .execute(
                "UPDATE kernel_facts
                 SET ledger_sequence = ?1, run_sequence = ?2, envelope_json = ?3
                 WHERE fact_id = 'fact-sequence-boundary'",
                params![ledger_sequence, run_sequence, encoded],
            )
            .expect("rewrite boundary fact"),
        1
    );
    assert_eq!(
        transaction
            .execute(
                "UPDATE outbox
                 SET ledger_sequence = ?1, envelope_json = ?2
                 WHERE fact_id = 'fact-sequence-boundary'",
                params![ledger_sequence, encoded],
            )
            .expect("rewrite boundary outbox"),
        1
    );
    assert_eq!(
        transaction
            .execute(
                "UPDATE run_state
                 SET run_sequence_high_water = ?1,
                     last_ledger_sequence = ?2,
                     state_json = ?3
                 WHERE run_id = ?4",
                params![run_sequence, ledger_sequence, encoded, run],
            )
            .expect("rewrite boundary run state"),
        1
    );
    transaction
        .execute_batch(&trigger_sql)
        .expect("restore append-only update trigger");
    transaction.commit().expect("commit boundary rewrite");
    connection
        .pragma_update(None, "foreign_keys", true)
        .expect("restore foreign keys after rewriting the boundary fixture");
    let foreign_key_violation = connection
        .query_row("PRAGMA foreign_key_check", [], |_row| Ok(()))
        .optional()
        .expect("check boundary fixture foreign keys");
    assert!(
        foreign_key_violation.is_none(),
        "boundary fixture must not contain a foreign key violation"
    );
    let checkpoint = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .expect("checkpoint boundary fixture");
    assert_eq!(
        checkpoint,
        (0, 0, 0),
        "boundary fixture WAL must be fully checkpointed and truncated"
    );
}

fn durable_table_counts(path: &Path) -> BTreeMap<String, i64> {
    let connection = Connection::open(path).expect("open database for count audit");
    [
        "kernel_facts",
        "outbox",
        "run_state",
        "public_command_receipts",
        "authority_material",
    ]
    .into_iter()
    .map(|table| {
        let count = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("read durable table count");
        (table.to_owned(), count)
    })
    .collect()
}

fn assert_preflight_stage(error: KernelError, expected_stage: &'static str) {
    match error {
        KernelError::Structured { stage, .. } => {
            assert_eq!(stage, expected_stage);
        }
        other => panic!("unexpected sequence-boundary error: {other}"),
    }
}

fn assert_boundary_store_reopens(
    database: &Path,
    expected_ledger_sequence: u64,
    expected_run_sequence: u64,
) {
    let store = CanonicalFactStore::open(database).expect("reopen boundary store");
    recover(&store);
    let snapshot = store
        .reader()
        .snapshot()
        .expect("snapshot reopened boundary store");
    assert_eq!(
        snapshot.ledger_sequence_high_water,
        expected_ledger_sequence
    );
    assert_eq!(snapshot.facts.len(), 1);
    assert_eq!(snapshot.facts[0].ledger_sequence, expected_ledger_sequence);
    assert_eq!(snapshot.facts[0].run_sequence, expected_run_sequence);
    assert_eq!(snapshot.run_sequence_high_water.len(), 1);
    assert_eq!(
        snapshot.run_sequence_high_water[0].run_sequence_high_water,
        expected_run_sequence
    );
    let publisher = store
        .claim_outbox_publisher()
        .expect("claim reopened boundary publisher");
    let pending = publisher
        .pending(0, None)
        .expect("read reopened boundary outbox");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].ledger_sequence, expected_ledger_sequence);
}

fn cancellation_draft(fact: &str, run: &str, epoch: u64, invocation: &str) -> KernelFactDraftV2 {
    KernelFactDraftV2 {
        fact_id: fact_id(fact),
        payload: KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested {
            identity: CancellationIdentityV2 {
                run_id: run_id(run),
                control_epoch: ControlEpoch::new(epoch).expect("non-zero epoch"),
                invocation_id: InvocationId::new(invocation).expect("invocation id"),
                cancel_request_id: CancelRequestId::new(format!("cancel-{fact}"))
                    .expect("cancel request id"),
                causation_fact_id: fact_id(format!("cause-{fact}")),
            },
            source: CancellationSourceV2::ExplicitCommand,
            reason_code: CancellationReasonCodeV2::UserRequested,
            reason: None,
        }),
    }
}

#[test]
fn v2_append_batch_is_atomic_and_monotonic_per_run() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    recover(&store);
    let writer = store
        .claim_authority_writer()
        .expect("claim authority writer");
    let reader = store.reader();
    let committed = writer
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
    assert!(writer
        .append_batch(vec![duplicate.clone(), duplicate])
        .is_err());
    assert_eq!(reader.ledger_sequence_high_water().unwrap(), 3);

    let next = writer
        .append(control_draft("fact-a3", "run-a", 3))
        .expect("append after rolled-back batch");
    assert_eq!(next.ledger_sequence, 4);
    assert_eq!(next.run_sequence, 3);
}

#[test]
fn v2_concurrent_append_allocates_unique_sequences() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    recover(&store);
    let writer = Arc::new(
        store
            .claim_authority_writer()
            .expect("claim authority writer"),
    );
    let participants = 32;
    let barrier = Arc::new(Barrier::new(participants));
    let mut handles = Vec::new();
    for index in 0..participants {
        let writer = Arc::clone(&writer);
        let barrier = Arc::clone(&barrier);
        handles.push(thread::spawn(move || {
            barrier.wait();
            writer
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
            .entry(fact.payload.run_id().as_str().to_owned())
            .or_default()
            .insert(fact.run_sequence);
    }
    assert_eq!(per_run.len(), 4);
    for sequences in per_run.values() {
        assert_eq!(sequences, &(1..=8).collect());
    }
}

#[test]
fn v2_fact_query_filters_are_exact_and_composable() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    recover(&store);
    let writer = store
        .claim_authority_writer()
        .expect("claim authority writer");
    let reader = store.reader();
    writer
        .append_batch(vec![
            cancellation_draft("fact-1", "run-1", 1, "invocation-1"),
            cancellation_draft("fact-2", "run-1", 2, "invocation-2"),
        ])
        .expect("append cancellation facts");

    let matched = reader
        .query(&FactQueryV2 {
            run_id: Some("run-1".to_owned()),
            invocation_id: Some("invocation-2".to_owned()),
            causation_id: Some("cause-fact-2".to_owned()),
            control_epoch: Some(2),
            ..FactQueryV2::default()
        })
        .expect("query exact fact identity");
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].fact_id.as_str(), "fact-2");

    assert!(reader
        .query(&FactQueryV2 {
            invocation_id: Some("invocation-2".to_owned()),
            causation_id: Some("cause-fact-1".to_owned()),
            ..FactQueryV2::default()
        })
        .expect("query mismatched composition")
        .is_empty());
}

#[test]
fn v2_rebuild_ignores_and_preserves_unrelated_legacy_bytes() {
    let root = TestRoot::new("replay");
    let database = root.database();
    let legacy = root.path.join("ledger.ndjson");
    let legacy_bytes = b"{\"abiVersion\":\"deepcode.kernel.abi.v1\"}\n";
    fs::write(&legacy, legacy_bytes).expect("write unrelated legacy bytes");
    set_legacy_mode(&legacy, 0o640);
    let initial_mode = legacy_mode(&legacy);

    {
        let store = CanonicalFactStore::open(&database).expect("open file store");
        recover(&store);
        let writer = store
            .claim_authority_writer()
            .expect("claim authority writer");
        writer
            .append_batch(vec![
                control_draft("fact-a1", "run-a", 1),
                control_draft("fact-a2", "run-a", 2),
                control_draft("fact-b1", "run-b", 1),
            ])
            .expect("append durable facts");
    }

    {
        let store = CanonicalFactStore::open(&database).expect("reopen file store");
        recover(&store);
        let snapshot = store.reader().snapshot().expect("snapshot after rebuild");
        assert_eq!(snapshot.ledger_sequence_high_water, 3);
        assert_eq!(snapshot.facts.len(), 3);
        let high_waters = snapshot
            .run_sequence_high_water
            .into_iter()
            .map(|entry| {
                (
                    entry.run_id.as_str().to_owned(),
                    entry.run_sequence_high_water,
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(high_waters.get("run-a"), Some(&2));
        assert_eq!(high_waters.get("run-b"), Some(&1));
    }

    assert_eq!(fs::read(&legacy).expect("read legacy bytes"), legacy_bytes);
    assert_eq!(legacy_mode(&legacy), initial_mode);
    root.cleanup();
}

#[test]
fn failed_append_is_not_visible_to_queries_or_outbox() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    recover(&store);
    let writer = store
        .claim_authority_writer()
        .expect("claim authority writer");
    let publisher = store
        .claim_outbox_publisher()
        .expect("claim outbox publisher");
    let reader = store.reader();
    let duplicate = control_draft("same-fact", "run-1", 1);
    assert!(writer
        .append_batch(vec![duplicate.clone(), duplicate])
        .is_err());
    assert!(reader
        .query(&FactQueryV2::default())
        .expect("query after rollback")
        .is_empty());
    assert!(publisher
        .pending(0, None)
        .expect("outbox after rollback")
        .is_empty());

    let rejected_fact_id = fact_id("rejected-tool-intent");
    let rejected_run_id = run_id("run-rejected-tool-intent");
    let request_id =
        CommandRequestId::new("request-rejected-tool-intent").expect("request identity");
    let request_digest = CommandRequestDigestV2::parse(format!("sha256:{}", "1".repeat(64)))
        .expect("request digest");
    let rejection_reply = ToolIntentSubmitReplyV2::Rejected {
        run_id: rejected_run_id.clone(),
        operation_id: OperationId::new("operation-rejected-tool-intent")
            .expect("operation identity"),
        current_control_epoch: ControlEpoch::new(1).expect("control epoch"),
        reason: ToolIntentRejectionReasonV2::InvalidArguments,
        guidance: "Use valid arguments.".to_owned(),
        rejection_fact_id: rejected_fact_id.clone(),
        rejection_batch_high_water: 1,
    };
    let rejected_draft = KernelFactDraftV2 {
        fact_id: rejected_fact_id.clone(),
        payload: KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
            identity: CommandReceiptIdentityV2 {
                run_id: rejected_run_id.clone(),
                epoch_context: CommandEpochContextV2::Exact {
                    control_epoch: ControlEpoch::new(1).expect("control epoch"),
                },
                command_request_identity: CommandRequestIdentityV2 {
                    command_request_id: request_id.clone(),
                    command_request_digest: request_digest.clone(),
                },
            },
            command_kind: MutationCommandKindV2::ToolIntentSubmit,
            result: MutationCommandResultV2::ToolIntentSubmission {
                reply: rejection_reply.clone(),
            },
        }),
    };
    let mut wrong_kind_draft = rejected_draft.clone();
    let KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded { command_kind, .. }) =
        &mut wrong_kind_draft.payload
    else {
        unreachable!("constructed CommandRecorded draft")
    };
    *command_kind = MutationCommandKindV2::InvocationCancel;
    assert!(writer.append(wrong_kind_draft).is_err());

    let mut mismatched_reply = rejection_reply;
    let ToolIntentSubmitReplyV2::Rejected { operation_id, .. } = &mut mismatched_reply else {
        unreachable!("constructed rejected ToolIntent reply")
    };
    *operation_id = OperationId::new("different-operation").expect("operation identity");
    let mismatched_receipt = PublicCommandReceiptV2 {
        command_request_id: request_id,
        command_request_digest: request_digest,
        command_kind: "toolIntentSubmit".to_owned(),
        run_id: Some(rejected_run_id),
        reply_json: serde_json::json!({
            "kind": "kernel",
            "data": {
                "reply": KernelReplyV2::ToolIntentSubmission(mismatched_reply)
            }
        }),
        settlement_fact_id: Some(rejected_fact_id),
    };
    assert!(writer
        .append_with_public_command_receipt(vec![rejected_draft], mismatched_receipt)
        .is_err());
    assert!(reader
        .query(&FactQueryV2::default())
        .expect("facts after rejected receipt binding")
        .is_empty());
    assert!(publisher
        .pending(0, None)
        .expect("outbox after rejected receipt binding")
        .is_empty());

    let committed = writer
        .append(control_draft("first-visible", "run-1", 1))
        .expect("append after rollback");
    assert_eq!(committed.ledger_sequence, 1);
    assert_eq!(committed.run_sequence, 1);
}

#[test]
fn unsafe_public_number_append_is_atomically_rejected_before_persistence() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    recover(&store);
    let writer = store
        .claim_authority_writer()
        .expect("claim authority writer");
    let publisher = store
        .claim_outbox_publisher()
        .expect("claim outbox publisher");
    let reader = store.reader();
    let unsafe_draft = KernelFactDraftV2 {
        fact_id: fact_id("unsafe-public-number"),
        payload: KernelFactPayloadV2::Control(ControlFactV2::RunTransportRebound {
            run_id: run_id("run-unsafe-public-number"),
            control_epoch: ControlEpoch::new(1).expect("safe epoch"),
            transport_generation: MAX_CROSS_LANGUAGE_SAFE_INTEGER_V2 + 1,
            causation_fact_id: fact_id("cause-unsafe-public-number"),
        }),
    };

    assert!(writer.append(unsafe_draft).is_err());
    assert_eq!(
        reader
            .ledger_sequence_high_water()
            .expect("high-water after rejected append"),
        0
    );
    assert!(reader
        .query(&FactQueryV2::default())
        .expect("facts after rejected append")
        .is_empty());
    assert!(publisher
        .pending(0, None)
        .expect("outbox after rejected append")
        .is_empty());
}

#[test]
fn global_sequence_boundary_rejects_before_any_durable_insert() {
    let root = TestRoot::new("global-sequence-boundary");
    let database = root.database();
    seed_sequence_boundary(
        &root,
        "run-global-boundary",
        MAX_CROSS_LANGUAGE_SAFE_INTEGER_V2,
        1,
    );
    let counts_before = durable_table_counts(&database);

    {
        let store = CanonicalFactStore::open(&database).expect("open global boundary store");
        recover(&store);
        let writer = store
            .claim_authority_writer()
            .expect("claim global boundary writer");
        let reader = store.reader();
        let publisher = store
            .claim_outbox_publisher()
            .expect("claim global boundary publisher");

        let error = writer
            .append(control_draft(
                "fact-must-not-cross-global-boundary",
                "run-other",
                1,
            ))
            .expect_err("global sequence exhaustion must reject the append");
        assert_preflight_stage(error, "allocate_ledger_sequence");
        assert_eq!(
            reader
                .ledger_sequence_high_water()
                .expect("read global boundary high-water"),
            MAX_CROSS_LANGUAGE_SAFE_INTEGER_V2
        );
        assert_eq!(
            reader
                .query(&FactQueryV2::default())
                .expect("read facts after global rejection")
                .len(),
            1
        );
        assert_eq!(
            publisher
                .pending(0, None)
                .expect("read outbox after global rejection")
                .len(),
            1
        );
        assert_eq!(durable_table_counts(&database), counts_before);
    }

    assert_boundary_store_reopens(&database, MAX_CROSS_LANGUAGE_SAFE_INTEGER_V2, 1);
    root.cleanup();
}

#[test]
fn mixed_run_batch_rejects_atomically_when_one_run_sequence_is_exhausted() {
    let root = TestRoot::new("run-sequence-boundary");
    let database = root.database();
    seed_sequence_boundary(
        &root,
        "run-saturated",
        1,
        MAX_CROSS_LANGUAGE_SAFE_INTEGER_V2,
    );
    let counts_before = durable_table_counts(&database);

    {
        let store = CanonicalFactStore::open(&database).expect("open run boundary store");
        recover(&store);
        let writer = store
            .claim_authority_writer()
            .expect("claim run boundary writer");
        let reader = store.reader();
        let publisher = store
            .claim_outbox_publisher()
            .expect("claim run boundary publisher");

        let error = writer
            .append_batch(vec![
                control_draft("fact-safe-run-must-not-commit", "run-safe", 1),
                control_draft("fact-saturated-run-must-not-commit", "run-saturated", 2),
            ])
            .expect_err("per-run sequence exhaustion must reject the whole batch");
        assert_preflight_stage(error, "allocate_run_sequence");
        let facts = reader
            .query(&FactQueryV2::default())
            .expect("read facts after per-run rejection");
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].fact_id.as_str(), "fact-sequence-boundary");
        let high_waters = reader
            .run_sequence_high_waters()
            .expect("read per-run high-waters")
            .into_iter()
            .map(|entry| {
                (
                    entry.run_id.as_str().to_owned(),
                    entry.run_sequence_high_water,
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            high_waters.get("run-saturated"),
            Some(&MAX_CROSS_LANGUAGE_SAFE_INTEGER_V2)
        );
        assert!(!high_waters.contains_key("run-safe"));
        assert_eq!(
            publisher
                .pending(0, None)
                .expect("read outbox after per-run rejection")
                .len(),
            1
        );
        assert_eq!(durable_table_counts(&database), counts_before);
    }

    assert_boundary_store_reopens(&database, 1, MAX_CROSS_LANGUAGE_SAFE_INTEGER_V2);
    root.cleanup();
}

#[test]
fn exact_outbox_ack_does_not_hide_an_earlier_failure() {
    let store = CanonicalFactStore::open_in_memory().expect("open memory store");
    recover(&store);
    let writer = store
        .claim_authority_writer()
        .expect("claim authority writer");
    let publisher = store
        .claim_outbox_publisher()
        .expect("claim outbox publisher");
    let facts = writer
        .append_batch(vec![
            control_draft("fact-1", "run-1", 1),
            control_draft("fact-2", "run-1", 2),
        ])
        .expect("append outbox facts");
    publisher
        .record_publish_failure(facts[0].ledger_sequence, "transport unavailable")
        .expect("record publish failure");
    publisher
        .mark_published(facts[1].ledger_sequence, facts[1].fact_id.as_str())
        .expect("ack exact later fact");

    let pending = publisher.pending(0, None).expect("pending outbox");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].fact_id, "fact-1");
    assert_eq!(pending[0].publish_attempts, 1);
    assert_eq!(
        pending[0].last_error.as_deref(),
        Some("transport unavailable")
    );
    assert!(publisher
        .mark_published(facts[0].ledger_sequence, "wrong-fact")
        .is_err());
}

#[test]
fn file_store_uses_wal_and_the_frozen_schema_family() {
    let root = TestRoot::new("schema");
    let database = root.database();
    let store = CanonicalFactStore::open(&database).expect("open file store");
    recover(&store);
    let writer = store
        .claim_authority_writer()
        .expect("claim authority writer");
    writer
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
            "authority_material",
            "fact_query_continuation_consumptions",
            "fact_query_continuations",
            "invocation_state",
            "kernel_facts",
            "outbox",
            "public_command_receipts",
            "resource_state",
            "run_state",
            "schema_meta",
        ]
        .into_iter()
        .map(str::to_owned)
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
    drop(writer);
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
