use deepcode_kernel_abi::v2::{
    query_digest_v2, validate_cross_language_safe_json_value_v2,
    validate_cross_language_safe_u64_v2, AuthorizationFactV2, CancellationSourceV2, CleanupFactV2,
    CommandRequestDigestV2, CommandRequestId, ControlFactV2, FactId, InvocationFactV2,
    KernelFactDraftV2, KernelFactEnvelopeV2, KernelFactPayloadV2, MutationCommandResultV2,
    RecordedAtV2, ResourceFactV2, RunId, FACT_STORE_SCHEMA_CONTRACT_V2,
};
use deepcode_kernel_abi::v2_command::{
    ControlCancellationReplyV2, InvocationCancelReplyV2, InvocationPhaseV2, KernelErrorV2,
    KernelReplyV2, MutationCommandKindV2, RecordedCommandErrorV2, ToolIntentSubmitReplyV2,
};
use deepcode_kernel_abi::{
    CapabilityLeaseIdV2, CapabilityLeaseRefV2, CapabilityLeaseVersionV2, CapabilityScopeDigestV2,
    FactQueryContinuationV2, KERNEL_ABI_V2_VERSION,
};
use deepcode_kernel_abi::{KernelError, KernelResult};
use rusqlite::types::Value as SqlValue;
use rusqlite::{
    params, params_from_iter, Connection, OpenFlags, OptionalExtension, Transaction,
    TransactionBehavior,
};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const SCHEMA_VERSION: &str = "6";
const SCHEMA_CONTRACT: &str = FACT_STORE_SCHEMA_CONTRACT_V2;
const WRITER_QUEUE_CAPACITY: usize = 256;
const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);
const WRITER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_OUTBOX_LIMIT: u32 = 1_000;
const MAX_COMMAND_KIND_BYTES: usize = 128;
const MAX_PUBLIC_REPLY_BYTES: usize = 5 * 1024 * 1024;
const MAX_AUTHORITY_MATERIAL_PAYLOAD_BYTES: usize = 5 * 1024 * 1024;
const MAX_AUTHORITY_MATERIAL_TOKEN_BYTES: usize = 256;
const MAX_DURABLE_CONTINUATIONS_GLOBAL: u64 = 8_192;
const MAX_DURABLE_CONTINUATIONS_PER_RUN: u64 = 1_024;
const CAPABILITY_LEASE_AUTHORITY_MATERIAL_KIND: &str = "capabilityLease";
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
    pub command_request_id: Option<String>,
    pub run_id: Option<String>,
    pub operation_id: Option<String>,
    pub invocation_id: Option<String>,
    pub attempt_id: Option<String>,
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

