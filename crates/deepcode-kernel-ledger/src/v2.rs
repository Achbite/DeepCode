use deepcode_kernel_abi::v2::{
    KernelFactDraftV2, KernelFactEnvelopeV2, KernelFactPayloadV2, RunId,
};
use deepcode_kernel_abi::KERNEL_ABI_V2_VERSION;
use deepcode_kernel_abi::{KernelError, KernelResult};
use rusqlite::types::Value as SqlValue;
use rusqlite::{
    params, params_from_iter, Connection, OpenFlags, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const SCHEMA_VERSION: &str = "1";
const SCHEMA_CONTRACT: &str = "deepcode.kernel.fact-store.v2.sqlite.1";
const WRITER_QUEUE_CAPACITY: usize = 256;
const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);
const WRITER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OUTBOX_LIMIT: u32 = 1_000;
static MEMORY_DATABASE_ID: AtomicU64 = AtomicU64::new(1);

pub const FACT_STORE_PATH_ENV: &str = "DEEPCODE_KERNEL_FACT_STORE_PATH";

pub fn configured_fact_store_path(config_root: impl AsRef<Path>) -> KernelResult<PathBuf> {
    match std::env::var_os(FACT_STORE_PATH_ENV) {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        Some(_) => Err(store_error_message(
            "resolve_database_path",
            format!("{FACT_STORE_PATH_ENV} must not be empty when set"),
        )),
        None => Ok(config_root
            .as_ref()
            .join("kernel")
            .join("kernel-v2.sqlite3")),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FactQueryV2 {
    pub fact_id: Option<String>,
    pub run_id: Option<String>,
    pub operation_id: Option<String>,
    pub invocation_id: Option<String>,
    pub attempt_id: Option<String>,
    pub capability_grant_id: Option<String>,
    pub grant_reservation_id: Option<String>,
    pub causation_id: Option<String>,
    pub idempotency_key_hash: Option<String>,
    pub correlation_ref: Option<(String, String)>,
    pub control_epoch: Option<u64>,
    pub resource_id: Option<String>,
    pub after_ledger_sequence: Option<u64>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunSequenceHighWater {
    pub run_id: RunId,
    pub run_sequence_high_water: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FactStoreSnapshotV2 {
    pub abi_version: String,
    pub ledger_sequence_high_water: u64,
    pub run_sequence_high_water: Vec<RunSequenceHighWater>,
    pub facts: Vec<KernelFactEnvelopeV2>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutboxFactV2 {
    pub ledger_sequence: u64,
    pub fact_id: String,
    pub envelope: KernelFactEnvelopeV2,
    pub publish_attempts: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
enum DatabaseTarget {
    File(PathBuf),
    SharedMemory(String),
}

impl DatabaseTarget {
    fn writer_connection(&self) -> KernelResult<Connection> {
        match self {
            Self::File(path) => Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| store_error("open_writer", error)),
            Self::SharedMemory(uri) => Connection::open_with_flags(
                uri,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| store_error("open_memory_writer", error)),
        }
    }

    fn query_connection(&self) -> KernelResult<Connection> {
        let connection = match self {
            Self::File(path) => Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| store_error("open_query", error))?,
            // A named shared-cache memory database cannot be opened with SQLite's
            // READ_ONLY flag. query_only makes this independent connection
            // application-read-only while the writer connection keeps the database alive.
            Self::SharedMemory(uri) => Connection::open_with_flags(
                uri,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| store_error("open_memory_query", error))?,
        };
        connection
            .busy_timeout(BUSY_TIMEOUT)
            .map_err(|error| store_error("configure_query_timeout", error))?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(|error| store_error("configure_query_foreign_keys", error))?;
        connection
            .pragma_update(None, "query_only", true)
            .map_err(|error| store_error("configure_query_only", error))?;
        Ok(connection)
    }

    fn is_memory(&self) -> bool {
        matches!(self, Self::SharedMemory(_))
    }
}

enum WriterCommand {
    Append {
        drafts: Vec<KernelFactDraftV2>,
        response: mpsc::Sender<KernelResult<Vec<KernelFactEnvelopeV2>>>,
    },
    MarkPublished {
        ledger_sequence: u64,
        fact_id: String,
        response: mpsc::Sender<KernelResult<()>>,
    },
    RecordPublishFailure {
        ledger_sequence: u64,
        error: String,
        response: mpsc::Sender<KernelResult<()>>,
    },
    RebuildMaterializedState {
        response: mpsc::Sender<KernelResult<()>>,
    },
}

struct StoreInner {
    target: DatabaseTarget,
    faulted: AtomicBool,
    sender: Mutex<Option<SyncSender<WriterCommand>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for StoreInner {
    fn drop(&mut self) {
        let sender = self
            .sender
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sender.take();
        let writer = self
            .writer
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(writer) = writer.take() {
            let _ = writer.join();
        }
    }
}

/// SQLite-backed canonical v2 fact store.
///
/// The writer connection is created and remains owned by one dedicated thread.
/// Callers submit bounded commands; reads use fresh, independent query-only
/// connections and therefore never share a `rusqlite::Connection` across threads.
#[derive(Clone)]
pub struct CanonicalFactStore {
    inner: Arc<StoreInner>,
}

impl std::fmt::Debug for CanonicalFactStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CanonicalFactStore")
            .field("target", &self.inner.target)
            .finish_non_exhaustive()
    }
}

impl CanonicalFactStore {
    pub fn open_configured(config_root: impl AsRef<Path>) -> KernelResult<Self> {
        Self::open(configured_fact_store_path(config_root)?)
    }

    pub fn open(path: impl AsRef<Path>) -> KernelResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                store_error_message("create_database_directory", error.to_string())
            })?;
        }
        let created = create_private_database_file_if_absent(&path)?;
        match Self::start(DatabaseTarget::File(path.clone())) {
            Ok(store) => Ok(store),
            Err(error) => {
                if created {
                    cleanup_failed_database(&path)?;
                }
                Err(error)
            }
        }
    }

    /// Opens a named shared-cache in-memory database.
    ///
    /// SQLite cannot use WAL for an in-memory database. This constructor is only
    /// for isolated unit tests; restart, WAL and durability tests must use `open`
    /// with a temporary file.
    pub fn open_in_memory() -> KernelResult<Self> {
        let id = MEMORY_DATABASE_ID.fetch_add(1, Ordering::Relaxed);
        let uri = format!(
            "file:deepcode-kernel-v2-{}-{id}?mode=memory&cache=shared",
            std::process::id()
        );
        Self::start(DatabaseTarget::SharedMemory(uri))
    }

    fn start(target: DatabaseTarget) -> KernelResult<Self> {
        let (sender, receiver) = mpsc::sync_channel(WRITER_QUEUE_CAPACITY);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let writer_target = target.clone();
        let writer = thread::Builder::new()
            .name("deepcode-kernel-fact-writer".to_string())
            .spawn(move || writer_main(writer_target, receiver, ready_sender))
            .map_err(|error| store_error_message("spawn_writer", error.to_string()))?;

        match ready_receiver.recv_timeout(WRITER_RESPONSE_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                inner: Arc::new(StoreInner {
                    target,
                    faulted: AtomicBool::new(false),
                    sender: Mutex::new(Some(sender)),
                    writer: Mutex::new(Some(writer)),
                }),
            }),
            Ok(Err(error)) => {
                drop(sender);
                let _ = writer.join();
                Err(error)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                drop(sender);
                let _ = writer.join();
                Err(store_error_message(
                    "initialize_writer",
                    format!(
                        "writer did not initialize within {}ms",
                        WRITER_RESPONSE_TIMEOUT.as_millis()
                    ),
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                drop(sender);
                let _ = writer.join();
                Err(store_error_message(
                    "initialize_writer",
                    "writer stopped before initialization acknowledgement",
                ))
            }
        }
    }

    pub fn append(&self, draft: KernelFactDraftV2) -> KernelResult<KernelFactEnvelopeV2> {
        let mut facts = self.append_batch(vec![draft])?;
        facts.pop().ok_or_else(|| {
            store_error_message(
                "append",
                "writer committed an empty result for a non-empty append",
            )
        })
    }

    pub fn append_batch(
        &self,
        drafts: Vec<KernelFactDraftV2>,
    ) -> KernelResult<Vec<KernelFactEnvelopeV2>> {
        if drafts.is_empty() {
            return Ok(Vec::new());
        }
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::Append { drafts, response })?;
        receive_response("append_batch", receiver, &self.inner.faulted)
    }

    pub fn query(&self, filter: &FactQueryV2) -> KernelResult<Vec<KernelFactEnvelopeV2>> {
        if filter.limit == Some(0) {
            return Err(store_error_message(
                "query",
                "query limit must be greater than zero",
            ));
        }
        let connection = self.inner.target.query_connection()?;
        query_facts(&connection, filter)
    }

    pub fn get_by_fact_id(&self, fact_id: &str) -> KernelResult<Option<KernelFactEnvelopeV2>> {
        let connection = self.inner.target.query_connection()?;
        let encoded = connection
            .query_row(
                "SELECT envelope_json FROM kernel_facts WHERE fact_id = ?1",
                params![fact_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| store_error("query_fact_id", error))?;
        encoded
            .map(|encoded| decode_envelope(&encoded, "query_fact_id"))
            .transpose()
    }

    pub fn snapshot(&self) -> KernelResult<FactStoreSnapshotV2> {
        let mut connection = self.inner.target.query_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|error| store_error("begin_snapshot", error))?;
        let ledger_sequence_high_water = high_water_with_connection(&transaction)?;
        let run_sequence_high_water = run_high_waters_with_connection(&transaction)?;
        let facts = query_facts(&transaction, &FactQueryV2::default())?;
        transaction
            .commit()
            .map_err(|error| store_error("commit_snapshot", error))?;
        Ok(FactStoreSnapshotV2 {
            abi_version: KERNEL_ABI_V2_VERSION.to_string(),
            ledger_sequence_high_water,
            run_sequence_high_water,
            facts,
        })
    }

    pub fn ledger_sequence_high_water(&self) -> KernelResult<u64> {
        let connection = self.inner.target.query_connection()?;
        high_water_with_connection(&connection)
    }

    pub fn run_sequence_high_waters(&self) -> KernelResult<Vec<RunSequenceHighWater>> {
        let connection = self.inner.target.query_connection()?;
        run_high_waters_with_connection(&connection)
    }

    pub fn pending_outbox(
        &self,
        after_ledger_sequence: u64,
        limit: Option<u32>,
    ) -> KernelResult<Vec<OutboxFactV2>> {
        let limit = limit.unwrap_or(DEFAULT_OUTBOX_LIMIT);
        if limit == 0 {
            return Err(store_error_message(
                "query_outbox",
                "outbox limit must be greater than zero",
            ));
        }
        let connection = self.inner.target.query_connection()?;
        let mut statement = connection
            .prepare(
                "SELECT ledger_sequence, fact_id, envelope_json, publish_attempts, last_error
                 FROM outbox
                 WHERE published_at IS NULL AND ledger_sequence > ?1
                 ORDER BY ledger_sequence
                 LIMIT ?2",
            )
            .map_err(|error| store_error("prepare_outbox_query", error))?;
        let rows = statement
            .query_map(
                params![
                    sqlite_integer(after_ledger_sequence, "afterLedgerSequence")?,
                    i64::from(limit)
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .map_err(|error| store_error("query_outbox", error))?;
        let mut entries = Vec::new();
        for row in rows {
            let (sequence, fact_id, encoded, publish_attempts, last_error) =
                row.map_err(|error| store_error("read_outbox", error))?;
            entries.push(OutboxFactV2 {
                ledger_sequence: sqlite_u64(sequence, "ledgerSequence")?,
                fact_id,
                envelope: decode_envelope(&encoded, "decode_outbox")?,
                publish_attempts: sqlite_u64(publish_attempts, "publishAttempts")?,
                last_error,
            });
        }
        Ok(entries)
    }

    pub fn mark_outbox_published(
        &self,
        ledger_sequence: u64,
        fact_id: impl Into<String>,
    ) -> KernelResult<()> {
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::MarkPublished {
            ledger_sequence,
            fact_id: fact_id.into(),
            response,
        })?;
        receive_response("mark_outbox_published", receiver, &self.inner.faulted)
    }

    pub fn record_outbox_publish_failure(
        &self,
        ledger_sequence: u64,
        error: impl Into<String>,
    ) -> KernelResult<()> {
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::RecordPublishFailure {
            ledger_sequence,
            error: error.into(),
            response,
        })?;
        receive_response(
            "record_outbox_publish_failure",
            receiver,
            &self.inner.faulted,
        )
    }

    pub fn rebuild_materialized_state(&self) -> KernelResult<()> {
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::RebuildMaterializedState { response })?;
        receive_response("rebuild_materialized_state", receiver, &self.inner.faulted)
    }

    fn send(&self, command: WriterCommand) -> KernelResult<()> {
        if self.inner.faulted.load(Ordering::Acquire) {
            return Err(store_error_message(
                "writer_faulted",
                "fact writer previously failed to acknowledge a command; reopen and reconcile",
            ));
        }
        let sender = self
            .inner
            .sender
            .lock()
            .map_err(|_| store_error_message("writer_queue", "writer queue lock poisoned"))?
            .as_ref()
            .cloned()
            .ok_or_else(|| store_error_message("writer_queue", "fact writer is closed"))?;
        match sender.try_send(command) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(store_error_message(
                "writer_queue_full",
                "fact writer queue reached its bounded capacity",
            )),
            Err(TrySendError::Disconnected(_)) => Err(store_error_message(
                "writer_queue_disconnected",
                "fact writer stopped",
            )),
        }
    }
}

