use deepcode_kernel_abi::v2::{
    CancelRequestId, CancellationIdentityV2, CancellationReasonCodeV2, CancellationSourceV2,
    ControlEpoch, ControlFactV2, FactId, InvocationId, KernelFactDraftV2, KernelFactPayloadV2,
    RunId,
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

    let committed = writer
        .append(control_draft("first-visible", "run-1", 1))
        .expect("append after rollback");
    assert_eq!(committed.ledger_sequence, 1);
    assert_eq!(committed.run_sequence, 1);
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