/// Private durable replay metadata for one public v2 command.
///
/// This record is deliberately stored outside `kernel_facts`; it is never
/// returned by `KernelFactsQuery`. `reply_json` must be a secret-free,
/// reconstructable reply. In particular, ephemeral run or decision
/// capabilities are rejected at the storage boundary and must be reissued
/// after restart.
#[derive(Debug, Clone, PartialEq)]
pub struct PublicCommandReceiptV2 {
    pub command_request_id: CommandRequestId,
    pub command_request_digest: CommandRequestDigestV2,
    pub command_kind: String,
    pub run_id: Option<RunId>,
    pub reply_json: serde_json::Value,
    pub settlement_fact_id: Option<FactId>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PutPublicCommandReceiptOutcomeV2 {
    Inserted(PublicCommandReceiptV2),
    ExistingSame(PublicCommandReceiptV2),
    DigestConflict {
        command_request_id: CommandRequestId,
        existing: CommandRequestDigestV2,
        submitted: CommandRequestDigestV2,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppendWithPublicCommandReceiptOutcomeV2 {
    pub facts: Vec<KernelFactEnvelopeV2>,
    pub receipt: PutPublicCommandReceiptOutcomeV2,
}

/// Private durable authority material used to reconstruct admission state.
///
/// Material is not a Kernel fact and is never exposed by fact queries or the
/// outbox. `payload_json` is deliberately secret-free; run and decision
/// capabilities are rejected at this storage boundary.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthorityMaterialRecordV2 {
    pub material_kind: String,
    pub material_id: String,
    pub run_id: RunId,
    pub control_epoch: u64,
    pub lifecycle: String,
    pub operation_id: Option<deepcode_kernel_abi::v2::OperationId>,
    pub invocation_id: Option<deepcode_kernel_abi::v2::InvocationId>,
    pub lease: Option<CapabilityLeaseRefV2>,
    pub payload_digest: String,
    pub payload_json: serde_json::Value,
    pub source_fact_id: FactId,
    pub last_fact_id: FactId,
    pub last_ledger_sequence: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuthorityMaterialDraftV2 {
    pub material_kind: String,
    pub material_id: String,
    pub run_id: RunId,
    pub control_epoch: u64,
    pub lifecycle: String,
    pub operation_id: Option<deepcode_kernel_abi::v2::OperationId>,
    pub invocation_id: Option<deepcode_kernel_abi::v2::InvocationId>,
    pub lease: Option<CapabilityLeaseRefV2>,
    pub payload_json: serde_json::Value,
}

/// Compare-and-set mutations applied after the referenced facts are appended
/// but before the same SQLite transaction commits.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthorityMaterialMutationV2 {
    Put {
        material: AuthorityMaterialDraftV2,
        fact_index: usize,
    },
    Replace {
        expected_lifecycle: String,
        expected_payload_digest: Option<String>,
        material: AuthorityMaterialDraftV2,
        fact_index: usize,
    },
    TransitionRunEpoch {
        run_id: RunId,
        through_control_epoch: u64,
        expected_lifecycles: Vec<String>,
        next_lifecycle: String,
        fact_index: usize,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppendWithAuthorityMaterialOutcomeV2 {
    pub facts: Vec<KernelFactEnvelopeV2>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppendWithPublicReceiptAndAuthorityMaterialOutcomeV2 {
    pub facts: Vec<KernelFactEnvelopeV2>,
    pub receipt: PutPublicCommandReceiptOutcomeV2,
}

#[derive(Clone, PartialEq, Eq)]
pub struct FactQueryContinuationDraftV2 {
    pub token: FactQueryContinuationV2,
    pub run_id: RunId,
    pub snapshot_high_water: u64,
    pub after_ledger_sequence: u64,
    pub expires_at: RecordedAtV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DurableFactQueryContinuationV2 {
    pub run_id: RunId,
    pub snapshot_high_water: u64,
    pub after_ledger_sequence: u64,
    pub created_at: RecordedAtV2,
    pub expires_at: RecordedAtV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactQueryContinuationExpectationV2 {
    pub run_id: RunId,
    pub after_ledger_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactQueryContinuationConsumerV2 {
    pub command_request_id: CommandRequestId,
    pub command_request_digest: CommandRequestDigestV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutFactQueryContinuationOutcomeV2 {
    Inserted(DurableFactQueryContinuationV2),
    ExistingSame(DurableFactQueryContinuationV2),
    ExistingConsumed(DurableFactQueryContinuationV2),
    ExistingExpired(DurableFactQueryContinuationV2),
    TokenConflict,
    CapacityExceeded {
        scope: FactQueryContinuationCapacityScopeV2,
        limit: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactQueryContinuationCapacityScopeV2 {
    Global,
    Run,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveFactQueryContinuationOutcomeV2 {
    Resolved(DurableFactQueryContinuationV2),
    NotFound,
    Expired { expires_at: RecordedAtV2 },
    ScopeMismatch,
    Consumed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsumeFactQueryContinuationOutcomeV2 {
    Consumed(DurableFactQueryContinuationV2),
    ExistingSame(DurableFactQueryContinuationV2),
    NotFound,
    Expired { expires_at: RecordedAtV2 },
    ScopeMismatch,
    AlreadyConsumed,
}

#[derive(Debug, Clone)]
enum DatabaseTarget {
    File(PathBuf),
    SharedMemory { uri: String, access: Arc<Mutex<()>> },
}

struct QueryConnection<'a> {
    connection: Connection,
    _shared_memory_access: Option<MutexGuard<'a, ()>>,
}

impl Deref for QueryConnection<'_> {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

impl DerefMut for QueryConnection<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.connection
    }
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
            Self::SharedMemory { uri, .. } => Connection::open_with_flags(
                uri,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| store_error("open_memory_writer", error)),
        }
    }

    fn query_connection(&self) -> KernelResult<QueryConnection<'_>> {
        let shared_memory_access = self.shared_memory_access();
        let connection = match self {
            Self::File(path) => Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| store_error("open_query", error))?,
            // A named shared-cache memory database cannot be opened with SQLite's
            // READ_ONLY flag. query_only makes this independent connection
            // application-read-only while the writer connection keeps the database alive.
            Self::SharedMemory { uri, .. } => Connection::open_with_flags(
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
        Ok(QueryConnection {
            connection,
            _shared_memory_access: shared_memory_access,
        })
    }

    fn shared_memory_access(&self) -> Option<MutexGuard<'_, ()>> {
        match self {
            Self::File(_) => None,
            Self::SharedMemory { access, .. } => Some(
                access
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            ),
        }
    }

    fn is_memory(&self) -> bool {
        matches!(self, Self::SharedMemory { .. })
    }
}

enum WriterCommand {
    Append {
        drafts: Vec<KernelFactDraftV2>,
        response: mpsc::Sender<KernelResult<Vec<KernelFactEnvelopeV2>>>,
    },
    AppendWithPublicCommandReceipt {
        drafts: Vec<KernelFactDraftV2>,
        receipt: PublicCommandReceiptV2,
        response: mpsc::Sender<KernelResult<AppendWithPublicCommandReceiptOutcomeV2>>,
    },
    AppendWithAuthorityMaterial {
        drafts: Vec<KernelFactDraftV2>,
        mutations: Vec<AuthorityMaterialMutationV2>,
        response: mpsc::Sender<KernelResult<AppendWithAuthorityMaterialOutcomeV2>>,
    },
    AppendWithPublicReceiptAndAuthorityMaterial {
        drafts: Vec<KernelFactDraftV2>,
        receipt: PublicCommandReceiptV2,
        mutations: Vec<AuthorityMaterialMutationV2>,
        response: mpsc::Sender<KernelResult<AppendWithPublicReceiptAndAuthorityMaterialOutcomeV2>>,
    },
    PutPublicCommandReceipt {
        receipt: PublicCommandReceiptV2,
        response: mpsc::Sender<KernelResult<PutPublicCommandReceiptOutcomeV2>>,
    },
    PutFactQueryContinuation {
        continuation: FactQueryContinuationDraftV2,
        response: mpsc::Sender<KernelResult<PutFactQueryContinuationOutcomeV2>>,
    },
    ConsumeFactQueryContinuation {
        token: FactQueryContinuationV2,
        expected: FactQueryContinuationExpectationV2,
        consumer: FactQueryContinuationConsumerV2,
        response: mpsc::Sender<KernelResult<ConsumeFactQueryContinuationOutcomeV2>>,
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
    writer_claimed: AtomicBool,
    publisher_claimed: AtomicBool,
    recovery_claimed: AtomicBool,
    recovery_completed: AtomicBool,
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
pub struct CanonicalFactStore {
    inner: Arc<StoreInner>,
}

#[derive(Clone)]
pub struct CanonicalFactReader {
    inner: Arc<StoreInner>,
}

pub struct AuthorityFactWriterLease {
    inner: Arc<StoreInner>,
}

pub struct OutboxPublisherLease {
    inner: Arc<StoreInner>,
}

pub struct RecoveryAdmin {
    inner: Arc<StoreInner>,
    completed: bool,
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
        if !created {
            validate_existing_database_read_only(&path)?;
        }
        match Self::start(DatabaseTarget::File(path.clone()), created) {
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
        Self::start(
            DatabaseTarget::SharedMemory {
                uri,
                access: Arc::new(Mutex::new(())),
            },
            true,
        )
    }

    fn start(target: DatabaseTarget, initialize_schema: bool) -> KernelResult<Self> {
        let (sender, receiver) = mpsc::sync_channel(WRITER_QUEUE_CAPACITY);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let writer_target = target.clone();
        let writer = thread::Builder::new()
            .name("deepcode-kernel-fact-writer".to_string())
            .spawn(move || writer_main(writer_target, initialize_schema, receiver, ready_sender))
            .map_err(|error| store_error_message("spawn_writer", error.to_string()))?;

        match ready_receiver.recv_timeout(WRITER_RESPONSE_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                inner: Arc::new(StoreInner {
                    target,
                    faulted: AtomicBool::new(false),
                    writer_claimed: AtomicBool::new(false),
                    publisher_claimed: AtomicBool::new(false),
                    recovery_claimed: AtomicBool::new(false),
                    recovery_completed: AtomicBool::new(false),
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

    pub fn reader(&self) -> CanonicalFactReader {
        CanonicalFactReader {
            inner: Arc::clone(&self.inner),
        }
    }

    pub fn claim_authority_writer(&self) -> KernelResult<AuthorityFactWriterLease> {
        require_recovery(&self.inner, "claim_authority_writer")?;
        claim_once(
            &self.inner.writer_claimed,
            "claim_authority_writer",
            "the opened fact store already has an authority writer lease",
        )?;
        Ok(AuthorityFactWriterLease {
            inner: Arc::clone(&self.inner),
        })
    }

    pub fn claim_outbox_publisher(&self) -> KernelResult<OutboxPublisherLease> {
        require_recovery(&self.inner, "claim_outbox_publisher")?;
        claim_once(
            &self.inner.publisher_claimed,
            "claim_outbox_publisher",
            "the opened fact store already has an outbox publisher lease",
        )?;
        Ok(OutboxPublisherLease {
            inner: Arc::clone(&self.inner),
        })
    }

    pub fn claim_recovery_admin(&self) -> KernelResult<RecoveryAdmin> {
        claim_once(
            &self.inner.recovery_claimed,
            "claim_recovery_admin",
            "startup recovery capability was already claimed",
        )?;
        Ok(RecoveryAdmin {
            inner: Arc::clone(&self.inner),
            completed: false,
        })
    }

    fn append(&self, draft: KernelFactDraftV2) -> KernelResult<KernelFactEnvelopeV2> {
        let mut facts = self.append_batch(vec![draft])?;
        facts.pop().ok_or_else(|| {
            store_error_message(
                "append",
                "writer committed an empty result for a non-empty append",
            )
        })
    }

    fn append_batch(
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

    fn query(&self, filter: &FactQueryV2) -> KernelResult<Vec<KernelFactEnvelopeV2>> {
        if filter.limit == Some(0) {
            return Err(store_error_message(
                "query",
                "query limit must be greater than zero",
            ));
        }
        let connection = self.inner.target.query_connection()?;
        query_facts(&connection, filter)
    }

    fn get_by_fact_id(&self, fact_id: &str) -> KernelResult<Option<KernelFactEnvelopeV2>> {
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

    fn get_public_command_receipt(
        &self,
        command_request_id: &CommandRequestId,
    ) -> KernelResult<Option<PublicCommandReceiptV2>> {
        let connection = self.inner.target.query_connection()?;
        read_public_command_receipt(&connection, command_request_id)
    }

    fn authority_material_snapshot(&self) -> KernelResult<Vec<AuthorityMaterialRecordV2>> {
        let connection = self.inner.target.query_connection()?;
        read_authority_material_snapshot(&connection)
    }

    fn append_with_public_command_receipt(
        &self,
        drafts: Vec<KernelFactDraftV2>,
        receipt: PublicCommandReceiptV2,
    ) -> KernelResult<AppendWithPublicCommandReceiptOutcomeV2> {
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::AppendWithPublicCommandReceipt {
            drafts,
            receipt,
            response,
        })?;
        receive_response(
            "append_with_public_command_receipt",
            receiver,
            &self.inner.faulted,
        )
    }

    fn append_with_authority_material(
        &self,
        drafts: Vec<KernelFactDraftV2>,
        mutations: Vec<AuthorityMaterialMutationV2>,
    ) -> KernelResult<AppendWithAuthorityMaterialOutcomeV2> {
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::AppendWithAuthorityMaterial {
            drafts,
            mutations,
            response,
        })?;
        receive_response(
            "append_with_authority_material",
            receiver,
            &self.inner.faulted,
        )
    }

    fn append_with_public_receipt_and_authority_material(
        &self,
        drafts: Vec<KernelFactDraftV2>,
        receipt: PublicCommandReceiptV2,
        mutations: Vec<AuthorityMaterialMutationV2>,
    ) -> KernelResult<AppendWithPublicReceiptAndAuthorityMaterialOutcomeV2> {
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::AppendWithPublicReceiptAndAuthorityMaterial {
            drafts,
            receipt,
            mutations,
            response,
        })?;
        receive_response(
            "append_with_public_receipt_and_authority_material",
            receiver,
            &self.inner.faulted,
        )
    }

    fn put_public_command_receipt_if_absent(
        &self,
        receipt: PublicCommandReceiptV2,
    ) -> KernelResult<PutPublicCommandReceiptOutcomeV2> {
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::PutPublicCommandReceipt { receipt, response })?;
        receive_response(
            "put_public_command_receipt_if_absent",
            receiver,
            &self.inner.faulted,
        )
    }

    fn resolve_fact_query_continuation(
        &self,
        token: &FactQueryContinuationV2,
        expected: &FactQueryContinuationExpectationV2,
    ) -> KernelResult<ResolveFactQueryContinuationOutcomeV2> {
        let connection = self.inner.target.query_connection()?;
        resolve_fact_query_continuation(&connection, token, expected)
    }

    fn put_fact_query_continuation_if_absent(
        &self,
        continuation: FactQueryContinuationDraftV2,
    ) -> KernelResult<PutFactQueryContinuationOutcomeV2> {
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::PutFactQueryContinuation {
            continuation,
            response,
        })?;
        receive_response(
            "put_fact_query_continuation_if_absent",
            receiver,
            &self.inner.faulted,
        )
    }

    fn consume_fact_query_continuation(
        &self,
        token: FactQueryContinuationV2,
        expected: FactQueryContinuationExpectationV2,
        consumer: FactQueryContinuationConsumerV2,
    ) -> KernelResult<ConsumeFactQueryContinuationOutcomeV2> {
        let (response, receiver) = mpsc::channel();
        self.send(WriterCommand::ConsumeFactQueryContinuation {
            token,
            expected,
            consumer,
            response,
        })?;
        receive_response(
            "consume_fact_query_continuation",
            receiver,
            &self.inner.faulted,
        )
    }

    fn snapshot(&self) -> KernelResult<FactStoreSnapshotV2> {
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

    fn ledger_sequence_high_water(&self) -> KernelResult<u64> {
        let connection = self.inner.target.query_connection()?;
        high_water_with_connection(&connection)
    }

    fn run_sequence_high_waters(&self) -> KernelResult<Vec<RunSequenceHighWater>> {
        let connection = self.inner.target.query_connection()?;
        run_high_waters_with_connection(&connection)
    }

    fn pending_outbox(
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

    fn mark_outbox_published(
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

    fn record_outbox_publish_failure(
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

    fn rebuild_materialized_state(&self) -> KernelResult<()> {
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

impl CanonicalFactReader {
    pub fn query(&self, filter: &FactQueryV2) -> KernelResult<Vec<KernelFactEnvelopeV2>> {
        store_handle(&self.inner).query(filter)
    }

    pub fn get_by_fact_id(&self, fact_id: &str) -> KernelResult<Option<KernelFactEnvelopeV2>> {
        store_handle(&self.inner).get_by_fact_id(fact_id)
    }

    pub fn get_public_command_receipt(
        &self,
        command_request_id: &CommandRequestId,
    ) -> KernelResult<Option<PublicCommandReceiptV2>> {
        store_handle(&self.inner).get_public_command_receipt(command_request_id)
    }

    /// Returns the private authority reconstruction snapshot. This API is for
    /// Kernel runtime recovery only and is intentionally separate from facts.
    pub fn authority_material_snapshot(&self) -> KernelResult<Vec<AuthorityMaterialRecordV2>> {
        require_recovery(&self.inner, "authority_material_snapshot")?;
        store_handle(&self.inner).authority_material_snapshot()
    }

    /// Read-only inspection of a continuation's durable scope and lifecycle.
    /// This does not authorize page admission; authority code must use the
    /// writer lease's atomic consume operation.
    pub fn resolve_fact_query_continuation(
        &self,
        token: &FactQueryContinuationV2,
        expected: &FactQueryContinuationExpectationV2,
    ) -> KernelResult<ResolveFactQueryContinuationOutcomeV2> {
        store_handle(&self.inner).resolve_fact_query_continuation(token, expected)
    }

    pub fn snapshot(&self) -> KernelResult<FactStoreSnapshotV2> {
        require_recovery(&self.inner, "snapshot")?;
        store_handle(&self.inner).snapshot()
    }

    pub fn ledger_sequence_high_water(&self) -> KernelResult<u64> {
        store_handle(&self.inner).ledger_sequence_high_water()
    }

    pub fn run_sequence_high_waters(&self) -> KernelResult<Vec<RunSequenceHighWater>> {
        require_recovery(&self.inner, "run_sequence_high_waters")?;
        store_handle(&self.inner).run_sequence_high_waters()
    }
}

impl AuthorityFactWriterLease {
    pub fn append(&self, draft: KernelFactDraftV2) -> KernelResult<KernelFactEnvelopeV2> {
        store_handle(&self.inner).append(draft)
    }

    pub fn append_batch(
        &self,
        drafts: Vec<KernelFactDraftV2>,
    ) -> KernelResult<Vec<KernelFactEnvelopeV2>> {
        store_handle(&self.inner).append_batch(drafts)
    }

    /// Atomically appends settlement facts and installs their private replay
    /// receipt. An already-recorded matching request returns the stored receipt
    /// without appending any of the supplied drafts.
    pub fn append_with_public_command_receipt(
        &self,
        drafts: Vec<KernelFactDraftV2>,
        receipt: PublicCommandReceiptV2,
    ) -> KernelResult<AppendWithPublicCommandReceiptOutcomeV2> {
        store_handle(&self.inner).append_with_public_command_receipt(drafts, receipt)
    }

    pub fn append_with_authority_material(
        &self,
        drafts: Vec<KernelFactDraftV2>,
        mutations: Vec<AuthorityMaterialMutationV2>,
    ) -> KernelResult<AppendWithAuthorityMaterialOutcomeV2> {
        store_handle(&self.inner).append_with_authority_material(drafts, mutations)
    }

    pub fn append_with_public_receipt_and_authority_material(
        &self,
        drafts: Vec<KernelFactDraftV2>,
        receipt: PublicCommandReceiptV2,
        mutations: Vec<AuthorityMaterialMutationV2>,
    ) -> KernelResult<AppendWithPublicReceiptAndAuthorityMaterialOutcomeV2> {
        store_handle(&self.inner)
            .append_with_public_receipt_and_authority_material(drafts, receipt, mutations)
    }

    /// Installs a private replay receipt only when its settlement fact already
    /// exists. This is useful when recovering a fact committed by an older
    /// process before it could install the receipt.
    pub fn put_public_command_receipt_if_absent(
        &self,
        receipt: PublicCommandReceiptV2,
    ) -> KernelResult<PutPublicCommandReceiptOutcomeV2> {
        store_handle(&self.inner).put_public_command_receipt_if_absent(receipt)
    }

    pub fn put_fact_query_continuation_if_absent(
        &self,
        continuation: FactQueryContinuationDraftV2,
    ) -> KernelResult<PutFactQueryContinuationOutcomeV2> {
        store_handle(&self.inner).put_fact_query_continuation_if_absent(continuation)
    }

    /// Atomically consumes a continuation for one public command identity.
    /// Repeating the same command identity is idempotent; a different command
    /// cannot reuse the token. Runtime admission must use this method rather
    /// than treating the reader's resolve result as a consumption grant.
    pub fn consume_fact_query_continuation(
        &self,
        token: FactQueryContinuationV2,
        expected: FactQueryContinuationExpectationV2,
        consumer: FactQueryContinuationConsumerV2,
    ) -> KernelResult<ConsumeFactQueryContinuationOutcomeV2> {
        store_handle(&self.inner).consume_fact_query_continuation(token, expected, consumer)
    }
}

impl Drop for AuthorityFactWriterLease {
    fn drop(&mut self) {
        self.inner.writer_claimed.store(false, Ordering::Release);
    }
}

impl OutboxPublisherLease {
    pub fn pending(
        &self,
        after_ledger_sequence: u64,
        limit: Option<u32>,
    ) -> KernelResult<Vec<OutboxFactV2>> {
        store_handle(&self.inner).pending_outbox(after_ledger_sequence, limit)
    }

    pub fn mark_published(
        &self,
        ledger_sequence: u64,
        fact_id: impl Into<String>,
    ) -> KernelResult<()> {
        store_handle(&self.inner).mark_outbox_published(ledger_sequence, fact_id)
    }

    pub fn record_publish_failure(
        &self,
        ledger_sequence: u64,
        error: impl Into<String>,
    ) -> KernelResult<()> {
        store_handle(&self.inner).record_outbox_publish_failure(ledger_sequence, error)
    }
}

impl Drop for OutboxPublisherLease {
    fn drop(&mut self) {
        self.inner.publisher_claimed.store(false, Ordering::Release);
    }
}

impl RecoveryAdmin {
    pub fn rebuild_materialized_state(&mut self) -> KernelResult<()> {
        if self.completed {
            return Err(store_error_message(
                "rebuild_materialized_state",
                "startup recovery capability was already consumed",
            ));
        }
        store_handle(&self.inner).rebuild_materialized_state()?;
        self.inner.recovery_completed.store(true, Ordering::Release);
        self.completed = true;
        Ok(())
    }
}

fn store_handle(inner: &Arc<StoreInner>) -> CanonicalFactStore {
    CanonicalFactStore {
        inner: Arc::clone(inner),
    }
}

fn claim_once(
    claimed: &AtomicBool,
    stage: &'static str,
    message: &'static str,
) -> KernelResult<()> {
    claimed
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| ())
        .map_err(|_| store_error_message(stage, message))
}

fn require_recovery(inner: &StoreInner, stage: &'static str) -> KernelResult<()> {
    if inner.recovery_completed.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(store_error_message(
            stage,
            "startup recovery must complete before authority capabilities are claimed",
        ))
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
    initialize_schema: bool,
    receiver: Receiver<WriterCommand>,
    ready: SyncSender<KernelResult<()>>,
) {
    let initialization_access = target.shared_memory_access();
    let mut connection = match target.writer_connection() {
        Ok(connection) => connection,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if let Err(error) = prepare_database(&mut connection, target.is_memory(), initialize_schema) {
        let _ = ready.send(Err(error));
        return;
    }
    if ready.send(Ok(())).is_err() {
        return;
    }
    drop(initialization_access);

    while let Ok(command) = receiver.recv() {
        let _shared_memory_access = target.shared_memory_access();
        match command {
            WriterCommand::Append { drafts, response } => {
                let _ = response.send(append_batch_transaction(&mut connection, drafts));
            }
            WriterCommand::AppendWithPublicCommandReceipt {
                drafts,
                receipt,
                response,
            } => {
                let _ = response.send(append_with_public_command_receipt_transaction(
                    &mut connection,
                    drafts,
                    receipt,
                ));
            }
            WriterCommand::AppendWithAuthorityMaterial {
                drafts,
                mutations,
                response,
            } => {
                let _ = response.send(append_with_authority_material_transaction(
                    &mut connection,
                    drafts,
                    mutations,
                ));
            }
            WriterCommand::AppendWithPublicReceiptAndAuthorityMaterial {
                drafts,
                receipt,
                mutations,
                response,
            } => {
                let _ = response.send(
                    append_with_public_receipt_and_authority_material_transaction(
                        &mut connection,
                        drafts,
                        receipt,
                        mutations,
                    ),
                );
            }
            WriterCommand::PutPublicCommandReceipt { receipt, response } => {
                let _ = response.send(put_public_command_receipt_transaction(
                    &mut connection,
                    receipt,
                ));
            }
            WriterCommand::PutFactQueryContinuation {
                continuation,
                response,
            } => {
                let _ = response.send(put_fact_query_continuation_transaction(
                    &mut connection,
                    continuation,
                ));
            }
            WriterCommand::ConsumeFactQueryContinuation {
                token,
                expected,
                consumer,
                response,
            } => {
                let _ = response.send(consume_fact_query_continuation_transaction(
                    &mut connection,
                    token,
                    expected,
                    consumer,
                ));
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

fn validate_existing_database_read_only(path: &Path) -> KernelResult<()> {
    let uri = immutable_sqlite_uri(path)?;
    let connection = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        unsupported_existing_history_schema_error(
            None,
            None,
            None,
            format!("immutable read-only open failed: {error}"),
        )
    })?;
    validate_current_database_schema(&connection)
}

fn immutable_sqlite_uri(path: &Path) -> KernelResult<String> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        unsupported_existing_history_schema_error(
            None,
            None,
            None,
            format!("database path cannot be resolved without mutation: {error}"),
        )
    })?;
    let value = canonical.to_str().ok_or_else(|| {
        unsupported_existing_history_schema_error(
            None,
            None,
            None,
            "database path is not valid UTF-8 for immutable SQLite inspection".to_string(),
        )
    })?;
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len() + 32);
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    Ok(format!("file:{encoded}?mode=ro&immutable=1"))
}

fn validate_current_database_schema(connection: &Connection) -> KernelResult<()> {
    let read_meta = |key: &str| {
        connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
    };
    let version = read_meta("schema_version").map_err(|error| {
        unsupported_existing_history_schema_error(
            None,
            None,
            None,
            format!("schema_meta is unavailable: {error}"),
        )
    })?;
    let contract = read_meta("schema_contract").map_err(|error| {
        unsupported_existing_history_schema_error(
            version.as_deref(),
            None,
            None,
            format!("schema contract discriminator is unavailable: {error}"),
        )
    })?;
    let abi_version = read_meta("abi_version").map_err(|error| {
        unsupported_existing_history_schema_error(
            version.as_deref(),
            contract.as_deref(),
            None,
            format!("ABI discriminator is unavailable: {error}"),
        )
    })?;
    if version.as_deref() != Some(SCHEMA_VERSION)
        || contract.as_deref() != Some(SCHEMA_CONTRACT)
        || abi_version.as_deref() != Some(KERNEL_ABI_V2_VERSION)
    {
        return Err(unsupported_existing_history_schema_error(
            version.as_deref(),
            contract.as_deref(),
            abi_version.as_deref(),
            "schema discriminator does not match the live v2 store".to_string(),
        ));
    }
    validate_schema_contract(connection).map_err(|error| {
        unsupported_existing_history_schema_error(
            version.as_deref(),
            contract.as_deref(),
            abi_version.as_deref(),
            format!("live schema contract validation failed: {error}"),
        )
    })?;
    let integrity = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))
        .map_err(|error| {
            unsupported_existing_history_schema_error(
                version.as_deref(),
                contract.as_deref(),
                abi_version.as_deref(),
                format!("read-only integrity check failed: {error}"),
            )
        })?;
    if integrity != "ok" {
        return Err(unsupported_existing_history_schema_error(
            version.as_deref(),
            contract.as_deref(),
            abi_version.as_deref(),
            format!("read-only integrity check returned {integrity}"),
        ));
    }
    Ok(())
}

fn prepare_database(
    connection: &mut Connection,
    is_memory: bool,
    initialize_schema: bool,
) -> KernelResult<()> {
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

    if initialize_schema {
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
                 command_request_id TEXT,
                 operation_id TEXT,
                 invocation_id TEXT,
                 attempt_id TEXT,
                 causation_id TEXT,
                 idempotency_key_hash TEXT,
                 correlation_refs_json TEXT NOT NULL,
                 control_epoch INTEGER NOT NULL,
                 resource_ids_json TEXT NOT NULL,
                 fact_kind TEXT NOT NULL,
                 recorded_at TEXT NOT NULL,
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
             CREATE INDEX IF NOT EXISTS kernel_facts_causation
                 ON kernel_facts (causation_id, ledger_sequence);
             CREATE UNIQUE INDEX IF NOT EXISTS kernel_facts_command_request
                 ON kernel_facts (command_request_id)
                 WHERE command_request_id IS NOT NULL;
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

             CREATE TABLE IF NOT EXISTS public_command_receipts (
                 command_request_id TEXT PRIMARY KEY NOT NULL,
                 command_request_digest TEXT NOT NULL,
                 command_kind TEXT NOT NULL,
                 run_id TEXT NOT NULL,
                 reply_json TEXT NOT NULL,
                 settlement_fact_id TEXT
                     REFERENCES kernel_facts (fact_id) ON DELETE RESTRICT,
                 recorded_at TEXT NOT NULL
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS public_command_receipts_run
                 ON public_command_receipts (run_id, command_request_id);
             CREATE TRIGGER IF NOT EXISTS public_command_receipts_reject_update
             BEFORE UPDATE ON public_command_receipts
             BEGIN
                 SELECT RAISE(ABORT, 'public_command_receipts is append-only');
             END;
             CREATE TRIGGER IF NOT EXISTS public_command_receipts_reject_delete
             BEFORE DELETE ON public_command_receipts
             BEGIN
                 SELECT RAISE(ABORT, 'public_command_receipts is append-only');
             END;

             CREATE TABLE IF NOT EXISTS fact_query_continuations (
                 token_hash TEXT PRIMARY KEY NOT NULL,
                 run_id TEXT NOT NULL,
                 snapshot_high_water INTEGER NOT NULL,
                 after_ledger_sequence INTEGER NOT NULL,
                 created_at TEXT NOT NULL,
                 expires_at TEXT NOT NULL
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS fact_query_continuations_expiry
                 ON fact_query_continuations (expires_at);
             CREATE INDEX IF NOT EXISTS fact_query_continuations_run
                 ON fact_query_continuations (run_id);
             CREATE TRIGGER IF NOT EXISTS fact_query_continuations_reject_update
             BEFORE UPDATE ON fact_query_continuations
             BEGIN
                 SELECT RAISE(ABORT, 'fact_query_continuations is immutable');
             END;

             CREATE TABLE IF NOT EXISTS fact_query_continuation_consumptions (
                 token_hash TEXT PRIMARY KEY NOT NULL
                     REFERENCES fact_query_continuations (token_hash) ON DELETE RESTRICT,
                 command_request_id TEXT NOT NULL,
                 command_request_digest TEXT NOT NULL,
                 consumed_at TEXT NOT NULL
             ) WITHOUT ROWID;
             CREATE TRIGGER IF NOT EXISTS fact_query_continuation_consumptions_reject_update
             BEFORE UPDATE ON fact_query_continuation_consumptions
             BEGIN
                 SELECT RAISE(ABORT, 'fact_query_continuation_consumptions is append-only');
             END;

             CREATE TABLE IF NOT EXISTS authority_material (
                 material_kind TEXT NOT NULL,
                 material_id TEXT NOT NULL,
                 run_id TEXT NOT NULL,
                 control_epoch INTEGER NOT NULL,
                 lifecycle TEXT NOT NULL,
                 operation_id TEXT,
                 invocation_id TEXT,
                 lease_id TEXT,
                 lease_version INTEGER,
                 lease_scope_digest TEXT,
                 payload_digest TEXT NOT NULL,
                 payload_json TEXT NOT NULL,
                 source_fact_id TEXT NOT NULL
                     REFERENCES kernel_facts (fact_id) ON DELETE RESTRICT,
                 last_fact_id TEXT NOT NULL
                     REFERENCES kernel_facts (fact_id) ON DELETE RESTRICT,
                 last_ledger_sequence INTEGER NOT NULL,
                 PRIMARY KEY (material_kind, material_id),
                 CHECK (
                     (lease_id IS NULL AND lease_version IS NULL
                         AND lease_scope_digest IS NULL)
                     OR
                     (lease_id IS NOT NULL AND lease_version IS NOT NULL
                         AND lease_scope_digest IS NOT NULL)
                 )
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS authority_material_run_epoch
                 ON authority_material (
                     run_id, control_epoch, material_kind, lifecycle
                 );
             CREATE INDEX IF NOT EXISTS authority_material_invocation
                 ON authority_material (run_id, invocation_id)
                 WHERE invocation_id IS NOT NULL;
             CREATE TRIGGER IF NOT EXISTS authority_material_reject_delete
             BEFORE DELETE ON authority_material
             BEGIN
                 SELECT RAISE(ABORT, 'authority_material lifecycle rows cannot be deleted');
             END;

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

        initialize_or_validate_schema_meta(&transaction)?;
        initialize_or_validate_meta(&transaction, "abi_version", KERNEL_ABI_V2_VERSION)?;
        validate_schema_contract(&transaction)?;
        transaction
            .commit()
            .map_err(|error| store_error("commit_schema_initialization", error))?;
        if !is_memory {
            let (busy, wal_frames, checkpointed_frames) = connection
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|error| store_error("checkpoint_schema_initialization", error))?;
            if busy != 0 || wal_frames != 0 || checkpointed_frames != 0 {
                return Err(store_error_message(
                    "checkpoint_schema_initialization",
                    format!(
                        "schema WAL checkpoint did not truncate cleanly \
                         (busy={busy}, wal_frames={wal_frames}, \
                         checkpointed_frames={checkpointed_frames})"
                    ),
                ));
            }
        }
    } else {
        validate_current_database_schema(connection)?;
    }

    let integrity: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| store_error("integrity_check", error))?;
    if integrity != "ok" {
        return Err(store_error_message(
            "integrity_check",
            format!("SQLite quick_check failed: {integrity}"),
        ));
    }
    Ok(())
}

fn initialize_or_validate_schema_meta(connection: &Connection) -> KernelResult<()> {
    let read = |key: &str| {
        connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| store_error("read_schema_meta", error))
    };
    let version = read("schema_version")?;
    let contract = read("schema_contract")?;
    match (version.as_deref(), contract.as_deref()) {
        (None, None) => {
            connection
                .execute(
                    "INSERT INTO schema_meta (key, value) VALUES
                         ('schema_version', ?1),
                         ('schema_contract', ?2)",
                    params![SCHEMA_VERSION, SCHEMA_CONTRACT],
                )
                .map_err(|error| store_error("initialize_schema_meta", error))?;
            Ok(())
        }
        (Some(SCHEMA_VERSION), Some(SCHEMA_CONTRACT)) => Ok(()),
        (version, contract) => Err(unsupported_history_schema_error(version, contract)),
    }
}

fn unsupported_history_schema_error(version: Option<&str>, contract: Option<&str>) -> KernelError {
    let received = format!("version={version:?}, contract={contract:?}");
    KernelError::Structured {
        code: "unsupported_history_schema",
        stage: "validate_schema_meta",
        message: format!(
            "unsupported Kernel history schema: expected version={SCHEMA_VERSION:?}, \
             contract={SCHEMA_CONTRACT:?}; received {received}"
        ),
        details: serde_json::json!({
            "expectedVersion": SCHEMA_VERSION,
            "expectedContract": SCHEMA_CONTRACT,
            "receivedVersion": version,
            "receivedContract": contract,
        }),
    }
}

fn unsupported_existing_history_schema_error(
    version: Option<&str>,
    contract: Option<&str>,
    abi_version: Option<&str>,
    reason: String,
) -> KernelError {
    KernelError::Structured {
        code: "unsupported_history_schema",
        stage: "preflight_existing_schema",
        message: format!(
            "existing Kernel history is not the exact live schema and was not opened: {reason}"
        ),
        details: serde_json::json!({
            "expectedVersion": SCHEMA_VERSION,
            "expectedContract": SCHEMA_CONTRACT,
            "expectedAbiVersion": KERNEL_ABI_V2_VERSION,
            "receivedVersion": version,
            "receivedContract": contract,
            "receivedAbiVersion": abi_version,
            "reason": reason,
        }),
    }
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
        "SELECT ledger_sequence, run_id, run_sequence, fact_id, command_request_id,
                operation_id, invocation_id, attempt_id,
                causation_id, idempotency_key_hash, correlation_refs_json, control_epoch,
                resource_ids_json, fact_kind, recorded_at, envelope_json
         FROM kernel_facts LIMIT 0",
        "SELECT run_id, run_sequence_high_water, control_epoch,
                last_ledger_sequence, state_json
         FROM run_state LIMIT 0",
        "SELECT invocation_id, run_id, status, last_ledger_sequence, state_json
         FROM invocation_state LIMIT 0",
        "SELECT resource_id, run_id, status, last_ledger_sequence, state_json
         FROM resource_state LIMIT 0",
        "SELECT command_request_id, command_request_digest, command_kind, run_id,
                reply_json, settlement_fact_id, recorded_at
         FROM public_command_receipts LIMIT 0",
        "SELECT token_hash, run_id, snapshot_high_water,
                after_ledger_sequence, created_at, expires_at
         FROM fact_query_continuations LIMIT 0",
        "SELECT token_hash, command_request_id, command_request_digest, consumed_at
         FROM fact_query_continuation_consumptions LIMIT 0",
        "SELECT material_kind, material_id, run_id, control_epoch, lifecycle,
                operation_id, invocation_id, lease_id, lease_version,
                lease_scope_digest, payload_digest, payload_json,
                source_fact_id, last_fact_id, last_ledger_sequence
         FROM authority_material LIMIT 0",
        "SELECT ledger_sequence, fact_id, envelope_json, published_at,
                publish_attempts, last_error
         FROM outbox LIMIT 0",
    ];
    for query in required_queries {
        connection
            .prepare(query)
            .map_err(|error| store_error("validate_schema_contract", error))?;
    }
    for trigger in [
        "kernel_facts_reject_update",
        "kernel_facts_reject_delete",
        "public_command_receipts_reject_update",
        "public_command_receipts_reject_delete",
        "fact_query_continuations_reject_update",
        "fact_query_continuation_consumptions_reject_update",
        "authority_material_reject_delete",
    ] {
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
    for trigger in [
        "fact_query_continuations_reject_delete",
        "fact_query_continuation_consumptions_reject_delete",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND name = ?1",
                params![trigger],
                |row| row.get(0),
            )
            .map_err(|error| store_error("validate_forbidden_trigger", error))?;
        if exists != 0 {
            return Err(store_error_message(
                "validate_forbidden_trigger",
                format!("obsolete trigger {trigger} changes the live private-store contract"),
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
    validate_fact_drafts(&drafts)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| store_error("begin_append", error))?;
    let envelopes = append_batch_in_transaction(&transaction, drafts)?;
    transaction
        .commit()
        .map_err(|error| store_error("commit_append", error))?;
    Ok(envelopes)
}

fn validate_fact_drafts(drafts: &[KernelFactDraftV2]) -> KernelResult<()> {
    for draft in drafts {
        draft
            .payload
            .validate()
            .map_err(|error| invalid_fact_error("validate_fact_draft", error.to_string()))?;
    }
    Ok(())
}

fn append_batch_in_transaction(
    transaction: &Transaction<'_>,
    drafts: Vec<KernelFactDraftV2>,
) -> KernelResult<Vec<KernelFactEnvelopeV2>> {
    let global_high_water = transaction
        .query_row(
            "SELECT COALESCE(MAX(ledger_sequence), 0) FROM kernel_facts",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| store_error("read_ledger_high_water", error))?;
    let mut next_ledger_sequence = sqlite_u64(global_high_water, "ledgerSequence")?;
    let batch_len = u64::try_from(drafts.len()).map_err(|_| {
        store_error_message(
            "allocate_ledger_sequence",
            "fact batch length exceeds the supported sequence range",
        )
    })?;
    let final_ledger_sequence = next_ledger_sequence.checked_add(batch_len).ok_or_else(|| {
        store_error_message("allocate_ledger_sequence", "ledger sequence overflow")
    })?;
    validate_cross_language_safe_u64_v2("ledgerSequence", final_ledger_sequence)
        .map_err(|error| invalid_fact_error("allocate_ledger_sequence", error.to_string()))?;
    let recorded_at = transaction
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| store_error("record_transaction_time", error))
        .and_then(|value| {
            RecordedAtV2::new(value)
                .map_err(|error| invalid_fact_error("record_transaction_time", error.to_string()))
        })?;
    let mut run_batch_counts = BTreeMap::<String, u64>::new();
    for draft in &drafts {
        let count = run_batch_counts
            .entry(draft.payload.run_id().as_str().to_owned())
            .or_default();
        *count = count.checked_add(1).ok_or_else(|| {
            store_error_message("allocate_run_sequence", "run fact batch length overflow")
        })?;
    }
    let mut run_high_waters = BTreeMap::<String, u64>::new();
    for (run_id, batch_count) in run_batch_counts {
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
        let final_run_sequence = high_water
            .checked_add(batch_count)
            .ok_or_else(|| store_error_message("allocate_run_sequence", "run sequence overflow"))?;
        validate_cross_language_safe_u64_v2("runSequence", final_run_sequence)
            .map_err(|error| invalid_fact_error("allocate_run_sequence", error.to_string()))?;
        run_high_waters.insert(run_id, high_water);
    }
    let mut envelopes = Vec::with_capacity(drafts.len());

    for draft in drafts {
        let run_id = draft.payload.run_id().as_str().to_string();
        let run_high_water = run_high_waters
            .get(&run_id)
            .copied()
            .ok_or_else(|| store_error_message("allocate_run_sequence", "run batch missing"))?;
        next_ledger_sequence = next_ledger_sequence.checked_add(1).ok_or_else(|| {
            store_error_message("allocate_ledger_sequence", "ledger sequence overflow")
        })?;
        let run_sequence = run_high_water
            .checked_add(1)
            .ok_or_else(|| store_error_message("allocate_run_sequence", "run sequence overflow"))?;
        let envelope = KernelFactEnvelopeV2 {
            abi_version: KERNEL_ABI_V2_VERSION.to_owned(),
            fact_id: draft.fact_id,
            ledger_sequence: next_ledger_sequence,
            run_sequence,
            recorded_at: recorded_at.clone(),
            payload: draft.payload,
        };
        envelope
            .validate()
            .map_err(|error| invalid_fact_error("assign_fact_sequences", error.to_string()))?;
        persist_envelope(transaction, &envelope)?;
        run_high_waters.insert(run_id, run_sequence);
        envelopes.push(envelope);
    }
    Ok(envelopes)
}

fn append_with_public_command_receipt_transaction(
    connection: &mut Connection,
    drafts: Vec<KernelFactDraftV2>,
    mut receipt: PublicCommandReceiptV2,
) -> KernelResult<AppendWithPublicCommandReceiptOutcomeV2> {
    validate_fact_drafts(&drafts)?;
    if let Some(first) = drafts.first() {
        let draft_run_id = first.payload.run_id();
        if drafts
            .iter()
            .any(|draft| draft.payload.run_id() != draft_run_id)
        {
            return Err(store_error_message(
                "append_with_public_command_receipt",
                "one public command cannot append facts for multiple runs",
            ));
        }
        match &receipt.run_id {
            Some(receipt_run_id) if receipt_run_id != draft_run_id => {
                return Err(store_error_message(
                    "append_with_public_command_receipt",
                    "receipt runId does not match its canonical fact batch",
                ));
            }
            Some(_) => {}
            None => receipt.run_id = Some(draft_run_id.clone()),
        }
    }
    validate_public_command_receipt(&receipt)?;
    if receipt.command_kind == "runOpen" && receipt.settlement_fact_id.is_none() {
        return Err(store_error_message(
            "append_with_public_command_receipt",
            "runOpen must identify its durable RunOpened settlement fact",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| store_error("begin_append_with_public_command_receipt", error))?;

    if let Some(existing) = read_public_command_receipt(&transaction, &receipt.command_request_id)?
    {
        let outcome = compare_public_command_receipt(existing, &receipt);
        transaction
            .commit()
            .map_err(|error| store_error("commit_public_command_receipt_replay", error))?;
        return Ok(AppendWithPublicCommandReceiptOutcomeV2 {
            facts: Vec::new(),
            receipt: outcome,
        });
    }

    let facts = append_batch_in_transaction(&transaction, drafts)?;
    let receipt = put_public_command_receipt_in_transaction(&transaction, receipt)?;
    transaction
        .commit()
        .map_err(|error| store_error("commit_append_with_public_command_receipt", error))?;
    Ok(AppendWithPublicCommandReceiptOutcomeV2 { facts, receipt })
}

fn append_with_authority_material_transaction(
    connection: &mut Connection,
    drafts: Vec<KernelFactDraftV2>,
    mutations: Vec<AuthorityMaterialMutationV2>,
) -> KernelResult<AppendWithAuthorityMaterialOutcomeV2> {
    validate_fact_drafts(&drafts)?;
    validate_authority_material_mutations(&mutations, drafts.len())?;
    if drafts.is_empty() {
        return Err(store_error_message(
            "append_with_authority_material",
            "authority material mutations require at least one canonical fact",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| store_error("begin_append_with_authority_material", error))?;
    let facts = append_batch_in_transaction(&transaction, drafts)?;
    apply_authority_material_mutations(&transaction, &facts, mutations)?;
    transaction
        .commit()
        .map_err(|error| store_error("commit_append_with_authority_material", error))?;
    Ok(AppendWithAuthorityMaterialOutcomeV2 { facts })
}

fn append_with_public_receipt_and_authority_material_transaction(
    connection: &mut Connection,
    drafts: Vec<KernelFactDraftV2>,
    mut receipt: PublicCommandReceiptV2,
    mutations: Vec<AuthorityMaterialMutationV2>,
) -> KernelResult<AppendWithPublicReceiptAndAuthorityMaterialOutcomeV2> {
    validate_fact_drafts(&drafts)?;
    validate_authority_material_mutations(&mutations, drafts.len())?;
    if drafts.is_empty() {
        return Err(store_error_message(
            "append_with_public_receipt_and_authority_material",
            "authority material mutations require at least one canonical fact",
        ));
    }
    let first_run_id = drafts
        .first()
        .map(|draft| draft.payload.run_id().clone())
        .ok_or_else(|| {
            store_error_message(
                "append_with_public_receipt_and_authority_material",
                "canonical fact batch must not be empty",
            )
        })?;
    if drafts
        .iter()
        .any(|draft| draft.payload.run_id() != &first_run_id)
    {
        return Err(store_error_message(
            "append_with_public_receipt_and_authority_material",
            "one public command cannot append facts for multiple runs",
        ));
    }
    match &receipt.run_id {
        Some(run_id) if run_id != &first_run_id => {
            return Err(store_error_message(
                "append_with_public_receipt_and_authority_material",
                "receipt runId does not match its canonical fact batch",
            ));
        }
        Some(_) => {}
        None => receipt.run_id = Some(first_run_id),
    }
    validate_public_command_receipt(&receipt)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            store_error(
                "begin_append_with_public_receipt_and_authority_material",
                error,
            )
        })?;
    if let Some(existing) = read_public_command_receipt(&transaction, &receipt.command_request_id)?
    {
        let outcome = compare_public_command_receipt(existing, &receipt);
        transaction.commit().map_err(|error| {
            store_error("commit_public_receipt_and_authority_material_replay", error)
        })?;
        return Ok(AppendWithPublicReceiptAndAuthorityMaterialOutcomeV2 {
            facts: Vec::new(),
            receipt: outcome,
        });
    }
    let facts = append_batch_in_transaction(&transaction, drafts)?;
    apply_authority_material_mutations(&transaction, &facts, mutations)?;
    let receipt = put_public_command_receipt_in_transaction(&transaction, receipt)?;
    transaction.commit().map_err(|error| {
        store_error(
            "commit_append_with_public_receipt_and_authority_material",
            error,
        )
    })?;
    Ok(AppendWithPublicReceiptAndAuthorityMaterialOutcomeV2 { facts, receipt })
}

fn validate_authority_material_mutations(
    mutations: &[AuthorityMaterialMutationV2],
    fact_count: usize,
) -> KernelResult<()> {
    for mutation in mutations {
        match mutation {
            AuthorityMaterialMutationV2::Put {
                material,
                fact_index,
            } => {
                validate_authority_material_draft(material)?;
                validate_authority_material_fact_index(*fact_index, fact_count)?;
            }
            AuthorityMaterialMutationV2::Replace {
                expected_lifecycle,
                expected_payload_digest,
                material,
                fact_index,
            } => {
                validate_authority_material_token("expectedLifecycle", expected_lifecycle)?;
                if let Some(digest) = expected_payload_digest {
                    validate_sha256_text("expectedPayloadDigest", digest)?;
                }
                validate_authority_material_draft(material)?;
                validate_authority_material_fact_index(*fact_index, fact_count)?;
            }
            AuthorityMaterialMutationV2::TransitionRunEpoch {
                through_control_epoch,
                expected_lifecycles,
                next_lifecycle,
                fact_index,
                ..
            } => {
                if *through_control_epoch == 0 || expected_lifecycles.is_empty() {
                    return Err(store_error_message(
                        "validate_authority_material_mutation",
                        "run-epoch transition requires a non-zero epoch and lifecycle set",
                    ));
                }
                validate_cross_language_safe_u64_v2("controlEpoch", *through_control_epoch)
                    .map_err(|error| {
                        invalid_fact_error(
                            "validate_authority_material_mutation",
                            error.to_string(),
                        )
                    })?;
                for lifecycle in expected_lifecycles {
                    validate_authority_material_token("expectedLifecycle", lifecycle)?;
                }
                validate_authority_material_token("nextLifecycle", next_lifecycle)?;
                validate_authority_material_fact_index(*fact_index, fact_count)?;
            }
        }
    }
    Ok(())
}

fn validate_authority_material_fact_index(
    fact_index: usize,
    fact_count: usize,
) -> KernelResult<()> {
    if fact_index >= fact_count {
        Err(store_error_message(
            "validate_authority_material_mutation",
            "authority material factIndex is outside its canonical fact batch",
        ))
    } else {
        Ok(())
    }
}

fn validate_authority_material_draft(material: &AuthorityMaterialDraftV2) -> KernelResult<()> {
    validate_authority_material_token("materialKind", &material.material_kind)?;
    validate_authority_material_token("materialId", &material.material_id)?;
    validate_authority_material_token("lifecycle", &material.lifecycle)?;
    if material.control_epoch == 0 {
        return Err(store_error_message(
            "validate_authority_material",
            "controlEpoch must be greater than zero",
        ));
    }
    validate_cross_language_safe_u64_v2("controlEpoch", material.control_epoch)
        .map_err(|error| invalid_fact_error("validate_authority_material", error.to_string()))?;
    if !material.payload_json.is_object() {
        return Err(store_error_message(
            "validate_authority_material",
            "payloadJson must be an object",
        ));
    }
    validate_cross_language_safe_json_value_v2("payloadJson", &material.payload_json)
        .map_err(|error| invalid_fact_error("validate_authority_material", error.to_string()))?;
    if contains_ephemeral_capability(&material.payload_json) {
        return Err(store_error_message(
            "validate_authority_material",
            "payloadJson must not contain an ephemeral capability or credential",
        ));
    }
    let encoded = serde_json::to_vec(&material.payload_json)
        .map_err(|error| store_error_message("encode_authority_material", error.to_string()))?;
    if encoded.len() > MAX_AUTHORITY_MATERIAL_PAYLOAD_BYTES {
        return Err(store_error_message(
            "validate_authority_material",
            format!("payloadJson exceeds the {MAX_AUTHORITY_MATERIAL_PAYLOAD_BYTES} byte boundary"),
        ));
    }
    Ok(())
}

fn validate_authority_material_token(field: &str, value: &str) -> KernelResult<()> {
    if value.is_empty()
        || value.len() > MAX_AUTHORITY_MATERIAL_TOKEN_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        Err(store_error_message(
            "validate_authority_material",
            format!("{field} must be a 1..={MAX_AUTHORITY_MATERIAL_TOKEN_BYTES} byte ASCII token"),
        ))
    } else {
        Ok(())
    }
}

fn validate_sha256_text(field: &str, value: &str) -> KernelResult<()> {
    if value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    }) {
        Ok(())
    } else {
        Err(store_error_message(
            "validate_authority_material",
            format!("{field} must be sha256:<64 lowercase hex>"),
        ))
    }
}

fn authority_material_payload_digest(
    material_kind: &str,
    material_id: &str,
    payload_json: &serde_json::Value,
) -> KernelResult<String> {
    query_digest_v2(&serde_json::json!({
        "domain": "deepcode.kernel.authority-material.v2",
        "materialKind": material_kind,
        "materialId": material_id,
        "payload": payload_json,
    }))
    .map(|digest| digest.as_str().to_owned())
    .map_err(|error| invalid_fact_error("digest_authority_material", error.to_string()))
}

fn apply_authority_material_mutations(
    transaction: &Transaction<'_>,
    facts: &[KernelFactEnvelopeV2],
    mutations: Vec<AuthorityMaterialMutationV2>,
) -> KernelResult<()> {
    for mutation in mutations {
        match mutation {
            AuthorityMaterialMutationV2::Put {
                material,
                fact_index,
            } => {
                let fact = &facts[fact_index];
                require_authority_material_fact_run(&material.run_id, fact)?;
                insert_authority_material(transaction, material, fact)?;
            }
            AuthorityMaterialMutationV2::Replace {
                expected_lifecycle,
                expected_payload_digest,
                material,
                fact_index,
            } => {
                let fact = &facts[fact_index];
                require_authority_material_fact_run(&material.run_id, fact)?;
                replace_authority_material(
                    transaction,
                    expected_lifecycle,
                    expected_payload_digest,
                    material,
                    fact,
                )?;
            }
            AuthorityMaterialMutationV2::TransitionRunEpoch {
                run_id,
                through_control_epoch,
                expected_lifecycles,
                next_lifecycle,
                fact_index,
            } => {
                let fact = &facts[fact_index];
                require_authority_material_fact_run(&run_id, fact)?;
                transition_authority_material_run_epoch(
                    transaction,
                    &run_id,
                    through_control_epoch,
                    &expected_lifecycles,
                    &next_lifecycle,
                    fact,
                )?;
            }
        }
    }
    Ok(())
}

fn require_authority_material_fact_run(
    run_id: &RunId,
    fact: &KernelFactEnvelopeV2,
) -> KernelResult<()> {
    if fact.payload.run_id() == run_id {
        Ok(())
    } else {
        Err(store_error_message(
            "apply_authority_material",
            "authority material and its causal fact must belong to the same run",
        ))
    }
}

fn insert_authority_material(
    transaction: &Transaction<'_>,
    material: AuthorityMaterialDraftV2,
    fact: &KernelFactEnvelopeV2,
) -> KernelResult<()> {
    let payload_digest = authority_material_payload_digest(
        &material.material_kind,
        &material.material_id,
        &material.payload_json,
    )?;
    let payload_json = serde_json::to_string(&material.payload_json)
        .map_err(|error| store_error_message("encode_authority_material", error.to_string()))?;
    let changed = transaction
        .execute(
            "INSERT INTO authority_material (
                 material_kind, material_id, run_id, control_epoch, lifecycle,
                 operation_id, invocation_id, lease_id, lease_version,
                 lease_scope_digest, payload_digest, payload_json,
                 source_fact_id, last_fact_id, last_ledger_sequence
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?13, ?14
             )",
            params![
                material.material_kind,
                material.material_id,
                material.run_id.as_str(),
                sqlite_integer(material.control_epoch, "controlEpoch")?,
                material.lifecycle,
                material.operation_id.as_ref().map(|value| value.as_str()),
                material.invocation_id.as_ref().map(|value| value.as_str()),
                material.lease.as_ref().map(|value| value.lease_id.as_str()),
                material
                    .lease
                    .as_ref()
                    .map(|value| sqlite_integer(value.version.get(), "leaseVersion"))
                    .transpose()?,
                material
                    .lease
                    .as_ref()
                    .map(|value| value.scope_digest.as_str()),
                payload_digest,
                payload_json,
                fact.fact_id.as_str(),
                sqlite_integer(fact.ledger_sequence, "lastLedgerSequence")?,
            ],
        )
        .map_err(|error| store_error("insert_authority_material", error))?;
    if changed != 1 {
        return Err(store_error_message(
            "insert_authority_material",
            "authority material insert did not affect exactly one row",
        ));
    }
    Ok(())
}

fn is_versioned_lease_replacement(
    existing: &AuthorityMaterialRecordV2,
    replacement: &AuthorityMaterialDraftV2,
    fact: &KernelFactEnvelopeV2,
) -> bool {
    let (
        Some(previous_lease),
        Some(expanded_lease),
        KernelFactPayloadV2::Authorization(AuthorizationFactV2::ExpansionAllowed {
            identity,
            previous_lease_id,
            previous_scope_digest,
            expanded_scope_digest,
            ..
        }),
    ) = (&existing.lease, &replacement.lease, &fact.payload)
    else {
        return false;
    };

    existing.material_kind == CAPABILITY_LEASE_AUTHORITY_MATERIAL_KIND
        && replacement.material_kind == CAPABILITY_LEASE_AUTHORITY_MATERIAL_KIND
        && existing.material_id == replacement.material_id
        && existing.material_id == previous_lease.lease_id.as_str()
        && replacement.material_id == expanded_lease.lease_id.as_str()
        && existing.run_id == replacement.run_id
        && existing.control_epoch == replacement.control_epoch
        && existing.lifecycle == replacement.lifecycle
        && existing.invocation_id.is_none()
        && replacement.invocation_id.is_none()
        && replacement.operation_id.as_ref() == Some(&identity.operation_id)
        && identity.run_id == replacement.run_id
        && identity.control_epoch.get() == replacement.control_epoch
        && previous_lease.lease_id == expanded_lease.lease_id
        && previous_lease.lease_id == identity.lease_id
        && previous_lease_id == &previous_lease.lease_id
        && previous_lease.scope_digest == *previous_scope_digest
        && expanded_lease.scope_digest == *expanded_scope_digest
        && previous_scope_digest != expanded_scope_digest
        && expanded_lease.version == identity.lease_version
        && previous_lease
            .version
            .get()
            .checked_add(1)
            .is_some_and(|next| next == expanded_lease.version.get())
}

fn replace_authority_material(
    transaction: &Transaction<'_>,
    expected_lifecycle: String,
    expected_payload_digest: Option<String>,
    material: AuthorityMaterialDraftV2,
    fact: &KernelFactEnvelopeV2,
) -> KernelResult<()> {
    let existing = read_authority_material_record(
        transaction,
        &material.material_kind,
        &material.material_id,
    )?
    .ok_or_else(|| {
        store_error_message(
            "replace_authority_material",
            "authority material identity does not exist",
        )
    })?;
    let stable_subject = existing.operation_id == material.operation_id
        && existing.invocation_id == material.invocation_id;
    if existing.lifecycle != expected_lifecycle
        || expected_payload_digest
            .as_ref()
            .is_some_and(|digest| digest != &existing.payload_digest)
        || existing.run_id != material.run_id
        || existing.control_epoch != material.control_epoch
        || (!stable_subject && !is_versioned_lease_replacement(&existing, &material, fact))
    {
        return Err(store_error_message(
            "replace_authority_material",
            "authority material compare-and-set precondition failed",
        ));
    }
    let payload_digest = authority_material_payload_digest(
        &material.material_kind,
        &material.material_id,
        &material.payload_json,
    )?;
    let payload_json = serde_json::to_string(&material.payload_json)
        .map_err(|error| store_error_message("encode_authority_material", error.to_string()))?;
    let changed = transaction
        .execute(
            "UPDATE authority_material
             SET lifecycle = ?3,
                 operation_id = ?4,
                 invocation_id = ?5,
                 lease_id = ?6,
                 lease_version = ?7,
                 lease_scope_digest = ?8,
                 payload_digest = ?9,
                 payload_json = ?10,
                 last_fact_id = ?11,
                 last_ledger_sequence = ?12
             WHERE material_kind = ?1 AND material_id = ?2
               AND lifecycle = ?13 AND payload_digest = ?14",
            params![
                material.material_kind,
                material.material_id,
                material.lifecycle,
                material.operation_id.as_ref().map(|value| value.as_str()),
                material.invocation_id.as_ref().map(|value| value.as_str()),
                material.lease.as_ref().map(|value| value.lease_id.as_str()),
                material
                    .lease
                    .as_ref()
                    .map(|value| sqlite_integer(value.version.get(), "leaseVersion"))
                    .transpose()?,
                material
                    .lease
                    .as_ref()
                    .map(|value| value.scope_digest.as_str()),
                payload_digest,
                payload_json,
                fact.fact_id.as_str(),
                sqlite_integer(fact.ledger_sequence, "lastLedgerSequence")?,
                expected_lifecycle,
                existing.payload_digest,
            ],
        )
        .map_err(|error| store_error("replace_authority_material", error))?;
    if changed != 1 {
        return Err(store_error_message(
            "replace_authority_material",
            "authority material compare-and-set lost its transaction precondition",
        ));
    }
    Ok(())
}

fn transition_authority_material_run_epoch(
    transaction: &Transaction<'_>,
    run_id: &RunId,
    through_control_epoch: u64,
    expected_lifecycles: &[String],
    next_lifecycle: &str,
    fact: &KernelFactEnvelopeV2,
) -> KernelResult<()> {
    let placeholders = (0..expected_lifecycles.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let statement = format!(
        "UPDATE authority_material
         SET lifecycle = ?1, last_fact_id = ?2, last_ledger_sequence = ?3
         WHERE run_id = ?4 AND control_epoch <= ?5
           AND lifecycle IN ({placeholders})"
    );
    let mut values = vec![
        SqlValue::Text(next_lifecycle.to_owned()),
        SqlValue::Text(fact.fact_id.to_string()),
        SqlValue::Integer(sqlite_integer(fact.ledger_sequence, "lastLedgerSequence")?),
        SqlValue::Text(run_id.to_string()),
        SqlValue::Integer(sqlite_integer(
            through_control_epoch,
            "throughControlEpoch",
        )?),
    ];
    values.extend(expected_lifecycles.iter().cloned().map(SqlValue::Text));
    transaction
        .execute(&statement, params_from_iter(values))
        .map_err(|error| store_error("transition_authority_material_run_epoch", error))?;
    Ok(())
}

fn read_authority_material_record(
    connection: &Connection,
    material_kind: &str,
    material_id: &str,
) -> KernelResult<Option<AuthorityMaterialRecordV2>> {
    Ok(read_authority_material_snapshot(connection)?
        .into_iter()
        .find(|record| record.material_kind == material_kind && record.material_id == material_id))
}

fn read_authority_material_snapshot(
    connection: &Connection,
) -> KernelResult<Vec<AuthorityMaterialRecordV2>> {
    let mut statement = connection
        .prepare(
            "SELECT material.material_kind, material.material_id, material.run_id,
                    material.control_epoch, material.lifecycle, material.operation_id,
                    material.invocation_id, material.lease_id, material.lease_version,
                    material.lease_scope_digest, material.payload_digest,
                    material.payload_json, material.source_fact_id,
                    material.last_fact_id, material.last_ledger_sequence,
                    source.run_id, source.ledger_sequence,
                    latest.run_id, latest.ledger_sequence
             FROM authority_material AS material
             JOIN kernel_facts AS source
               ON source.fact_id = material.source_fact_id
             JOIN kernel_facts AS latest
               ON latest.fact_id = material.last_fact_id
             ORDER BY material.run_id, material.control_epoch,
                      material.material_kind, material.material_id",
        )
        .map_err(|error| store_error("prepare_authority_material_snapshot", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, i64>(14)?,
                row.get::<_, String>(15)?,
                row.get::<_, i64>(16)?,
                row.get::<_, String>(17)?,
                row.get::<_, i64>(18)?,
            ))
        })
        .map_err(|error| store_error("query_authority_material_snapshot", error))?;
    let mut records = Vec::new();
    for row in rows {
        let (
            material_kind,
            material_id,
            run_id,
            control_epoch,
            lifecycle,
            operation_id,
            invocation_id,
            lease_id,
            lease_version,
            lease_scope_digest,
            payload_digest,
            payload_json,
            source_fact_id,
            last_fact_id,
            last_ledger_sequence,
            source_run_id,
            source_ledger_sequence,
            last_run_id,
            canonical_last_ledger_sequence,
        ) = row.map_err(|error| store_error("read_authority_material_snapshot", error))?;
        validate_authority_material_token("materialKind", &material_kind)?;
        validate_authority_material_token("materialId", &material_id)?;
        validate_authority_material_token("lifecycle", &lifecycle)?;
        validate_sha256_text("payloadDigest", &payload_digest)?;
        let run_id = RunId::new(run_id)
            .map_err(|error| invalid_fact_error("decode_authority_material", error.to_string()))?;
        if source_run_id != run_id.as_str() || last_run_id != run_id.as_str() {
            return Err(store_error_message(
                "decode_authority_material",
                "authority material causal facts belong to a different run",
            ));
        }
        let control_epoch = sqlite_u64(control_epoch, "controlEpoch")?;
        if control_epoch == 0 {
            return Err(store_error_message(
                "decode_authority_material",
                "authority material controlEpoch must be greater than zero",
            ));
        }
        let source_ledger_sequence = sqlite_u64(source_ledger_sequence, "sourceLedgerSequence")?;
        let last_ledger_sequence = sqlite_u64(last_ledger_sequence, "lastLedgerSequence")?;
        let canonical_last_ledger_sequence = sqlite_u64(
            canonical_last_ledger_sequence,
            "canonicalLastLedgerSequence",
        )?;
        if last_ledger_sequence != canonical_last_ledger_sequence
            || last_ledger_sequence < source_ledger_sequence
        {
            return Err(store_error_message(
                "decode_authority_material",
                "authority material fact lineage or ledger sequence is inconsistent",
            ));
        }
        let payload_json: serde_json::Value =
            serde_json::from_str(&payload_json).map_err(|error| {
                store_error_message("decode_authority_material_payload", error.to_string())
            })?;
        let draft = AuthorityMaterialDraftV2 {
            material_kind: material_kind.clone(),
            material_id: material_id.clone(),
            run_id: run_id.clone(),
            control_epoch,
            lifecycle: lifecycle.clone(),
            operation_id: operation_id
                .map(deepcode_kernel_abi::v2::OperationId::new)
                .transpose()
                .map_err(|error| {
                    invalid_fact_error("decode_authority_material", error.to_string())
                })?,
            invocation_id: invocation_id
                .map(deepcode_kernel_abi::v2::InvocationId::new)
                .transpose()
                .map_err(|error| {
                    invalid_fact_error("decode_authority_material", error.to_string())
                })?,
            lease: match (lease_id, lease_version, lease_scope_digest) {
                (None, None, None) => None,
                (Some(lease_id), Some(lease_version), Some(scope_digest)) => {
                    Some(CapabilityLeaseRefV2 {
                        lease_id: CapabilityLeaseIdV2::new(lease_id).map_err(|error| {
                            invalid_fact_error("decode_authority_material", error.to_string())
                        })?,
                        version: CapabilityLeaseVersionV2::new(sqlite_u64(
                            lease_version,
                            "leaseVersion",
                        )?)
                        .map_err(|error| {
                            invalid_fact_error("decode_authority_material", error.to_string())
                        })?,
                        scope_digest: CapabilityScopeDigestV2::parse(scope_digest).map_err(
                            |error| {
                                invalid_fact_error("decode_authority_material", error.to_string())
                            },
                        )?,
                    })
                }
                _ => {
                    return Err(store_error_message(
                        "decode_authority_material",
                        "partial capability lease identity is forbidden",
                    ))
                }
            },
            payload_json: payload_json.clone(),
        };
        validate_authority_material_draft(&draft)?;
        let computed_digest =
            authority_material_payload_digest(&material_kind, &material_id, &payload_json)?;
        if computed_digest != payload_digest {
            return Err(store_error_message(
                "decode_authority_material",
                "authority material payload digest does not match payloadJson",
            ));
        }
        records.push(AuthorityMaterialRecordV2 {
            material_kind,
            material_id,
            run_id,
            control_epoch,
            lifecycle,
            operation_id: draft.operation_id,
            invocation_id: draft.invocation_id,
            lease: draft.lease,
            payload_digest,
            payload_json,
            source_fact_id: FactId::new(source_fact_id).map_err(|error| {
                invalid_fact_error("decode_authority_material", error.to_string())
            })?,
            last_fact_id: FactId::new(last_fact_id).map_err(|error| {
                invalid_fact_error("decode_authority_material", error.to_string())
            })?,
            last_ledger_sequence,
        });
    }
    Ok(records)
}

fn put_public_command_receipt_transaction(
    connection: &mut Connection,
    receipt: PublicCommandReceiptV2,
) -> KernelResult<PutPublicCommandReceiptOutcomeV2> {
    validate_public_command_receipt(&receipt)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| store_error("begin_put_public_command_receipt", error))?;
    let outcome = put_public_command_receipt_in_transaction(&transaction, receipt)?;
    transaction
        .commit()
        .map_err(|error| store_error("commit_put_public_command_receipt", error))?;
    Ok(outcome)
}

fn put_public_command_receipt_in_transaction(
    transaction: &Transaction<'_>,
    mut receipt: PublicCommandReceiptV2,
) -> KernelResult<PutPublicCommandReceiptOutcomeV2> {
    if let Some(existing) = read_public_command_receipt(transaction, &receipt.command_request_id)? {
        return Ok(compare_public_command_receipt(existing, &receipt));
    }

    validate_public_command_receipt_settlement(transaction, &mut receipt)?;
    let encoded = serde_json::to_string(&receipt.reply_json)
        .map_err(|error| store_error_message("encode_public_command_reply", error.to_string()))?;
    transaction
        .execute(
            "INSERT INTO public_command_receipts (
                 command_request_id, command_request_digest, command_kind, run_id,
                 reply_json, settlement_fact_id, recorded_at
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             )",
            params![
                receipt.command_request_id.as_str(),
                receipt.command_request_digest.as_str(),
                receipt.command_kind.as_str(),
                receipt.run_id.as_ref().map(RunId::as_str),
                encoded,
                receipt.settlement_fact_id.as_ref().map(FactId::as_str),
            ],
        )
        .map_err(|error| store_error("insert_public_command_receipt", error))?;
    Ok(PutPublicCommandReceiptOutcomeV2::Inserted(receipt))
}

fn validate_public_command_receipt_settlement(
    connection: &Connection,
    receipt: &mut PublicCommandReceiptV2,
) -> KernelResult<()> {
    let mutation_kind = match receipt.command_kind.as_str() {
        "toolIntentSubmit" => Some(MutationCommandKindV2::ToolIntentSubmit),
        "controlEpochAdvance" => Some(MutationCommandKindV2::ControlEpochAdvance),
        "invocationCancel" => Some(MutationCommandKindV2::InvocationCancel),
        _ => None,
    };
    if mutation_kind.is_some() && receipt.settlement_fact_id.is_none() {
        return Err(store_error_message(
            "validate_public_command_receipt",
            "mutation receipt requires its CommandRecorded settlement fact",
        ));
    }
    if let Some(settlement_fact_id) = &receipt.settlement_fact_id {
        let settlement = read_receipt_fact(
            connection,
            settlement_fact_id,
            "read_receipt_settlement_fact",
        )?;
        if let Some(expected_command_kind) = mutation_kind {
            let KernelFactPayloadV2::Control(ControlFactV2::CommandRecorded {
                identity,
                command_kind,
                result,
            }) = &settlement.payload
            else {
                return Err(store_error_message(
                    "validate_public_command_receipt",
                    "mutation settlementFactId must identify its CommandRecorded fact",
                ));
            };
            if command_kind != &expected_command_kind
                || identity.command_request_identity.command_request_id
                    != receipt.command_request_id
                || identity.command_request_identity.command_request_digest
                    != receipt.command_request_digest
            {
                return Err(store_error_message(
                    "validate_public_command_receipt",
                    "mutation receipt identity does not match its CommandRecorded fact",
                ));
            }
            let expected_reply = serde_json::json!({
                "kind": "kernel",
                "data": {
                    "reply": kernel_reply_for_mutation_result(result)
                }
            });
            if receipt.reply_json != expected_reply {
                return Err(store_error_message(
                    "validate_public_command_receipt",
                    "mutation receipt reply does not match its CommandRecorded result",
                ));
            }
            validate_mutation_result_facts(connection, &settlement, result)?;
        }
        if receipt.command_kind == "runOpen" {
            let KernelFactPayloadV2::Control(ControlFactV2::RunOpened {
                public_request_id,
                public_request_digest,
                ..
            }) = &settlement.payload
            else {
                return Err(store_error_message(
                    "validate_public_command_receipt",
                    "runOpen settlementFactId must identify its RunOpened fact",
                ));
            };
            if public_request_id != &receipt.command_request_id
                || public_request_digest != &receipt.command_request_digest
            {
                return Err(store_error_message(
                    "validate_public_command_receipt",
                    "runOpen receipt identity does not match its RunOpened fact",
                ));
            }
        }
        let settlement_run_id = settlement.payload.run_id();
        if let Some(run_id) = &receipt.run_id {
            if run_id != settlement_run_id {
                return Err(store_error_message(
                    "validate_public_command_receipt",
                    "receipt runId does not match its settlement fact",
                ));
            }
        } else {
            receipt.run_id = Some(settlement_run_id.clone());
        }
    }
    if receipt.run_id.is_none() {
        return Err(store_error_message(
            "validate_public_command_receipt",
            "runId is required for every durable public command receipt",
        ));
    }
    Ok(())
}

fn read_receipt_fact(
    connection: &Connection,
    fact_id: &FactId,
    operation: &'static str,
) -> KernelResult<KernelFactEnvelopeV2> {
    let envelope_json = connection
        .query_row(
            "SELECT envelope_json FROM kernel_facts WHERE fact_id = ?1",
            params![fact_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| store_error(operation, error))?
        .ok_or_else(|| {
            store_error_message(
                "validate_public_command_receipt",
                "receipt references a Kernel fact that is not durable",
            )
        })?;
    decode_envelope(&envelope_json, operation)
}

fn kernel_reply_for_mutation_result(result: &MutationCommandResultV2) -> KernelReplyV2 {
    match result {
        MutationCommandResultV2::ToolIntentSubmission { reply } => {
            KernelReplyV2::ToolIntentSubmission(reply.clone())
        }
        MutationCommandResultV2::EpochAdvance { reply } => {
            KernelReplyV2::ControlEpochAdvanced(reply.clone())
        }
        MutationCommandResultV2::InvocationCancel { reply } => {
            KernelReplyV2::InvocationCancelResult(reply.clone())
        }
        MutationCommandResultV2::RecordedSemanticError { error } => {
            KernelReplyV2::Error(kernel_error_for_recorded_error(error))
        }
    }
}

fn kernel_error_for_recorded_error(error: &RecordedCommandErrorV2) -> KernelErrorV2 {
    match error {
        RecordedCommandErrorV2::ControlEpochAlreadyExists { run_id, current } => {
            KernelErrorV2::ControlEpochAlreadyExists {
                run_id: run_id.clone(),
                current: *current,
            }
        }
        RecordedCommandErrorV2::ControlEpochExhausted { run_id, current } => {
            KernelErrorV2::ControlEpochExhausted {
                run_id: run_id.clone(),
                current: *current,
            }
        }
        RecordedCommandErrorV2::StaleControlEpoch {
            run_id,
            submitted,
            current,
        } => KernelErrorV2::StaleControlEpoch {
            run_id: run_id.clone(),
            submitted: *submitted,
            current: *current,
        },
        RecordedCommandErrorV2::InvocationNotFound {
            run_id,
            invocation_id,
        } => KernelErrorV2::InvocationNotFound {
            run_id: run_id.clone(),
            invocation_id: invocation_id.clone(),
        },
        RecordedCommandErrorV2::InvocationNotOwnedByRun {
            run_id,
            invocation_id,
        } => KernelErrorV2::InvocationNotOwnedByRun {
            run_id: run_id.clone(),
            invocation_id: invocation_id.clone(),
        },
    }
}

fn validate_mutation_result_facts(
    connection: &Connection,
    command: &KernelFactEnvelopeV2,
    result: &MutationCommandResultV2,
) -> KernelResult<()> {
    match result {
        MutationCommandResultV2::ToolIntentSubmission { reply } => match reply {
            ToolIntentSubmitReplyV2::Admitted {
                run_id,
                operation_id,
                accepted_control_epoch,
                invocation_id,
                attempt_id,
                admission_fact_id,
                admission_batch_high_water,
                ..
            } => {
                let admission =
                    read_receipt_fact(connection, admission_fact_id, "read_admission_fact")?;
                let KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIntentAdmitted {
                    identity,
                    ..
                }) = &admission.payload
                else {
                    return Err(receipt_fact_mismatch(
                        "admissionFactId must identify ToolIntentAdmitted",
                    ));
                };
                if identity.run_id != *run_id
                    || identity.control_epoch != *accepted_control_epoch
                    || identity.operation_id != *operation_id
                    || identity.invocation_id != *invocation_id
                    || identity.attempt_id != *attempt_id
                    || identity.causation_fact_id != command.fact_id
                    || admission.ledger_sequence > *admission_batch_high_water
                {
                    return Err(receipt_fact_mismatch(
                        "admitted reply does not match ToolIntentAdmitted identity",
                    ));
                }
                require_batch_high_water(connection, run_id, *admission_batch_high_water)?;
            }
            ToolIntentSubmitReplyV2::AwaitingCapability {
                run_id,
                operation_id,
                accepted_control_epoch,
                invocation_id,
                preview,
                awaiting_fact_id,
                awaiting_batch_high_water,
            } => {
                let awaiting =
                    read_receipt_fact(connection, awaiting_fact_id, "read_awaiting_fact")?;
                let KernelFactPayloadV2::Authorization(AuthorizationFactV2::CapabilityAwaiting {
                    identity,
                    preview_id,
                    tool_id,
                    canonical_arguments_digest: _,
                    scope_digest,
                    tool_contract_digest,
                    context_ref,
                }) = &awaiting.payload
                else {
                    return Err(receipt_fact_mismatch(
                        "awaitingFactId must identify CapabilityAwaiting",
                    ));
                };
                if identity.run_id != *run_id
                    || identity.control_epoch != *accepted_control_epoch
                    || identity.operation_id != *operation_id
                    || identity.invocation_id != *invocation_id
                    || identity.plan_revision != preview.plan_revision
                    || identity.plan_action_id != preview.plan_action_id
                    || preview_id != &preview.preview_id
                    || tool_id != &preview.tool_id
                    || scope_digest != &preview.scope_digest
                    || tool_contract_digest != &preview.tool_contract_digest
                    || context_ref != &preview.context_ref
                    || awaiting.ledger_sequence != *awaiting_batch_high_water
                {
                    return Err(receipt_fact_mismatch(
                        "awaiting reply does not match CapabilityAwaiting identity",
                    ));
                }
            }
            ToolIntentSubmitReplyV2::Rejected { .. } => {
                if command.fact_id
                    != match reply {
                        ToolIntentSubmitReplyV2::Rejected {
                            rejection_fact_id, ..
                        } => rejection_fact_id.clone(),
                        _ => unreachable!(),
                    }
                {
                    return Err(receipt_fact_mismatch(
                        "rejected reply must bind the CommandRecorded fact",
                    ));
                }
            }
        },
        MutationCommandResultV2::EpochAdvance { reply } => {
            let epoch =
                read_receipt_fact(connection, &reply.epoch_fact_id, "read_epoch_advanced_fact")?;
            let KernelFactPayloadV2::Control(ControlFactV2::EpochAdvanced { identity, .. }) =
                &epoch.payload
            else {
                return Err(receipt_fact_mismatch(
                    "epochFactId must identify EpochAdvanced",
                ));
            };
            if identity.run_id != reply.run_id
                || identity.control_epoch != reply.accepted_control_epoch
                || identity.causation_fact_id != command.fact_id
            {
                return Err(receipt_fact_mismatch(
                    "epoch reply does not match EpochAdvanced identity",
                ));
            }
            match &reply.cancellation {
                ControlCancellationReplyV2::Requested {
                    cancel_request_id,
                    invocation_id,
                    cancellation_fact_id,
                } => {
                    let cancellation = validate_cancellation_fact(
                        connection,
                        cancellation_fact_id,
                        &reply.run_id,
                        cancel_request_id,
                        invocation_id,
                    )?;
                    let KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested {
                        identity,
                        source,
                        ..
                    }) = &cancellation.payload
                    else {
                        unreachable!()
                    };
                    if identity.control_epoch != reply.accepted_control_epoch
                        || identity.causation_fact_id != reply.epoch_fact_id
                        || source != &CancellationSourceV2::EpochAdvance
                        || cancellation.ledger_sequence != reply.command_batch_high_water
                    {
                        return Err(receipt_fact_mismatch(
                            "epoch cancellation does not match the advanced epoch",
                        ));
                    }
                }
                ControlCancellationReplyV2::AlreadyRequested {
                    cancel_request_id,
                    invocation_id,
                    cancellation_fact_id,
                } => {
                    validate_cancellation_fact(
                        connection,
                        cancellation_fact_id,
                        &reply.run_id,
                        cancel_request_id,
                        invocation_id,
                    )?;
                    if epoch.ledger_sequence != reply.command_batch_high_water {
                        return Err(receipt_fact_mismatch(
                            "epoch high-water must end at EpochAdvanced when cancellation already exists",
                        ));
                    }
                }
                ControlCancellationReplyV2::None {} => {
                    if epoch.ledger_sequence != reply.command_batch_high_water {
                        return Err(receipt_fact_mismatch(
                            "epoch high-water must end at EpochAdvanced without cancellation",
                        ));
                    }
                }
            }
        }
        MutationCommandResultV2::InvocationCancel { reply } => match reply {
            InvocationCancelReplyV2::Requested {
                cancel_request_id,
                invocation_id,
                fact_id,
                ledger_sequence,
            } => {
                let cancellation = validate_cancellation_fact(
                    connection,
                    fact_id,
                    command.payload.run_id(),
                    cancel_request_id,
                    invocation_id,
                )?;
                let KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested {
                    identity,
                    source,
                    ..
                }) = &cancellation.payload
                else {
                    unreachable!()
                };
                if identity.causation_fact_id != command.fact_id
                    || source != &CancellationSourceV2::ExplicitCommand
                    || cancellation.ledger_sequence != *ledger_sequence
                {
                    return Err(receipt_fact_mismatch(
                        "requested cancellation does not match its canonical fact",
                    ));
                }
            }
            InvocationCancelReplyV2::AlreadyRequested {
                cancel_request_id,
                invocation_id,
                fact_id,
                ledger_sequence,
            } => {
                let cancellation = validate_cancellation_fact(
                    connection,
                    fact_id,
                    command.payload.run_id(),
                    cancel_request_id,
                    invocation_id,
                )?;
                if cancellation.ledger_sequence != *ledger_sequence {
                    return Err(receipt_fact_mismatch(
                        "existing cancellation ledger sequence does not match its fact",
                    ));
                }
            }
            InvocationCancelReplyV2::NoActiveInvocation { .. } => {}
            InvocationCancelReplyV2::AlreadyTerminal {
                invocation_id,
                terminal_fact_id,
                terminal_phase,
            } => {
                let terminal =
                    read_receipt_fact(connection, terminal_fact_id, "read_terminal_fact")?;
                if terminal.payload.run_id() != command.payload.run_id()
                    || terminal.payload.invocation_id() != Some(invocation_id)
                    || terminal_invocation_phase(&terminal.payload) != Some(*terminal_phase)
                {
                    return Err(receipt_fact_mismatch(
                        "terminal cancellation reply does not match its terminal fact",
                    ));
                }
            }
        },
        MutationCommandResultV2::RecordedSemanticError { .. } => {}
    }
    Ok(())
}

fn validate_cancellation_fact(
    connection: &Connection,
    fact_id: &FactId,
    run_id: &RunId,
    cancel_request_id: &deepcode_kernel_abi::v2::CancelRequestId,
    invocation_id: &deepcode_kernel_abi::v2::InvocationId,
) -> KernelResult<KernelFactEnvelopeV2> {
    let cancellation = read_receipt_fact(connection, fact_id, "read_cancellation_fact")?;
    let KernelFactPayloadV2::Control(ControlFactV2::CancellationRequested { identity, .. }) =
        &cancellation.payload
    else {
        return Err(receipt_fact_mismatch(
            "cancellation fact reference must identify CancellationRequested",
        ));
    };
    if &identity.run_id != run_id
        || &identity.cancel_request_id != cancel_request_id
        || &identity.invocation_id != invocation_id
    {
        return Err(receipt_fact_mismatch(
            "cancellation reply identity does not match its canonical fact",
        ));
    }
    Ok(cancellation)
}

fn terminal_invocation_phase(payload: &KernelFactPayloadV2) -> Option<InvocationPhaseV2> {
    match payload {
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolFailedBeforeEffect { .. }) => {
            Some(InvocationPhaseV2::FailedBeforeEffect)
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCancelledBeforeEffect { .. }) => {
            Some(InvocationPhaseV2::CancelledBeforeEffect)
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolTimedOutBeforeEffect { .. }) => {
            Some(InvocationPhaseV2::TimedOutBeforeEffect)
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolCompleted { .. }) => {
            Some(InvocationPhaseV2::Completed)
        }
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolFailedAfterObservedEffect {
            ..
        }) => Some(InvocationPhaseV2::FailedAfterObservedEffect),
        KernelFactPayloadV2::Invocation(InvocationFactV2::ToolIndeterminate { .. }) => {
            Some(InvocationPhaseV2::Indeterminate)
        }
        _ => None,
    }
}

fn require_batch_high_water(
    connection: &Connection,
    run_id: &RunId,
    high_water: u64,
) -> KernelResult<()> {
    let high_water = i64::try_from(high_water).map_err(|_| {
        receipt_fact_mismatch("reply batch high-water exceeds SQLite integer range")
    })?;
    let exists = connection
        .query_row(
            "SELECT 1 FROM kernel_facts WHERE ledger_sequence = ?1 AND run_id = ?2",
            params![high_water, run_id.as_str()],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| store_error("read_receipt_batch_high_water", error))?
        .is_some();
    if !exists {
        return Err(receipt_fact_mismatch(
            "reply batch high-water does not identify a fact in its run",
        ));
    }
    Ok(())
}

fn receipt_fact_mismatch(message: &str) -> KernelError {
    store_error_message("validate_public_command_receipt", message)
}

fn compare_public_command_receipt(
    existing: PublicCommandReceiptV2,
    submitted: &PublicCommandReceiptV2,
) -> PutPublicCommandReceiptOutcomeV2 {
    if existing.command_request_digest == submitted.command_request_digest {
        PutPublicCommandReceiptOutcomeV2::ExistingSame(existing)
    } else {
        PutPublicCommandReceiptOutcomeV2::DigestConflict {
            command_request_id: existing.command_request_id,
            existing: existing.command_request_digest,
            submitted: submitted.command_request_digest.clone(),
        }
    }
}

fn read_public_command_receipt(
    connection: &Connection,
    command_request_id: &CommandRequestId,
) -> KernelResult<Option<PublicCommandReceiptV2>> {
    let row = connection
        .query_row(
            "SELECT command_request_digest, command_kind, run_id, reply_json,
                    settlement_fact_id
             FROM public_command_receipts
             WHERE command_request_id = ?1",
            params![command_request_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| store_error("read_public_command_receipt", error))?;
    let Some((digest, command_kind, run_id, reply_json, settlement_fact_id)) = row else {
        return Ok(None);
    };
    let mut receipt =
        PublicCommandReceiptV2 {
            command_request_id: command_request_id.clone(),
            command_request_digest: CommandRequestDigestV2::parse(digest).map_err(|error| {
                invalid_fact_error("decode_public_command_receipt", error.to_string())
            })?,
            command_kind,
            run_id: run_id.map(RunId::new).transpose().map_err(|error| {
                invalid_fact_error("decode_public_command_receipt", error.to_string())
            })?,
            reply_json: serde_json::from_str(&reply_json).map_err(|error| {
                store_error_message("decode_public_command_receipt", error.to_string())
            })?,
            settlement_fact_id: settlement_fact_id.map(FactId::new).transpose().map_err(
                |error| invalid_fact_error("decode_public_command_receipt", error.to_string()),
            )?,
        };
    validate_public_command_receipt(&receipt)?;
    validate_public_command_receipt_settlement(connection, &mut receipt)?;
    Ok(Some(receipt))
}

fn validate_public_command_receipt(receipt: &PublicCommandReceiptV2) -> KernelResult<()> {
    if receipt.command_kind.is_empty()
        || receipt.command_kind.len() > MAX_COMMAND_KIND_BYTES
        || !receipt
            .command_kind
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(store_error_message(
            "validate_public_command_receipt",
            "commandKind must be a 1..=128 byte ASCII token",
        ));
    }
    if !receipt.reply_json.is_object() {
        return Err(store_error_message(
            "validate_public_command_receipt",
            "replyJson must be an object",
        ));
    }
    validate_cross_language_safe_json_value_v2("replyJson", &receipt.reply_json).map_err(
        |error| store_error_message("validate_public_command_receipt", error.to_string()),
    )?;
    if contains_ephemeral_capability(&receipt.reply_json) {
        return Err(store_error_message(
            "validate_public_command_receipt",
            "replyJson must not contain an ephemeral capability or credential",
        ));
    }
    let encoded = serde_json::to_vec(&receipt.reply_json)
        .map_err(|error| store_error_message("encode_public_command_reply", error.to_string()))?;
    if encoded.len() > MAX_PUBLIC_REPLY_BYTES {
        return Err(store_error_message(
            "validate_public_command_receipt",
            format!("replyJson exceeds the {MAX_PUBLIC_REPLY_BYTES} byte storage boundary"),
        ));
    }
    Ok(())
}

fn contains_ephemeral_capability(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(values) => values.iter().any(|(key, value)| {
            let normalized = key
                .bytes()
                .filter(|byte| byte.is_ascii_alphanumeric())
                .map(|byte| byte.to_ascii_lowercase())
                .collect::<Vec<_>>();
            matches!(
                normalized.as_slice(),
                b"runcapability"
                    | b"decisioncapability"
                    | b"capabilitytoken"
                    | b"accesstoken"
                    | b"refreshtoken"
                    | b"authorization"
                    | b"secret"
                    | b"nextcontinuation"
                    | b"continuationtoken"
                    | b"factquerycontinuation"
            ) || contains_ephemeral_capability(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(contains_ephemeral_capability),
        _ => false,
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ContinuationTokenHashPreimage<'a> {
    domain: &'static str,
    token: &'a str,
}

fn continuation_token_hash(token: &FactQueryContinuationV2) -> KernelResult<String> {
    query_digest_v2(&ContinuationTokenHashPreimage {
        domain: "deepcode.kernel.fact-query-continuation-token.v2",
        token: token.as_str(),
    })
    .map(|digest| digest.as_str().to_owned())
    .map_err(|error| invalid_fact_error("hash_fact_query_continuation_token", error.to_string()))
}

fn put_fact_query_continuation_transaction(
    connection: &mut Connection,
    continuation: FactQueryContinuationDraftV2,
) -> KernelResult<PutFactQueryContinuationOutcomeV2> {
    validate_cross_language_safe_u64_v2("snapshotHighWater", continuation.snapshot_high_water)
        .map_err(|error| {
            invalid_fact_error("validate_fact_query_continuation", error.to_string())
        })?;
    validate_cross_language_safe_u64_v2("afterLedgerSequence", continuation.after_ledger_sequence)
        .map_err(|error| {
            invalid_fact_error("validate_fact_query_continuation", error.to_string())
        })?;
    if continuation.after_ledger_sequence > continuation.snapshot_high_water {
        return Err(store_error_message(
            "validate_fact_query_continuation",
            "afterLedgerSequence must not exceed snapshotHighWater",
        ));
    }
    let token_hash = continuation_token_hash(&continuation.token)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| store_error("begin_put_fact_query_continuation", error))?;
    let run_exists: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM run_state WHERE run_id = ?1",
            params![continuation.run_id.as_str()],
            |row| row.get(0),
        )
        .map_err(|error| store_error("validate_fact_query_continuation_run", error))?;
    if run_exists != 1 {
        return Err(store_error_message(
            "validate_fact_query_continuation",
            "runId does not identify a durable Kernel run",
        ));
    }
    let current_high_water = high_water_with_connection(&transaction)?;
    if continuation.snapshot_high_water > current_high_water {
        return Err(store_error_message(
            "validate_fact_query_continuation",
            "snapshotHighWater exceeds the durable fact high-water",
        ));
    }
    let created_at = transaction
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| store_error("record_fact_query_continuation_time", error))
        .and_then(|value| {
            RecordedAtV2::new(value).map_err(|error| {
                invalid_fact_error("record_fact_query_continuation_time", error.to_string())
            })
        })?;
    if let Some(existing) = read_fact_query_continuation(&transaction, &token_hash)? {
        let outcome = if durable_continuation_matches_draft(&existing, &continuation) {
            if existing.expires_at.as_str() <= created_at.as_str() {
                delete_fact_query_continuation(&transaction, &token_hash)?;
                PutFactQueryContinuationOutcomeV2::ExistingExpired(existing)
            } else if read_fact_query_continuation_consumption(&transaction, &token_hash)?.is_some()
            {
                PutFactQueryContinuationOutcomeV2::ExistingConsumed(existing)
            } else {
                PutFactQueryContinuationOutcomeV2::ExistingSame(existing)
            }
        } else {
            PutFactQueryContinuationOutcomeV2::TokenConflict
        };
        transaction
            .commit()
            .map_err(|error| store_error("commit_fact_query_continuation_replay", error))?;
        return Ok(outcome);
    }

    if continuation.expires_at.as_str() <= created_at.as_str() {
        return Err(store_error_message(
            "validate_fact_query_continuation",
            "expiresAt must be later than the durable creation time",
        ));
    }
    prune_expired_fact_query_continuations(&transaction, &created_at)?;
    let global_count = count_fact_query_continuations(&transaction, None)?;
    if global_count >= MAX_DURABLE_CONTINUATIONS_GLOBAL {
        transaction
            .commit()
            .map_err(|error| store_error("commit_fact_query_continuation_prune", error))?;
        return Ok(PutFactQueryContinuationOutcomeV2::CapacityExceeded {
            scope: FactQueryContinuationCapacityScopeV2::Global,
            limit: MAX_DURABLE_CONTINUATIONS_GLOBAL,
        });
    }
    let run_count = count_fact_query_continuations(&transaction, Some(&continuation.run_id))?;
    if run_count >= MAX_DURABLE_CONTINUATIONS_PER_RUN {
        transaction
            .commit()
            .map_err(|error| store_error("commit_fact_query_continuation_prune", error))?;
        return Ok(PutFactQueryContinuationOutcomeV2::CapacityExceeded {
            scope: FactQueryContinuationCapacityScopeV2::Run,
            limit: MAX_DURABLE_CONTINUATIONS_PER_RUN,
        });
    }

    transaction
        .execute(
            "INSERT INTO fact_query_continuations (
                 token_hash, run_id, snapshot_high_water, after_ledger_sequence,
                 created_at, expires_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                token_hash,
                continuation.run_id.as_str(),
                sqlite_integer(continuation.snapshot_high_water, "snapshotHighWater")?,
                sqlite_integer(continuation.after_ledger_sequence, "afterLedgerSequence")?,
                created_at.as_str(),
                continuation.expires_at.as_str(),
            ],
        )
        .map_err(|error| store_error("insert_fact_query_continuation", error))?;
    let stored = DurableFactQueryContinuationV2 {
        run_id: continuation.run_id,
        snapshot_high_water: continuation.snapshot_high_water,
        after_ledger_sequence: continuation.after_ledger_sequence,
        created_at,
        expires_at: continuation.expires_at,
    };
    transaction
        .commit()
        .map_err(|error| store_error("commit_put_fact_query_continuation", error))?;
    Ok(PutFactQueryContinuationOutcomeV2::Inserted(stored))
}

fn prune_expired_fact_query_continuations(
    transaction: &Transaction<'_>,
    now: &RecordedAtV2,
) -> KernelResult<()> {
    transaction
        .execute(
            "DELETE FROM fact_query_continuation_consumptions
             WHERE token_hash IN (
                 SELECT token_hash FROM fact_query_continuations WHERE expires_at <= ?1
             )",
            params![now.as_str()],
        )
        .map_err(|error| store_error("prune_fact_query_continuation_consumptions", error))?;
    transaction
        .execute(
            "DELETE FROM fact_query_continuations WHERE expires_at <= ?1",
            params![now.as_str()],
        )
        .map_err(|error| store_error("prune_fact_query_continuations", error))?;
    Ok(())
}

fn delete_fact_query_continuation(
    transaction: &Transaction<'_>,
    token_hash: &str,
) -> KernelResult<()> {
    transaction
        .execute(
            "DELETE FROM fact_query_continuation_consumptions WHERE token_hash = ?1",
            params![token_hash],
        )
        .map_err(|error| store_error("delete_fact_query_continuation_consumption", error))?;
    let deleted = transaction
        .execute(
            "DELETE FROM fact_query_continuations WHERE token_hash = ?1",
            params![token_hash],
        )
        .map_err(|error| store_error("delete_fact_query_continuation", error))?;
    if deleted != 1 {
        return Err(store_error_message(
            "delete_fact_query_continuation",
            "exact continuation identity disappeared during maintenance",
        ));
    }
    Ok(())
}

fn count_fact_query_continuations(
    transaction: &Transaction<'_>,
    run_id: Option<&RunId>,
) -> KernelResult<u64> {
    let count = match run_id {
        Some(run_id) => transaction
            .query_row(
                "SELECT COUNT(*) FROM fact_query_continuations WHERE run_id = ?1",
                params![run_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| store_error("count_run_fact_query_continuations", error))?,
        None => transaction
            .query_row("SELECT COUNT(*) FROM fact_query_continuations", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| store_error("count_fact_query_continuations", error))?,
    };
    sqlite_u64(count, "continuationCount")
}

fn resolve_fact_query_continuation(
    connection: &Connection,
    token: &FactQueryContinuationV2,
    expected: &FactQueryContinuationExpectationV2,
) -> KernelResult<ResolveFactQueryContinuationOutcomeV2> {
    validate_cross_language_safe_u64_v2("afterLedgerSequence", expected.after_ledger_sequence)
        .map_err(|error| {
            invalid_fact_error("resolve_fact_query_continuation", error.to_string())
        })?;
    let token_hash = continuation_token_hash(token)?;
    let Some(stored) = read_fact_query_continuation(connection, &token_hash)? else {
        return Ok(ResolveFactQueryContinuationOutcomeV2::NotFound);
    };
    if stored.run_id != expected.run_id
        || stored.after_ledger_sequence != expected.after_ledger_sequence
    {
        return Ok(ResolveFactQueryContinuationOutcomeV2::ScopeMismatch);
    }
    if read_fact_query_continuation_consumption(connection, &token_hash)?.is_some() {
        return Ok(ResolveFactQueryContinuationOutcomeV2::Consumed);
    }
    let now = connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| store_error("resolve_fact_query_continuation_time", error))?;
    if stored.expires_at.as_str() <= now.as_str() {
        return Ok(ResolveFactQueryContinuationOutcomeV2::Expired {
            expires_at: stored.expires_at,
        });
    }
    Ok(ResolveFactQueryContinuationOutcomeV2::Resolved(stored))
}

fn consume_fact_query_continuation_transaction(
    connection: &mut Connection,
    token: FactQueryContinuationV2,
    expected: FactQueryContinuationExpectationV2,
    consumer: FactQueryContinuationConsumerV2,
) -> KernelResult<ConsumeFactQueryContinuationOutcomeV2> {
    validate_cross_language_safe_u64_v2("afterLedgerSequence", expected.after_ledger_sequence)
        .map_err(|error| {
            invalid_fact_error("consume_fact_query_continuation", error.to_string())
        })?;
    let token_hash = continuation_token_hash(&token)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| store_error("begin_consume_fact_query_continuation", error))?;
    let Some(stored) = read_fact_query_continuation(&transaction, &token_hash)? else {
        return Ok(ConsumeFactQueryContinuationOutcomeV2::NotFound);
    };
    if stored.run_id != expected.run_id
        || stored.after_ledger_sequence != expected.after_ledger_sequence
    {
        return Ok(ConsumeFactQueryContinuationOutcomeV2::ScopeMismatch);
    }
    if let Some((existing_request_id, existing_request_digest)) =
        read_fact_query_continuation_consumption(&transaction, &token_hash)?
    {
        let outcome = if existing_request_id == consumer.command_request_id
            && existing_request_digest == consumer.command_request_digest
        {
            ConsumeFactQueryContinuationOutcomeV2::ExistingSame(stored)
        } else {
            ConsumeFactQueryContinuationOutcomeV2::AlreadyConsumed
        };
        transaction
            .commit()
            .map_err(|error| store_error("commit_fact_query_continuation_consume_replay", error))?;
        return Ok(outcome);
    }
    let consumed_at = transaction
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| store_error("record_fact_query_continuation_consumption_time", error))?;
    if stored.expires_at.as_str() <= consumed_at.as_str() {
        return Ok(ConsumeFactQueryContinuationOutcomeV2::Expired {
            expires_at: stored.expires_at,
        });
    }
    transaction
        .execute(
            "INSERT INTO fact_query_continuation_consumptions (
                 token_hash, command_request_id, command_request_digest, consumed_at
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                token_hash,
                consumer.command_request_id.as_str(),
                consumer.command_request_digest.as_str(),
                consumed_at,
            ],
        )
        .map_err(|error| store_error("insert_fact_query_continuation_consumption", error))?;
    transaction
        .commit()
        .map_err(|error| store_error("commit_consume_fact_query_continuation", error))?;
    Ok(ConsumeFactQueryContinuationOutcomeV2::Consumed(stored))
}