fn receive_response<T>(
    stage: &'static str,
    receiver: mpsc::Receiver<KernelResult<T>>,
    faulted: &AtomicBool,
) -> KernelResult<T> {
    match receiver.recv_timeout(WRITER_RESPONSE_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            faulted.store(true, Ordering::Release);
            // The writer may still commit after the caller's wait expires. The
            // store is therefore poisoned for new writes until reopen/reconcile;
            // fact_id uniqueness makes an exact retry observable instead of
            // silently duplicating the canonical fact.
            Err(store_error_message(
                stage,
                format!(
                    "fact writer did not reply within {}ms; write outcome requires reconciliation",
                    WRITER_RESPONSE_TIMEOUT.as_millis()
                ),
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            faulted.store(true, Ordering::Release);
            Err(store_error_message(
                stage,
                "fact writer stopped before replying; write outcome requires reconciliation",
            ))
        }
    }
}

fn writer_main(
    target: DatabaseTarget,
    receiver: Receiver<WriterCommand>,
    ready: SyncSender<KernelResult<()>>,
) {
    let mut connection = match target.writer_connection() {
        Ok(connection) => connection,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if let Err(error) = initialize_database(&mut connection, target.is_memory()) {
        let _ = ready.send(Err(error));
        return;
    }
    if ready.send(Ok(())).is_err() {
        return;
    }

    while let Ok(command) = receiver.recv() {
        match command {
            WriterCommand::Append { drafts, response } => {
                let _ = response.send(append_batch_transaction(&mut connection, drafts));
            }
            WriterCommand::MarkPublished {
                ledger_sequence,
                fact_id,
                response,
            } => {
                let result =
                    sqlite_integer(ledger_sequence, "ledgerSequence").and_then(|sequence| {
                        let changed = connection
                            .execute(
                                "UPDATE outbox
                             SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                                 last_error = NULL
                             WHERE published_at IS NULL
                               AND ledger_sequence = ?1
                               AND fact_id = ?2",
                                params![sequence, fact_id],
                            )
                            .map_err(|error| store_error("mark_outbox_published", error))?;
                        if changed != 1 {
                            return Err(store_error_message(
                                "mark_outbox_published",
                                "exact pending outbox identity does not exist",
                            ));
                        }
                        Ok(())
                    });
                let _ = response.send(result);
            }
            WriterCommand::RecordPublishFailure {
                ledger_sequence,
                error,
                response,
            } => {
                let result =
                    sqlite_integer(ledger_sequence, "ledgerSequence").and_then(|sequence| {
                        let changed = connection
                            .execute(
                                "UPDATE outbox
                             SET publish_attempts = publish_attempts + 1, last_error = ?2
                             WHERE ledger_sequence = ?1 AND published_at IS NULL",
                                params![sequence, error],
                            )
                            .map_err(|sqlite_error| {
                                store_error("record_outbox_publish_failure", sqlite_error)
                            })?;
                        if changed != 1 {
                            return Err(store_error_message(
                                "record_outbox_publish_failure",
                                "pending outbox entry does not exist",
                            ));
                        }
                        Ok(())
                    });
                let _ = response.send(result);
            }
            WriterCommand::RebuildMaterializedState { response } => {
                let _ = response.send(rebuild_materialized_state_transaction(&mut connection));
            }
        }
    }
}

fn initialize_database(connection: &mut Connection, is_memory: bool) -> KernelResult<()> {
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| store_error("configure_busy_timeout", error))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| store_error("configure_foreign_keys", error))?;

    let requested_mode = if is_memory { "MEMORY" } else { "WAL" };
    connection
        .pragma_update(None, "journal_mode", requested_mode)
        .map_err(|error| store_error("configure_journal_mode", error))?;
    let journal_mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|error| store_error("read_journal_mode", error))?;
    if !journal_mode.eq_ignore_ascii_case(requested_mode) {
        return Err(store_error_message(
            "configure_journal_mode",
            format!("expected {requested_mode}, SQLite selected {journal_mode}"),
        ));
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| store_error("configure_synchronous", error))?;
    let synchronous: i64 = connection
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(|error| store_error("read_synchronous", error))?;
    if synchronous != 2 {
        return Err(store_error_message(
            "configure_synchronous",
            format!("expected synchronous=FULL (2), SQLite selected {synchronous}"),
        ));
    }
    let foreign_keys: i64 = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(|error| store_error("read_foreign_keys", error))?;
    if foreign_keys != 1 {
        return Err(store_error_message(
            "configure_foreign_keys",
            format!("expected foreign_keys=ON (1), SQLite selected {foreign_keys}"),
        ));
    }
    let busy_timeout: i64 = connection
        .pragma_query_value(None, "busy_timeout", |row| row.get(0))
        .map_err(|error| store_error("read_busy_timeout", error))?;
    if busy_timeout != i64::try_from(BUSY_TIMEOUT.as_millis()).unwrap_or(i64::MAX) {
        return Err(store_error_message(
            "configure_busy_timeout",
            format!(
                "expected busy_timeout={}ms, SQLite selected {busy_timeout}ms",
                BUSY_TIMEOUT.as_millis()
            ),
        ));
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| store_error("begin_schema_initialization", error))?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_meta (
                 key TEXT PRIMARY KEY NOT NULL,
                 value TEXT NOT NULL
             ) WITHOUT ROWID;

             CREATE TABLE IF NOT EXISTS kernel_facts (
                 ledger_sequence INTEGER PRIMARY KEY NOT NULL,
                 run_id TEXT NOT NULL,
                 run_sequence INTEGER NOT NULL,
                 fact_id TEXT NOT NULL UNIQUE,
                 operation_id TEXT,
                 invocation_id TEXT,
                 attempt_id TEXT,
                 capability_grant_id TEXT,
                 grant_reservation_id TEXT,
                 causation_id TEXT,
                 idempotency_key_hash TEXT,
                 correlation_refs_json TEXT NOT NULL,
                 control_epoch INTEGER NOT NULL,
                 resource_ids_json TEXT NOT NULL,
                 fact_kind TEXT NOT NULL,
                 occurred_at TEXT NOT NULL,
                 envelope_json TEXT NOT NULL,
                 UNIQUE (run_id, run_sequence)
             );

             CREATE INDEX IF NOT EXISTS kernel_facts_run
                 ON kernel_facts (run_id, run_sequence);
             CREATE INDEX IF NOT EXISTS kernel_facts_operation
                 ON kernel_facts (operation_id, ledger_sequence);
             CREATE INDEX IF NOT EXISTS kernel_facts_invocation
                 ON kernel_facts (invocation_id, ledger_sequence);
             CREATE INDEX IF NOT EXISTS kernel_facts_attempt
                 ON kernel_facts (attempt_id, ledger_sequence);
             CREATE INDEX IF NOT EXISTS kernel_facts_grant
                 ON kernel_facts (capability_grant_id, ledger_sequence);
             CREATE INDEX IF NOT EXISTS kernel_facts_reservation
                 ON kernel_facts (grant_reservation_id, ledger_sequence);
             CREATE INDEX IF NOT EXISTS kernel_facts_causation
                 ON kernel_facts (causation_id, ledger_sequence);
             CREATE TRIGGER IF NOT EXISTS kernel_facts_reject_update
             BEFORE UPDATE ON kernel_facts
             BEGIN
                 SELECT RAISE(ABORT, 'kernel_facts is append-only');
             END;
             CREATE TRIGGER IF NOT EXISTS kernel_facts_reject_delete
             BEFORE DELETE ON kernel_facts
             BEGIN
                 SELECT RAISE(ABORT, 'kernel_facts is append-only');
             END;

             CREATE TABLE IF NOT EXISTS run_state (
                 run_id TEXT PRIMARY KEY NOT NULL,
                 run_sequence_high_water INTEGER NOT NULL,
                 control_epoch INTEGER NOT NULL,
                 last_ledger_sequence INTEGER NOT NULL,
                 state_json TEXT NOT NULL
             ) WITHOUT ROWID;

             CREATE TABLE IF NOT EXISTS grant_state (
                 grant_id TEXT PRIMARY KEY NOT NULL,
                 run_id TEXT NOT NULL,
                 observed_use_count INTEGER NOT NULL,
                 status TEXT NOT NULL,
                 last_ledger_sequence INTEGER NOT NULL,
                 state_json TEXT NOT NULL
             ) WITHOUT ROWID;

             CREATE TABLE IF NOT EXISTS invocation_state (
                 invocation_id TEXT PRIMARY KEY NOT NULL,
                 run_id TEXT NOT NULL,
                 status TEXT NOT NULL,
                 last_ledger_sequence INTEGER NOT NULL,
                 state_json TEXT NOT NULL
             ) WITHOUT ROWID;

             CREATE TABLE IF NOT EXISTS resource_state (
                 resource_id TEXT PRIMARY KEY NOT NULL,
                 run_id TEXT NOT NULL,
                 status TEXT NOT NULL,
                 last_ledger_sequence INTEGER NOT NULL,
                 state_json TEXT NOT NULL
             ) WITHOUT ROWID;

             CREATE TABLE IF NOT EXISTS outbox (
                 ledger_sequence INTEGER PRIMARY KEY NOT NULL
                     REFERENCES kernel_facts (ledger_sequence) ON DELETE RESTRICT,
                 fact_id TEXT NOT NULL UNIQUE,
                 envelope_json TEXT NOT NULL,
                 published_at TEXT,
                 publish_attempts INTEGER NOT NULL DEFAULT 0,
                 last_error TEXT
             ) WITHOUT ROWID;",
        )
        .map_err(|error| store_error("create_schema", error))?;

    initialize_or_validate_meta(&transaction, "schema_version", SCHEMA_VERSION)?;
    initialize_or_validate_meta(&transaction, "schema_contract", SCHEMA_CONTRACT)?;
    initialize_or_validate_meta(&transaction, "abi_version", KERNEL_ABI_V2_VERSION)?;
    validate_schema_contract(&transaction)?;
    transaction
        .commit()
        .map_err(|error| store_error("commit_schema_initialization", error))?;

    let integrity: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| store_error("integrity_check", error))?;
    if integrity != "ok" {
        return Err(store_error_message(
            "integrity_check",
            format!("SQLite quick_check failed: {integrity}"),
        ));
    }
    rebuild_materialized_state_transaction(connection)
}