fn read_fact_query_continuation_consumption(
    connection: &Connection,
    token_hash: &str,
) -> KernelResult<Option<(CommandRequestId, CommandRequestDigestV2)>> {
    let row = connection
        .query_row(
            "SELECT command_request_id, command_request_digest
             FROM fact_query_continuation_consumptions
             WHERE token_hash = ?1",
            params![token_hash],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| store_error("read_fact_query_continuation_consumption", error))?;
    row.map(|(request_id, request_digest)| {
        Ok((
            CommandRequestId::new(request_id).map_err(|error| {
                invalid_fact_error(
                    "decode_fact_query_continuation_consumption",
                    error.to_string(),
                )
            })?,
            CommandRequestDigestV2::parse(request_digest).map_err(|error| {
                invalid_fact_error(
                    "decode_fact_query_continuation_consumption",
                    error.to_string(),
                )
            })?,
        ))
    })
    .transpose()
}

fn read_fact_query_continuation(
    connection: &Connection,
    token_hash: &str,
) -> KernelResult<Option<DurableFactQueryContinuationV2>> {
    let row = connection
        .query_row(
            "SELECT run_id, snapshot_high_water, after_ledger_sequence,
                    created_at, expires_at
             FROM fact_query_continuations
             WHERE token_hash = ?1",
            params![token_hash],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| store_error("read_fact_query_continuation", error))?;
    let Some((run_id, snapshot_high_water, after_ledger_sequence, created_at, expires_at)) = row
    else {
        return Ok(None);
    };
    let decode_error = |error: deepcode_kernel_abi::v2::V2ValidationError| {
        invalid_fact_error("decode_fact_query_continuation", error.to_string())
    };
    let continuation = DurableFactQueryContinuationV2 {
        run_id: RunId::new(run_id).map_err(&decode_error)?,
        snapshot_high_water: sqlite_u64(snapshot_high_water, "snapshotHighWater")?,
        after_ledger_sequence: sqlite_u64(after_ledger_sequence, "afterLedgerSequence")?,
        created_at: RecordedAtV2::new(created_at).map_err(&decode_error)?,
        expires_at: RecordedAtV2::new(expires_at).map_err(&decode_error)?,
    };
    validate_cross_language_safe_u64_v2("snapshotHighWater", continuation.snapshot_high_water)
        .map_err(|error| invalid_fact_error("decode_fact_query_continuation", error.to_string()))?;
    validate_cross_language_safe_u64_v2("afterLedgerSequence", continuation.after_ledger_sequence)
        .map_err(|error| invalid_fact_error("decode_fact_query_continuation", error.to_string()))?;
    Ok(Some(continuation))
}