fn initialize_or_validate_meta(
    connection: &Connection,
    key: &str,
    expected: &str,
) -> KernelResult<()> {
    let existing = connection
        .query_row(
            "SELECT value FROM schema_meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| store_error("read_schema_meta", error))?;
    match existing {
        Some(existing) if existing == expected => Ok(()),
        Some(existing) => Err(store_error_message(
            "validate_schema_meta",
            format!("unsupported {key}: expected {expected}, found {existing}"),
        )),
        None => {
            connection
                .execute(
                    "INSERT INTO schema_meta (key, value) VALUES (?1, ?2)",
                    params![key, expected],
                )
                .map_err(|error| store_error("write_schema_meta", error))?;
            Ok(())
        }
    }
}

fn validate_schema_contract(connection: &Connection) -> KernelResult<()> {
    let required_queries = [
        "SELECT key, value FROM schema_meta LIMIT 0",
        "SELECT ledger_sequence, run_id, run_sequence, fact_id, operation_id,
                invocation_id, attempt_id, capability_grant_id, grant_reservation_id,
                causation_id, idempotency_key_hash, correlation_refs_json, control_epoch,
                resource_ids_json, fact_kind, occurred_at, envelope_json
         FROM kernel_facts LIMIT 0",
        "SELECT run_id, run_sequence_high_water, control_epoch,
                last_ledger_sequence, state_json
         FROM run_state LIMIT 0",
        "SELECT grant_id, run_id, observed_use_count, status,
                last_ledger_sequence, state_json
         FROM grant_state LIMIT 0",
        "SELECT invocation_id, run_id, status, last_ledger_sequence, state_json
         FROM invocation_state LIMIT 0",
        "SELECT resource_id, run_id, status, last_ledger_sequence, state_json
         FROM resource_state LIMIT 0",
        "SELECT ledger_sequence, fact_id, envelope_json, published_at,
                publish_attempts, last_error
         FROM outbox LIMIT 0",
    ];
    for query in required_queries {
        connection
            .prepare(query)
            .map_err(|error| store_error("validate_schema_contract", error))?;
    }
    for trigger in ["kernel_facts_reject_update", "kernel_facts_reject_delete"] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name = ?1",
                params![trigger],
                |row| row.get(0),
            )
            .map_err(|error| store_error("validate_append_only_trigger", error))?;
        if exists != 1 {
            return Err(store_error_message(
                "validate_append_only_trigger",
                format!("required append-only trigger {trigger} is missing"),
            ));
        }
    }

    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| store_error("prepare_foreign_key_check", error))?;
    let mut rows = statement
        .query([])
        .map_err(|error| store_error("foreign_key_check", error))?;
    if rows
        .next()
        .map_err(|error| store_error("read_foreign_key_check", error))?
        .is_some()
    {
        return Err(store_error_message(
            "foreign_key_check",
            "canonical schema contains a foreign key violation",
        ));
    }
    Ok(())
}

fn append_batch_transaction(
    connection: &mut Connection,
    drafts: Vec<KernelFactDraftV2>,
) -> KernelResult<Vec<KernelFactEnvelopeV2>> {
    for draft in &drafts {
        draft
            .validate()
            .map_err(|error| invalid_fact_error("validate_fact_draft", error.to_string()))?;
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| store_error("begin_append", error))?;
    let global_high_water = transaction
        .query_row(
            "SELECT COALESCE(MAX(ledger_sequence), 0) FROM kernel_facts",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| store_error("read_ledger_high_water", error))?;
    let mut next_ledger_sequence = sqlite_u64(global_high_water, "ledgerSequence")?;
    let mut run_high_waters = BTreeMap::<String, u64>::new();
    let mut envelopes = Vec::with_capacity(drafts.len());

    for draft in drafts {
        let run_id = draft.identity.run_id.as_str().to_string();
        let run_high_water = match run_high_waters.get(&run_id) {
            Some(high_water) => *high_water,
            None => {
                let high_water = transaction
                    .query_row(
                        "SELECT run_sequence_high_water FROM run_state WHERE run_id = ?1",
                        params![run_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(|error| store_error("read_run_high_water", error))?
                    .map(|value| sqlite_u64(value, "runSequence"))
                    .transpose()?
                    .unwrap_or(0);
                run_high_waters.insert(run_id.clone(), high_water);
                high_water
            }
        };
        next_ledger_sequence = next_ledger_sequence.checked_add(1).ok_or_else(|| {
            store_error_message("allocate_ledger_sequence", "ledger sequence overflow")
        })?;
        let run_sequence = run_high_water
            .checked_add(1)
            .ok_or_else(|| store_error_message("allocate_run_sequence", "run sequence overflow"))?;
        let envelope = draft
            .with_sequences(next_ledger_sequence, run_sequence)
            .map_err(|error| invalid_fact_error("assign_fact_sequences", error.to_string()))?;
        persist_envelope(&transaction, &envelope)?;
        run_high_waters.insert(run_id, run_sequence);
        envelopes.push(envelope);
    }

    transaction
        .commit()
        .map_err(|error| store_error("commit_append", error))?;
    Ok(envelopes)
}

fn persist_envelope(
    transaction: &Transaction<'_>,
    envelope: &KernelFactEnvelopeV2,
) -> KernelResult<()> {
    envelope
        .validate()
        .map_err(|error| invalid_fact_error("validate_fact_envelope", error.to_string()))?;
    let encoded = serde_json::to_string(envelope)
        .map_err(|error| store_error_message("encode_fact_envelope", error.to_string()))?;
    let resource_ids_json = serde_json::to_string(&resource_ids(envelope))
        .map_err(|error| store_error_message("encode_resource_ids", error.to_string()))?;
    let identity = &envelope.identity;
    let correlation_refs_json = serde_json::to_string(&identity.correlation_refs)
        .map_err(|error| store_error_message("encode_correlation_refs", error.to_string()))?;
    transaction
        .execute(
            "INSERT INTO kernel_facts (
                 ledger_sequence, run_id, run_sequence, fact_id, operation_id,
                 invocation_id, attempt_id, capability_grant_id, grant_reservation_id,
                 causation_id, idempotency_key_hash, correlation_refs_json, control_epoch,
                 resource_ids_json, fact_kind, occurred_at, envelope_json
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17
             )",
            params![
                sqlite_integer(envelope.ledger_sequence, "ledgerSequence")?,
                envelope.identity.run_id.as_str(),
                sqlite_integer(envelope.run_sequence, "runSequence")?,
                envelope.fact_id.as_str(),
                identity.operation_id.as_ref().map(|id| id.as_str()),
                identity.invocation_id.as_ref().map(|id| id.as_str()),
                identity.attempt_id.as_ref().map(|id| id.as_str()),
                identity.capability_grant_id.as_ref().map(|id| id.as_str()),
                identity.grant_reservation_id.as_ref().map(|id| id.as_str()),
                identity.causation_id.as_ref().map(|id| id.as_str()),
                identity.idempotency_key_hash.as_deref(),
                correlation_refs_json,
                sqlite_integer(identity.control_epoch.get(), "controlEpoch")?,
                resource_ids_json,
                fact_kind(&envelope.payload),
                envelope.occurred_at.as_str(),
                encoded.as_str(),
            ],
        )
        .map_err(|error| store_error("insert_fact", error))?;

    update_materialized_state(transaction, envelope, &encoded)?;
    transaction
        .execute(
            "INSERT INTO outbox (ledger_sequence, fact_id, envelope_json)
             VALUES (?1, ?2, ?3)",
            params![
                sqlite_integer(envelope.ledger_sequence, "ledgerSequence")?,
                envelope.fact_id.as_str(),
                encoded,
            ],
        )
        .map_err(|error| store_error("insert_outbox", error))?;
    Ok(())
}

fn update_materialized_state(
    transaction: &Transaction<'_>,
    envelope: &KernelFactEnvelopeV2,
    encoded: &str,
) -> KernelResult<()> {
    let identity = &envelope.identity;
    let ledger_sequence = sqlite_integer(envelope.ledger_sequence, "ledgerSequence")?;
    transaction
        .execute(
            "INSERT INTO run_state (
                 run_id, run_sequence_high_water, control_epoch, last_ledger_sequence, state_json
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(run_id) DO UPDATE SET
                 run_sequence_high_water = MAX(
                     run_state.run_sequence_high_water,
                     excluded.run_sequence_high_water
                 ),
                 control_epoch = MAX(run_state.control_epoch, excluded.control_epoch),
                 last_ledger_sequence = excluded.last_ledger_sequence,
                 state_json = excluded.state_json
             WHERE excluded.last_ledger_sequence > run_state.last_ledger_sequence",
            params![
                envelope.identity.run_id.as_str(),
                sqlite_integer(envelope.run_sequence, "runSequence")?,
                sqlite_integer(identity.control_epoch.get(), "controlEpoch")?,
                ledger_sequence,
                encoded,
            ],
        )
        .map_err(|error| store_error("update_run_state", error))?;

    match &envelope.payload {
        KernelFactPayloadV2::Grant(fact) => {
            transaction
                .execute(
                    "INSERT INTO grant_state (
                         grant_id, run_id, observed_use_count, status,
                         last_ledger_sequence, state_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(grant_id) DO UPDATE SET
                         run_id = excluded.run_id,
                         observed_use_count = excluded.observed_use_count,
                         status = excluded.status,
                         last_ledger_sequence = excluded.last_ledger_sequence,
                         state_json = excluded.state_json
                     WHERE excluded.last_ledger_sequence > grant_state.last_ledger_sequence",
                    params![
                        fact.grant_id.as_str(),
                        envelope.identity.run_id.as_str(),
                        sqlite_integer(fact.observed_use_count, "observedUseCount")?,
                        enum_json(&fact.kind, "grant_kind")?,
                        ledger_sequence,
                        encoded,
                    ],
                )
                .map_err(|error| store_error("update_grant_state", error))?;
        }
        KernelFactPayloadV2::Invocation(fact) => {
            transaction
                .execute(
                    "INSERT INTO invocation_state (
                         invocation_id, run_id, status, last_ledger_sequence, state_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(invocation_id) DO UPDATE SET
                         run_id = excluded.run_id,
                         status = excluded.status,
                         last_ledger_sequence = excluded.last_ledger_sequence,
                         state_json = excluded.state_json
                     WHERE excluded.last_ledger_sequence > invocation_state.last_ledger_sequence",
                    params![
                        fact.invocation_id.as_str(),
                        envelope.identity.run_id.as_str(),
                        enum_json(&fact.kind, "invocation_kind")?,
                        ledger_sequence,
                        encoded,
                    ],
                )
                .map_err(|error| store_error("update_invocation_state", error))?;
        }
        KernelFactPayloadV2::Resource(fact) => {
            update_resource_state(
                transaction,
                fact.resource_id.as_str(),
                envelope.identity.run_id.as_str(),
                &enum_json(&fact.kind, "resource_kind")?,
                ledger_sequence,
                encoded,
            )?;
        }
        KernelFactPayloadV2::Cleanup(fact) => {
            update_resource_state(
                transaction,
                fact.resource_id.as_str(),
                envelope.identity.run_id.as_str(),
                &format!("cleanup:{}", enum_json(&fact.kind, "cleanup_kind")?),
                ledger_sequence,
                encoded,
            )?;
        }
        KernelFactPayloadV2::Control(_) | KernelFactPayloadV2::Effect(_) => {}
    }
    Ok(())
}

fn update_resource_state(
    transaction: &Transaction<'_>,
    resource_id: &str,
    run_id: &str,
    status: &str,
    ledger_sequence: i64,
    encoded: &str,
) -> KernelResult<()> {
    transaction
        .execute(
            "INSERT INTO resource_state (
                 resource_id, run_id, status, last_ledger_sequence, state_json
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(resource_id) DO UPDATE SET
                 run_id = excluded.run_id,
                 status = excluded.status,
                 last_ledger_sequence = excluded.last_ledger_sequence,
                 state_json = excluded.state_json
             WHERE excluded.last_ledger_sequence > resource_state.last_ledger_sequence",
            params![resource_id, run_id, status, ledger_sequence, encoded],
        )
        .map_err(|error| store_error("update_resource_state", error))?;
    Ok(())
}

fn query_facts(
    connection: &Connection,
    filter: &FactQueryV2,
) -> KernelResult<Vec<KernelFactEnvelopeV2>> {
    let mut sql = String::from("SELECT envelope_json FROM kernel_facts WHERE ledger_sequence > ?");
    let mut values = vec![SqlValue::Integer(sqlite_integer(
        filter.after_ledger_sequence.unwrap_or(0),
        "afterLedgerSequence",
    )?)];

    push_filter(&mut sql, &mut values, "run_id", filter.run_id.as_deref());
    push_filter(&mut sql, &mut values, "fact_id", filter.fact_id.as_deref());
    push_filter(
        &mut sql,
        &mut values,
        "operation_id",
        filter.operation_id.as_deref(),
    );
    push_filter(
        &mut sql,
        &mut values,
        "invocation_id",
        filter.invocation_id.as_deref(),
    );
    push_filter(
        &mut sql,
        &mut values,
        "attempt_id",
        filter.attempt_id.as_deref(),
    );
    push_filter(
        &mut sql,
        &mut values,
        "capability_grant_id",
        filter.capability_grant_id.as_deref(),
    );
    push_filter(
        &mut sql,
        &mut values,
        "grant_reservation_id",
        filter.grant_reservation_id.as_deref(),
    );
    push_filter(
        &mut sql,
        &mut values,
        "causation_id",
        filter.causation_id.as_deref(),
    );
    push_filter(
        &mut sql,
        &mut values,
        "idempotency_key_hash",
        filter.idempotency_key_hash.as_deref(),
    );
    if let Some((kind, value)) = &filter.correlation_ref {
        if kind.trim().is_empty() || value.trim().is_empty() {
            return Err(invalid_fact_error(
                "query",
                "correlation reference kind and value must be non-empty",
            ));
        }
        sql.push_str(
            " AND EXISTS (
                 SELECT 1
                 FROM json_each(kernel_facts.correlation_refs_json)
                 WHERE json_extract(json_each.value, '$.kind') = ?
                   AND json_extract(json_each.value, '$.value') = ?
             )",
        );
        values.push(SqlValue::Text(kind.clone()));
        values.push(SqlValue::Text(value.clone()));
    }
    if let Some(control_epoch) = filter.control_epoch {
        sql.push_str(" AND control_epoch = ?");
        values.push(SqlValue::Integer(sqlite_integer(
            control_epoch,
            "controlEpoch",
        )?));
    }
    if let Some(resource_id) = filter.resource_id.as_deref() {
        sql.push_str(
            " AND EXISTS (
                 SELECT 1 FROM json_each(kernel_facts.resource_ids_json)
                 WHERE json_each.value = ?
             )",
        );
        values.push(SqlValue::Text(resource_id.to_string()));
    }
    sql.push_str(" ORDER BY ledger_sequence");
    if let Some(limit) = filter.limit {
        sql.push_str(" LIMIT ?");
        values.push(SqlValue::Integer(i64::from(limit)));
    }

    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| store_error("prepare_fact_query", error))?;
    let rows = statement
        .query_map(params_from_iter(values), |row| row.get::<_, String>(0))
        .map_err(|error| store_error("query_facts", error))?;
    let mut facts = Vec::new();
    for row in rows {
        let encoded = row.map_err(|error| store_error("read_fact", error))?;
        facts.push(decode_envelope(&encoded, "decode_fact")?);
    }
    Ok(facts)
}