fn durable_continuation_matches_draft(
    stored: &DurableFactQueryContinuationV2,
    draft: &FactQueryContinuationDraftV2,
) -> bool {
    stored.run_id == draft.run_id
        && stored.snapshot_high_water == draft.snapshot_high_water
        && stored.after_ledger_sequence == draft.after_ledger_sequence
        && stored.expires_at == draft.expires_at
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
    let correlation_refs_json = serde_json::to_string(
        &envelope
            .payload
            .correlation_set()
            .map(|set| set.refs.as_slice())
            .unwrap_or(&[]),
    )
    .map_err(|error| store_error_message("encode_correlation_refs", error.to_string()))?;
    transaction
        .execute(
            "INSERT INTO kernel_facts (
                 ledger_sequence, run_id, run_sequence, fact_id, command_request_id,
                 operation_id, invocation_id, attempt_id,
                 causation_id, idempotency_key_hash, correlation_refs_json, control_epoch,
                 resource_ids_json, fact_kind, recorded_at, envelope_json
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16
             )",
            params![
                sqlite_integer(envelope.ledger_sequence, "ledgerSequence")?,
                envelope.payload.run_id().as_str(),
                sqlite_integer(envelope.run_sequence, "runSequence")?,
                envelope.fact_id.as_str(),
                envelope.payload.command_request_id().map(|id| id.as_str()),
                envelope.payload.operation_id().map(|id| id.as_str()),
                envelope.payload.invocation_id().map(|id| id.as_str()),
                envelope.payload.attempt_id().map(|id| id.as_str()),
                envelope.payload.causation_fact_id().map(|id| id.as_str()),
                envelope
                    .payload
                    .idempotency_hash()
                    .map(|value| value.as_str()),
                correlation_refs_json,
                sqlite_integer(
                    envelope
                        .payload
                        .control_epoch()
                        .map(|epoch| epoch.get())
                        .unwrap_or(0),
                    "controlEpoch"
                )?,
                resource_ids_json,
                envelope.payload.kind_token(),
                envelope.recorded_at.as_str(),
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
    let ledger_sequence = sqlite_integer(envelope.ledger_sequence, "ledgerSequence")?;
    let run_id = envelope.payload.run_id().as_str();
    let control_epoch = envelope
        .payload
        .control_epoch()
        .map(|epoch| epoch.get())
        .unwrap_or(0);
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
                run_id,
                sqlite_integer(envelope.run_sequence, "runSequence")?,
                sqlite_integer(control_epoch, "controlEpoch")?,
                ledger_sequence,
                encoded,
            ],
        )
        .map_err(|error| store_error("update_run_state", error))?;

    match &envelope.payload {
        KernelFactPayloadV2::Authorization(fact) => match fact {
            AuthorizationFactV2::CapabilityAwaiting { identity, .. } => {
                transaction
                    .execute(
                        "INSERT INTO invocation_state (
                                 invocation_id, run_id, status,
                                 last_ledger_sequence, state_json
                             ) VALUES (?1, ?2, 'awaitingCapability', ?3, ?4)
                             ON CONFLICT(invocation_id) DO UPDATE SET
                                 run_id = excluded.run_id,
                                 status = excluded.status,
                                 last_ledger_sequence = excluded.last_ledger_sequence,
                                 state_json = excluded.state_json
                             WHERE excluded.last_ledger_sequence >
                                 invocation_state.last_ledger_sequence",
                        params![
                            identity.invocation_id.as_str(),
                            run_id,
                            ledger_sequence,
                            encoded,
                        ],
                    )
                    .map_err(|error| store_error("update_awaiting_capability_state", error))?;
            }
            AuthorizationFactV2::ScopePreviewed { .. }
            | AuthorizationFactV2::CapabilityIssued { .. }
            | AuthorizationFactV2::CapabilityDenied { .. }
            | AuthorizationFactV2::ExpansionDenied { .. }
            | AuthorizationFactV2::ExpansionAllowed { .. }
            | AuthorizationFactV2::TrustGranted { .. }
            | AuthorizationFactV2::TrustRevoked { .. }
            | AuthorizationFactV2::LeaseRevoked { .. }
            | AuthorizationFactV2::LeaseSuperseded { .. }
            | AuthorizationFactV2::ContextInvalidated { .. } => {}
        },
        KernelFactPayloadV2::Invocation(fact) => {
            let (invocation_id, status) = match fact {
                InvocationFactV2::ToolIntentAdmitted { identity, .. } => {
                    (&identity.invocation_id, "admitted")
                }
                InvocationFactV2::ToolAttemptPrepared { identity } => {
                    (&identity.invocation_id, "attemptPrepared")
                }
                InvocationFactV2::ToolExecutionStarted { identity, .. } => {
                    (&identity.invocation_id, "executing")
                }
                InvocationFactV2::ToolCancellationObserved { identity, .. } => {
                    (&identity.invocation_id, "cancellationObserved")
                }
                InvocationFactV2::ToolDeadlineObserved { identity } => {
                    (&identity.invocation_id, "deadlineObserved")
                }
                InvocationFactV2::ToolFailedBeforeEffect { identity, .. } => {
                    (&identity.invocation_id, "failedBeforeEffect")
                }
                InvocationFactV2::ToolCancelledBeforeEffect { identity, .. } => {
                    (&identity.invocation_id, "cancelledBeforeEffect")
                }
                InvocationFactV2::ToolTimedOutBeforeEffect { identity } => {
                    (&identity.invocation_id, "timedOutBeforeEffect")
                }
                InvocationFactV2::ToolCompleted { identity, .. } => {
                    (&identity.invocation_id, "completed")
                }
                InvocationFactV2::ToolFailedAfterObservedEffect { identity, .. } => {
                    (&identity.invocation_id, "failedAfterObservedEffect")
                }
                InvocationFactV2::ToolIndeterminate { identity, .. } => {
                    (&identity.invocation_id, "indeterminate")
                }
            };
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
                        invocation_id.as_str(),
                        run_id,
                        status,
                        ledger_sequence,
                        encoded,
                    ],
                )
                .map_err(|error| store_error("update_invocation_state", error))?;
        }
        KernelFactPayloadV2::Resource(fact) => {
            let (resource_id, status) = match fact {
                ResourceFactV2::ResolvedForInvocation { identity, .. } => {
                    (&identity.resource_id, "resolved")
                }
                ResourceFactV2::RevalidatedBeforeEffect { identity, .. } => {
                    (&identity.resource_id, "revalidated")
                }
            };
            update_resource_state(
                transaction,
                resource_id.as_str(),
                run_id,
                status,
                ledger_sequence,
                encoded,
            )?;
        }
        KernelFactPayloadV2::Cleanup(fact) => {
            let (resource_id, status) = match fact {
                CleanupFactV2::Scheduled { identity } => {
                    (&identity.resource_id, "cleanup:scheduled")
                }
                CleanupFactV2::Attempted { identity, .. } => {
                    (&identity.resource_id, "cleanup:attempted")
                }
                CleanupFactV2::Completed { identity, .. } => {
                    (&identity.resource_id, "cleanup:completed")
                }
                CleanupFactV2::Failed { identity, .. } => (&identity.resource_id, "cleanup:failed"),
            };
            update_resource_state(
                transaction,
                resource_id.as_str(),
                run_id,
                status,
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
        "command_request_id",
        filter.command_request_id.as_deref(),
    );
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
                   AND json_extract(json_each.value, '$.data.value') = ?
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
    let value = sqlite_u64(value, "ledgerSequence")?;
    validate_cross_language_safe_u64_v2("ledgerSequence", value)
        .map_err(|error| invalid_fact_error("read_ledger_high_water", error.to_string()))?;
    Ok(value)
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
        let high_water = sqlite_u64(high_water, "runSequence")?;
        validate_cross_language_safe_u64_v2("runSequence", high_water)
            .map_err(|error| invalid_fact_error("read_run_high_water", error.to_string()))?;
        high_waters.push(RunSequenceHighWater {
            run_id: RunId::new(run_id)
                .map_err(|error| invalid_fact_error("read_run_high_water", error.to_string()))?,
            run_sequence_high_water: high_water,
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

fn resource_ids(envelope: &KernelFactEnvelopeV2) -> Vec<String> {
    envelope
        .payload
        .resource_ids()
        .into_iter()
        .map(|resource_id| resource_id.as_str().to_owned())
        .collect()
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