fn push_filter(sql: &mut String, values: &mut Vec<SqlValue>, column: &str, value: Option<&str>) {
    if let Some(value) = value {
        sql.push_str(" AND ");
        sql.push_str(column);
        sql.push_str(" = ?");
        values.push(SqlValue::Text(value.to_string()));
    }
}

fn high_water_with_connection(connection: &Connection) -> KernelResult<u64> {
    let value = connection
        .query_row(
            "SELECT COALESCE(MAX(ledger_sequence), 0) FROM kernel_facts",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| store_error("read_ledger_high_water", error))?;
    sqlite_u64(value, "ledgerSequence")
}

fn run_high_waters_with_connection(
    connection: &Connection,
) -> KernelResult<Vec<RunSequenceHighWater>> {
    let mut statement = connection
        .prepare(
            "SELECT run_id, run_sequence_high_water
             FROM run_state
             ORDER BY run_id",
        )
        .map_err(|error| store_error("prepare_run_high_waters", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| store_error("query_run_high_waters", error))?;
    let mut high_waters = Vec::new();
    for row in rows {
        let (run_id, high_water) =
            row.map_err(|error| store_error("read_run_high_water", error))?;
        high_waters.push(RunSequenceHighWater {
            run_id: RunId::new(run_id),
            run_sequence_high_water: sqlite_u64(high_water, "runSequence")?,
        });
    }
    Ok(high_waters)
}

fn rebuild_materialized_state_transaction(connection: &mut Connection) -> KernelResult<()> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| store_error("begin_rebuild", error))?;
    transaction
        .execute_batch(
            "DELETE FROM run_state;
             DELETE FROM grant_state;
             DELETE FROM invocation_state;
             DELETE FROM resource_state;",
        )
        .map_err(|error| store_error("clear_materialized_state", error))?;

    {
        let mut statement = transaction
            .prepare("SELECT envelope_json FROM kernel_facts ORDER BY ledger_sequence")
            .map_err(|error| store_error("prepare_replay", error))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| store_error("query_replay", error))?;
        for row in rows {
            let encoded = row.map_err(|error| store_error("read_replay", error))?;
            let envelope = decode_envelope(&encoded, "decode_replay")?;
            update_materialized_state(&transaction, &envelope, &encoded)?;
        }
    }

    transaction
        .commit()
        .map_err(|error| store_error("commit_rebuild", error))
}

fn fact_kind(payload: &KernelFactPayloadV2) -> &'static str {
    match payload {
        KernelFactPayloadV2::Control(_) => "control",
        KernelFactPayloadV2::Grant(_) => "grant",
        KernelFactPayloadV2::Invocation(_) => "invocation",
        KernelFactPayloadV2::Effect(_) => "effect",
        KernelFactPayloadV2::Resource(_) => "resource",
        KernelFactPayloadV2::Cleanup(_) => "cleanup",
    }
}

fn resource_ids(envelope: &KernelFactEnvelopeV2) -> Vec<String> {
    match &envelope.payload {
        KernelFactPayloadV2::Effect(fact) => fact
            .affected_resources
            .iter()
            .map(|resource_id| resource_id.as_str().to_string())
            .collect(),
        KernelFactPayloadV2::Resource(fact) => vec![fact.resource_id.as_str().to_string()],
        KernelFactPayloadV2::Cleanup(fact) => vec![fact.resource_id.as_str().to_string()],
        KernelFactPayloadV2::Control(_)
        | KernelFactPayloadV2::Grant(_)
        | KernelFactPayloadV2::Invocation(_) => Vec::new(),
    }
}

fn enum_json<T: serde::Serialize>(value: &T, stage: &'static str) -> KernelResult<String> {
    match serde_json::to_value(value)
        .map_err(|error| store_error_message(stage, error.to_string()))?
    {
        Value::String(value) => Ok(value),
        _ => Err(store_error_message(
            stage,
            "enum did not serialize to a string",
        )),
    }
}

fn decode_envelope(encoded: &str, stage: &'static str) -> KernelResult<KernelFactEnvelopeV2> {
    let envelope = serde_json::from_str::<KernelFactEnvelopeV2>(encoded)
        .map_err(|error| store_error_message(stage, error.to_string()))?;
    envelope
        .validate()
        .map_err(|error| store_error_message(stage, error.to_string()))?;
    Ok(envelope)
}

fn sqlite_integer(value: u64, field: &'static str) -> KernelResult<i64> {
    i64::try_from(value).map_err(|_| {
        store_error_message(
            "encode_sqlite_integer",
            format!("{field} exceeds SQLite INTEGER range"),
        )
    })
}

fn sqlite_u64(value: i64, field: &'static str) -> KernelResult<u64> {
    u64::try_from(value).map_err(|_| {
        store_error_message(
            "decode_sqlite_integer",
            format!("{field} is negative in canonical storage"),
        )
    })
}

#[cfg(unix)]
fn create_private_database_file_if_absent(path: &Path) -> KernelResult<bool> {
    use std::os::unix::fs::OpenOptionsExt;
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(store_error("create_database_file", error)),
    }
}

#[cfg(not(unix))]
fn create_private_database_file_if_absent(path: &Path) -> KernelResult<bool> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(store_error("create_database_file", error)),
    }
}

fn cleanup_failed_database(path: &Path) -> KernelResult<()> {
    for candidate in [
        path.to_path_buf(),
        path_with_suffix(path, "-wal"),
        path_with_suffix(path, "-shm"),
    ] {
        match fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(store_error("cleanup_failed_database", error)),
        }
    }
    Ok(())
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn store_error(stage: &'static str, error: impl std::fmt::Display) -> KernelError {
    store_error_message(stage, error.to_string())
}

fn invalid_fact_error(stage: &'static str, message: impl Into<String>) -> KernelError {
    let message = message.into();
    KernelError::Structured {
        code: "invalid_identity",
        stage,
        message: format!("kernel v2 fact rejected during {stage}: {message}"),
        details: serde_json::json!({ "reason": message }),
    }
}

fn store_error_message(stage: &'static str, message: impl Into<String>) -> KernelError {
    let message = message.into();
    KernelError::Structured {
        code: "fact_store_unavailable",
        stage,
        message: format!("kernel v2 fact store unavailable during {stage}: {message}"),
        details: serde_json::json!({ "reason": message }),
    }
}
