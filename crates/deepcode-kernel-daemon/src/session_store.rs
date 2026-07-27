use crate::prelude::*;
use crate::*;

pub(crate) const ARCHIVE_DEBUG_STREAMS: &[&str] = &[
    "parser-results.jsonl",
    "trace-events.jsonl",
    "llm-exchanges.jsonl",
    "context-assemblies.jsonl",
    "agent-plan-parts.jsonl",
    "action-bundle-drafts.jsonl",
    "draft-task-queues.jsonl",
    "plan-review-reports.jsonl",
    "resource-packets.jsonl",
    "review-packets.jsonl",
    "permission-tool-facts.jsonl",
    "llm-provider-errors.jsonl",
    "wire-ledger.jsonl",
    "cache-telemetry.jsonl",
    "projection-delivery.jsonl",
];

#[derive(Default)]
pub(crate) struct ProjectionSummary {
    pub(crate) event_count: usize,
    pub(crate) first_timestamp: Option<String>,
    pub(crate) last_timestamp: Option<String>,
    pub(crate) first_user_content: Option<String>,
}

const SESSION_DOMAIN_BATCH_SCHEMA_VERSION: &str = "deepcode.session.domain-batch.v1";
const SESSION_APPEND_COMMAND_SCHEMA_VERSION: &str = "deepcode.session.append-command.v1";
const SESSION_PROVIDER_ADMISSION_SCHEMA_VERSION: &str =
    "deepcode.session.provider-admission-metadata.v1";
const SESSION_DOMAIN_BATCH_RECORD_KIND: &str = "domainBatch";
const SESSION_DOMAIN_GENESIS_BATCH_ID: &str = "session-domain-genesis-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionDomainHeadV1 {
    pub(crate) schema_version: String,
    pub(crate) head_revision: u64,
    pub(crate) event_version: u64,
    pub(crate) head_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderAdmissionMetadataV1 {
    pub(crate) schema_version: String,
    pub(crate) request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) parent_request_id: Option<String>,
    pub(crate) turn_authority_ref: String,
    pub(crate) attempt_kind: String,
    pub(crate) stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) language_revision: Option<u64>,
    pub(crate) provider_payload_digest: String,
    pub(crate) transport_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionRunFenceExpectationV1 {
    pub(crate) state: SessionRunFenceStateV1,
    pub(crate) revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) owner_batch_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionInteractionExpectationV1 {
    pub(crate) state: SessionInteractionFenceStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) claim_batch_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(crate) enum SessionAppendPreconditionV1 {
    #[serde(rename = "runFence")]
    RunFence {
        #[serde(rename = "runId")]
        run_id: String,
        expected: SessionRunFenceExpectationV1,
    },
    #[serde(rename = "turnAuthority")]
    TurnAuthority {
        #[serde(rename = "eventId")]
        event_id: String,
    },
    #[serde(rename = "interaction")]
    Interaction {
        #[serde(rename = "interactionId")]
        interaction_id: String,
        #[serde(rename = "interactionRevision")]
        interaction_revision: String,
        #[serde(rename = "targetId")]
        target_id: String,
        expected: SessionInteractionExpectationV1,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionRunFenceStateV1 {
    Open,
    Closing,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionInteractionFenceStateV1 {
    Open,
    Claimed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionAppendIntentV1 {
    OpenRun,
    BootstrapRun,
    DomainFacts,
    Guidance,
    InteractionSettlement,
    ReleaseInteractionClaim,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionClosePhaseV1 {
    Request,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(crate) enum SessionAppendTransitionV1 {
    #[serde(rename = "genesis")]
    Genesis,
    #[serde(rename = "append")]
    Append {
        intent: SessionAppendIntentV1,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(
            rename = "turnAuthorityRef",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        turn_authority_ref: Option<String>,
        #[serde(
            rename = "bootstrapAdmissionId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        bootstrap_admission_id: Option<String>,
        #[serde(
            rename = "interactionId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        interaction_id: Option<String>,
        #[serde(
            rename = "interactionRevision",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        interaction_revision: Option<String>,
        #[serde(rename = "targetId", default, skip_serializing_if = "Option::is_none")]
        target_id: Option<String>,
        #[serde(
            rename = "claimBatchId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        claim_batch_id: Option<String>,
    },
    #[serde(rename = "claim")]
    Claim {
        #[serde(rename = "claimantRunId")]
        claimant_run_id: String,
        #[serde(rename = "decisionRequestId")]
        decision_request_id: String,
        #[serde(rename = "interactionId")]
        interaction_id: String,
        #[serde(rename = "interactionRevision")]
        interaction_revision: String,
        #[serde(rename = "targetId")]
        target_id: String,
    },
    #[serde(rename = "close")]
    Close {
        phase: SessionClosePhaseV1,
        #[serde(rename = "runId")]
        run_id: String,
        status: String,
        #[serde(rename = "parentCloseBatchId", default)]
        parent_close_batch_id: Option<String>,
        #[serde(
            rename = "interactionEffect",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        interaction_effect: Option<SessionInteractionEffectV1>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(crate) enum SessionInteractionEffectV1 {
    #[serde(rename = "open")]
    Open {
        #[serde(rename = "interactionId")]
        interaction_id: String,
        #[serde(rename = "interactionRevision")]
        interaction_revision: String,
        #[serde(rename = "targetId")]
        target_id: String,
    },
    #[serde(rename = "settle")]
    Settle {
        #[serde(rename = "interactionId")]
        interaction_id: String,
        #[serde(rename = "interactionRevision")]
        interaction_revision: String,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "claimBatchId")]
        claim_batch_id: String,
    },
    #[serde(rename = "release")]
    Release {
        #[serde(rename = "interactionId")]
        interaction_id: String,
        #[serde(rename = "interactionRevision")]
        interaction_revision: String,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "claimBatchId")]
        claim_batch_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionAppendCommandV1 {
    pub(crate) schema_version: String,
    pub(crate) batch_id: String,
    pub(crate) base_head: SessionDomainHeadV1,
    #[serde(default)]
    pub(crate) preconditions: Vec<SessionAppendPreconditionV1>,
    pub(crate) transition: SessionAppendTransitionV1,
    #[serde(default)]
    pub(crate) provider_admissions: Vec<SessionProviderAdmissionMetadataV1>,
    #[serde(default)]
    pub(crate) events: Vec<Value>,
    #[serde(default)]
    pub(crate) timeline: Option<Value>,
    #[serde(
        rename = "bootstrapToken",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) bootstrap_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionDomainBatchRecordV1 {
    pub(crate) schema_version: String,
    pub(crate) record_kind: String,
    pub(crate) session_id: String,
    pub(crate) batch_id: String,
    pub(crate) batch_digest: String,
    pub(crate) base_head: SessionDomainHeadV1,
    pub(crate) preconditions: Vec<SessionAppendPreconditionV1>,
    pub(crate) transition: SessionAppendTransitionV1,
    pub(crate) provider_admissions: Vec<SessionProviderAdmissionMetadataV1>,
    pub(crate) events: Vec<Value>,
    pub(crate) result_head: SessionDomainHeadV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) projection_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) projection_revision: Option<u64>,
    pub(crate) committed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionDomainWriteability {
    Uninitialized,
    Current,
    LegacyReadOnly,
    Corrupt,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionDomainSnapshot {
    pub(crate) writeability: SessionDomainWriteability,
    pub(crate) head: Option<SessionDomainHeadV1>,
    pub(crate) events: Vec<Value>,
    pub(crate) records: Vec<SessionDomainBatchRecordV1>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionProjectionCommitAckV1 {
    pub(crate) schema_version: String,
    pub(crate) revision: u64,
    pub(crate) source_event_version: u64,
    pub(crate) projection_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionAppendReceiptV1 {
    pub(crate) schema_version: String,
    pub(crate) session_id: String,
    pub(crate) batch_id: String,
    pub(crate) server_digest: String,
    pub(crate) base_head: SessionDomainHeadV1,
    pub(crate) result_state: SessionDomainStateSnapshotV1,
    pub(crate) idempotent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) projection_ack: Option<SessionProjectionCommitAckV1>,
    pub(crate) committed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionDomainStateSnapshotV1 {
    pub(crate) schema_version: String,
    pub(crate) head: SessionDomainHeadV1,
    pub(crate) run_fences: Vec<SessionRunFenceViewV1>,
    pub(crate) interaction_fences: Vec<SessionInteractionFenceViewV1>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRunFenceViewV1 {
    pub(crate) run_id: String,
    pub(crate) state: String,
    pub(crate) revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) owner_batch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionInteractionFenceViewV1 {
    pub(crate) interaction_id: String,
    pub(crate) interaction_revision: String,
    pub(crate) target_id: String,
    pub(crate) state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) claim_batch_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionDomainStoreError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) current_head: Option<SessionDomainHeadV1>,
    pub(crate) failed_precondition: Option<SessionAppendPreconditionV1>,
    pub(crate) precondition_index: Option<usize>,
    pub(crate) batch_id: Option<String>,
    pub(crate) existing_batch_digest: Option<String>,
    pub(crate) submitted_batch_digest: Option<String>,
    pub(crate) expected_head: Option<SessionDomainHeadV1>,
    pub(crate) transition: Option<SessionAppendTransitionV1>,
    pub(crate) event_id: Option<String>,
}

impl SessionDomainStoreError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            current_head: None,
            failed_precondition: None,
            precondition_index: None,
            batch_id: None,
            existing_batch_digest: None,
            submitted_batch_digest: None,
            expected_head: None,
            transition: None,
            event_id: None,
        }
    }

    fn with_current_head(mut self, current_head: Option<SessionDomainHeadV1>) -> Self {
        self.current_head = current_head;
        self
    }

    fn with_failed_precondition(
        mut self,
        precondition_index: usize,
        failed_precondition: SessionAppendPreconditionV1,
    ) -> Self {
        self.failed_precondition = Some(failed_precondition);
        self.precondition_index = Some(precondition_index);
        self
    }

    pub(crate) fn details(&self) -> Value {
        json!({
            "currentHead": self.current_head,
            "failedPrecondition": self.failed_precondition,
            "preconditionIndex": self.precondition_index,
            "batchId": self.batch_id,
            "existingBatchDigest": self.existing_batch_digest,
            "submittedBatchDigest": self.submitted_batch_digest,
            "expectedHead": self.expected_head,
            "transition": self.transition,
            "eventId": self.event_id
        })
    }

    pub(crate) fn api_details(&self, sessions_dir: &FsPath, session_id: &str) -> Value {
        let mut details = serde_json::Map::new();
        details.insert(
            "schemaVersion".to_string(),
            json!("deepcode.session.append-error-details.v1"),
        );
        details.insert("code".to_string(), json!(self.code));
        details.insert("sessionId".to_string(), json!(session_id));
        details.insert("reason".to_string(), json!(self.message));
        match self.code {
            "session_append_legacy_read_only" | "session_append_recovery_required" => {
                details.insert(
                    "writeability".to_string(),
                    session_append_writeability_value(sessions_dir, session_id),
                );
            }
            "session_append_batch_conflict" => {
                insert_optional_detail(&mut details, "batchId", self.batch_id.as_ref());
                insert_optional_detail(
                    &mut details,
                    "existingBatchDigest",
                    self.existing_batch_digest.as_ref(),
                );
                insert_optional_detail(
                    &mut details,
                    "submittedBatchDigest",
                    self.submitted_batch_digest.as_ref(),
                );
                insert_optional_json_detail(
                    &mut details,
                    "currentHead",
                    self.current_head.as_ref(),
                );
            }
            "session_append_head_conflict" => {
                insert_optional_detail(&mut details, "batchId", self.batch_id.as_ref());
                insert_optional_json_detail(
                    &mut details,
                    "expectedHead",
                    self.expected_head.as_ref(),
                );
                insert_optional_json_detail(
                    &mut details,
                    "currentHead",
                    self.current_head.as_ref(),
                );
            }
            "session_append_precondition_failed" => {
                insert_optional_detail(&mut details, "batchId", self.batch_id.as_ref());
                insert_optional_json_detail(
                    &mut details,
                    "currentHead",
                    self.current_head.as_ref(),
                );
                if let Some(index) = self.precondition_index {
                    details.insert("preconditionIndex".to_string(), json!(index));
                }
                insert_optional_json_detail(
                    &mut details,
                    "failedPrecondition",
                    self.failed_precondition.as_ref(),
                );
            }
            "session_append_transition_invalid" => {
                insert_optional_detail(&mut details, "batchId", self.batch_id.as_ref());
                insert_optional_json_detail(
                    &mut details,
                    "currentHead",
                    self.current_head.as_ref(),
                );
                insert_optional_json_detail(&mut details, "transition", self.transition.as_ref());
            }
            "session_append_lineage_invalid" => {
                insert_optional_detail(&mut details, "batchId", self.batch_id.as_ref());
                insert_optional_json_detail(
                    &mut details,
                    "currentHead",
                    self.current_head.as_ref(),
                );
                insert_optional_detail(&mut details, "eventId", self.event_id.as_ref());
            }
            _ => {}
        }
        Value::Object(details)
    }
}

fn insert_optional_detail(
    details: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<&String>,
) {
    if let Some(value) = value {
        details.insert(key.to_string(), json!(value));
    }
}

fn insert_optional_json_detail<T: Serialize>(
    details: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<&T>,
) {
    if let Some(value) = value {
        if let Ok(value) = serde_json::to_value(value) {
            details.insert(key.to_string(), value);
        }
    }
}

#[derive(Debug, Clone)]
struct SessionRunFenceSnapshot {
    revision: u64,
    state: SessionRunFenceSnapshotState,
    owner_batch_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionRunFenceSnapshotState {
    Open,
    Closing,
    Closed,
}

#[derive(Debug, Clone)]
struct SessionInteractionFenceSnapshot {
    interaction_revision: String,
    target_id: String,
    state: SessionInteractionFenceSnapshotState,
    claim_batch_id: Option<String>,
    claimant_run_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionInteractionFenceSnapshotState {
    Open,
    Claimed,
    Settled,
}

#[derive(Clone, Default)]
struct SessionDomainDerivedState {
    run_fences: HashMap<String, SessionRunFenceSnapshot>,
    interactions: HashMap<String, SessionInteractionFenceSnapshot>,
    turn_authority_event_ids: std::collections::HashSet<String>,
    event_ids: std::collections::HashSet<String>,
    provider_request_ids: std::collections::HashSet<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionRunBootstrapGrant {
    pub(crate) admission_id: String,
    pub(crate) token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionRunBootstrapObservation {
    Pending,
    Committed {
        batch_id: String,
        turn_authority_ref: String,
    },
    Revoked {
        reason: String,
    },
    Missing,
}

#[derive(Debug, Clone)]
enum SessionRunBootstrapAdmissionState {
    Pending,
    Committed {
        batch_id: String,
        turn_authority_ref: String,
    },
    Revoked {
        reason: String,
    },
}

#[derive(Debug, Clone)]
struct SessionRunBootstrapAdmission {
    admission_id: String,
    token: String,
    state: SessionRunBootstrapAdmissionState,
}

fn session_run_bootstrap_registry() -> &'static Mutex<HashMap<String, SessionRunBootstrapAdmission>>
{
    static REGISTRY: std::sync::OnceLock<Mutex<HashMap<String, SessionRunBootstrapAdmission>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_run_bootstrap_registry_key(
    sessions_dir: &FsPath,
    session_id: &str,
    run_id: &str,
) -> String {
    format!(
        "{}\u{1f}{session_id}\u{1f}{run_id}",
        sessions_dir.to_string_lossy()
    )
}

fn new_session_run_bootstrap_token() -> Result<String, SessionDomainStoreError> {
    #[cfg(unix)]
    {
        let mut entropy = [0u8; 32];
        let mut source = fs::File::open("/dev/urandom").map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Cannot open the OS bootstrap entropy source: {error}"),
            )
        })?;
        source.read_exact(&mut entropy).map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Cannot read the OS bootstrap entropy source: {error}"),
            )
        })?;
        let encoded = entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        return Ok(format!("bootstrap-token-{encoded}"));
    }
    #[cfg(not(unix))]
    {
        Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "This build has no approved OS bootstrap entropy source",
        ))
    }
}

fn bootstrap_tokens_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

pub(crate) fn restore_session_index(paths: &HostPaths) -> Vec<Value> {
    let mut sessions_by_id: HashMap<String, Value> = HashMap::new();

    if let Some(indexed) = read_json_file(&paths.sessions_index_path)
        .and_then(|value| value.get("sessions").and_then(Value::as_array).cloned())
    {
        for session in indexed {
            if let Some(session_id) = session
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(ToOwned::to_owned)
            {
                sessions_by_id.insert(session_id, session);
            }
        }
    }

    for session in read_archived_session_metadata(&paths.conversation_archives_dir) {
        let Some(session_id) = session
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        sessions_by_id
            .entry(session_id)
            .and_modify(|existing| {
                if session_sort_key(&session) > session_sort_key(existing) {
                    *existing = session.clone();
                }
            })
            .or_insert(session);
    }

    for session_id in projection_session_ids(&paths.sessions_dir) {
        sessions_by_id.entry(session_id.clone()).or_insert_with(|| {
            let created_at = timestamp_from_session_id(&session_id).unwrap_or_else(now_text);
            let mut restored = create_agent_session_value(
                &session_id,
                &created_at,
                "New Agent Session",
                "plan",
                None,
                None,
                None,
            );
            if let Some(object) = restored.as_object_mut() {
                object.remove("kernelAbiVersion");
                object.remove("agentProtocolVersion");
                object.remove("toolCatalogVersion");
            }
            restored
        });
    }

    let session_ids = sessions_by_id.keys().cloned().collect::<Vec<_>>();
    for session_id in session_ids {
        if let Some(session) = sessions_by_id.get_mut(&session_id) {
            normalize_restored_session(session, &session_id, &paths.sessions_dir);
        }
    }

    let mut sessions = sessions_by_id
        .into_values()
        .filter(|session| session.get("id").and_then(Value::as_str).is_some())
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| std::cmp::Reverse(session_sort_key(session)));
    sessions
}

pub(crate) fn persist_session_index(gui: &GuiState) -> Result<(), String> {
    persist_session_index_values(&gui.paths.sessions_index_path, &gui.sessions)
}

fn persist_session_index_values(path: &PathBuf, sessions: &[Value]) -> Result<(), String> {
    atomic_write_json(
        path,
        &json!({
            "schemaVersion": "deepcode.agent.sessions.v1",
            "sessions": sessions
        }),
    )
}

pub(crate) fn restored_current_session_ids_by_scope(sessions: &[Value]) -> HashMap<String, String> {
    let mut current = HashMap::new();
    for session in sessions {
        if is_archived_session(session) {
            continue;
        }
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        current
            .entry(session_scope_key(session))
            .or_insert_with(|| session_id.to_string());
    }
    current
}

pub(crate) async fn session_store_index(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "sessions": gui.sessions,
        "storeRoot": gui.paths.sessions_dir.to_string_lossy(),
        "conversationArchiveRoot": gui.paths.conversation_archives_dir.to_string_lossy()
    }))
}

pub(crate) async fn session_store_archive_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if !trusted_private_storage_origin(&headers) {
        return ApiResponse::error(
            "conversation_archive_origin_forbidden",
            "conversation archive accepts only non-browser local clients or the DeepCode local application origin",
        );
    }
    let (archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    let archives = read_conversation_archive_manifests(&archive_root, &session_id);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "conversationArchiveRoot": archive_root.to_string_lossy(),
        "defaultWorkspaceScopeKey": workspace_scope_key(session.as_ref()),
        "archives": archives
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveFileQuery {
    pub(crate) run_id: Option<String>,
    pub(crate) path: String,
}

pub(crate) async fn session_store_archive_file_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<ArchiveFileQuery>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if !trusted_private_storage_origin(&headers) {
        return ApiResponse::error(
            "conversation_archive_origin_forbidden",
            "conversation archive accepts only non-browser local clients or the DeepCode local application origin",
        );
    }
    let (archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    let Some(manifest) =
        select_archive_manifest(&archive_root, &session_id, query.run_id.as_deref())
    else {
        return ApiResponse::error(
            "conversation_archive_not_found",
            "conversation archive not found",
        );
    };
    let Some(archive_path) = manifest.get("archivePath").and_then(Value::as_str) else {
        return ApiResponse::error(
            "conversation_archive_invalid",
            "conversation archive manifest missing archivePath",
        );
    };
    let archive_dir = PathBuf::from(archive_path);
    if !archive_dir.starts_with(&archive_root) {
        return ApiResponse::error(
            "conversation_archive_invalid",
            "conversation archive path is outside archive root",
        );
    }
    let Some(relative_path) = safe_archive_relative_path(&query.path) else {
        return ApiResponse::error(
            "invalid_archive_path",
            "archive file path must be relative and safe",
        );
    };
    let relative_display = relative_path.to_string_lossy().replace('\\', "/");
    if !is_public_conversation_archive_file(&relative_display) {
        return ApiResponse::error(
            "archive_file_private",
            "private analysis and debug archive files are not available through the conversation archive endpoint",
        );
    }
    let file_path = archive_dir.join(&relative_path);
    if !file_path.starts_with(&archive_dir) {
        return ApiResponse::error(
            "invalid_archive_path",
            "archive file path escapes archive directory",
        );
    }
    let run_id = manifest
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or("session");
    let Some(content) = render_public_conversation_archive_file(
        &archive_root,
        &archive_dir,
        &session_id,
        run_id,
        &relative_display,
    ) else {
        return ApiResponse::error(
            "archive_file_not_found",
            "public archive file could not be rendered from the current conversation export policy",
        );
    };
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "workspaceScopeKey": workspace_scope_key(session.as_ref()),
        "runId": manifest.get("runId").cloned().unwrap_or(Value::Null),
        "path": relative_path.to_string_lossy(),
        "content": content
    }))
}

pub(crate) async fn session_store_memory_archive_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if !trusted_private_storage_origin(&headers) {
        return ApiResponse::error(
            "memory_archive_origin_forbidden",
            "memory archive accepts only non-browser local clients or the DeepCode local application origin",
        );
    }
    let (memory_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.memory_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    let archive_dir = memory_archive_dir(&memory_root, session.as_ref());
    let session_archive_dir = archive_dir.join("sessions");
    let safe_session = safe_path_segment(&session_id);
    let project_markdown_path = archive_dir.join("project.md");
    let project_sidecar_path = archive_dir.join("project.memory.json");
    let session_markdown_path = session_archive_dir.join(format!("{safe_session}.md"));
    let session_sidecar_path = session_archive_dir.join(format!("{safe_session}.memory.json"));
    let manifest_path = archive_dir.join("manifest.json");
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "workspaceScopeKey": workspace_scope_key(session.as_ref()),
        "memoryArchiveRoot": memory_root.to_string_lossy(),
        "archivePath": archive_dir.to_string_lossy(),
        "exists": project_markdown_path.exists() || session_markdown_path.exists(),
        "projectMarkdown": read_optional_text_file(&project_markdown_path),
        "sessionMarkdown": read_optional_text_file(&session_markdown_path),
        "projectSidecar": read_json_file(&project_sidecar_path),
        "sessionSidecar": read_json_file(&session_sidecar_path),
        "manifest": read_json_file(&manifest_path),
        "files": {
            "projectMarkdown": project_markdown_path.to_string_lossy(),
            "projectSidecar": project_sidecar_path.to_string_lossy(),
            "sessionMarkdown": session_markdown_path.to_string_lossy(),
            "sessionSidecar": session_sidecar_path.to_string_lossy(),
            "manifest": manifest_path.to_string_lossy()
        }
    }))
}

pub(crate) async fn session_store_memory_archive_post(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    if !trusted_private_storage_origin(&headers) {
        return ApiResponse::error(
            "memory_archive_origin_forbidden",
            "memory archive accepts only non-browser local clients or the DeepCode local application origin",
        );
    }
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return json_body_rejection_response(
                "/api/session-store/:session_id/memory/archive",
                rejection,
            )
        }
    };
    let (memory_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.memory_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    match write_session_memory_archive(&memory_root, &session_id, session.as_ref(), &body) {
        Ok(result) => ApiResponse::ok(result),
        Err(error) => ApiResponse::error("write_memory_archive_failed", error.to_string()),
    }
}

pub(crate) async fn session_store_projection_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    let entries = session_projection(&state, &session_id);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "entries": entries,
        "events": entries
    }))
}

pub(crate) async fn session_store_projection_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    let entries = sanitize_non_analysis_persistence_entries(
        body.get("entries")
            .or_else(|| body.get("events"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    );
    let requested = entries.len();
    let outcome = match append_session_projection(&state, &session_id, entries) {
        Ok(outcome) => outcome,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let stored = session_projection(&state, &session_id);
    let diagnostics = outcome
        .conversation_archive_error
        .as_ref()
        .map(|message| {
            vec![json!({
                "code": "conversation_archive_projection_degraded",
                "message": message
            })]
        })
        .unwrap_or_default();
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "requested": requested,
        "appended": outcome.appended,
        "entryCount": outcome.entry_count,
        "entries": stored,
        "events": stored,
        "diagnostics": diagnostics
    }))
}

pub(crate) async fn session_store_transcript_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let entries = sanitize_non_analysis_persistence_entries(read_session_jsonl(
        &sessions_dir,
        &session_id,
        "transcript.jsonl",
    ));
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "entries": entries
    }))
}

pub(crate) async fn session_store_transcript_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return json_body_rejection_response(
                "/api/session-store/:session_id/transcript",
                rejection,
            )
        }
    };
    let entry = body.get("entry").cloned().unwrap_or_else(|| body.clone());
    if is_hidden_reasoning_persistence_record(&entry) {
        return ApiResponse::error(
            "session_transcript_reasoning_forbidden",
            "hidden reasoning cannot be persisted in the Session transcript",
        );
    }
    let entry = strip_hidden_reasoning_fields(entry);
    let (sessions_dir, archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.sessions_dir.clone(),
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    match append_session_jsonl(
        &sessions_dir,
        &session_id,
        "transcript.jsonl",
        std::slice::from_ref(&entry),
    ) {
        Ok(()) => {
            if let Err(error) = append_conversation_archive_transcript(
                &archive_root,
                &session_id,
                session.as_ref(),
                std::slice::from_ref(&entry),
            ) {
                eprintln!("failed to append conversation archive transcript: {error}");
            }
            let entries = sanitize_non_analysis_persistence_entries(read_session_jsonl(
                &sessions_dir,
                &session_id,
                "transcript.jsonl",
            ));
            ApiResponse::ok(json!({
                "sessionId": session_id,
                "entryCount": entries.len(),
                "entries": entries
            }))
        }
        Err(error) => ApiResponse::error("write_session_transcript_failed", error.to_string()),
    }
}

pub(crate) async fn session_store_wire_ledger_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    session_observability_stream_get(&state, &session_id, "wire-ledger.jsonl")
}

pub(crate) async fn session_store_wire_ledger_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    session_observability_stream_append(&state, &session_id, body, "wire-ledger.jsonl", true)
}

pub(crate) async fn session_store_cache_telemetry_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    session_observability_stream_get(&state, &session_id, "cache-telemetry.jsonl")
}

pub(crate) async fn session_store_cache_telemetry_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    session_observability_stream_append(&state, &session_id, body, "cache-telemetry.jsonl", false)
}

pub(crate) async fn session_store_analysis_timeline_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    if !trusted_private_storage_origin(&headers) {
        return ApiResponse::error(
            "analysis_timeline_origin_forbidden",
            "analysis timeline accepts only non-browser local clients or the DeepCode local application origin",
        );
    }
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return json_body_rejection_response(
                "/api/session-store/:session_id/analysis-timeline",
                rejection,
            )
        }
    };
    let entries = body
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![body.get("entry").cloned().unwrap_or(body)]);
    if entries.is_empty() {
        return ApiResponse::ok(json!({
            "sessionId": session_id,
            "appended": 0,
            "records": []
        }));
    }
    if entries.len() > MAX_ANALYSIS_TIMELINE_BATCH_RECORDS {
        return ApiResponse::error(
            "analysis_timeline_batch_too_large",
            format!(
                "analysis timeline accepts at most {MAX_ANALYSIS_TIMELINE_BATCH_RECORDS} records per durable batch"
            ),
        );
    }
    if let Err(message) = validate_analysis_timeline_batch_size(&entries) {
        return ApiResponse::error("analysis_timeline_batch_too_large", message);
    }
    let sessions_dir = {
        let gui = state.gui.lock().expect("gui state lock");
        if session_metadata(&gui.sessions, &session_id).is_none() {
            return ApiResponse::error(
                "analysis_timeline_session_not_found",
                "analysis timeline requires an exact registered Session identity",
            );
        }
        gui.paths.sessions_dir.clone()
    };
    let append_session_id = session_id.clone();
    match tokio::task::spawn_blocking(move || {
        append_analysis_timeline_entries(&sessions_dir, &append_session_id, entries)
    })
    .await
    {
        Ok(Ok(data)) => ApiResponse::ok(data),
        Ok(Err((code, message))) => ApiResponse::error(code, message),
        Err(error) => ApiResponse::error(
            "write_analysis_timeline_failed",
            format!("analysis timeline blocking append failed: {error}"),
        ),
    }
}

fn trusted_private_storage_origin(headers: &axum::http::HeaderMap) -> bool {
    let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    if origin == "deepcode-gui://localhost" {
        return true;
    }
    let Some(origin_authority) = origin.strip_prefix("http://") else {
        return false;
    };
    let Some(request_authority) = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    origin_authority == request_authority && is_loopback_authority(origin_authority)
}

fn private_storage_origin_error(headers: &axum::http::HeaderMap) -> Option<Json<ApiResponse>> {
    (!trusted_private_storage_origin(headers)).then(|| {
        ApiResponse::error(
            "session_store_origin_forbidden",
            "private Session storage accepts only non-browser local clients or the DeepCode local application origin",
        )
    })
}

fn is_loopback_authority(authority: &str) -> bool {
    authority == "localhost"
        || authority.starts_with("localhost:")
        || authority == "127.0.0.1"
        || authority.starts_with("127.0.0.1:")
        || authority == "[::1]"
        || authority.starts_with("[::1]:")
}

fn append_analysis_timeline_entries(
    sessions_dir: &FsPath,
    session_id: &str,
    entries: Vec<Value>,
) -> Result<Value, (String, String)> {
    // Sequence assignment, digest chaining, recovery, and one group fsync are
    // serialized per path shard without holding GuiState or a Tokio worker.
    let _append_guard = analysis_timeline_append_lock(sessions_dir, session_id)
        .lock()
        .expect("analysis timeline append lock");
    if let Err(error) = repair_incomplete_analysis_timeline_tail(&sessions_dir, &session_id) {
        return Err(("analysis_timeline_tail_invalid".to_string(), error));
    }
    let tail = match read_last_session_jsonl(&sessions_dir, &session_id, "analysis-timeline.jsonl")
    {
        Ok(tail) => tail,
        Err(error) => {
            return Err(("analysis_timeline_tail_invalid".to_string(), error));
        }
    };
    if let Err(error) =
        validate_analysis_timeline_chain_if_needed(&sessions_dir, &session_id, tail.as_ref())
    {
        return Err(("analysis_timeline_chain_invalid".to_string(), error));
    }
    let mut batch_record_ids = std::collections::HashSet::new();
    for entry in &entries {
        if let Some(record_id) = entry.get("recordId").and_then(Value::as_str) {
            if !batch_record_ids.insert(record_id.to_string()) {
                return Err((
                    "analysis_timeline_batch_duplicate_record".to_string(),
                    format!("analysis timeline batch duplicated recordId {record_id}"),
                ));
            }
        }
    }
    let (mut analysis_seq, mut previous_record_digest, current_tail_seq) = match tail.as_ref() {
        Some(existing) => {
            let Some(sequence) = existing.get("analysisSeq").and_then(Value::as_u64) else {
                return Err((
                    "analysis_timeline_tail_invalid".to_string(),
                    "analysis timeline tail has no valid analysisSeq".to_string(),
                ));
            };
            let Some(digest) = existing
                .get("recordDigest")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            else {
                return Err((
                    "analysis_timeline_tail_invalid".to_string(),
                    "analysis timeline tail has no valid recordDigest".to_string(),
                ));
            };
            (sequence + 1, Some(digest.to_string()), sequence)
        }
        None => (1, None, 0),
    };
    let mut durable_records = Vec::new();
    let mut durable_acknowledgements = Vec::new();
    let mut acknowledgements = Vec::with_capacity(entries.len());
    let mut replay_last_seq: Option<u64> = None;
    let mut saw_new_record = false;
    for entry in entries {
        let incoming_record_id = entry
            .get("recordId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                (
                    "analysis_timeline_invalid".to_string(),
                    "analysis timeline recordId must be a non-empty string".to_string(),
                )
            })?;
        if let Some(existing) =
            verified_analysis_timeline_record(sessions_dir, session_id, incoming_record_id)
        {
            if saw_new_record {
                return Err((
                    "analysis_timeline_replay_order_invalid".to_string(),
                    "analysis timeline replay records must be a contiguous batch prefix"
                        .to_string(),
                ));
            }
            if let Err(error) = validate_analysis_timeline_idempotent_replay(&entry, &existing) {
                return Err(("analysis_timeline_replay_conflict".to_string(), error));
            }
            if replay_last_seq.is_some_and(|sequence| existing.analysis_seq != sequence + 1) {
                return Err((
                    "analysis_timeline_replay_order_invalid".to_string(),
                    "analysis timeline replay prefix is not sequence-contiguous".to_string(),
                ));
            }
            replay_last_seq = Some(existing.analysis_seq);
            acknowledgements.push(existing);
            continue;
        }
        if known_analysis_timeline_record(sessions_dir, session_id, incoming_record_id) {
            return Err((
                "analysis_timeline_replay_window_expired".to_string(),
                format!(
                    "analysis timeline recordId {incoming_record_id} is outside the immediate replay window"
                ),
            ));
        }
        if !saw_new_record {
            if replay_last_seq.is_some_and(|sequence| sequence != current_tail_seq) {
                return Err((
                    "analysis_timeline_replay_order_invalid".to_string(),
                    "analysis timeline replay prefix does not end at the current durable tail"
                        .to_string(),
                ));
            }
            saw_new_record = true;
        }
        let sanitized = match sanitize_analysis_timeline_entry(
            session_id,
            entry,
            analysis_seq,
            previous_record_digest.as_deref(),
        ) {
            Ok(entry) => entry,
            Err(error) => {
                return Err(("analysis_timeline_invalid".to_string(), error));
            }
        };
        let acknowledgement = match analysis_timeline_ack_from_record(&sanitized) {
            Ok(acknowledgement) => acknowledgement,
            Err(error) => {
                return Err(("analysis_timeline_ack_invalid".to_string(), error));
            }
        };
        analysis_seq += 1;
        previous_record_digest = Some(acknowledgement.record_digest.clone());
        durable_records.push(sanitized);
        durable_acknowledgements.push(acknowledgement.clone());
        acknowledgements.push(acknowledgement);
    }
    if !saw_new_record && replay_last_seq.is_some_and(|sequence| sequence != current_tail_seq) {
        return Err((
            "analysis_timeline_replay_order_invalid".to_string(),
            "analysis timeline replay batch does not end at the current durable tail".to_string(),
        ));
    }
    let durable_write = if durable_records.is_empty() {
        sync_analysis_timeline_storage(sessions_dir, session_id)
    } else {
        append_analysis_timeline_records_durable(sessions_dir, session_id, &durable_records)
    };
    if let Err(error) = durable_write {
        return Err((
            "write_analysis_timeline_failed".to_string(),
            error.to_string(),
        ));
    }
    for acknowledgement in &durable_acknowledgements {
        remember_verified_analysis_timeline_tail(sessions_dir, session_id, acknowledgement);
    }
    let appended = durable_records.len();
    let tail_record_digest = acknowledgements
        .last()
        .expect("non-empty analysis timeline batch")
        .record_digest
        .clone();
    Ok(json!({
        "sessionId": session_id,
        "appended": appended,
        "tailRecordDigest": tail_record_digest,
        "records": acknowledgements
            .iter()
            .map(analysis_timeline_ack_value)
            .collect::<Vec<_>>()
    }))
}

pub(crate) async fn session_store_projection_delivery_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    session_observability_stream_get(&state, &session_id, "projection-delivery.jsonl")
}

fn sanitize_analysis_timeline_entry(
    session_id: &str,
    entry: Value,
    analysis_seq: u64,
    previous_record_digest: Option<&str>,
) -> Result<Value, String> {
    const SCHEMA_VERSION: &str = "deepcode.session.provider-analysis.v1";
    const KINDS: &[&str] = &[
        "provider_request",
        "provider_stream",
        "provider_response",
        "provider_error",
        "semantic_exchange",
    ];
    const COMPLETIONS: &[&str] = &["complete", "partial"];
    const REQUIRED_STRING_FIELDS: &[&str] = &[
        "recordId",
        "runId",
        "stage",
        "kind",
        "completion",
        "payloadDigest",
        "createdAt",
    ];

    let mut object = entry
        .as_object()
        .cloned()
        .ok_or_else(|| "analysis timeline entry must be an object".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_str) != Some(SCHEMA_VERSION) {
        return Err("unsupported analysis timeline schemaVersion".to_string());
    }
    for field in REQUIRED_STRING_FIELDS {
        if !object
            .get(*field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(format!(
                "analysis timeline {field} must be a non-empty string"
            ));
        }
    }
    if !object
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| KINDS.contains(&kind))
    {
        return Err("unsupported analysis timeline kind".to_string());
    }
    if !object
        .get("completion")
        .and_then(Value::as_str)
        .is_some_and(|completion| COMPLETIONS.contains(&completion))
    {
        return Err("unsupported analysis timeline completion".to_string());
    }
    if !object.contains_key("payload") {
        return Err("analysis timeline payload is required".to_string());
    }
    let payload_bytes = serde_json::to_vec(
        object
            .get("payload")
            .expect("analysis timeline payload checked above"),
    )
    .map_err(|error| format!("analysis timeline payload serialization failed: {error}"))?;
    let source_payload_digest = object
        .get("payloadDigest")
        .and_then(Value::as_str)
        .expect("analysis timeline payloadDigest checked above")
        .to_string();
    object.insert(
        "sourcePayloadDigest".to_string(),
        Value::String(source_payload_digest),
    );
    object.insert(
        "payloadDigest".to_string(),
        Value::String(deepcode_kernel_tools::hash_bytes(&payload_bytes)),
    );

    object.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    object.insert(
        "analysisSeq".to_string(),
        Value::Number(analysis_seq.into()),
    );
    if let Some(previous) = previous_record_digest {
        object.insert(
            "previousRecordDigest".to_string(),
            Value::String(previous.to_string()),
        );
    } else {
        object.remove("previousRecordDigest");
    }
    object.remove("recordDigest");
    let canonical = serde_json::to_vec(&Value::Object(object.clone()))
        .map_err(|error| format!("analysis timeline serialization failed: {error}"))?;
    let digest = deepcode_kernel_tools::hash_bytes(&canonical);
    object.insert("recordDigest".to_string(), Value::String(digest));
    Ok(Value::Object(object))
}

#[derive(Clone, Debug)]
struct AnalysisTimelineRecordAck {
    record_id: String,
    analysis_seq: u64,
    previous_record_digest: Option<String>,
    record_digest: String,
    payload_digest: String,
    source_payload_digest: String,
    replay_digest: String,
}

// The Session client retries one bounded chronological batch immediately.
// Keeping one full batch in the replay window preserves idempotency without
// retaining every streamed token event in Daemon memory.
const MAX_ANALYSIS_TIMELINE_BATCH_RECORDS: usize = 256;
const MAX_ANALYSIS_TIMELINE_BATCH_BYTES: usize = 16 * 1024 * 1024;
const MAX_VERIFIED_ANALYSIS_REPLAY_RECORDS: usize = 256;

fn validate_analysis_timeline_batch_size(entries: &[Value]) -> Result<(), String> {
    struct LimitedCountWriter {
        written: usize,
    }

    impl std::io::Write for LimitedCountWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let next = self.written.saturating_add(bytes.len());
            if next > MAX_ANALYSIS_TIMELINE_BATCH_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "analysis timeline batch exceeded its byte limit",
                ));
            }
            self.written = next;
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut writer = LimitedCountWriter { written: 0 };
    serde_json::to_writer(&mut writer, entries).map_err(|error| {
        format!(
            "analysis timeline accepts at most {MAX_ANALYSIS_TIMELINE_BATCH_BYTES} serialized bytes per durable batch: {error}"
        )
    })
}

#[derive(Default)]
struct AnalysisTimelineReplayWindow {
    order: std::collections::VecDeque<String>,
    records: HashMap<String, AnalysisTimelineRecordAck>,
}

impl AnalysisTimelineReplayWindow {
    fn insert(&mut self, acknowledgement: AnalysisTimelineRecordAck) {
        if self.records.contains_key(&acknowledgement.record_id) {
            self.records
                .insert(acknowledgement.record_id.clone(), acknowledgement);
            return;
        }
        while self.order.len() >= MAX_VERIFIED_ANALYSIS_REPLAY_RECORDS {
            if let Some(record_id) = self.order.pop_front() {
                self.records.remove(&record_id);
            }
        }
        self.order.push_back(acknowledgement.record_id.clone());
        self.records
            .insert(acknowledgement.record_id.clone(), acknowledgement);
    }
}

#[derive(Default)]
struct AnalysisTimelineRecordIndex {
    known_record_ids: std::collections::HashSet<String>,
    replay_window: AnalysisTimelineReplayWindow,
}

impl AnalysisTimelineRecordIndex {
    fn insert(&mut self, acknowledgement: AnalysisTimelineRecordAck) {
        self.known_record_ids
            .insert(acknowledgement.record_id.clone());
        self.replay_window.insert(acknowledgement);
    }

    fn acknowledgement(&self, record_id: &str) -> Option<AnalysisTimelineRecordAck> {
        self.replay_window.records.get(record_id).cloned()
    }

    fn contains(&self, record_id: &str) -> bool {
        self.known_record_ids.contains(record_id)
    }
}

fn analysis_timeline_verified_tails() -> &'static std::sync::Mutex<HashMap<PathBuf, (u64, String)>>
{
    static VERIFIED: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, (u64, String)>>> =
        std::sync::OnceLock::new();
    VERIFIED.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn analysis_timeline_verified_records(
) -> &'static std::sync::Mutex<HashMap<PathBuf, AnalysisTimelineRecordIndex>> {
    static VERIFIED: std::sync::OnceLock<
        std::sync::Mutex<HashMap<PathBuf, AnalysisTimelineRecordIndex>>,
    > = std::sync::OnceLock::new();
    VERIFIED.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn analysis_timeline_path(sessions_dir: &FsPath, session_id: &str) -> PathBuf {
    sessions_dir
        .join(safe_path_segment(session_id))
        .join("analysis-timeline.jsonl")
}

fn analysis_timeline_append_lock(
    sessions_dir: &FsPath,
    session_id: &str,
) -> &'static std::sync::Mutex<()> {
    use std::hash::{Hash, Hasher};

    const SHARD_COUNT: usize = 64;
    static SHARDS: std::sync::OnceLock<Vec<std::sync::Mutex<()>>> = std::sync::OnceLock::new();
    let shards = SHARDS.get_or_init(|| {
        (0..SHARD_COUNT)
            .map(|_| std::sync::Mutex::new(()))
            .collect()
    });
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    analysis_timeline_path(sessions_dir, session_id).hash(&mut hasher);
    &shards[(hasher.finish() as usize) % SHARD_COUNT]
}

fn repair_incomplete_analysis_timeline_tail(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};

    let path = analysis_timeline_path(sessions_dir, session_id);
    let mut file = match fs::OpenOptions::new().read(true).write(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("analysis timeline recovery read failed: {error}")),
    };
    let length = file
        .metadata()
        .map_err(|error| format!("analysis timeline recovery metadata failed: {error}"))?
        .len();
    if length == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|error| format!("analysis timeline recovery seek failed: {error}"))?;
    let mut final_byte = [0_u8; 1];
    file.read_exact(&mut final_byte)
        .map_err(|error| format!("analysis timeline recovery read failed: {error}"))?;
    if final_byte[0] == b'\n' {
        return Ok(());
    }
    const RECOVERY_SCAN_CHUNK_BYTES: u64 = 64 * 1024;
    let mut scan_end = length;
    let mut buffer = Vec::new();
    let valid_len = loop {
        if scan_end == 0 {
            break 0;
        }
        let scan_start = scan_end.saturating_sub(RECOVERY_SCAN_CHUNK_BYTES);
        let scan_len = (scan_end - scan_start) as usize;
        buffer.resize(scan_len, 0);
        file.seek(SeekFrom::Start(scan_start))
            .map_err(|error| format!("analysis timeline recovery seek failed: {error}"))?;
        file.read_exact(&mut buffer)
            .map_err(|error| format!("analysis timeline recovery scan failed: {error}"))?;
        if let Some(index) = buffer.iter().rposition(|byte| *byte == b'\n') {
            break scan_start + index as u64 + 1;
        }
        scan_end = scan_start;
    };
    file.set_len(valid_len)
        .map_err(|error| format!("analysis timeline recovery truncate failed: {error}"))?;
    file.flush()
        .map_err(|error| format!("analysis timeline recovery flush failed: {error}"))?;
    file.sync_data()
        .map_err(|error| format!("analysis timeline recovery sync failed: {error}"))?;
    analysis_timeline_verified_tails()
        .lock()
        .expect("analysis timeline cache lock")
        .remove(&path);
    analysis_timeline_verified_records()
        .lock()
        .expect("analysis timeline record cache lock")
        .remove(&path);
    Ok(())
}

fn validate_analysis_timeline_chain_if_needed(
    sessions_dir: &FsPath,
    session_id: &str,
    tail: Option<&Value>,
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};

    let path = analysis_timeline_path(sessions_dir, session_id);
    let Some(tail) = tail else {
        analysis_timeline_verified_tails()
            .lock()
            .expect("analysis timeline cache lock")
            .remove(&path);
        analysis_timeline_verified_records()
            .lock()
            .expect("analysis timeline record cache lock")
            .remove(&path);
        return Ok(());
    };
    validate_analysis_timeline_record(tail)?;
    let tail_seq = tail
        .get("analysisSeq")
        .and_then(Value::as_u64)
        .ok_or_else(|| "analysis timeline tail has no valid analysisSeq".to_string())?;
    let tail_digest = tail
        .get("recordDigest")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "analysis timeline tail has no valid recordDigest".to_string())?
        .to_string();
    {
        let verified = analysis_timeline_verified_tails()
            .lock()
            .expect("analysis timeline cache lock");
        if verified.get(&path) == Some(&(tail_seq, tail_digest.clone())) {
            return Ok(());
        }
    }

    let file = fs::File::open(&path)
        .map_err(|error| format!("analysis timeline chain open failed: {error}"))?;
    let mut expected_seq = 1_u64;
    let mut previous_digest: Option<String> = None;
    let mut observed_tail: Option<(u64, String)> = None;
    let mut verified_records = AnalysisTimelineRecordIndex::default();
    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| format!("analysis timeline chain read failed: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let record: Value = serde_json::from_str(&line).map_err(|error| {
            format!(
                "analysis timeline chain line {} is invalid JSON: {error}",
                line_index + 1
            )
        })?;
        validate_analysis_timeline_record(&record)?;
        let sequence = record
            .get("analysisSeq")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                format!(
                    "analysis timeline chain line {} has no sequence",
                    line_index + 1
                )
            })?;
        if sequence != expected_seq {
            return Err(format!(
                "analysis timeline chain line {} expected sequence {} but found {}",
                line_index + 1,
                expected_seq,
                sequence
            ));
        }
        let record_previous = record
            .get("previousRecordDigest")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if record_previous != previous_digest {
            return Err(format!(
                "analysis timeline chain line {} has an invalid previous digest",
                line_index + 1
            ));
        }
        let digest = record
            .get("recordDigest")
            .and_then(Value::as_str)
            .expect("record digest validated above")
            .to_string();
        let acknowledgement = analysis_timeline_ack_from_record(&record)?;
        if verified_records.contains(&acknowledgement.record_id) {
            return Err(format!(
                "analysis timeline chain line {} duplicated recordId",
                line_index + 1
            ));
        }
        verified_records.insert(acknowledgement);
        previous_digest = Some(digest.clone());
        observed_tail = Some((sequence, digest));
        expected_seq += 1;
    }
    if observed_tail != Some((tail_seq, tail_digest.clone())) {
        return Err("analysis timeline verified chain does not match its tail".to_string());
    }
    analysis_timeline_verified_tails()
        .lock()
        .expect("analysis timeline cache lock")
        .insert(path, (tail_seq, tail_digest));
    analysis_timeline_verified_records()
        .lock()
        .expect("analysis timeline record cache lock")
        .insert(
            analysis_timeline_path(sessions_dir, session_id),
            verified_records,
        );
    Ok(())
}

fn validate_analysis_timeline_record(record: &Value) -> Result<(), String> {
    let object = record
        .as_object()
        .ok_or_else(|| "analysis timeline record must be an object".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.session.provider-analysis.v1")
    {
        return Err("analysis timeline record has an unsupported schemaVersion".to_string());
    }
    let payload = object
        .get("payload")
        .ok_or_else(|| "analysis timeline record has no payload".to_string())?;
    if !object
        .get("sourcePayloadDigest")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err("analysis timeline record has no sourcePayloadDigest".to_string());
    }
    let payload_bytes = serde_json::to_vec(payload)
        .map_err(|error| format!("analysis timeline payload validation failed: {error}"))?;
    let expected_payload_digest = deepcode_kernel_tools::hash_bytes(&payload_bytes);
    if object.get("payloadDigest").and_then(Value::as_str) != Some(expected_payload_digest.as_str())
    {
        return Err("analysis timeline payload digest mismatch".to_string());
    }
    let expected_record_digest = object
        .get("recordDigest")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "analysis timeline record has no recordDigest".to_string())?;
    let mut canonical = object.clone();
    canonical.remove("recordDigest");
    let canonical_bytes = serde_json::to_vec(&Value::Object(canonical))
        .map_err(|error| format!("analysis timeline record validation failed: {error}"))?;
    if deepcode_kernel_tools::hash_bytes(&canonical_bytes) != expected_record_digest {
        return Err("analysis timeline record digest mismatch".to_string());
    }
    Ok(())
}

fn validate_analysis_timeline_idempotent_replay(
    incoming: &Value,
    existing: &AnalysisTimelineRecordAck,
) -> Result<(), String> {
    let record_id = incoming
        .get("recordId")
        .and_then(Value::as_str)
        .ok_or_else(|| "analysis timeline replay has no recordId".to_string())?;
    if record_id != existing.record_id {
        return Err("analysis timeline replay changed record identity".to_string());
    }
    if analysis_timeline_replay_digest(incoming)? != existing.replay_digest {
        return Err("analysis timeline replay changed record content".to_string());
    }
    Ok(())
}

fn analysis_timeline_replay_digest(entry: &Value) -> Result<String, String> {
    let mut object = entry
        .as_object()
        .cloned()
        .ok_or_else(|| "analysis timeline replay must be an object".to_string())?;
    for field in [
        "sessionId",
        "analysisSeq",
        "previousRecordDigest",
        "recordDigest",
        "payloadDigest",
        "sourcePayloadDigest",
    ] {
        object.remove(field);
    }
    let bytes = serde_json::to_vec(&Value::Object(object))
        .map_err(|error| format!("analysis timeline replay serialization failed: {error}"))?;
    Ok(deepcode_kernel_tools::hash_bytes(&bytes))
}

fn analysis_timeline_ack_from_record(entry: &Value) -> Result<AnalysisTimelineRecordAck, String> {
    let record_id = entry
        .get("recordId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "analysis timeline acknowledgement has no recordId".to_string())?
        .to_string();
    let analysis_seq = entry
        .get("analysisSeq")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "analysis timeline acknowledgement has no sequence".to_string())?;
    let record_digest = entry
        .get("recordDigest")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "analysis timeline acknowledgement has no recordDigest".to_string())?
        .to_string();
    let payload_digest = entry
        .get("payloadDigest")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "analysis timeline acknowledgement has no payloadDigest".to_string())?
        .to_string();
    let source_payload_digest = entry
        .get("sourcePayloadDigest")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "analysis timeline acknowledgement has no sourcePayloadDigest".to_string())?
        .to_string();
    Ok(AnalysisTimelineRecordAck {
        record_id,
        analysis_seq,
        previous_record_digest: entry
            .get("previousRecordDigest")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        record_digest,
        payload_digest,
        source_payload_digest,
        replay_digest: analysis_timeline_replay_digest(entry)?,
    })
}

fn verified_analysis_timeline_record(
    sessions_dir: &FsPath,
    session_id: &str,
    record_id: &str,
) -> Option<AnalysisTimelineRecordAck> {
    analysis_timeline_verified_records()
        .lock()
        .expect("analysis timeline record cache lock")
        .get(&analysis_timeline_path(sessions_dir, session_id))
        .and_then(|index| index.acknowledgement(record_id))
}

fn known_analysis_timeline_record(
    sessions_dir: &FsPath,
    session_id: &str,
    record_id: &str,
) -> bool {
    analysis_timeline_verified_records()
        .lock()
        .expect("analysis timeline record cache lock")
        .get(&analysis_timeline_path(sessions_dir, session_id))
        .is_some_and(|index| index.contains(record_id))
}

fn append_analysis_timeline_records_durable(
    sessions_dir: &FsPath,
    session_id: &str,
    entries: &[Value],
) -> std::io::Result<()> {
    use std::io::Write;

    if entries.is_empty() {
        return Ok(());
    }
    let dir = sessions_dir.join(safe_path_segment(session_id));
    let dir_preexisted = dir.exists();
    create_private_analysis_directory(&dir)?;
    secure_private_analysis_directory(&dir)?;
    let path = dir.join("analysis-timeline.jsonl");
    let file_preexisted = path.exists();
    let mut bytes = Vec::new();
    for entry in entries {
        bytes.extend(serde_json::to_vec(entry).unwrap_or_else(|_| b"{}".to_vec()));
        bytes.push(b'\n');
    }
    let mut open_options = fs::OpenOptions::new();
    open_options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_options.mode(0o600);
    }
    let mut file = open_options.open(&path)?;
    secure_private_analysis_file(&path)?;
    file.write_all(&bytes)?;
    file.flush()?;
    file.sync_data()?;
    if !file_preexisted {
        sync_analysis_directory(&dir)?;
    }
    if !dir_preexisted {
        sync_analysis_directory(sessions_dir)?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_analysis_directory(path: &FsPath) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(path)
}

#[cfg(not(unix))]
fn create_private_analysis_directory(path: &FsPath) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

#[cfg(unix)]
fn secure_private_analysis_directory(path: &FsPath) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn secure_private_analysis_directory(_path: &FsPath) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn secure_private_analysis_file(path: &FsPath) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn secure_private_analysis_file(_path: &FsPath) -> std::io::Result<()> {
    Ok(())
}

fn sync_analysis_timeline_storage(sessions_dir: &FsPath, session_id: &str) -> std::io::Result<()> {
    let dir = sessions_dir.join(safe_path_segment(session_id));
    fs::OpenOptions::new()
        .read(true)
        .open(dir.join("analysis-timeline.jsonl"))?
        .sync_data()?;
    sync_analysis_directory(&dir)?;
    sync_analysis_directory(sessions_dir)
}

#[cfg(unix)]
fn sync_analysis_directory(path: &FsPath) -> std::io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_analysis_directory(_path: &FsPath) -> std::io::Result<()> {
    Ok(())
}

fn remember_verified_analysis_timeline_tail(
    sessions_dir: &FsPath,
    session_id: &str,
    acknowledgement: &AnalysisTimelineRecordAck,
) {
    analysis_timeline_verified_tails()
        .lock()
        .expect("analysis timeline cache lock")
        .insert(
            analysis_timeline_path(sessions_dir, session_id),
            (
                acknowledgement.analysis_seq,
                acknowledgement.record_digest.clone(),
            ),
        );
    analysis_timeline_verified_records()
        .lock()
        .expect("analysis timeline record cache lock")
        .entry(analysis_timeline_path(sessions_dir, session_id))
        .or_default()
        .insert(acknowledgement.clone());
}

fn analysis_timeline_ack_value(entry: &AnalysisTimelineRecordAck) -> Value {
    json!({
        "recordId": entry.record_id,
        "analysisSeq": entry.analysis_seq,
        "previousRecordDigest": entry.previous_record_digest,
        "recordDigest": entry.record_digest,
        "payloadDigest": entry.payload_digest,
        "sourcePayloadDigest": entry.source_payload_digest,
    })
}

pub(crate) async fn session_store_projection_delivery_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    if let Some(error) = private_storage_origin_error(&headers) {
        return error;
    }
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return json_body_rejection_response(
                "/api/session-store/:session_id/projection-delivery",
                rejection,
            )
        }
    };
    let entries = body
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![body.get("entry").cloned().unwrap_or(body)]);
    let append_state = state.clone();
    let append_session_id = session_id.clone();
    match tokio::task::spawn_blocking(move || {
        append_projection_delivery_entries(&append_state, &append_session_id, entries)
    })
    .await
    {
        Ok(Ok(appended)) => ApiResponse::ok(json!({
            "sessionId": session_id,
            "appended": appended
        })),
        Ok(Err(error)) => ApiResponse::error("write_projection_delivery_failed", error),
        Err(error) => ApiResponse::error(
            "write_projection_delivery_failed",
            format!("projection delivery blocking append failed: {error}"),
        ),
    }
}

fn session_observability_stream_get(
    state: &AppState,
    session_id: &str,
    file_name: &str,
) -> Json<ApiResponse> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let entries = read_session_jsonl(&sessions_dir, session_id, file_name);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "entries": entries
    }))
}

fn session_observability_stream_append(
    state: &AppState,
    session_id: &str,
    body: Result<Json<Value>, JsonRejection>,
    file_name: &str,
    reject_reasoning: bool,
) -> Json<ApiResponse> {
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return json_body_rejection_response(
                "/api/session-store/:session_id/observability",
                rejection,
            )
        }
    };
    let entries = body
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![body.get("entry").cloned().unwrap_or(body.clone())]);
    if reject_reasoning && entries.iter().any(is_hidden_reasoning_wire_record) {
        return ApiResponse::error(
            "wire_ledger_reasoning_forbidden",
            "hidden reasoning cannot be persisted in the wire ledger",
        );
    }
    let sanitized = entries
        .into_iter()
        .map(strip_hidden_reasoning_fields)
        .map(redact_archive_value)
        .collect::<Vec<_>>();
    let (sessions_dir, archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.sessions_dir.clone(),
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, session_id),
        )
    };
    if let Err(error) = append_session_jsonl(&sessions_dir, session_id, file_name, &sanitized) {
        return ApiResponse::error("write_session_observability_failed", error.to_string());
    }
    if let Err(error) = append_conversation_archive_entries(
        &archive_root,
        session_id,
        session.as_ref(),
        file_name,
        file_name,
        &sanitized,
    ) {
        eprintln!("failed to append conversation archive {file_name}: {error}");
    }
    let stored = read_session_jsonl(&sessions_dir, session_id, file_name);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "appended": sanitized.len(),
        "entryCount": stored.len(),
        "entries": stored
    }))
}

pub(crate) fn append_projection_delivery_entries(
    state: &AppState,
    session_id: &str,
    entries: Vec<Value>,
) -> Result<usize, String> {
    let sanitized = entries
        .into_iter()
        .map(|entry| sanitize_projection_delivery_entry(session_id, entry))
        .collect::<Result<Vec<_>, _>>()?;
    if sanitized.is_empty() {
        return Ok(0);
    }
    let (sessions_dir, archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.sessions_dir.clone(),
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, session_id),
        )
    };
    let _append_guard = projection_delivery_append_lock(&sessions_dir, session_id)
        .lock()
        .expect("projection delivery append lock");
    append_session_jsonl(
        &sessions_dir,
        session_id,
        "projection-delivery.jsonl",
        &sanitized,
    )
    .map_err(|error| error.to_string())?;
    append_conversation_archive_entries(
        &archive_root,
        session_id,
        session.as_ref(),
        "projection-delivery.jsonl",
        "projection-delivery.jsonl",
        &sanitized,
    )
    .map_err(|error| error.to_string())?;
    Ok(sanitized.len())
}

fn projection_delivery_append_lock(
    sessions_dir: &FsPath,
    session_id: &str,
) -> &'static std::sync::Mutex<()> {
    use std::hash::{Hash, Hasher};

    const SHARD_COUNT: usize = 64;
    static SHARDS: std::sync::OnceLock<Vec<std::sync::Mutex<()>>> = std::sync::OnceLock::new();
    let shards = SHARDS.get_or_init(|| {
        (0..SHARD_COUNT)
            .map(|_| std::sync::Mutex::new(()))
            .collect()
    });
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    sessions_dir
        .join(safe_path_segment(session_id))
        .join("projection-delivery.jsonl")
        .hash(&mut hasher);
    &shards[(hasher.finish() as usize) % SHARD_COUNT]
}

fn sanitize_projection_delivery_entry(session_id: &str, entry: Value) -> Result<Value, String> {
    const SCHEMA_VERSION: &str = "deepcode.session.projection-delivery.v1";
    const STAGES: &[&str] = &[
        "session.provider_delta_received",
        "session.timeline_delta_projected",
        "session.timeline_delta_posted",
        "session.timeline_delta_post_failed",
        "daemon.timeline_delta_received",
        "daemon.timeline_delta_enqueued",
        "daemon.sse_delta_sent",
        "daemon.sse_terminal_sent",
        "gui.sse_stream_started",
        "gui.sse_stream_ended",
        "gui.sse_stream_failed",
        "gui.sse_delta_received",
        "gui.reducer_applied",
        "gui.reducer_gap",
        "gui.playback_released",
        "gui.render_committed",
        "gui.playback_settled",
        "diagnostic.dropped",
    ];
    const REQUIRED_STRING_FIELDS: &[&str] = &["stage", "at", "runId"];
    const OPTIONAL_STRING_FIELDS: &[&str] = &[
        "turnId",
        "itemId",
        "blockId",
        "op",
        "deliveryMode",
        "contentHash",
        "failureCode",
        "result",
    ];
    const OPTIONAL_NUMBER_FIELDS: &[&str] = &["revision", "deltaSeq", "charLength", "droppedCount"];

    let object = entry
        .as_object()
        .ok_or_else(|| "projection delivery entry must be an object".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_str) != Some(SCHEMA_VERSION) {
        return Err("unsupported projection delivery schemaVersion".to_string());
    }
    let mut sanitized = serde_json::Map::new();
    sanitized.insert(
        "schemaVersion".to_string(),
        Value::String(SCHEMA_VERSION.to_string()),
    );
    sanitized.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    for field in REQUIRED_STRING_FIELDS {
        let value = object
            .get(*field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("projection delivery entry requires {field}"))?;
        sanitized.insert((*field).to_string(), Value::String(value.to_string()));
    }
    if !sanitized
        .get("stage")
        .and_then(Value::as_str)
        .is_some_and(|stage| STAGES.contains(&stage))
    {
        return Err("unsupported projection delivery stage".to_string());
    }
    for field in OPTIONAL_STRING_FIELDS {
        if let Some(value) = object.get(*field).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                sanitized.insert((*field).to_string(), Value::String(value.to_string()));
            }
        }
    }
    for field in OPTIONAL_NUMBER_FIELDS {
        if let Some(value) = object.get(*field).and_then(Value::as_u64) {
            sanitized.insert((*field).to_string(), Value::Number(value.into()));
        }
    }
    Ok(Value::Object(sanitized))
}

pub(crate) fn parse_session_append_command(
    body: Value,
) -> Result<SessionAppendCommandV1, SessionDomainStoreError> {
    let command = serde_json::from_value::<SessionAppendCommandV1>(body).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("Session append command is invalid: {error}"),
        )
    })?;
    validate_session_append_command(&command)?;
    if matches!(
        command.transition,
        SessionAppendTransitionV1::Append {
            intent: SessionAppendIntentV1::OpenRun,
            ..
        }
    ) {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "New Session runs must use the atomic bootstrapRun admission; openRun is replay-only",
        ));
    }
    Ok(command)
}

pub(crate) fn initialize_session_domain_store(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<SessionDomainHeadV1, SessionDomainStoreError> {
    validate_domain_identity(session_id, "sessionId")?;
    let admission_lock = session_domain_admission_lock(sessions_dir, session_id);
    let _admission_guard = admission_lock
        .lock()
        .expect("session domain admission lock");
    let _projection_guard = session_jsonl_append_lock(sessions_dir, session_id, "projection.jsonl")
        .lock()
        .expect("session projection JSONL lock");
    let snapshot = load_session_domain_snapshot_unlocked(sessions_dir, session_id, true)?;
    match snapshot.writeability {
        SessionDomainWriteability::Current => {
            return snapshot.head.ok_or_else(|| {
                SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    "Current Session domain store has no composite head",
                )
            });
        }
        SessionDomainWriteability::LegacyReadOnly => {
            return Err(SessionDomainStoreError::new(
                "session_append_legacy_read_only",
                "Legacy raw-event Session is read-only and cannot be initialized as a domain-batch store",
            ));
        }
        SessionDomainWriteability::Corrupt => {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Corrupt Session domain store cannot be initialized automatically",
            ));
        }
        SessionDomainWriteability::Uninitialized => {}
    }

    let base_head = empty_session_domain_head();
    let projection_digest = None;
    let projection_revision = None;
    let batch_digest = session_domain_batch_digest(
        session_id,
        SESSION_DOMAIN_GENESIS_BATCH_ID,
        &base_head,
        &[],
        &SessionAppendTransitionV1::Genesis,
        &[],
        &[],
        projection_digest.as_deref(),
        projection_revision,
    )?;
    let result_head = next_session_domain_head(
        &base_head,
        SESSION_DOMAIN_GENESIS_BATCH_ID,
        &batch_digest,
        0,
    )?;
    let record = SessionDomainBatchRecordV1 {
        schema_version: SESSION_DOMAIN_BATCH_SCHEMA_VERSION.to_string(),
        record_kind: SESSION_DOMAIN_BATCH_RECORD_KIND.to_string(),
        session_id: session_id.to_string(),
        batch_id: SESSION_DOMAIN_GENESIS_BATCH_ID.to_string(),
        batch_digest,
        base_head,
        preconditions: Vec::new(),
        transition: SessionAppendTransitionV1::Genesis,
        provider_admissions: Vec::new(),
        events: Vec::new(),
        result_head: result_head.clone(),
        projection_digest,
        projection_revision,
        committed_at: now_text(),
    };
    append_session_domain_record_durable(sessions_dir, session_id, &record)?;
    Ok(result_head)
}

pub(crate) fn read_session_domain_snapshot(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<SessionDomainSnapshot, SessionDomainStoreError> {
    let _projection_guard = session_jsonl_append_lock(sessions_dir, session_id, "projection.jsonl")
        .lock()
        .expect("session projection JSONL lock");
    load_session_domain_snapshot_unlocked(sessions_dir, session_id, true)
}

pub(crate) fn register_session_run_bootstrap(
    state: &AppState,
    session_id: &str,
    run_id: &str,
) -> Result<SessionRunBootstrapGrant, SessionDomainStoreError> {
    validate_domain_identity(session_id, "sessionId")?;
    validate_domain_identity(run_id, "runId")?;
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let admission_lock = session_domain_admission_lock(&sessions_dir, session_id);
    let _admission_guard = admission_lock
        .lock()
        .expect("session domain admission lock");
    let snapshot = {
        let _projection_guard =
            session_jsonl_append_lock(&sessions_dir, session_id, "projection.jsonl")
                .lock()
                .expect("session projection JSONL lock");
        load_session_domain_snapshot_unlocked(&sessions_dir, session_id, true)?
    };
    if snapshot.writeability != SessionDomainWriteability::Current {
        return Err(match snapshot.writeability {
            SessionDomainWriteability::LegacyReadOnly => SessionDomainStoreError::new(
                "session_append_legacy_read_only",
                "Legacy raw-event Session cannot admit a new run",
            ),
            _ => SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session domain store cannot admit a new run until recovery completes",
            ),
        });
    }
    let derived = validate_session_domain_record_chain(session_id, &snapshot.records)?;
    if derived.run_fences.contains_key(run_id) {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("Run fence {run_id} already exists"),
        ));
    }
    let key = session_run_bootstrap_registry_key(&sessions_dir, session_id, run_id);
    let token = new_session_run_bootstrap_token()?;
    let admission_digest = deepcode_kernel_tools::hash_bytes(
        format!("{session_id}:{run_id}:{token}:admission").as_bytes(),
    );
    let admission_id = format!(
        "bootstrap-admission-{}",
        admission_digest
            .strip_prefix("sha256:")
            .unwrap_or(admission_digest.as_str())
    );
    let mut registry = session_run_bootstrap_registry()
        .lock()
        .expect("session run bootstrap registry");
    if registry
        .get(&key)
        .is_some_and(|entry| matches!(entry.state, SessionRunBootstrapAdmissionState::Pending))
    {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("Run {run_id} already has a pending bootstrap admission"),
        ));
    }
    registry.insert(
        key,
        SessionRunBootstrapAdmission {
            admission_id: admission_id.clone(),
            token: token.clone(),
            state: SessionRunBootstrapAdmissionState::Pending,
        },
    );
    Ok(SessionRunBootstrapGrant {
        admission_id,
        token,
    })
}

pub(crate) fn observe_session_run_bootstrap(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    token: &str,
) -> SessionRunBootstrapObservation {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let key = session_run_bootstrap_registry_key(&sessions_dir, session_id, run_id);
    let registry = session_run_bootstrap_registry()
        .lock()
        .expect("session run bootstrap registry");
    let Some(entry) = registry.get(&key) else {
        return SessionRunBootstrapObservation::Missing;
    };
    if !bootstrap_tokens_equal(&entry.token, token) {
        return SessionRunBootstrapObservation::Missing;
    }
    match &entry.state {
        SessionRunBootstrapAdmissionState::Pending => SessionRunBootstrapObservation::Pending,
        SessionRunBootstrapAdmissionState::Committed {
            batch_id,
            turn_authority_ref,
        } => SessionRunBootstrapObservation::Committed {
            batch_id: batch_id.clone(),
            turn_authority_ref: turn_authority_ref.clone(),
        },
        SessionRunBootstrapAdmissionState::Revoked { reason } => {
            SessionRunBootstrapObservation::Revoked {
                reason: reason.clone(),
            }
        }
    }
}

pub(crate) fn revoke_session_run_bootstrap(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    token: &str,
    reason: &str,
) -> Result<SessionRunBootstrapObservation, SessionDomainStoreError> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let admission_lock = session_domain_admission_lock(&sessions_dir, session_id);
    let _admission_guard = admission_lock
        .lock()
        .expect("session domain admission lock");
    let key = session_run_bootstrap_registry_key(&sessions_dir, session_id, run_id);
    let mut registry = session_run_bootstrap_registry()
        .lock()
        .expect("session run bootstrap registry");
    let Some(entry) = registry.get_mut(&key) else {
        return Ok(SessionRunBootstrapObservation::Missing);
    };
    if !bootstrap_tokens_equal(&entry.token, token) {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "Run bootstrap token does not match its registered admission",
        ));
    }
    match &entry.state {
        SessionRunBootstrapAdmissionState::Pending => {
            entry.state = SessionRunBootstrapAdmissionState::Revoked {
                reason: reason.to_string(),
            };
            Ok(SessionRunBootstrapObservation::Revoked {
                reason: reason.to_string(),
            })
        }
        SessionRunBootstrapAdmissionState::Committed {
            batch_id,
            turn_authority_ref,
        } => Ok(SessionRunBootstrapObservation::Committed {
            batch_id: batch_id.clone(),
            turn_authority_ref: turn_authority_ref.clone(),
        }),
        SessionRunBootstrapAdmissionState::Revoked { reason } => {
            Ok(SessionRunBootstrapObservation::Revoked {
                reason: reason.clone(),
            })
        }
    }
}

pub(crate) fn clear_session_run_bootstrap(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    token: &str,
) {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let key = session_run_bootstrap_registry_key(&sessions_dir, session_id, run_id);
    let mut registry = session_run_bootstrap_registry()
        .lock()
        .expect("session run bootstrap registry");
    if registry
        .get(&key)
        .is_some_and(|entry| bootstrap_tokens_equal(&entry.token, token))
    {
        registry.remove(&key);
    }
}

fn session_run_recovery_candidates() -> &'static Mutex<std::collections::HashSet<String>> {
    static CANDIDATES: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    CANDIDATES.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

pub(crate) fn discover_session_run_recovery(state: &AppState) {
    let (sessions_dir, session_ids) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.sessions_dir.clone(),
            gui.sessions
                .iter()
                .filter_map(|session| {
                    session
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_string)
                })
                .collect::<Vec<_>>(),
        )
    };
    let mut candidates = session_run_recovery_candidates()
        .lock()
        .expect("session run recovery candidates");
    for session_id in session_ids {
        let requires_recovery = match read_session_domain_snapshot(&sessions_dir, &session_id) {
            Ok(snapshot) if snapshot.writeability == SessionDomainWriteability::Current => {
                validate_session_domain_record_chain(&session_id, &snapshot.records)
                    .map(|derived| {
                        derived
                            .run_fences
                            .values()
                            .any(|run| run.state != SessionRunFenceSnapshotState::Closed)
                    })
                    .unwrap_or(true)
            }
            Ok(snapshot)
                if matches!(
                    snapshot.writeability,
                    SessionDomainWriteability::LegacyReadOnly
                        | SessionDomainWriteability::Uninitialized
                ) =>
            {
                false
            }
            Ok(_) | Err(_) => true,
        };
        if requires_recovery {
            candidates.insert(session_id);
        }
    }
}

pub(crate) fn reconcile_session_run_recovery(
    state: &AppState,
    session_id: &str,
) -> Result<usize, SessionDomainStoreError> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let snapshot = read_session_domain_snapshot(&sessions_dir, session_id)?;
    match snapshot.writeability {
        SessionDomainWriteability::Current => {}
        SessionDomainWriteability::LegacyReadOnly => {
            return Err(SessionDomainStoreError::new(
                "session_append_legacy_read_only",
                "Legacy raw-event Session is read-only and cannot recover or admit runs",
            ))
        }
        _ => {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session domain state is not recoverable by deterministic run reconciliation",
            ))
        }
    }
    let derived = validate_session_domain_record_chain(session_id, &snapshot.records)?;
    let active_run_ids = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.values()
            .filter(|run| run.session_id == session_id && run_status_active(&run.status))
            .map(|run| run.run_id.clone())
            .collect::<std::collections::HashSet<_>>()
    };
    let mut orphan_runs = derived
        .run_fences
        .iter()
        .filter(|(run_id, run)| {
            run.state != SessionRunFenceSnapshotState::Closed && !active_run_ids.contains(*run_id)
        })
        .map(|(run_id, run)| (run_id.clone(), run.state))
        .collect::<Vec<_>>();
    orphan_runs.sort_by(|left, right| left.0.cmp(&right.0));
    let mut recovered = 0usize;
    for (run_id, state_before) in orphan_runs {
        let requested_status = if state_before == SessionRunFenceSnapshotState::Closing {
            "cancelled"
        } else {
            "failed"
        };
        let terminal_code = if state_before == SessionRunFenceSnapshotState::Closing {
            "session_recovery_cancelled_run"
        } else {
            "session_recovery_abandoned_run"
        };
        admit_session_terminal_close(
            state,
            session_id,
            &run_id,
            requested_status,
            Some(terminal_code),
            Some(
                "Daemon restart deterministically closed an unfinished Session run without replaying Provider or tool work.",
            ),
        )?;
        recovered += 1;
    }
    let current = read_session_domain_snapshot(&sessions_dir, session_id)?;
    let current_derived = validate_session_domain_record_chain(session_id, &current.records)?;
    let still_orphaned = current_derived.run_fences.iter().any(|(run_id, run)| {
        run.state != SessionRunFenceSnapshotState::Closed && !active_run_ids.contains(run_id)
    });
    let mut candidates = session_run_recovery_candidates()
        .lock()
        .expect("session run recovery candidates");
    if still_orphaned {
        candidates.insert(session_id.to_string());
    } else {
        candidates.remove(session_id);
    }
    Ok(recovered)
}

#[derive(Debug, Clone)]
pub(crate) struct DurableSessionRunOutcome {
    pub(crate) status: String,
    pub(crate) started_at: String,
    pub(crate) completed_at: String,
    pub(crate) message: Option<String>,
    pub(crate) final_text: Option<String>,
}

pub(crate) fn durable_session_run_outcome(
    state: &AppState,
    session_id: &str,
    run_id: &str,
) -> Result<DurableSessionRunOutcome, SessionDomainStoreError> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let snapshot = read_session_domain_snapshot(&sessions_dir, session_id)?;
    if snapshot.writeability != SessionDomainWriteability::Current {
        return Err(match snapshot.writeability {
            SessionDomainWriteability::LegacyReadOnly => SessionDomainStoreError::new(
                "session_append_legacy_read_only",
                "Legacy raw-event Session has no canonical durable run outcome",
            ),
            _ => SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session domain state cannot reconstruct a durable run outcome",
            ),
        });
    }
    let derived = validate_session_domain_record_chain(session_id, &snapshot.records)?;
    let run = derived.run_fences.get(run_id).ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Durable run fence {run_id} is missing"),
        )
    })?;
    if run.state != SessionRunFenceSnapshotState::Closed {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Durable run {run_id} has not reached a terminal outcome"),
        ));
    }
    let terminal_batch_id = run.owner_batch_id.as_deref().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Durable run {run_id} has no terminal owner batch"),
        )
    })?;
    let terminal_record_index = snapshot
        .records
        .iter()
        .position(|record| record.batch_id == terminal_batch_id)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Durable run {run_id} terminal owner record is missing"),
            )
        })?;
    let terminal_record = &snapshot.records[terminal_record_index];
    let status = terminal_transition_status(&terminal_record.transition)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Durable run {run_id} terminal owner is not a close transition"),
            )
        })?
        .to_string();
    let run_start_record_index = snapshot
        .records
        .iter()
        .position(|record| transition_host_run_id(&record.transition) == Some(run_id))
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Durable run {run_id} has no opening transition record"),
            )
        })?;
    if run_start_record_index > terminal_record_index {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Durable run {run_id} terminal owner precedes its opening transition"),
        ));
    }
    let started_at = snapshot.records[run_start_record_index]
        .committed_at
        .clone();
    let record_prefix = &snapshot.records[..=terminal_record_index];
    let run_record_interval = &snapshot.records[run_start_record_index..=terminal_record_index];
    let turn_authority_ref =
        match current_turn_authority_ref_for_host_run(record_prefix, session_id, run_id) {
            Ok(authority_ref) => Some(authority_ref),
            Err(error) if error.code == "session_append_transition_invalid" => None,
            Err(error) => return Err(error),
        };
    let (message, final_text) = if let Some(turn_authority_ref) = turn_authority_ref.as_deref() {
        let mut terminal_facts = terminal_record.events.iter().filter(|event| {
            event.get("kind").and_then(Value::as_str) == Some("session_run_state")
                && event.pointer("/payload/status").and_then(Value::as_str) == Some(status.as_str())
                && event
                    .pointer("/payload/phase")
                    .and_then(Value::as_str)
                    .is_some_and(|phase| terminal_fact_phase_matches(&status, phase))
                && event
                    .pointer("/payload/lineage/turnAuthorityRef")
                    .and_then(Value::as_str)
                    == Some(turn_authority_ref)
        });
        let terminal_fact = terminal_facts.next().ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Durable run {run_id} terminal owner has no exact {status} fact under authority {turn_authority_ref}"
                ),
            )
        })?;
        if terminal_facts.next().is_some() {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Durable run {run_id} terminal owner has multiple exact terminal facts under authority {turn_authority_ref}"
                ),
            ));
        }
        let message = terminal_fact
            .pointer("/payload/message")
            .or_else(|| terminal_fact.pointer("/payload/summary"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string);
        let final_text = run_record_interval
            .iter()
            .rev()
            .flat_map(|record| record.events.iter().rev())
            .find_map(|event| {
                durable_final_assistant_text_for_authority(event, turn_authority_ref)
            });
        (message, final_text)
    } else {
        // Compatibility-only current logs created before atomic bootstrap may
        // have a run fence without an authority binding. They remain readable,
        // but no event text is attributed without exact durable lineage.
        (None, None)
    };
    Ok(DurableSessionRunOutcome {
        status,
        started_at,
        completed_at: terminal_record.committed_at.clone(),
        message,
        final_text,
    })
}

fn terminal_fact_phase_matches(status: &str, phase: &str) -> bool {
    phase == "terminal"
        || matches!(
            (status, phase),
            ("completed", "completed") | ("failed", "failed") | ("cancelled", "cancelled")
        )
        || (status == "waiting" && phase.starts_with("waiting_"))
}

fn durable_final_assistant_text_for_authority(
    event: &Value,
    turn_authority_ref: &str,
) -> Option<String> {
    let payload = event.get("payload")?;
    if event.get("kind").and_then(Value::as_str) != Some("assistant_msg")
        || payload.get("channel").and_then(Value::as_str) != Some("final")
        || payload.get("reasoningTrace").and_then(Value::as_bool) == Some(true)
        || matches!(
            payload.get("visibility").and_then(Value::as_str),
            Some("hidden" | "debug")
        )
        || payload.get("presentation").and_then(Value::as_str) == Some("traceOnly")
        || event
            .pointer("/display/presentation")
            .and_then(Value::as_str)
            == Some("traceOnly")
        || payload
            .pointer("/lineage/turnAuthorityRef")
            .and_then(Value::as_str)
            != Some(turn_authority_ref)
    {
        return None;
    }
    payload
        .get("content")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

pub(crate) fn session_run_has_durable_fence(
    state: &AppState,
    session_id: &str,
    run_id: &str,
) -> Result<bool, SessionDomainStoreError> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let snapshot = read_session_domain_snapshot(&sessions_dir, session_id)?;
    match snapshot.writeability {
        SessionDomainWriteability::Current => {
            let derived = validate_session_domain_record_chain(session_id, &snapshot.records)?;
            Ok(derived.run_fences.contains_key(run_id))
        }
        SessionDomainWriteability::LegacyReadOnly => Err(SessionDomainStoreError::new(
            "session_append_legacy_read_only",
            "Legacy raw-event Session cannot own a canonical durable run fence",
        )),
        SessionDomainWriteability::Uninitialized => Ok(false),
        SessionDomainWriteability::Corrupt => Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Session domain state is corrupt and cannot prove a durable run fence",
        )),
    }
}

fn transition_host_run_id(transition: &SessionAppendTransitionV1) -> Option<&str> {
    match transition {
        SessionAppendTransitionV1::Append { run_id, .. }
        | SessionAppendTransitionV1::Close { run_id, .. } => Some(run_id),
        SessionAppendTransitionV1::Claim {
            claimant_run_id, ..
        } => Some(claimant_run_id),
        SessionAppendTransitionV1::Genesis => None,
    }
}

pub(crate) fn inspect_session_domain_writeability(
    sessions_dir: &FsPath,
    session_id: &str,
) -> SessionDomainWriteability {
    match read_session_domain_snapshot(sessions_dir, session_id) {
        Ok(snapshot) => snapshot.writeability,
        Err(_) => SessionDomainWriteability::Corrupt,
    }
}

pub(crate) fn session_append_writeability_value(sessions_dir: &FsPath, session_id: &str) -> Value {
    match read_session_domain_snapshot(sessions_dir, session_id) {
        Ok(snapshot) if snapshot.writeability == SessionDomainWriteability::Current => json!({
            "schemaVersion": "deepcode.session.append-writeability.v1",
            "status": "writable",
            "format": "domainBatchV1"
        }),
        Ok(snapshot) if snapshot.writeability == SessionDomainWriteability::LegacyReadOnly => {
            json!({
            "schemaVersion": "deepcode.session.append-writeability.v1",
            "status": "readOnly",
            "format": "legacyRawEventsV1",
            "reason": "legacyFormat"
            })
        }
        Ok(_) => json!({
            "schemaVersion": "deepcode.session.append-writeability.v1",
            "status": "readOnly",
            "format": "invalid",
            "reason": "recoveryRequired"
        }),
        Err(error) if error.message.contains("mixes legacy raw AgentEvent") => json!({
            "schemaVersion": "deepcode.session.append-writeability.v1",
            "status": "readOnly",
            "format": "mixed",
            "reason": "mixedFormat"
        }),
        Err(error)
            if error.message.contains("incomplete non-newline")
                || error.message.contains("staged timeline") =>
        {
            json!({
                "schemaVersion": "deepcode.session.append-writeability.v1",
                "status": "readOnly",
                "format": "invalid",
                "reason": "recoveryRequired"
            })
        }
        Err(_) => json!({
            "schemaVersion": "deepcode.session.append-writeability.v1",
            "status": "readOnly",
            "format": "invalid",
            "reason": "invalidRecord"
        }),
    }
}

fn load_session_domain_snapshot_unlocked(
    sessions_dir: &FsPath,
    session_id: &str,
    repair_incomplete_tail: bool,
) -> Result<SessionDomainSnapshot, SessionDomainStoreError> {
    let path = session_domain_projection_path(sessions_dir, session_id);
    let raw_records =
        read_session_domain_records_strict(&path, session_id, repair_incomplete_tail)?;
    if raw_records.is_empty() {
        return Ok(SessionDomainSnapshot {
            writeability: SessionDomainWriteability::Uninitialized,
            head: None,
            events: Vec::new(),
            records: Vec::new(),
        });
    }

    let mut domain_record_count = 0usize;
    let mut legacy_record_count = 0usize;
    for value in &raw_records {
        if is_session_domain_batch_envelope(value) {
            domain_record_count += 1;
        } else {
            validate_legacy_session_event(value, session_id)?;
            legacy_record_count += 1;
        }
    }
    if domain_record_count > 0 && legacy_record_count > 0 {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "projection.jsonl mixes legacy raw AgentEvent lines with domain-batch envelopes",
        ));
    }
    if legacy_record_count > 0 {
        return Ok(SessionDomainSnapshot {
            writeability: SessionDomainWriteability::LegacyReadOnly,
            head: None,
            events: raw_records,
            records: Vec::new(),
        });
    }

    let records = raw_records
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            serde_json::from_value::<SessionDomainBatchRecordV1>(value).map_err(|error| {
                SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Session domain-batch record {} does not match the v1 private schema: {error}",
                        index + 1
                    ),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_session_domain_record_chain(session_id, &records)?;
    let events = records
        .iter()
        .flat_map(|record| record.events.iter().cloned())
        .collect::<Vec<_>>();
    let head = records.last().map(|record| record.result_head.clone());
    Ok(SessionDomainSnapshot {
        writeability: SessionDomainWriteability::Current,
        head,
        events,
        records,
    })
}

fn read_session_domain_records_strict(
    path: &FsPath,
    session_id: &str,
    repair_incomplete_tail: bool,
) -> Result<Vec<Value>, SessionDomainStoreError> {
    let mut bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Failed to read Session domain log {}: {error}",
                    path.display()
                ),
            ))
        }
    };
    if bytes.is_empty() {
        return Ok(Vec::new());
    }

    if !bytes.ends_with(b"\n") {
        let tail_start = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        let tail = &bytes[tail_start..];
        if serde_json::from_slice::<Value>(strip_optional_carriage_return(tail)).is_err() {
            if !repair_incomplete_tail {
                return Err(SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    "projection.jsonl ends with an incomplete non-newline JSON fragment",
                ));
            }
            validate_current_domain_tail_recovery_prefix(session_id, &bytes[..tail_start])?;
            quarantine_and_truncate_incomplete_domain_tail(path, &bytes, tail_start)?;
            bytes.truncate(tail_start);
        }
    }

    parse_session_domain_record_bytes(&bytes)
}

fn parse_session_domain_record_bytes(bytes: &[u8]) -> Result<Vec<Value>, SessionDomainStoreError> {
    let mut records = Vec::new();
    let mut line_start = 0usize;
    let mut line_number = 1usize;
    while line_start < bytes.len() {
        let line_end = bytes[line_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| line_start + offset)
            .unwrap_or(bytes.len());
        let line = strip_optional_carriage_return(&bytes[line_start..line_end]);
        if line.is_empty() {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("projection.jsonl contains a blank physical record at line {line_number}"),
            ));
        }
        let record = serde_json::from_slice::<Value>(line).map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("projection.jsonl contains invalid JSON at line {line_number}: {error}"),
            )
        })?;
        if !record.is_object() {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("projection.jsonl record at line {line_number} must be a JSON object"),
            ));
        }
        records.push(record);
        line_number += 1;
        line_start = line_end.saturating_add(1);
    }
    Ok(records)
}

fn validate_current_domain_tail_recovery_prefix(
    session_id: &str,
    prefix: &[u8],
) -> Result<(), SessionDomainStoreError> {
    let raw_records = parse_session_domain_record_bytes(prefix)?;
    if raw_records.is_empty()
        || raw_records
            .iter()
            .any(|record| !is_session_domain_batch_envelope(record))
    {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Incomplete Session domain tail cannot be repaired until its prefix is proven to be a current domainBatch chain",
        ));
    }
    let records = raw_records
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            serde_json::from_value::<SessionDomainBatchRecordV1>(value).map_err(|error| {
                SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Session domain-batch recovery prefix record {} does not match the v1 private schema: {error}",
                        index + 1
                    ),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_session_domain_record_chain(session_id, &records)?;
    Ok(())
}

fn strip_optional_carriage_return(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

fn quarantine_and_truncate_incomplete_domain_tail(
    path: &FsPath,
    original: &[u8],
    valid_prefix_len: usize,
) -> Result<(), SessionDomainStoreError> {
    let parent = path.parent().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Session domain log has no parent directory",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Failed to create Session domain recovery directory: {error}"),
        )
    })?;
    let mut suffix = now_millis().to_string();
    let backup_path = loop {
        let candidate = parent.join(format!("projection.jsonl.incomplete-tail.{suffix}.bak"));
        if !candidate.exists() {
            break candidate;
        }
        suffix.push('x');
    };
    let mut backup = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&backup_path)
        .map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Failed to create incomplete-tail backup {}: {error}",
                    backup_path.display()
                ),
            )
        })?;
    backup.write_all(original).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Failed to write incomplete-tail backup: {error}"),
        )
    })?;
    backup
        .flush()
        .and_then(|_| backup.sync_data())
        .map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Failed to sync incomplete-tail backup: {error}"),
            )
        })?;
    let file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Failed to reopen incomplete Session domain log: {error}"),
            )
        })?;
    file.set_len(valid_prefix_len as u64).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Failed to truncate incomplete Session domain tail: {error}"),
        )
    })?;
    file.sync_data().map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Failed to sync repaired Session domain log: {error}"),
        )
    })
}

fn is_session_domain_batch_envelope(value: &Value) -> bool {
    value.get("recordKind").and_then(Value::as_str) == Some(SESSION_DOMAIN_BATCH_RECORD_KIND)
        || value
            .get("schemaVersion")
            .and_then(Value::as_str)
            .is_some_and(|version| version.starts_with("deepcode.session.domain-batch."))
}

fn validate_legacy_session_event(
    event: &Value,
    session_id: &str,
) -> Result<(), SessionDomainStoreError> {
    let object = event.as_object().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Legacy projection record must be a JSON object",
        )
    })?;
    for field in ["id", "sessionId", "ts", "kind"] {
        if !object
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Legacy projection record requires non-empty {field}"),
            ));
        }
    }
    if object.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Legacy projection record belongs to a different Session",
        ));
    }
    if !object.contains_key("payload") {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Legacy projection record requires payload",
        ));
    }
    Ok(())
}

fn empty_session_domain_head() -> SessionDomainHeadV1 {
    SessionDomainHeadV1 {
        schema_version: "deepcode.session.domain-head.v1".to_string(),
        head_revision: 0,
        event_version: 0,
        head_digest: deepcode_kernel_tools::hash_bytes(b"deepcode.session.domain-head.v1:empty"),
    }
}

fn session_domain_batch_digest(
    session_id: &str,
    batch_id: &str,
    base_head: &SessionDomainHeadV1,
    preconditions: &[SessionAppendPreconditionV1],
    transition: &SessionAppendTransitionV1,
    provider_admissions: &[SessionProviderAdmissionMetadataV1],
    events: &[Value],
    projection_digest: Option<&str>,
    projection_revision: Option<u64>,
) -> Result<String, SessionDomainStoreError> {
    let material = json!({
        "schemaVersion": SESSION_APPEND_COMMAND_SCHEMA_VERSION,
        "sessionId": session_id,
        "batchId": batch_id,
        "baseHead": base_head,
        "preconditions": preconditions,
        "transition": transition,
        "providerAdmissions": provider_admissions,
        "events": events,
        "projectionDigest": projection_digest,
        "projectionRevision": projection_revision
    });
    let canonical = canonical_json_bytes(&material)?;
    Ok(deepcode_kernel_tools::hash_bytes(&canonical))
}

fn next_session_domain_head(
    base_head: &SessionDomainHeadV1,
    batch_id: &str,
    batch_digest: &str,
    appended_events: usize,
) -> Result<SessionDomainHeadV1, SessionDomainStoreError> {
    let head_revision = base_head.head_revision.checked_add(1).ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Session domain head revision overflow",
        )
    })?;
    let appended_events = u64::try_from(appended_events).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Session event count conversion failed: {error}"),
        )
    })?;
    let event_version = base_head
        .event_version
        .checked_add(appended_events)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session domain event version overflow",
            )
        })?;
    let digest_material = json!({
        "schemaVersion": "deepcode.session.domain-head.v1",
        "baseHead": base_head,
        "batchId": batch_id,
        "batchDigest": batch_digest,
        "headRevision": head_revision,
        "eventVersion": event_version
    });
    let head_digest = deepcode_kernel_tools::hash_bytes(&canonical_json_bytes(&digest_material)?);
    Ok(SessionDomainHeadV1 {
        schema_version: "deepcode.session.domain-head.v1".to_string(),
        head_revision,
        event_version,
        head_digest,
    })
}

fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, SessionDomainStoreError> {
    serde_json::to_vec(&canonical_json_value(value)).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("Failed to canonicalize Session append material: {error}"),
        )
    })
}

fn canonical_json_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut canonical = serde_json::Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonical_json_value(&object[key]));
            }
            Value::Object(canonical)
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical_json_value).collect()),
        _ => value.clone(),
    }
}

fn session_domain_projection_path(sessions_dir: &FsPath, session_id: &str) -> PathBuf {
    sessions_dir
        .join(safe_path_segment(session_id))
        .join("projection.jsonl")
}

fn session_domain_admission_lock(
    sessions_dir: &FsPath,
    session_id: &str,
) -> std::sync::Arc<std::sync::Mutex<()>> {
    use std::sync::{Arc, Mutex, OnceLock, Weak};

    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let path = session_domain_projection_path(sessions_dir, session_id);
    let mut locks = locks.lock().expect("session domain lock registry");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&path).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path, Arc::downgrade(&lock));
    lock
}

fn validate_domain_identity(value: &str, label: &str) -> Result<(), SessionDomainStoreError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 240
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!(
                "{label} must be a non-empty bounded ASCII identity using letters, digits, '.', '_', ':' or '-'"
            ),
        ));
    }
    Ok(())
}

fn append_session_domain_record_durable(
    sessions_dir: &FsPath,
    session_id: &str,
    record: &SessionDomainBatchRecordV1,
) -> Result<(), SessionDomainStoreError> {
    let dir = sessions_dir.join(safe_path_segment(session_id));
    fs::create_dir_all(&dir).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Failed to create Session domain directory: {error}"),
        )
    })?;
    let path = dir.join("projection.jsonl");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(&path)
        .map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Failed to open Session domain log for append: {error}"),
            )
        })?;
    let length = file
        .metadata()
        .map(|metadata| metadata.len())
        .map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Failed to inspect Session domain log before append: {error}"),
            )
        })?;
    if length > 0 {
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::End(-1)).map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Failed to inspect Session domain log tail: {error}"),
            )
        })?;
        let mut tail = [0u8; 1];
        file.read_exact(&mut tail).map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Failed to read Session domain log tail: {error}"),
            )
        })?;
        if tail[0] != b'\n' {
            file.write_all(b"\n").map_err(|error| {
                SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!("Failed to terminate the previous Session domain record: {error}"),
                )
            })?;
        }
    }
    let mut bytes = serde_json::to_vec(record).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("Failed to serialize Session domain-batch record: {error}"),
        )
    })?;
    bytes.push(b'\n');
    file.write_all(&bytes).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Failed to append Session domain-batch record: {error}"),
        )
    })?;
    file.flush()
        .and_then(|_| file.sync_data())
        .map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Failed to sync Session domain-batch record: {error}"),
            )
        })
}

fn validate_session_append_command(
    command: &SessionAppendCommandV1,
) -> Result<(), SessionDomainStoreError> {
    if command.schema_version != SESSION_APPEND_COMMAND_SCHEMA_VERSION {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!(
                "Unsupported Session append command schemaVersion {}",
                command.schema_version
            ),
        ));
    }
    validate_domain_identity(&command.batch_id, "batchId")?;
    validate_session_domain_head(&command.base_head, "baseHead")?;
    if matches!(command.transition, SessionAppendTransitionV1::Genesis) {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "The private genesis transition cannot be submitted over the append API",
        ));
    }
    validate_session_append_precondition_shapes(&command.preconditions)?;
    validate_session_append_transition_shape(&command.transition)?;
    let is_bootstrap = matches!(
        command.transition,
        SessionAppendTransitionV1::Append {
            intent: SessionAppendIntentV1::BootstrapRun,
            ..
        }
    );
    if is_bootstrap {
        if let Some(token) = command.bootstrap_token.as_deref() {
            validate_domain_identity(token, "bootstrapToken")?;
        }
    } else if command.bootstrap_token.is_some() {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "Only bootstrapRun may carry the request-only bootstrapToken",
        ));
    }
    validate_provider_admission_metadata(&command.provider_admissions)?;
    validate_session_domain_events(&command.events, None)?;
    Ok(())
}

fn validate_session_domain_head(
    head: &SessionDomainHeadV1,
    label: &str,
) -> Result<(), SessionDomainStoreError> {
    if head.schema_version != "deepcode.session.domain-head.v1" {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("{label} has unsupported schemaVersion"),
        ));
    }
    if !valid_sha256_digest(&head.head_digest) {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("{label}.headDigest is not a canonical sha256 digest"),
        ));
    }
    Ok(())
}

fn validate_session_append_precondition_shapes(
    preconditions: &[SessionAppendPreconditionV1],
) -> Result<(), SessionDomainStoreError> {
    let mut identities = std::collections::HashSet::new();
    for precondition in preconditions {
        let identity = match precondition {
            SessionAppendPreconditionV1::RunFence { run_id, expected } => {
                validate_domain_identity(run_id, "runFence.runId")?;
                match expected.state {
                    SessionRunFenceStateV1::Open if expected.owner_batch_id.is_some() => {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Open runFence expectation must not carry ownerBatchId",
                        ))
                    }
                    SessionRunFenceStateV1::Closing | SessionRunFenceStateV1::Closed
                        if expected.owner_batch_id.is_none() =>
                    {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Closing or closed runFence expectation requires ownerBatchId",
                        ))
                    }
                    _ => {}
                }
                if let Some(owner_batch_id) = expected.owner_batch_id.as_deref() {
                    validate_domain_identity(owner_batch_id, "runFence.ownerBatchId")?;
                }
                format!("run:{run_id}")
            }
            SessionAppendPreconditionV1::TurnAuthority { event_id } => {
                validate_domain_identity(event_id, "turnAuthority.eventId")?;
                format!("authority:{event_id}")
            }
            SessionAppendPreconditionV1::Interaction {
                interaction_id,
                interaction_revision,
                target_id,
                expected,
            } => {
                validate_domain_identity(interaction_id, "interaction.interactionId")?;
                validate_domain_identity(interaction_revision, "interaction.interactionRevision")?;
                validate_domain_identity(target_id, "interaction.targetId")?;
                match expected.state {
                    SessionInteractionFenceStateV1::Open if expected.claim_batch_id.is_some() => {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Open interaction expectation must not carry claimBatchId",
                        ))
                    }
                    SessionInteractionFenceStateV1::Claimed
                        if expected.claim_batch_id.is_none() =>
                    {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Claimed interaction expectation requires claimBatchId",
                        ))
                    }
                    _ => {}
                }
                if let Some(claim_batch_id) = expected.claim_batch_id.as_deref() {
                    validate_domain_identity(claim_batch_id, "interaction.claimBatchId")?;
                }
                format!("interaction:{interaction_id}")
            }
        };
        if !identities.insert(identity) {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Session append command contains a duplicate precondition identity",
            ));
        }
    }
    Ok(())
}

fn validate_session_append_transition_shape(
    transition: &SessionAppendTransitionV1,
) -> Result<(), SessionDomainStoreError> {
    match transition {
        SessionAppendTransitionV1::Genesis => Ok(()),
        SessionAppendTransitionV1::Append {
            intent,
            run_id,
            turn_authority_ref,
            bootstrap_admission_id,
            interaction_id,
            interaction_revision,
            target_id,
            claim_batch_id,
        } => {
            validate_domain_identity(run_id, "transition.runId")?;
            match intent {
                SessionAppendIntentV1::OpenRun => {
                    if turn_authority_ref.is_some() || bootstrap_admission_id.is_some() {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "openRun transition must not carry authority or bootstrap fields",
                        ));
                    }
                    if interaction_id.is_some()
                        || interaction_revision.is_some()
                        || target_id.is_some()
                        || claim_batch_id.is_some()
                    {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "openRun transition carries unsupported fields",
                        ));
                    }
                }
                SessionAppendIntentV1::BootstrapRun => {
                    let authority = turn_authority_ref.as_deref().ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "bootstrapRun transition requires turnAuthorityRef",
                        )
                    })?;
                    let admission_id = bootstrap_admission_id.as_deref().ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "bootstrapRun transition requires bootstrapAdmissionId",
                        )
                    })?;
                    validate_domain_identity(authority, "transition.turnAuthorityRef")?;
                    validate_domain_identity(admission_id, "transition.bootstrapAdmissionId")?;
                    if interaction_id.is_some()
                        || interaction_revision.is_some()
                        || target_id.is_some()
                        || claim_batch_id.is_some()
                    {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "bootstrapRun transition carries interaction settlement fields",
                        ));
                    }
                }
                SessionAppendIntentV1::DomainFacts | SessionAppendIntentV1::Guidance => {
                    if bootstrap_admission_id.is_some() {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Ordinary append transitions must not carry bootstrapAdmissionId",
                        ));
                    }
                    let authority = turn_authority_ref.as_deref().ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "domainFacts and guidance append transitions require turnAuthorityRef",
                        )
                    })?;
                    validate_domain_identity(authority, "transition.turnAuthorityRef")?;
                    if interaction_id.is_some()
                        || interaction_revision.is_some()
                        || target_id.is_some()
                        || claim_batch_id.is_some()
                    {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Non-settlement append transition carries interaction settlement fields",
                        ));
                    }
                }
                SessionAppendIntentV1::InteractionSettlement
                | SessionAppendIntentV1::ReleaseInteractionClaim => {
                    if turn_authority_ref.is_some() || bootstrap_admission_id.is_some() {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Interaction settlement transition must not carry authority or bootstrap fields",
                        ));
                    }
                    for (value, label) in [
                        (interaction_id.as_deref(), "transition.interactionId"),
                        (
                            interaction_revision.as_deref(),
                            "transition.interactionRevision",
                        ),
                        (target_id.as_deref(), "transition.targetId"),
                        (claim_batch_id.as_deref(), "transition.claimBatchId"),
                    ] {
                        validate_domain_identity(
                            value.ok_or_else(|| {
                                SessionDomainStoreError::new(
                                    "session_append_transition_invalid",
                                    format!("{label} is required"),
                                )
                            })?,
                            label,
                        )?;
                    }
                }
            }
            Ok(())
        }
        SessionAppendTransitionV1::Claim {
            claimant_run_id,
            decision_request_id,
            interaction_id,
            interaction_revision,
            target_id,
        } => {
            for (value, label) in [
                (claimant_run_id.as_str(), "transition.claimantRunId"),
                (decision_request_id.as_str(), "transition.decisionRequestId"),
                (interaction_id.as_str(), "transition.interactionId"),
                (
                    interaction_revision.as_str(),
                    "transition.interactionRevision",
                ),
                (target_id.as_str(), "transition.targetId"),
            ] {
                validate_domain_identity(value, label)?;
            }
            Ok(())
        }
        SessionAppendTransitionV1::Close {
            phase,
            run_id,
            status,
            parent_close_batch_id,
            interaction_effect,
        } => {
            validate_domain_identity(run_id, "transition.runId")?;
            match phase {
                SessionClosePhaseV1::Request => {
                    if status != "cancelRequested"
                        || parent_close_batch_id.is_some()
                        || interaction_effect.is_some()
                    {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Close request requires status=cancelRequested and no parent or interaction effect",
                        ));
                    }
                }
                SessionClosePhaseV1::Terminal => {
                    if !matches!(
                        status.as_str(),
                        "completed" | "failed" | "waiting" | "cancelled"
                    ) {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Terminal close status must be completed, failed, waiting or cancelled",
                        ));
                    }
                    match (status.as_str(), parent_close_batch_id.as_deref()) {
                        ("cancelled", Some(parent_close_batch_id)) => {
                            validate_domain_identity(
                                parent_close_batch_id,
                                "transition.parentCloseBatchId",
                            )?;
                        }
                        ("cancelled", None) => {
                            return Err(SessionDomainStoreError::new(
                                "session_append_transition_invalid",
                                "Cancelled terminal close requires parentCloseBatchId",
                            ))
                        }
                        (_, Some(_)) => {
                            return Err(SessionDomainStoreError::new(
                                "session_append_transition_invalid",
                                "Non-cancelled terminal close must not carry parentCloseBatchId",
                            ))
                        }
                        _ => {}
                    }
                    match (status.as_str(), interaction_effect) {
                        ("waiting", Some(SessionInteractionEffectV1::Open { .. })) => {}
                        ("waiting", _) => {
                            return Err(SessionDomainStoreError::new(
                                "session_append_transition_invalid",
                                "Waiting terminal close must open exactly one new interaction",
                            ))
                        }
                        (_, Some(SessionInteractionEffectV1::Open { .. })) => {
                            return Err(SessionDomainStoreError::new(
                                "session_append_transition_invalid",
                                "Only a waiting terminal close may open an interaction",
                            ))
                        }
                        _ => {}
                    }
                }
            }
            if let Some(effect) = interaction_effect {
                validate_session_interaction_effect_shape(effect)?;
            }
            Ok(())
        }
    }
}

fn validate_session_interaction_effect_shape(
    effect: &SessionInteractionEffectV1,
) -> Result<(), SessionDomainStoreError> {
    let (interaction_id, interaction_revision, target_id, claim_batch_id) = match effect {
        SessionInteractionEffectV1::Open {
            interaction_id,
            interaction_revision,
            target_id,
        } => (
            interaction_id.as_str(),
            interaction_revision.as_str(),
            target_id.as_str(),
            None,
        ),
        SessionInteractionEffectV1::Settle {
            interaction_id,
            interaction_revision,
            target_id,
            claim_batch_id,
        }
        | SessionInteractionEffectV1::Release {
            interaction_id,
            interaction_revision,
            target_id,
            claim_batch_id,
        } => (
            interaction_id.as_str(),
            interaction_revision.as_str(),
            target_id.as_str(),
            Some(claim_batch_id.as_str()),
        ),
    };
    for (value, label) in [
        (interaction_id, "interactionEffect.interactionId"),
        (
            interaction_revision,
            "interactionEffect.interactionRevision",
        ),
        (target_id, "interactionEffect.targetId"),
    ] {
        validate_domain_identity(value, label)?;
    }
    if let Some(claim_batch_id) = claim_batch_id {
        validate_domain_identity(claim_batch_id, "interactionEffect.claimBatchId")?;
    }
    Ok(())
}

fn validate_open_interaction_projection_binding(
    transition: &SessionAppendTransitionV1,
    timeline: Option<&Value>,
) -> Result<(), SessionDomainStoreError> {
    let SessionAppendTransitionV1::Close {
        phase: SessionClosePhaseV1::Terminal,
        status,
        interaction_effect:
            Some(SessionInteractionEffectV1::Open {
                interaction_id,
                interaction_revision,
                target_id,
            }),
        ..
    } = transition
    else {
        return Ok(());
    };
    if status != "waiting" {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "Only a waiting terminal transition may bind an open interaction projection",
        ));
    }
    let pending = timeline
        .and_then(|value| value.pointer("/interactionProjection/pending"))
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Waiting interaction open requires an exact pending Shared Projection identity",
            )
        })?;
    if pending.get("interactionId").and_then(Value::as_str) != Some(interaction_id)
        || pending.get("interactionRevision").and_then(Value::as_str) != Some(interaction_revision)
        || pending.get("targetId").and_then(Value::as_str) != Some(target_id)
    {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "Waiting interaction open identity does not match Shared Projection pending identity",
        ));
    }
    Ok(())
}

fn validate_provider_admission_metadata(
    admissions: &[SessionProviderAdmissionMetadataV1],
) -> Result<(), SessionDomainStoreError> {
    let mut request_ids = std::collections::HashSet::new();
    for admission in admissions {
        if admission.schema_version != SESSION_PROVIDER_ADMISSION_SCHEMA_VERSION {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Provider admission metadata has unsupported schemaVersion",
            ));
        }
        for (value, label) in [
            (admission.request_id.as_str(), "providerAdmission.requestId"),
            (
                admission.turn_authority_ref.as_str(),
                "providerAdmission.turnAuthorityRef",
            ),
            (
                admission.attempt_kind.as_str(),
                "providerAdmission.attemptKind",
            ),
            (admission.stage.as_str(), "providerAdmission.stage"),
        ] {
            validate_domain_identity(value, label)?;
        }
        if let Some(parent_request_id) = admission.parent_request_id.as_deref() {
            validate_domain_identity(parent_request_id, "providerAdmission.parentRequestId")?;
        }
        if !matches!(
            admission.attempt_kind.as_str(),
            "primary" | "resume" | "repair" | "emptyRetry" | "streamFallback" | "review"
        ) {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Provider admission metadata has unsupported attemptKind",
            ));
        }
        if !valid_sha256_digest(&admission.provider_payload_digest)
            || !valid_sha256_digest(&admission.transport_digest)
        {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Provider admission metadata requires canonical providerPayloadDigest and transportDigest",
            ));
        }
        if !request_ids.insert(admission.request_id.clone()) {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Provider admission metadata duplicates requestId within one batch",
            ));
        }
    }
    Ok(())
}

fn valid_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    })
}

fn validate_session_domain_events(
    events: &[Value],
    expected_session_id: Option<&str>,
) -> Result<(), SessionDomainStoreError> {
    let mut event_ids = std::collections::HashSet::new();
    for event in events {
        let object = event.as_object().ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Session domain event must be a JSON object",
            )
        })?;
        for field in ["id", "sessionId", "ts", "kind"] {
            if !object
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(SessionDomainStoreError::new(
                    "session_append_transition_invalid",
                    format!("Session domain event requires non-empty {field}"),
                ));
            }
        }
        let event_id = object
            .get("id")
            .and_then(Value::as_str)
            .expect("event id validated above");
        validate_domain_identity(event_id, "event.id")?;
        if !event_ids.insert(event_id.to_string()) {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                format!("Session append batch duplicates event id {event_id}"),
            ));
        }
        if let Some(expected_session_id) = expected_session_id {
            if object.get("sessionId").and_then(Value::as_str) != Some(expected_session_id) {
                return Err(SessionDomainStoreError::new(
                    "session_append_transition_invalid",
                    format!("Session domain event {event_id} belongs to a different Session"),
                ));
            }
        }
        if !object.contains_key("payload") {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                format!("Session domain event {event_id} requires payload"),
            ));
        }
        if is_hidden_reasoning_persistence_record(event)
            || strip_hidden_reasoning_fields(event.clone()) != *event
        {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                format!(
                    "Session domain event {event_id} contains private reasoning data and cannot enter projection.jsonl"
                ),
            ));
        }
    }
    Ok(())
}

fn validate_session_domain_record_chain(
    session_id: &str,
    records: &[SessionDomainBatchRecordV1],
) -> Result<SessionDomainDerivedState, SessionDomainStoreError> {
    if records.is_empty() {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Current Session domain store has no genesis record",
        ));
    }
    let mut expected_head = empty_session_domain_head();
    let mut state = SessionDomainDerivedState::default();
    let mut batch_ids = std::collections::HashSet::new();

    for (index, record) in records.iter().enumerate() {
        if record.schema_version != SESSION_DOMAIN_BATCH_SCHEMA_VERSION
            || record.record_kind != SESSION_DOMAIN_BATCH_RECORD_KIND
        {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Session domain record {} has unsupported private schema",
                    index + 1
                ),
            ));
        }
        if record.session_id != session_id {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Session domain record {} belongs to a different Session",
                    index + 1
                ),
            ));
        }
        validate_domain_identity(&record.batch_id, "record.batchId").map_err(|mut error| {
            error.code = "session_append_recovery_required";
            error
        })?;
        if !batch_ids.insert(record.batch_id.clone()) {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Session domain chain duplicates batchId {}",
                    record.batch_id
                ),
            ));
        }
        validate_session_domain_head(&record.base_head, "record.baseHead").map_err(
            |mut error| {
                error.code = "session_append_recovery_required";
                error
            },
        )?;
        validate_session_domain_head(&record.result_head, "record.resultHead").map_err(
            |mut error| {
                error.code = "session_append_recovery_required";
                error
            },
        )?;
        if record.base_head != expected_head {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Session domain record {} does not extend the previous composite head",
                    index + 1
                ),
            )
            .with_current_head(Some(expected_head)));
        }
        if index == 0 {
            if record.batch_id != SESSION_DOMAIN_GENESIS_BATCH_ID
                || !matches!(record.transition, SessionAppendTransitionV1::Genesis)
                || !record.preconditions.is_empty()
                || !record.provider_admissions.is_empty()
                || !record.events.is_empty()
                || record.projection_digest.is_some()
                || record.projection_revision.is_some()
            {
                return Err(SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    "First Session domain record is not the canonical zero-event genesis",
                ));
            }
        } else if matches!(record.transition, SessionAppendTransitionV1::Genesis) {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session domain chain contains genesis after its first record",
            ));
        }
        validate_session_append_precondition_shapes(&record.preconditions).map_err(
            |mut error| {
                error.code = "session_append_recovery_required";
                error
            },
        )?;
        validate_session_append_transition_shape(&record.transition).map_err(|mut error| {
            error.code = "session_append_recovery_required";
            error
        })?;
        validate_provider_admission_metadata(&record.provider_admissions).map_err(
            |mut error| {
                error.code = "session_append_recovery_required";
                error
            },
        )?;
        validate_session_domain_events(&record.events, Some(session_id)).map_err(|mut error| {
            error.code = "session_append_recovery_required";
            error
        })?;
        validate_projection_record_fields(record)?;

        let expected_batch_digest = session_domain_batch_digest(
            session_id,
            &record.batch_id,
            &record.base_head,
            &record.preconditions,
            &record.transition,
            &record.provider_admissions,
            &record.events,
            record.projection_digest.as_deref(),
            record.projection_revision,
        )?;
        if record.batch_digest != expected_batch_digest {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Session domain record {} batchDigest does not match canonical command material",
                    index + 1
                ),
            ));
        }
        let expected_result_head = next_session_domain_head(
            &record.base_head,
            &record.batch_id,
            &record.batch_digest,
            record.events.len(),
        )?;
        if record.result_head != expected_result_head {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Session domain record {} resultHead does not match its batch",
                    index + 1
                ),
            ));
        }

        for event in &record.events {
            let event_id = event
                .get("id")
                .and_then(Value::as_str)
                .expect("domain event id validated above");
            if state.event_ids.contains(event_id) {
                return Err(SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!("Session domain chain duplicates event id {event_id}"),
                ));
            }
        }
        for admission in &record.provider_admissions {
            if state.provider_request_ids.contains(&admission.request_id) {
                return Err(SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Session domain chain duplicates Provider request id {}",
                        admission.request_id
                    ),
                ));
            }
        }

        validate_session_append_preconditions(&state, &record.preconditions, &record.base_head)
            .map_err(|mut error| {
                error.code = "session_append_recovery_required";
                error
            })?;
        let incoming_authorities = record
            .events
            .iter()
            .filter(|event| {
                event.get("kind").and_then(Value::as_str) == Some("session_turn_authority")
            })
            .filter_map(|event| event.get("id").and_then(Value::as_str))
            .collect::<std::collections::HashSet<_>>();
        validate_provider_admission_authority_refs(
            &state,
            &record.provider_admissions,
            &incoming_authorities,
        )
        .map_err(|mut error| {
            error.code = "session_append_recovery_required";
            error
        })?;
        apply_session_append_transition(
            &mut state,
            &record.transition,
            &record.preconditions,
            &record.batch_id,
            &record.events,
        )
        .map_err(|mut error| {
            error.code = "session_append_recovery_required";
            error
        })?;
        for event in &record.events {
            let event_id = event
                .get("id")
                .and_then(Value::as_str)
                .expect("domain event id validated above")
                .to_string();
            if event.get("kind").and_then(Value::as_str) == Some("session_turn_authority") {
                state.turn_authority_event_ids.insert(event_id.clone());
            }
            state.event_ids.insert(event_id);
        }
        state.provider_request_ids.extend(
            record
                .provider_admissions
                .iter()
                .map(|admission| admission.request_id.clone()),
        );
        expected_head = record.result_head.clone();
    }
    Ok(state)
}

fn validate_projection_record_fields(
    record: &SessionDomainBatchRecordV1,
) -> Result<(), SessionDomainStoreError> {
    match (
        record.projection_digest.as_deref(),
        record.projection_revision,
    ) {
        (None, None) => Ok(()),
        (Some(digest), Some(_)) if valid_sha256_digest(digest) => Ok(()),
        _ => Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Session domain record projectionDigest and projectionRevision must both be present and valid",
        )),
    }
}

fn validate_provider_admission_authority_refs(
    state: &SessionDomainDerivedState,
    admissions: &[SessionProviderAdmissionMetadataV1],
    incoming_authorities: &std::collections::HashSet<&str>,
) -> Result<(), SessionDomainStoreError> {
    let mut admitted_in_batch = std::collections::HashSet::new();
    for admission in admissions {
        if !state
            .turn_authority_event_ids
            .contains(&admission.turn_authority_ref)
            && !incoming_authorities.contains(admission.turn_authority_ref.as_str())
        {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Provider admission {} references missing turn authority {}",
                    admission.request_id, admission.turn_authority_ref
                ),
            ));
        }
        if let Some(parent_request_id) = admission.parent_request_id.as_deref() {
            if !state.provider_request_ids.contains(parent_request_id)
                && !admitted_in_batch.contains(parent_request_id)
            {
                return Err(SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Provider admission {} references missing parent request {}",
                        admission.request_id, parent_request_id
                    ),
                ));
            }
        }
        admitted_in_batch.insert(admission.request_id.as_str());
    }
    Ok(())
}

fn validate_session_append_preconditions(
    state: &SessionDomainDerivedState,
    preconditions: &[SessionAppendPreconditionV1],
    current_head: &SessionDomainHeadV1,
) -> Result<(), SessionDomainStoreError> {
    for (index, precondition) in preconditions.iter().enumerate() {
        let matched = match precondition {
            SessionAppendPreconditionV1::RunFence { run_id, expected } => {
                state.run_fences.get(run_id).is_some_and(|actual| {
                    let state_matches = match expected.state {
                        SessionRunFenceStateV1::Open => {
                            actual.state == SessionRunFenceSnapshotState::Open
                        }
                        SessionRunFenceStateV1::Closing => {
                            actual.state == SessionRunFenceSnapshotState::Closing
                        }
                        SessionRunFenceStateV1::Closed => {
                            actual.state == SessionRunFenceSnapshotState::Closed
                        }
                    };
                    state_matches
                        && actual.revision == expected.revision
                        && actual.owner_batch_id == expected.owner_batch_id
                })
            }
            SessionAppendPreconditionV1::TurnAuthority { event_id } => {
                state.turn_authority_event_ids.contains(event_id)
            }
            SessionAppendPreconditionV1::Interaction {
                interaction_id,
                interaction_revision,
                target_id,
                expected,
            } => state
                .interactions
                .get(interaction_id)
                .is_some_and(|actual| {
                    actual.interaction_revision == *interaction_revision
                        && actual.target_id == *target_id
                        && match expected.state {
                            SessionInteractionFenceStateV1::Open => {
                                actual.state == SessionInteractionFenceSnapshotState::Open
                                    && actual.claim_batch_id.is_none()
                            }
                            SessionInteractionFenceStateV1::Claimed => {
                                actual.state == SessionInteractionFenceSnapshotState::Claimed
                                    && actual.claim_batch_id == expected.claim_batch_id
                            }
                        }
                }),
        };
        if !matched {
            return Err(SessionDomainStoreError::new(
                "session_append_precondition_failed",
                format!("Session append precondition {index} does not match durable domain state"),
            )
            .with_current_head(Some(current_head.clone()))
            .with_failed_precondition(index, precondition.clone()));
        }
    }
    Ok(())
}

fn has_exact_open_run_precondition(
    preconditions: &[SessionAppendPreconditionV1],
    run_id: &str,
) -> bool {
    preconditions.iter().any(|precondition| {
        matches!(
            precondition,
            SessionAppendPreconditionV1::RunFence {
                run_id: candidate,
                expected: SessionRunFenceExpectationV1 {
                    state: SessionRunFenceStateV1::Open,
                    ..
                }
            } if candidate == run_id
        )
    })
}

fn has_exact_closing_run_precondition(
    preconditions: &[SessionAppendPreconditionV1],
    run_id: &str,
    owner_batch_id: &str,
) -> bool {
    preconditions.iter().any(|precondition| {
        matches!(
            precondition,
            SessionAppendPreconditionV1::RunFence {
                run_id: candidate,
                expected: SessionRunFenceExpectationV1 {
                    state: SessionRunFenceStateV1::Closing,
                    owner_batch_id: Some(owner),
                    ..
                }
            } if candidate == run_id && owner == owner_batch_id
        )
    })
}

fn has_exact_interaction_precondition(
    preconditions: &[SessionAppendPreconditionV1],
    interaction_id: &str,
    interaction_revision: &str,
    target_id: &str,
    state: SessionInteractionFenceStateV1,
    claim_batch_id: Option<&str>,
) -> bool {
    preconditions.iter().any(|precondition| {
        matches!(
            precondition,
            SessionAppendPreconditionV1::Interaction {
                interaction_id: candidate_id,
                interaction_revision: candidate_revision,
                target_id: candidate_target,
                expected
            } if candidate_id == interaction_id
                && candidate_revision == interaction_revision
                && candidate_target == target_id
                && expected.state == state
                && expected.claim_batch_id.as_deref() == claim_batch_id
        )
    })
}

fn apply_session_append_transition(
    state: &mut SessionDomainDerivedState,
    transition: &SessionAppendTransitionV1,
    preconditions: &[SessionAppendPreconditionV1],
    batch_id: &str,
    incoming_events: &[Value],
) -> Result<(), SessionDomainStoreError> {
    match transition {
        SessionAppendTransitionV1::Genesis => Ok(()),
        SessionAppendTransitionV1::Append {
            intent,
            run_id,
            turn_authority_ref,
            bootstrap_admission_id: _,
            interaction_id,
            interaction_revision,
            target_id,
            claim_batch_id,
        } => {
            match intent {
                SessionAppendIntentV1::OpenRun => {
                    if state.run_fences.contains_key(run_id) {
                        return transition_state_error(
                            format!("Run fence {run_id} already exists"),
                            transition,
                        );
                    }
                    state.run_fences.insert(
                        run_id.clone(),
                        SessionRunFenceSnapshot {
                            revision: 1,
                            state: SessionRunFenceSnapshotState::Open,
                            owner_batch_id: None,
                        },
                    );
                }
                SessionAppendIntentV1::BootstrapRun => {
                    if state.run_fences.contains_key(run_id) {
                        return transition_state_error(
                            format!("Bootstrap run fence {run_id} already exists"),
                            transition,
                        );
                    }
                    if preconditions.iter().any(|precondition| {
                        matches!(
                            precondition,
                            SessionAppendPreconditionV1::RunFence { .. }
                                | SessionAppendPreconditionV1::Interaction { .. }
                        )
                    }) {
                        return transition_state_error(
                            "bootstrapRun must not depend on a run or interaction fence",
                            transition,
                        );
                    }
                    require_transition_authority(
                        state,
                        incoming_events,
                        turn_authority_ref.as_deref(),
                        transition,
                    )?;
                    state.run_fences.insert(
                        run_id.clone(),
                        SessionRunFenceSnapshot {
                            revision: 1,
                            state: SessionRunFenceSnapshotState::Open,
                            owner_batch_id: None,
                        },
                    );
                }
                SessionAppendIntentV1::DomainFacts | SessionAppendIntentV1::Guidance => {
                    if !has_exact_open_run_precondition(preconditions, run_id) {
                        return transition_state_error(
                            format!(
                                "{intent:?} append requires an exact open runFence precondition"
                            ),
                            transition,
                        );
                    }
                    if *intent == SessionAppendIntentV1::DomainFacts {
                        require_transition_authority(
                            state,
                            incoming_events,
                            turn_authority_ref.as_deref(),
                            transition,
                        )?;
                    } else {
                        require_prior_transition_authority(
                            state,
                            turn_authority_ref.as_deref(),
                            transition,
                        )?;
                    }
                }
                SessionAppendIntentV1::InteractionSettlement
                | SessionAppendIntentV1::ReleaseInteractionClaim => {
                    let interaction_id = interaction_id
                        .as_deref()
                        .expect("settlement interactionId shape validated");
                    let interaction_revision = interaction_revision
                        .as_deref()
                        .expect("settlement interactionRevision shape validated");
                    let target_id = target_id
                        .as_deref()
                        .expect("settlement targetId shape validated");
                    let claim_batch_id = claim_batch_id
                        .as_deref()
                        .expect("settlement claimBatchId shape validated");
                    if !has_exact_open_run_precondition(preconditions, run_id)
                        || !has_exact_interaction_precondition(
                            preconditions,
                            interaction_id,
                            interaction_revision,
                            target_id,
                            SessionInteractionFenceStateV1::Claimed,
                            Some(claim_batch_id),
                        )
                    {
                        return transition_state_error(
                            "Interaction settlement/release requires exact open claimant run and claimed interaction preconditions",
                            transition,
                        );
                    }
                    let interaction = state
                        .interactions
                        .get_mut(interaction_id)
                        .expect("claimed interaction precondition validated");
                    if interaction.claimant_run_id.as_deref() != Some(run_id) {
                        return transition_state_error(
                            "Interaction settlement/release run is not the exact durable claimant",
                            transition,
                        );
                    }
                    if *intent == SessionAppendIntentV1::InteractionSettlement {
                        interaction.state = SessionInteractionFenceSnapshotState::Settled;
                    } else {
                        interaction.state = SessionInteractionFenceSnapshotState::Open;
                    }
                    interaction.claim_batch_id = None;
                    interaction.claimant_run_id = None;
                }
            }
            Ok(())
        }
        SessionAppendTransitionV1::Claim {
            claimant_run_id,
            interaction_id,
            interaction_revision,
            target_id,
            ..
        } => {
            if state.run_fences.contains_key(claimant_run_id) {
                return transition_state_error(
                    format!("Claimant run fence {claimant_run_id} already exists"),
                    transition,
                );
            }
            if !has_exact_interaction_precondition(
                preconditions,
                interaction_id,
                interaction_revision,
                target_id,
                SessionInteractionFenceStateV1::Open,
                None,
            ) {
                return transition_state_error(
                    "Claim transition requires an exact open interaction precondition",
                    transition,
                );
            }
            require_claim_transition_authority(state, transition, incoming_events)?;
            let interaction = state
                .interactions
                .get_mut(interaction_id)
                .expect("open interaction precondition validated");
            interaction.state = SessionInteractionFenceSnapshotState::Claimed;
            interaction.claim_batch_id = Some(batch_id.to_string());
            interaction.claimant_run_id = Some(claimant_run_id.clone());
            state.run_fences.insert(
                claimant_run_id.clone(),
                SessionRunFenceSnapshot {
                    revision: 1,
                    state: SessionRunFenceSnapshotState::Open,
                    owner_batch_id: None,
                },
            );
            Ok(())
        }
        SessionAppendTransitionV1::Close {
            phase,
            run_id,
            status,
            parent_close_batch_id,
            interaction_effect,
        } => {
            let current = state.run_fences.get(run_id).cloned().ok_or_else(|| {
                SessionDomainStoreError::new(
                    "session_append_transition_invalid",
                    format!("Close transition references missing run fence {run_id}"),
                )
            })?;
            match phase {
                SessionClosePhaseV1::Request => {
                    if current.state != SessionRunFenceSnapshotState::Open
                        || !has_exact_open_run_precondition(preconditions, run_id)
                    {
                        return transition_state_error(
                            "Cancel request must win an exact open runFence precondition",
                            transition,
                        );
                    }
                    let run = state
                        .run_fences
                        .get_mut(run_id)
                        .expect("run fence checked above");
                    run.revision = run.revision.checked_add(1).ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Run fence revision overflow",
                        )
                    })?;
                    run.state = SessionRunFenceSnapshotState::Closing;
                    run.owner_batch_id = Some(batch_id.to_string());
                }
                SessionClosePhaseV1::Terminal => {
                    require_terminal_claim_resolution(
                        state,
                        run_id,
                        status,
                        interaction_effect.as_ref(),
                        transition,
                    )?;
                    match current.state {
                        SessionRunFenceSnapshotState::Open => {
                            if !has_exact_open_run_precondition(preconditions, run_id)
                                || parent_close_batch_id.is_some()
                                || status == "cancelled"
                            {
                                return transition_state_error(
                                    "Direct terminal close requires an exact open runFence, no parentCloseBatchId, and a non-cancelled terminal status",
                                    transition,
                                );
                            }
                        }
                        SessionRunFenceSnapshotState::Closing => {
                            let owner = current.owner_batch_id.as_deref().ok_or_else(|| {
                                SessionDomainStoreError::new(
                                    "session_append_recovery_required",
                                    "Closing run fence has no owner batch",
                                )
                            })?;
                            if status != "cancelled"
                                || parent_close_batch_id.as_deref() != Some(owner)
                                || !has_exact_closing_run_precondition(preconditions, run_id, owner)
                            {
                                return transition_state_error(
                                    "Cancellation terminal close must reference and precondition the closing owner batch",
                                    transition,
                                );
                            }
                        }
                        SessionRunFenceSnapshotState::Closed => {
                            return transition_state_error(
                                "Closed run fence cannot transition again",
                                transition,
                            )
                        }
                    }
                    let run = state
                        .run_fences
                        .get_mut(run_id)
                        .expect("run fence checked above");
                    run.revision = run.revision.checked_add(1).ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Run fence revision overflow",
                        )
                    })?;
                    run.state = SessionRunFenceSnapshotState::Closed;
                    run.owner_batch_id = Some(batch_id.to_string());
                }
            }
            if let Some(effect) = interaction_effect {
                apply_session_interaction_effect(
                    state,
                    effect,
                    preconditions,
                    incoming_events,
                    transition,
                )?;
            }
            Ok(())
        }
    }
}

fn require_transition_authority(
    state: &SessionDomainDerivedState,
    incoming_events: &[Value],
    authority_ref: Option<&str>,
    transition: &SessionAppendTransitionV1,
) -> Result<(), SessionDomainStoreError> {
    let authority_ref = authority_ref.ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "Append transition has no turnAuthorityRef",
        )
    })?;
    let incoming = incoming_events.iter().any(|event| {
        event.get("id").and_then(Value::as_str) == Some(authority_ref)
            && event.get("kind").and_then(Value::as_str) == Some("session_turn_authority")
    });
    if state.turn_authority_event_ids.contains(authority_ref) || incoming {
        Ok(())
    } else {
        transition_state_error(
            format!("Append transition references missing turn authority {authority_ref}"),
            transition,
        )
    }
}

fn require_prior_transition_authority(
    state: &SessionDomainDerivedState,
    authority_ref: Option<&str>,
    transition: &SessionAppendTransitionV1,
) -> Result<(), SessionDomainStoreError> {
    let authority_ref = authority_ref.ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "Append transition has no turnAuthorityRef",
        )
    })?;
    if state.turn_authority_event_ids.contains(authority_ref) {
        Ok(())
    } else {
        transition_state_error(
            format!(
                "Append transition authority {authority_ref} was not durable before this batch"
            ),
            transition,
        )
    }
}

fn require_claim_transition_authority(
    state: &SessionDomainDerivedState,
    transition: &SessionAppendTransitionV1,
    incoming_events: &[Value],
) -> Result<(), SessionDomainStoreError> {
    let mut matching_claims = incoming_events
        .iter()
        .filter_map(|event| exact_interaction_claim_payload(event, transition));
    let payload = matching_claims.next().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "Claim transition requires exact immutable interaction-claim authority evidence",
        )
    })?;
    if matching_claims.next().is_some() {
        return transition_state_error(
            "Claim transition contains multiple exact interaction-claim authority records",
            transition,
        );
    }
    let authority_ref = payload
        .get("turnAuthorityRef")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Interaction claim has no immutable turnAuthorityRef",
            )
        })?;
    validate_domain_identity(authority_ref, "interactionClaim.turnAuthorityRef")?;
    require_prior_transition_authority(state, Some(authority_ref), transition)
}

fn exact_interaction_claim_payload<'a>(
    event: &'a Value,
    transition: &SessionAppendTransitionV1,
) -> Option<&'a serde_json::Map<String, Value>> {
    let SessionAppendTransitionV1::Claim {
        claimant_run_id,
        decision_request_id,
        interaction_id,
        interaction_revision,
        target_id,
    } = transition
    else {
        return None;
    };
    let payload = event.get("payload").and_then(Value::as_object)?;
    (event.get("kind").and_then(Value::as_str) == Some("session_interaction_claim")
        && payload.get("admittedRunId").and_then(Value::as_str) == Some(claimant_run_id)
        && payload.get("decisionRequestId").and_then(Value::as_str) == Some(decision_request_id)
        && payload.get("interactionId").and_then(Value::as_str) == Some(interaction_id)
        && payload.get("interactionRevision").and_then(Value::as_str) == Some(interaction_revision)
        && payload.get("targetId").and_then(Value::as_str) == Some(target_id)
        && payload.get("status").and_then(Value::as_str) == Some("claimed"))
    .then_some(payload)
}

fn require_terminal_claim_resolution(
    state: &SessionDomainDerivedState,
    run_id: &str,
    status: &str,
    effect: Option<&SessionInteractionEffectV1>,
    transition: &SessionAppendTransitionV1,
) -> Result<(), SessionDomainStoreError> {
    if status == "waiting" {
        if state
            .interactions
            .values()
            .any(|interaction| interaction.state == SessionInteractionFenceSnapshotState::Claimed)
        {
            return transition_state_error(
                "Waiting terminal close cannot settle, release, or bypass an active interaction claim in the same batch",
                transition,
            );
        }
        if !matches!(effect, Some(SessionInteractionEffectV1::Open { .. })) {
            return transition_state_error(
                "Waiting terminal close requires a new open interaction",
                transition,
            );
        }
        return Ok(());
    }
    let owned_claims = state
        .interactions
        .iter()
        .filter(|(_, interaction)| {
            interaction.state == SessionInteractionFenceSnapshotState::Claimed
                && interaction.claimant_run_id.as_deref() == Some(run_id)
        })
        .collect::<Vec<_>>();
    if owned_claims.len() > 1 {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Run {run_id} owns more than one active interaction claim"),
        ));
    }
    let Some((interaction_id, interaction)) = owned_claims.first().copied() else {
        if effect.is_some() {
            return transition_state_error(
                format!(
                    "Terminal close for run {run_id} carries an interaction effect without an active owned claim"
                ),
                transition,
            );
        }
        return Ok(());
    };
    let claim_batch_id = interaction.claim_batch_id.as_deref().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Claimed interaction {interaction_id} has no claim batch identity"),
        )
    })?;
    let resolves_exact_claim = matches!(
        effect,
        Some(
            SessionInteractionEffectV1::Settle {
                interaction_id: effect_interaction_id,
                interaction_revision,
                target_id,
                claim_batch_id: effect_claim_batch_id,
            }
            | SessionInteractionEffectV1::Release {
                interaction_id: effect_interaction_id,
                interaction_revision,
                target_id,
                claim_batch_id: effect_claim_batch_id,
            }
        ) if effect_interaction_id == interaction_id
            && interaction_revision == &interaction.interaction_revision
            && target_id == &interaction.target_id
            && effect_claim_batch_id == claim_batch_id
    );
    if !resolves_exact_claim {
        return transition_state_error(
            format!(
                "Terminal close for claimant run {run_id} must settle or release interaction {interaction_id}"
            ),
            transition,
        );
    }
    Ok(())
}

fn apply_session_interaction_effect(
    state: &mut SessionDomainDerivedState,
    effect: &SessionInteractionEffectV1,
    preconditions: &[SessionAppendPreconditionV1],
    incoming_events: &[Value],
    transition: &SessionAppendTransitionV1,
) -> Result<(), SessionDomainStoreError> {
    match effect {
        SessionInteractionEffectV1::Open {
            interaction_id,
            interaction_revision,
            target_id,
        } => {
            if state.interactions.contains_key(interaction_id) {
                return transition_state_error(
                    format!("Interaction fence {interaction_id} already exists"),
                    transition,
                );
            }
            let opening_event_exists = incoming_events
                .iter()
                .any(|event| event.get("id").and_then(Value::as_str) == Some(interaction_revision))
                || state.event_ids.contains(interaction_revision);
            if !opening_event_exists {
                return transition_state_error(
                    "Interaction open effect references a missing opening AgentEvent",
                    transition,
                );
            }
            state.interactions.insert(
                interaction_id.clone(),
                SessionInteractionFenceSnapshot {
                    interaction_revision: interaction_revision.clone(),
                    target_id: target_id.clone(),
                    state: SessionInteractionFenceSnapshotState::Open,
                    claim_batch_id: None,
                    claimant_run_id: None,
                },
            );
        }
        SessionInteractionEffectV1::Settle {
            interaction_id,
            interaction_revision,
            target_id,
            claim_batch_id,
        }
        | SessionInteractionEffectV1::Release {
            interaction_id,
            interaction_revision,
            target_id,
            claim_batch_id,
        } => {
            if !has_exact_interaction_precondition(
                preconditions,
                interaction_id,
                interaction_revision,
                target_id,
                SessionInteractionFenceStateV1::Claimed,
                Some(claim_batch_id),
            ) {
                return transition_state_error(
                    "Interaction settle/release effect requires its exact claimed precondition",
                    transition,
                );
            }
            let interaction = state
                .interactions
                .get_mut(interaction_id)
                .expect("claimed interaction precondition validated");
            let closing_run_id = match transition {
                SessionAppendTransitionV1::Close { run_id, .. } => Some(run_id.as_str()),
                _ => None,
            };
            if closing_run_id.is_some() && interaction.claimant_run_id.as_deref() != closing_run_id
            {
                return transition_state_error(
                    "Interaction settle/release effect run is not the exact durable claimant",
                    transition,
                );
            }
            if matches!(effect, SessionInteractionEffectV1::Settle { .. }) {
                interaction.state = SessionInteractionFenceSnapshotState::Settled;
            } else {
                interaction.state = SessionInteractionFenceSnapshotState::Open;
            }
            interaction.claim_batch_id = None;
            interaction.claimant_run_id = None;
        }
    }
    Ok(())
}

fn transition_state_error<T>(
    message: impl Into<String>,
    _transition: &SessionAppendTransitionV1,
) -> Result<T, SessionDomainStoreError> {
    Err(SessionDomainStoreError::new(
        "session_append_transition_invalid",
        message,
    ))
}

fn session_domain_state_snapshot(
    head: SessionDomainHeadV1,
    state: &SessionDomainDerivedState,
) -> SessionDomainStateSnapshotV1 {
    let mut run_fences = state
        .run_fences
        .iter()
        .map(|(run_id, fence)| SessionRunFenceViewV1 {
            run_id: run_id.clone(),
            state: match fence.state {
                SessionRunFenceSnapshotState::Open => "open",
                SessionRunFenceSnapshotState::Closing => "closing",
                SessionRunFenceSnapshotState::Closed => "closed",
            }
            .to_string(),
            revision: fence.revision,
            owner_batch_id: fence.owner_batch_id.clone(),
        })
        .collect::<Vec<_>>();
    run_fences.sort_by(|left, right| left.run_id.cmp(&right.run_id));
    let mut interaction_fences = state
        .interactions
        .iter()
        .filter_map(|(interaction_id, fence)| {
            let state = match fence.state {
                SessionInteractionFenceSnapshotState::Open => "open",
                SessionInteractionFenceSnapshotState::Claimed => "claimed",
                SessionInteractionFenceSnapshotState::Settled => return None,
            };
            Some(SessionInteractionFenceViewV1 {
                interaction_id: interaction_id.clone(),
                interaction_revision: fence.interaction_revision.clone(),
                target_id: fence.target_id.clone(),
                state: state.to_string(),
                claim_batch_id: fence.claim_batch_id.clone(),
            })
        })
        .collect::<Vec<_>>();
    interaction_fences.sort_by(|left, right| left.interaction_id.cmp(&right.interaction_id));
    SessionDomainStateSnapshotV1 {
        schema_version: "deepcode.session.domain-state-snapshot.v1".to_string(),
        head,
        run_fences,
        interaction_fences,
    }
}

pub(crate) fn session_domain_state(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<SessionDomainStateSnapshotV1, SessionDomainStoreError> {
    let snapshot = read_session_domain_snapshot(sessions_dir, session_id)?;
    session_domain_state_from_snapshot(session_id, &snapshot)
}

pub(crate) fn session_domain_state_from_snapshot(
    session_id: &str,
    snapshot: &SessionDomainSnapshot,
) -> Result<SessionDomainStateSnapshotV1, SessionDomainStoreError> {
    match snapshot.writeability {
        SessionDomainWriteability::Current => {
            let head = snapshot.head.clone().ok_or_else(|| {
                SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    "Current Session domain store has no head",
                )
            })?;
            let state = validate_session_domain_record_chain(session_id, &snapshot.records)?;
            Ok(session_domain_state_snapshot(head, &state))
        }
        SessionDomainWriteability::LegacyReadOnly => Err(SessionDomainStoreError::new(
            "session_append_legacy_read_only",
            "Legacy raw-event Session has no writable domain state snapshot",
        )),
        _ => Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Session domain state is not initialized or requires recovery",
        )),
    }
}

#[derive(Debug)]
pub(crate) struct SessionTerminalCloseOutcome {
    pub(crate) status: String,
}

#[derive(Debug, Clone)]
struct SessionClaimedInteractionBinding {
    interaction_id: String,
    interaction_revision: String,
    target_id: String,
    claim_batch_id: String,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn admit_session_interaction_claim(
    state: &AppState,
    session_id: &str,
    claimant_run_id: &str,
    decision_request_id: &str,
    interaction_id: &str,
    interaction_revision: &str,
    target_id: &str,
    events: Vec<Value>,
) -> Result<SessionAppendReceiptV1, SessionDomainStoreError> {
    reconcile_session_run_recovery(state, session_id)?;
    for (value, label) in [
        (claimant_run_id, "claimantRunId"),
        (decision_request_id, "decisionRequestId"),
        (interaction_id, "interactionId"),
        (interaction_revision, "interactionRevision"),
        (target_id, "targetId"),
    ] {
        validate_domain_identity(value, label)?;
    }
    let batch_id = daemon_session_batch_id("claim", decision_request_id);
    let command_batch_id = batch_id.clone();
    let receipt = admit_session_domain_batch_from_current(
        state,
        session_id,
        &batch_id,
        move |snapshot, derived, existing| {
            let preconditions = if let Some(existing) = existing {
                existing.preconditions.clone()
            } else {
                let interaction = derived.interactions.get(interaction_id).ok_or_else(|| {
                    SessionDomainStoreError::new(
                        "session_append_precondition_failed",
                        format!("Interaction fence {interaction_id} does not exist"),
                    )
                })?;
                if interaction.interaction_revision != interaction_revision
                    || interaction.target_id != target_id
                    || interaction.state != SessionInteractionFenceSnapshotState::Open
                    || interaction.claim_batch_id.is_some()
                {
                    return Err(SessionDomainStoreError::new(
                        "session_append_precondition_failed",
                        format!(
                            "Interaction fence {interaction_id} is not the requested open revision"
                        ),
                    ));
                }
                vec![SessionAppendPreconditionV1::Interaction {
                    interaction_id: interaction_id.to_string(),
                    interaction_revision: interaction_revision.to_string(),
                    target_id: target_id.to_string(),
                    expected: SessionInteractionExpectationV1 {
                        state: SessionInteractionFenceStateV1::Open,
                        claim_batch_id: None,
                    },
                }]
            };
            Ok(Some(internal_session_append_command(
                snapshot,
                existing,
                command_batch_id,
                preconditions,
                SessionAppendTransitionV1::Claim {
                    claimant_run_id: claimant_run_id.to_string(),
                    decision_request_id: decision_request_id.to_string(),
                    interaction_id: interaction_id.to_string(),
                    interaction_revision: interaction_revision.to_string(),
                    target_id: target_id.to_string(),
                },
                events,
            )?))
        },
    )?;
    receipt.ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Interaction-claim admission completed without a receipt",
        )
    })
}

pub(crate) fn admit_session_guidance(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    observed_base_head: SessionDomainHeadV1,
    observed_turn_authority_ref: String,
    guidance_event: Value,
) -> Result<SessionAppendReceiptV1, SessionDomainStoreError> {
    reconcile_session_run_recovery(state, session_id)?;
    validate_domain_identity(run_id, "runId")?;
    validate_session_domain_head(&observed_base_head, "guidance.baseHead")?;
    validate_domain_identity(&observed_turn_authority_ref, "guidance.turnAuthorityRef")?;
    let event_id = guidance_event
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Guidance event requires an id",
            )
        })?
        .to_string();
    let batch_id = daemon_session_batch_id("guidance", &event_id);
    let command_batch_id = batch_id.clone();
    let receipt = admit_session_domain_batch_from_current(
        state,
        session_id,
        &batch_id,
        move |snapshot, derived, existing| {
            let (preconditions, turn_authority_ref) = if let Some(existing) = existing {
                let turn_authority_ref = match &existing.transition {
                    SessionAppendTransitionV1::Append {
                        intent: SessionAppendIntentV1::Guidance,
                        run_id: existing_run_id,
                        turn_authority_ref: Some(turn_authority_ref),
                        ..
                    } if existing_run_id == run_id => turn_authority_ref.clone(),
                    _ => return Err(SessionDomainStoreError::new(
                        "session_append_batch_conflict",
                        format!(
                                "Guidance batch {command_batch_id} already exists with a different transition"
                        ),
                    )),
                };
                (existing.preconditions.clone(), turn_authority_ref)
            } else {
                let current_head = snapshot.head.as_ref().ok_or_else(|| {
                    SessionDomainStoreError::new(
                        "session_append_recovery_required",
                        "Current Session domain store has no composite head",
                    )
                })?;
                if current_head != &observed_base_head {
                    return Err(SessionDomainStoreError {
                        code: "session_append_head_conflict",
                        message: format!(
                            "Guidance append batch {command_batch_id} was based on a stale composite head"
                        ),
                        current_head: Some(current_head.clone()),
                        failed_precondition: None,
                        precondition_index: None,
                        batch_id: Some(command_batch_id.clone()),
                        existing_batch_digest: None,
                        submitted_batch_digest: None,
                        expected_head: Some(observed_base_head.clone()),
                        transition: None,
                        event_id: None,
                    });
                }
                let run = derived.run_fences.get(run_id).ok_or_else(|| {
                    SessionDomainStoreError::new(
                        "session_append_precondition_failed",
                        format!("Run fence {run_id} does not exist"),
                    )
                })?;
                if run.state != SessionRunFenceSnapshotState::Open {
                    return Err(SessionDomainStoreError::new(
                        "session_append_precondition_failed",
                        format!("Run fence {run_id} is not open"),
                    ));
                }
                let durable_turn_authority_ref =
                    current_turn_authority_ref_for_host_run(&snapshot.records, session_id, run_id)?;
                if durable_turn_authority_ref != observed_turn_authority_ref {
                    let failed_precondition = SessionAppendPreconditionV1::TurnAuthority {
                        event_id: observed_turn_authority_ref.clone(),
                    };
                    return Err(SessionDomainStoreError {
                        code: "session_append_precondition_failed",
                        message: format!(
                            "Guidance authority {} does not match Host run {run_id} authority {durable_turn_authority_ref}",
                            observed_turn_authority_ref
                        ),
                        current_head: Some(current_head.clone()),
                        failed_precondition: Some(failed_precondition),
                        precondition_index: Some(1),
                        batch_id: Some(command_batch_id.clone()),
                        existing_batch_digest: None,
                        submitted_batch_digest: None,
                        expected_head: None,
                        transition: None,
                        event_id: None,
                    });
                }
                (
                    vec![
                        run_fence_precondition(run_id, run),
                        SessionAppendPreconditionV1::TurnAuthority {
                            event_id: observed_turn_authority_ref.clone(),
                        },
                    ],
                    observed_turn_authority_ref.clone(),
                )
            };
            let mut command = internal_session_append_command(
                snapshot,
                existing,
                command_batch_id,
                preconditions,
                SessionAppendTransitionV1::Append {
                    intent: SessionAppendIntentV1::Guidance,
                    run_id: run_id.to_string(),
                    turn_authority_ref: Some(turn_authority_ref),
                    bootstrap_admission_id: None,
                    interaction_id: None,
                    interaction_revision: None,
                    target_id: None,
                    claim_batch_id: None,
                },
                vec![guidance_event],
            )?;
            if existing.is_none() {
                command.base_head = observed_base_head.clone();
            }
            Ok(Some(command))
        },
    )?;
    receipt.ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Guidance admission completed without a receipt",
        )
    })
}

pub(crate) fn admit_session_cancel_request(
    state: &AppState,
    session_id: &str,
    run_id: &str,
) -> Result<Option<SessionAppendReceiptV1>, SessionDomainStoreError> {
    reconcile_session_run_recovery(state, session_id)?;
    validate_domain_identity(run_id, "runId")?;
    let batch_id = daemon_session_batch_id("cancel-request", run_id);
    let command_batch_id = batch_id.clone();
    admit_session_domain_batch_from_current(
        state,
        session_id,
        &batch_id,
        move |snapshot, derived, existing| {
            if let Some(existing) = existing {
                return Ok(Some(internal_session_append_command(
                    snapshot,
                    Some(existing),
                    command_batch_id.clone(),
                    existing.preconditions.clone(),
                    SessionAppendTransitionV1::Close {
                        phase: SessionClosePhaseV1::Request,
                        run_id: run_id.to_string(),
                        status: "cancelRequested".to_string(),
                        parent_close_batch_id: None,
                        interaction_effect: None,
                    },
                    Vec::new(),
                )?));
            }
            let run = derived.run_fences.get(run_id).ok_or_else(|| {
                SessionDomainStoreError::new(
                    "session_append_precondition_failed",
                    format!("Run fence {run_id} does not exist"),
                )
            })?;
            match run.state {
                SessionRunFenceSnapshotState::Open => Ok(Some(internal_session_append_command(
                    snapshot,
                    None,
                    command_batch_id,
                    vec![run_fence_precondition(run_id, run)],
                    SessionAppendTransitionV1::Close {
                        phase: SessionClosePhaseV1::Request,
                        run_id: run_id.to_string(),
                        status: "cancelRequested".to_string(),
                        parent_close_batch_id: None,
                        interaction_effect: None,
                    },
                    Vec::new(),
                )?)),
                SessionRunFenceSnapshotState::Closing | SessionRunFenceSnapshotState::Closed => {
                    Ok(None)
                }
            }
        },
    )
}

pub(crate) fn admit_session_release_interaction_claim(
    state: &AppState,
    session_id: &str,
    claimant_run_id: &str,
) -> Result<Option<SessionAppendReceiptV1>, SessionDomainStoreError> {
    validate_domain_identity(claimant_run_id, "claimantRunId")?;
    let batch_id = daemon_session_batch_id("release-claim", claimant_run_id);
    let command_batch_id = batch_id.clone();
    admit_session_domain_batch_from_current(
        state,
        session_id,
        &batch_id,
        move |snapshot, derived, existing| {
            if let Some(existing) = existing {
                let durable_claim =
                    session_claim_record_for_run(&snapshot.records, claimant_run_id)?;
                let exact_release = matches!(
                    (&existing.transition, durable_claim.as_ref()),
                    (
                        SessionAppendTransitionV1::Append {
                            intent: SessionAppendIntentV1::ReleaseInteractionClaim,
                            run_id,
                            interaction_id: Some(interaction_id),
                            interaction_revision: Some(interaction_revision),
                            target_id: Some(target_id),
                            claim_batch_id: Some(claim_batch_id),
                            ..
                        },
                        Some(claim),
                    ) if run_id == claimant_run_id
                        && interaction_id == &claim.interaction_id
                        && interaction_revision == &claim.interaction_revision
                        && target_id == &claim.target_id
                        && claim_batch_id == &claim.claim_batch_id
                );
                if !exact_release {
                    return Err(SessionDomainStoreError::new(
                        "session_append_batch_conflict",
                        format!(
                            "Release-claim batch {command_batch_id} already exists with a different transition"
                        ),
                    ));
                }
                return Ok(Some(internal_session_append_command(
                    snapshot,
                    Some(existing),
                    command_batch_id.clone(),
                    existing.preconditions.clone(),
                    existing.transition.clone(),
                    Vec::new(),
                )?));
            }
            let Some(claim) =
                active_claimed_interaction_for_run(&snapshot.records, derived, claimant_run_id)?
            else {
                return Ok(None);
            };
            let run = derived.run_fences.get(claimant_run_id).ok_or_else(|| {
                SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Claimant run fence {claimant_run_id} is missing while its interaction remains claimed"
                    ),
                )
            })?;
            if run.state == SessionRunFenceSnapshotState::Closed {
                return Err(SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Closed claimant run {claimant_run_id} still owns interaction claim {}",
                        claim.interaction_id
                    ),
                ));
            }
            if run.state != SessionRunFenceSnapshotState::Open {
                // A cancelling run releases the claim atomically with its
                // terminal close.
                return Ok(None);
            }
            let interaction_precondition = claimed_interaction_precondition(&claim);
            Ok(Some(internal_session_append_command(
                snapshot,
                None,
                command_batch_id,
                vec![
                    run_fence_precondition(claimant_run_id, run),
                    interaction_precondition,
                ],
                SessionAppendTransitionV1::Append {
                    intent: SessionAppendIntentV1::ReleaseInteractionClaim,
                    run_id: claimant_run_id.to_string(),
                    turn_authority_ref: None,
                    bootstrap_admission_id: None,
                    interaction_id: Some(claim.interaction_id),
                    interaction_revision: Some(claim.interaction_revision),
                    target_id: Some(claim.target_id),
                    claim_batch_id: Some(claim.claim_batch_id),
                },
                Vec::new(),
            )?))
        },
    )
}

pub(crate) fn admit_session_terminal_close(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    requested_status: &str,
    terminal_code: Option<&str>,
    terminal_message: Option<&str>,
) -> Result<SessionTerminalCloseOutcome, SessionDomainStoreError> {
    validate_domain_identity(run_id, "runId")?;
    if !matches!(
        requested_status,
        "completed" | "failed" | "waiting" | "cancelled"
    ) {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "Daemon terminal close requested an unsupported status",
        ));
    }
    let batch_id = daemon_session_batch_id("terminal", run_id);
    let command_batch_id = batch_id.clone();
    let mut durable_status = requested_status.to_string();
    let terminal_code = terminal_code.map(str::to_owned);
    let terminal_message = terminal_message.map(str::to_owned);
    let receipt = admit_session_domain_batch_from_current(
        state,
        session_id,
        &batch_id,
        |snapshot, derived, existing| {
            if let Some(existing) = existing {
                let status = terminal_transition_status(&existing.transition).ok_or_else(|| {
                    SessionDomainStoreError::new(
                        "session_append_batch_conflict",
                        format!(
                            "Terminal batch {command_batch_id} already exists with a different transition"
                        ),
                    )
                })?;
                durable_status = status.to_string();
                return Ok(None);
            }
            let run = derived.run_fences.get(run_id).ok_or_else(|| {
                SessionDomainStoreError::new(
                    "session_append_precondition_failed",
                    format!("Run fence {run_id} does not exist"),
                )
            })?;
            let (status, parent_close_batch_id) = match run.state {
                SessionRunFenceSnapshotState::Open => {
                    if requested_status == "cancelled" {
                        return Err(SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "An open run cannot close directly as cancelled",
                        ));
                    }
                    (requested_status.to_string(), None)
                }
                SessionRunFenceSnapshotState::Closing => {
                    let owner = run.owner_batch_id.clone().ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_recovery_required",
                            "Closing run fence has no owner batch",
                        )
                    })?;
                    ("cancelled".to_string(), Some(owner))
                }
                SessionRunFenceSnapshotState::Closed => {
                    let owner = run.owner_batch_id.as_deref().ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_recovery_required",
                            "Closed run fence has no terminal owner batch",
                        )
                    })?;
                    let record = snapshot
                        .records
                        .iter()
                        .find(|record| record.batch_id == owner)
                        .ok_or_else(|| {
                            SessionDomainStoreError::new(
                                "session_append_recovery_required",
                                "Closed run fence owner batch is missing",
                            )
                        })?;
                    durable_status = terminal_transition_status(&record.transition)
                        .ok_or_else(|| {
                            SessionDomainStoreError::new(
                                "session_append_recovery_required",
                                "Closed run fence owner is not a terminal transition",
                            )
                        })?
                        .to_string();
                    return Ok(None);
                }
            };
            durable_status = status.clone();
            let claimed_interaction =
                active_claimed_interaction_for_run(&snapshot.records, derived, run_id)?;
            let mut preconditions = vec![run_fence_precondition(run_id, run)];
            let interaction_effect = claimed_interaction.as_ref().map(|claim| {
                preconditions.push(claimed_interaction_precondition(claim));
                SessionInteractionEffectV1::Release {
                    interaction_id: claim.interaction_id.clone(),
                    interaction_revision: claim.interaction_revision.clone(),
                    target_id: claim.target_id.clone(),
                    claim_batch_id: claim.claim_batch_id.clone(),
                }
            });
            let terminal_event = daemon_terminal_session_run_state_event(
                snapshot,
                session_id,
                run_id,
                &command_batch_id,
                &status,
                terminal_code.as_deref(),
                terminal_message.as_deref(),
            )?;
            if terminal_event.is_none()
                && session_claim_record_for_run(&snapshot.records, run_id)?.is_some()
            {
                return Err(SessionDomainStoreError::new(
                    "session_append_lineage_invalid",
                    format!(
                        "Claimant run {run_id} cannot close without a durable terminal Session fact"
                    ),
                ));
            }
            Ok(Some(internal_session_append_command(
                snapshot,
                None,
                command_batch_id,
                preconditions,
                SessionAppendTransitionV1::Close {
                    phase: SessionClosePhaseV1::Terminal,
                    run_id: run_id.to_string(),
                    status,
                    parent_close_batch_id,
                    interaction_effect,
                },
                terminal_event.into_iter().collect(),
            )?))
        },
    )?;
    let _ = receipt;
    Ok(SessionTerminalCloseOutcome {
        status: durable_status,
    })
}

fn admit_session_domain_batch_from_current<F>(
    state: &AppState,
    session_id: &str,
    batch_id: &str,
    build: F,
) -> Result<Option<SessionAppendReceiptV1>, SessionDomainStoreError>
where
    F: FnOnce(
        &SessionDomainSnapshot,
        &SessionDomainDerivedState,
        Option<&SessionDomainBatchRecordV1>,
    ) -> Result<Option<SessionAppendCommandV1>, SessionDomainStoreError>,
{
    validate_domain_identity(session_id, "sessionId")?;
    validate_domain_identity(batch_id, "batchId")?;
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let admission_lock = session_domain_admission_lock(&sessions_dir, session_id);
    let _admission_guard = admission_lock
        .lock()
        .expect("session domain admission lock");
    let snapshot = {
        let _projection_guard =
            session_jsonl_append_lock(&sessions_dir, session_id, "projection.jsonl")
                .lock()
                .expect("session projection JSONL lock");
        load_session_domain_snapshot_unlocked(&sessions_dir, session_id, true)?
    };
    if snapshot.writeability != SessionDomainWriteability::Current {
        return Err(match snapshot.writeability {
            SessionDomainWriteability::LegacyReadOnly => SessionDomainStoreError::new(
                "session_append_legacy_read_only",
                "Legacy raw-event Session is read-only and cannot accept domain batches",
            ),
            _ => SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session domain store is not writable",
            ),
        });
    }
    publish_session_domain_snapshot(state, session_id, &snapshot)?;
    let derived = validate_session_domain_record_chain(session_id, &snapshot.records)?;
    let existing = snapshot
        .records
        .iter()
        .find(|record| record.batch_id == batch_id);
    let Some(mut command) = build(&snapshot, &derived, existing)? else {
        return Ok(None);
    };
    if let Some(existing) = existing {
        let same_material = command.schema_version == SESSION_APPEND_COMMAND_SCHEMA_VERSION
            && command.batch_id == existing.batch_id
            && command.base_head == existing.base_head
            && command.preconditions == existing.preconditions
            && command.transition == existing.transition
            && command.provider_admissions == existing.provider_admissions
            && command.events == existing.events;
        if !same_material {
            return Err(SessionDomainStoreError {
                code: "session_append_batch_conflict",
                message: format!(
                    "batchId {} already exists with different internal command material",
                    command.batch_id
                ),
                current_head: snapshot.head.clone(),
                failed_precondition: None,
                precondition_index: None,
                batch_id: Some(command.batch_id),
                existing_batch_digest: Some(existing.batch_digest.clone()),
                submitted_batch_digest: None,
                expected_head: None,
                transition: Some(command.transition),
                event_id: None,
            });
        }
        let record_index = snapshot
            .records
            .iter()
            .position(|record| record.batch_id == existing.batch_id)
            .expect("existing record selected from snapshot");
        let result_state =
            session_domain_state_for_record(session_id, &snapshot.records, record_index)?;
        return Ok(Some(session_append_receipt(
            session_id,
            existing,
            result_state,
            true,
        )));
    }
    if !command.events.is_empty() {
        command.timeline = Some(carry_forward_internal_session_timeline(
            state,
            session_id,
            &snapshot,
            &command.events,
        )?);
    }
    validate_session_append_command(&command)?;
    validate_session_domain_events(&command.events, Some(session_id))?;
    admit_session_domain_batch_locked(state, &sessions_dir, session_id, command).map(Some)
}

fn carry_forward_internal_session_timeline(
    state: &AppState,
    session_id: &str,
    snapshot: &SessionDomainSnapshot,
    incoming_events: &[Value],
) -> Result<Value, SessionDomainStoreError> {
    for event in incoming_events {
        if event.get("kind").and_then(Value::as_str) != Some("user_guidance")
            && !internal_terminal_session_run_state(event)
            && !internal_projection_hidden_event(event)
        {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Internal Session append cannot carry forward an unsupported visible event",
            ));
        }
    }
    let mut timeline = match session_timeline(state, session_id) {
        Some(timeline) => timeline,
        None => {
            if snapshot
                .events
                .iter()
                .any(|event| !internal_projection_hidden_event(event))
            {
                return Err(SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    "Cannot synthesize a Shared Projection over unprojected visible Session events",
                ));
            }
            json!({
                "schemaVersion": "deepcode.shared-conversation-projection.v2",
                "sessionId": session_id,
                "revision": 0,
                "sourceEventVersion": snapshot.events.len(),
                "lastDeltaSeq": 0,
                "generatedAt": now_text(),
                "turns": [],
                "eventCount": snapshot.events.len()
            })
        }
    };
    if timeline.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.shared-conversation-projection.v2")
        || timeline.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || timeline
            .get("sourceEventVersion")
            .and_then(json_safe_nonnegative_integer)
            != Some(snapshot.events.len() as u64)
        || timeline
            .get("eventCount")
            .and_then(json_safe_nonnegative_integer)
            != Some(snapshot.events.len() as u64)
    {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Internal Session control append requires a current Shared Projection v2 base",
        ));
    }
    let revision = timeline
        .get("revision")
        .and_then(json_safe_nonnegative_integer)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Current Shared Projection has no safe revision",
            )
        })?
        .checked_add(1)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Shared Projection revision overflow",
            )
        })?;
    let next_event_version = snapshot
        .events
        .len()
        .checked_add(incoming_events.len())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session event version overflow",
            )
        })? as u64;
    let object = timeline.as_object_mut().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Current Shared Projection is not an object",
        )
    })?;
    object.insert("revision".to_string(), json!(revision));
    object.insert("sourceEventVersion".to_string(), json!(next_event_version));
    object.insert("eventCount".to_string(), json!(next_event_version));
    object.insert("generatedAt".to_string(), json!(now_text()));
    let turns = object
        .get_mut("turns")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Current Shared Projection has no structured turns",
            )
        })?;
    for event in incoming_events {
        if event.get("kind").and_then(Value::as_str) == Some("user_guidance") {
            turns.push(internal_guidance_projection_turn(event, turns.len())?);
        } else if internal_terminal_session_run_state(event) {
            attach_internal_terminal_projection(turns, event)?;
        }
    }
    Ok(timeline)
}

fn internal_terminal_session_run_state(event: &Value) -> bool {
    event.get("kind").and_then(Value::as_str) == Some("session_run_state")
        && matches!(
            event.pointer("/payload/status").and_then(Value::as_str),
            Some("completed" | "failed" | "cancelled" | "waiting")
        )
}

fn internal_projection_hidden_event(event: &Value) -> bool {
    event.get("kind").and_then(Value::as_str) == Some("session_turn_authority")
        || event.pointer("/payload/visibility").and_then(Value::as_str) == Some("hidden")
        || event
            .pointer("/payload/presentation")
            .and_then(Value::as_str)
            == Some("traceOnly")
        || event
            .pointer("/display/presentation")
            .and_then(Value::as_str)
            == Some("traceOnly")
}

fn internal_guidance_projection_turn(
    event: &Value,
    sequence: usize,
) -> Result<Value, SessionDomainStoreError> {
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Guidance projection requires an event id",
            )
        })?;
    let session_id = event
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Guidance projection requires a Session id",
            )
        })?;
    let timestamp = event
        .get("ts")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Guidance projection requires a timestamp",
            )
        })?;
    let payload = event
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Guidance projection requires an object payload",
            )
        })?;
    let content = payload
        .get("content")
        .or_else(|| payload.get("guidance"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Guidance projection requires non-empty content",
            )
        })?;
    let language = match payload.get("hostLanguage").and_then(Value::as_str) {
        Some("zh-CN") => "zh-CN",
        Some("en-US") => "en-US",
        _ => "neutral",
    };
    let (title, summary_label) = if language == "zh-CN" {
        ("用户补充", "用户补充")
    } else {
        ("User guidance", "User guidance")
    };
    let turn_id = format!("turn-guidance-{event_id}");
    let block_id = format!("timeline:user-guidance:{event_id}");
    Ok(json!({
        "id": turn_id,
        "sequence": sequence,
        "sessionId": session_id,
        "status": "running",
        "startedAt": timestamp,
        "blocks": [{
            "id": block_id,
            "sequence": 0,
            "revision": 1,
            "deliveryMode": "replay",
            "durability": "committed",
            "kind": "user",
            "narrativeKind": "user",
            "entryRole": "userMessage",
            "title": title,
            "summary": content,
            "status": "completed",
            "defaultCollapsed": false,
            "bodyMarkdown": content,
            "localizedContent": {
                "text": content
            },
            "confirmable": false,
            "feedbackRef": {
                "eventId": event_id,
                "sessionId": session_id,
                "kind": "user_guidance"
            },
            "displayHints": {
                "density": "normal",
                "evidenceMode": "inline",
                "collapseAfterComplete": false,
                "checkpointKind": "userGuidance",
                "showInTaskList": false,
                "taskListLabel": summary_label,
                "taskListSummary": content
            },
            "evidenceRefs": [],
            "provenance": {
                "origin": "user",
                "authority": "user",
                "sourceEventRefs": [format!("event:{event_id}")],
                "factRefs": [],
                "evidenceRefs": []
            },
            "languageBinding": {
                "language": language,
                "status": if language == "neutral" { "unavailable" } else { "fallback" },
                "sourceTurnId": turn_id
            }
        }]
    }))
}

fn attach_internal_terminal_projection(
    turns: &mut [Value],
    event: &Value,
) -> Result<(), SessionDomainStoreError> {
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Terminal projection requires an event id",
            )
        })?;
    let payload = event
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Terminal projection requires an object payload",
            )
        })?;
    let lineage = payload
        .get("lineage")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_lineage_invalid",
                "Terminal projection requires SessionFactLineage",
            )
        })?;
    let turn_authority_ref = lineage
        .get("turnAuthorityRef")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_lineage_invalid",
                "Terminal projection lineage requires turnAuthorityRef",
            )
        })?;
    let turn_id = payload
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_lineage_invalid",
                "Terminal projection requires its exact authority turnId",
            )
        })?;
    let matching_turns = turns
        .iter()
        .enumerate()
        .filter_map(|(index, turn)| {
            (turn.get("id").and_then(Value::as_str) == Some(turn_id)).then_some(index)
        })
        .collect::<Vec<_>>();
    if matching_turns.len() != 1 {
        return Err(SessionDomainStoreError::new(
            "session_append_lineage_invalid",
            format!("Terminal fact {event_id} does not resolve one exact authority turn {turn_id}"),
        ));
    }
    let turn = turns[matching_turns[0]].as_object_mut().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Terminal projection authority turn is not an object",
        )
    })?;
    let status = payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    let event_ref = format!("event:{event_id}");
    turn.insert(
        "settlement".to_string(),
        json!({
            "schemaVersion": "deepcode.session.turn-settlement.v1",
            "status": status,
            "factRef": event_ref,
            "turnAuthorityRef": turn_authority_ref,
        }),
    );
    let blocks = turn
        .get_mut("blocks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Terminal projection authority turn has no structured blocks",
            )
        })?;
    let language = match payload.get("presentationLanguage").and_then(Value::as_str) {
        Some("zh-CN") => "zh-CN",
        Some("en-US") => "en-US",
        _ => "neutral",
    };
    let revision = payload.get("languageRevision").and_then(Value::as_u64);
    let (title, fallback_summary) = match (language, status) {
        ("zh-CN", "cancelled") => ("任务已取消", "本次任务已取消。"),
        ("zh-CN", "completed") => ("任务已完成", "本次任务已完成。"),
        ("zh-CN", "waiting") => ("等待用户输入", "本次任务正在等待用户输入。"),
        ("zh-CN", _) => ("任务失败", "本次任务失败，请查看诊断信息。"),
        (_, "cancelled") => ("Task cancelled", "This task was cancelled."),
        (_, "completed") => ("Task completed", "This task completed."),
        (_, "waiting") => (
            "Waiting for user input",
            "This task is waiting for user input.",
        ),
        _ => (
            "Task failed",
            "This task failed. Review the diagnostic information.",
        ),
    };
    let summary = payload
        .get("message")
        .or_else(|| payload.get("summary"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_summary);
    let mut language_binding = json!({
        "language": language,
        "status": if language == "neutral" { "unavailable" } else { "fallback" },
        "sourceTurnId": turn_id
    });
    if let Some(revision) = revision {
        language_binding["revision"] = json!(revision);
    }
    let block_sequence = blocks.len();
    blocks.push(json!({
        "id": format!("timeline:session-run-state:{event_id}"),
        "sequence": block_sequence,
        "revision": 1,
        "deliveryMode": "replay",
        "durability": "committed",
        "kind": "error",
        "narrativeKind": "diagnostic",
        "entryRole": "diagnostic",
        "title": title,
        "summary": summary,
        "status": status,
        "defaultCollapsed": false,
        "provenance": {
            "origin": "session",
            "authority": "session",
            "sourceEventRefs": [event_ref],
            "factRefs": [event_ref],
            "evidenceRefs": []
        },
        "languageBinding": language_binding
    }));
    Ok(())
}

fn internal_session_append_command(
    snapshot: &SessionDomainSnapshot,
    existing: Option<&SessionDomainBatchRecordV1>,
    batch_id: String,
    preconditions: Vec<SessionAppendPreconditionV1>,
    transition: SessionAppendTransitionV1,
    events: Vec<Value>,
) -> Result<SessionAppendCommandV1, SessionDomainStoreError> {
    let base_head = existing
        .map(|record| record.base_head.clone())
        .or_else(|| snapshot.head.clone())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Current Session domain store has no composite head",
            )
        })?;
    Ok(SessionAppendCommandV1 {
        schema_version: SESSION_APPEND_COMMAND_SCHEMA_VERSION.to_string(),
        batch_id,
        base_head,
        preconditions,
        transition,
        provider_admissions: Vec::new(),
        events,
        timeline: None,
        bootstrap_token: None,
    })
}

fn run_fence_precondition(
    run_id: &str,
    run: &SessionRunFenceSnapshot,
) -> SessionAppendPreconditionV1 {
    SessionAppendPreconditionV1::RunFence {
        run_id: run_id.to_string(),
        expected: SessionRunFenceExpectationV1 {
            state: match run.state {
                SessionRunFenceSnapshotState::Open => SessionRunFenceStateV1::Open,
                SessionRunFenceSnapshotState::Closing => SessionRunFenceStateV1::Closing,
                SessionRunFenceSnapshotState::Closed => SessionRunFenceStateV1::Closed,
            },
            revision: run.revision,
            owner_batch_id: run.owner_batch_id.clone(),
        },
    }
}

fn claimed_interaction_precondition(
    claim: &SessionClaimedInteractionBinding,
) -> SessionAppendPreconditionV1 {
    SessionAppendPreconditionV1::Interaction {
        interaction_id: claim.interaction_id.clone(),
        interaction_revision: claim.interaction_revision.clone(),
        target_id: claim.target_id.clone(),
        expected: SessionInteractionExpectationV1 {
            state: SessionInteractionFenceStateV1::Claimed,
            claim_batch_id: Some(claim.claim_batch_id.clone()),
        },
    }
}

fn session_claim_record_for_run(
    records: &[SessionDomainBatchRecordV1],
    claimant_run_id: &str,
) -> Result<Option<SessionClaimedInteractionBinding>, SessionDomainStoreError> {
    let mut binding = None;
    for record in records {
        let SessionAppendTransitionV1::Claim {
            claimant_run_id: record_run_id,
            interaction_id,
            interaction_revision,
            target_id,
            ..
        } = &record.transition
        else {
            continue;
        };
        if record_run_id != claimant_run_id {
            continue;
        }
        if binding.is_some() {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Claimant run {claimant_run_id} has more than one durable interaction claim"
                ),
            ));
        }
        binding = Some(SessionClaimedInteractionBinding {
            interaction_id: interaction_id.clone(),
            interaction_revision: interaction_revision.clone(),
            target_id: target_id.clone(),
            claim_batch_id: record.batch_id.clone(),
        });
    }
    Ok(binding)
}

fn active_claimed_interaction_for_run(
    records: &[SessionDomainBatchRecordV1],
    derived: &SessionDomainDerivedState,
    claimant_run_id: &str,
) -> Result<Option<SessionClaimedInteractionBinding>, SessionDomainStoreError> {
    let Some(binding) = session_claim_record_for_run(records, claimant_run_id)? else {
        return Ok(None);
    };
    let active = derived
        .interactions
        .get(&binding.interaction_id)
        .is_some_and(|interaction| {
            interaction.interaction_revision == binding.interaction_revision
                && interaction.target_id == binding.target_id
                && interaction.state == SessionInteractionFenceSnapshotState::Claimed
                && interaction.claim_batch_id.as_deref() == Some(binding.claim_batch_id.as_str())
                && interaction.claimant_run_id.as_deref() == Some(claimant_run_id)
        });
    Ok(active.then_some(binding))
}

fn daemon_terminal_session_run_state_event(
    snapshot: &SessionDomainSnapshot,
    session_id: &str,
    host_run_id: &str,
    terminal_batch_id: &str,
    status: &str,
    terminal_code: Option<&str>,
    terminal_message: Option<&str>,
) -> Result<Option<Value>, SessionDomainStoreError> {
    let has_claim = session_claim_record_for_run(&snapshot.records, host_run_id)?.is_some();
    let turn_authority_ref =
        match current_turn_authority_ref_for_host_run(&snapshot.records, session_id, host_run_id) {
            Ok(authority_ref) => authority_ref,
            Err(error) if !has_claim && error.code == "session_append_transition_invalid" => {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
    let authority = snapshot
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str) == Some(turn_authority_ref.as_str())
                && event.get("kind").and_then(Value::as_str)
                    == Some("session_turn_authority")
        })
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Terminal claimant run {host_run_id} references missing authority {turn_authority_ref}"
                ),
            )
        })?;
    let authority_payload = authority
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Turn authority {turn_authority_ref} has no object payload"),
            )
        })?;
    let required_authority_field = |field: &str| {
        authority_payload
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!("Turn authority {turn_authority_ref} has no {field}"),
                )
            })
    };
    let run_id = required_authority_field("runId")?;
    let turn_id = required_authority_field("turnId")?;
    let task_id = required_authority_field("taskId")?;
    let language_policy = authority_payload
        .get("languagePolicy")
        .and_then(Value::as_object);
    let language_revision = language_policy
        .and_then(|policy| policy.get("revision"))
        .and_then(Value::as_u64);
    let language = language_policy
        .and_then(|policy| {
            policy
                .get("language")
                .or_else(|| policy.get("hostLanguage"))
        })
        .and_then(Value::as_str)
        .filter(|language| matches!(*language, "zh-CN" | "en-US"));
    let summary_key = match status {
        "cancelled" => "session.runState.cancelled",
        "completed" => "session.runState.completed",
        "waiting" => "session.runState.waiting",
        _ => "session.runState.failed",
    };
    let summary = terminal_message
        .filter(|message| !message.trim().is_empty())
        .unwrap_or(summary_key);
    let digest_input = format!("{session_id}:{terminal_batch_id}:terminal-session-fact");
    let digest = deepcode_kernel_tools::hash_bytes(digest_input.as_bytes());
    let event_id = format!(
        "daemon:terminal-fact:{}",
        digest.strip_prefix("sha256:").unwrap_or(digest.as_str())
    );
    let domain_parent_refs = snapshot
        .events
        .iter()
        .rev()
        .find_map(|event| {
            let event_id = event
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())?;
            let lineage = event.pointer("/payload/lineage")?;
            (lineage.get("schemaVersion").and_then(Value::as_str)
                == Some("deepcode.session.fact-lineage.v1")
                && lineage.get("turnAuthorityRef").and_then(Value::as_str)
                    == Some(turn_authority_ref.as_str()))
            .then(|| event_id.to_string())
        })
        .into_iter()
        .collect::<Vec<_>>();
    let mut payload = json!({
        "status": status,
        "phase": "terminal",
        "reason": terminal_code.unwrap_or("session"),
        "runId": run_id,
        "turnId": turn_id,
        "taskId": task_id,
        "decisionKind": "session",
        "decisionOwner": {
            "kind": "session",
            "runId": run_id
        },
        "summary": summary,
        "summaryKey": summary_key,
        "message": summary,
        "messageKey": summary_key,
        "messageArgs": {
            "reason": terminal_code.unwrap_or("session"),
            "status": status
        },
        "channel": "task",
        "visibility": "debug",
        "presentation": "stageSummary",
        "lineage": {
            "schemaVersion": "deepcode.session.fact-lineage.v1",
            "turnAuthorityRef": turn_authority_ref,
            "producer": {
                "kind": "sessionRule",
                "ruleId": "session.daemon.terminal-close.v1",
                "sourceEventRefs": [turn_authority_ref]
            },
            "domainParentRefs": domain_parent_refs,
            "kernelFactRefs": []
        }
    });
    if let Some(revision) = language_revision {
        payload["languageRevision"] = json!(revision);
    }
    if let Some(language) = language {
        payload["presentationLanguage"] = json!(language);
    }
    Ok(Some(json!({
        "id": event_id,
        "sessionId": session_id,
        "ts": now_text(),
        "kind": "session_run_state",
        "payload": payload
    })))
}

fn current_turn_authority_ref_for_host_run(
    records: &[SessionDomainBatchRecordV1],
    session_id: &str,
    host_run_id: &str,
) -> Result<String, SessionDomainStoreError> {
    // A Host run is a Daemon lifecycle identity; authority payload runId is a
    // separate Session/Kernel identity. Only the durable batch transition may
    // bind the two sides without inventing an identity mapping.
    let authority_positions = persisted_turn_authority_positions(records, session_id)?;
    let mut current: Option<((usize, usize), String)> = None;
    for (record_index, record) in records.iter().enumerate() {
        let SessionAppendTransitionV1::Append {
            intent,
            run_id,
            turn_authority_ref: Some(turn_authority_ref),
            ..
        } = &record.transition
        else {
            continue;
        };
        if run_id != host_run_id
            || !matches!(
                intent,
                SessionAppendIntentV1::BootstrapRun
                    | SessionAppendIntentV1::DomainFacts
                    | SessionAppendIntentV1::Guidance
            )
        {
            continue;
        }
        let authority_position = persisted_turn_authority_position(
            &authority_positions,
            turn_authority_ref,
            record_index,
            matches!(
                intent,
                SessionAppendIntentV1::BootstrapRun | SessionAppendIntentV1::DomainFacts
            ),
        )?;
        if let Some((current_position, current_ref)) = current.as_ref() {
            if authority_position < *current_position
                || (authority_position == *current_position && turn_authority_ref != current_ref)
            {
                return Err(SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Host run {host_run_id} regresses its durable turn-authority mapping from {current_ref} to {turn_authority_ref}"
                    ),
                ));
            }
        }
        current = Some((authority_position, turn_authority_ref.clone()));
    }
    if let Some((_, authority_ref)) = current {
        return Ok(authority_ref);
    }

    // A claimed continuation may not have emitted its first domainFacts batch
    // yet. Its immutable claim evidence is the only bounded fallback.
    let mut claim_fallback: Option<String> = None;
    for (record_index, record) in records.iter().enumerate() {
        let SessionAppendTransitionV1::Claim {
            claimant_run_id, ..
        } = &record.transition
        else {
            continue;
        };
        if claimant_run_id != host_run_id {
            continue;
        }
        for event in &record.events {
            if event.get("sessionId").and_then(Value::as_str) != Some(session_id) {
                continue;
            }
            let Some(payload) = exact_interaction_claim_payload(event, &record.transition) else {
                continue;
            };
            let authority_ref = payload
                .get("turnAuthorityRef")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    SessionDomainStoreError::new(
                        "session_append_recovery_required",
                        format!(
                            "Host run {host_run_id} has interaction-claim evidence without turnAuthorityRef"
                        ),
                    )
                })?;
            persisted_turn_authority_position(
                &authority_positions,
                authority_ref,
                record_index,
                false,
            )?;
            if claim_fallback.is_some() {
                return Err(SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Host run {host_run_id} has multiple immutable interaction-claim authority bindings"
                    ),
                ));
            }
            claim_fallback = Some(authority_ref.to_string());
        }
    }
    claim_fallback.ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("Host run {host_run_id} has no exact durable turn-authority mapping"),
        )
    })
}

fn persisted_turn_authority_positions(
    records: &[SessionDomainBatchRecordV1],
    session_id: &str,
) -> Result<HashMap<String, (usize, usize)>, SessionDomainStoreError> {
    let mut positions = HashMap::new();
    let persisted_events = records
        .iter()
        .flat_map(|record| record.events.iter().cloned())
        .collect::<Vec<_>>();
    let mut persisted_event_index = 0usize;
    for (record_index, record) in records.iter().enumerate() {
        for (event_index, event) in record.events.iter().enumerate() {
            if event.get("kind").and_then(Value::as_str) == Some("session_turn_authority") {
                let authority_ref = event
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_recovery_required",
                            "Persisted turn authority has no event identity",
                        )
                    })?;
                validate_session_fact_lineage_batch(
                    session_id,
                    &persisted_events[..persisted_event_index],
                    std::slice::from_ref(event),
                    &[],
                    None,
                )
                .map_err(|error| {
                    SessionDomainStoreError::new(
                        "session_append_recovery_required",
                        format!(
                            "Turn authority event {authority_ref} is invalid: {}",
                            error.message
                        ),
                    )
                })?;
                if positions
                    .insert(authority_ref.to_string(), (record_index, event_index))
                    .is_some()
                {
                    return Err(SessionDomainStoreError::new(
                        "session_append_recovery_required",
                        format!("Turn authority event {authority_ref} is duplicated"),
                    ));
                }
            }
            persisted_event_index += 1;
        }
    }
    Ok(positions)
}

fn persisted_turn_authority_position(
    authority_positions: &HashMap<String, (usize, usize)>,
    authority_ref: &str,
    consumer_record_index: usize,
    allow_same_record: bool,
) -> Result<(usize, usize), SessionDomainStoreError> {
    let (authority_record_index, authority_event_index) = authority_positions
        .get(authority_ref)
        .copied()
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Turn authority event {authority_ref} is not a durable v2 authority"),
            )
        })?;
    let is_earlier = authority_record_index < consumer_record_index
        || (allow_same_record && authority_record_index == consumer_record_index);
    if !is_earlier {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!(
                "Turn authority event {authority_ref} is not earlier than its host-run binding"
            ),
        ));
    }
    Ok((authority_record_index, authority_event_index))
}

fn terminal_transition_status(transition: &SessionAppendTransitionV1) -> Option<&str> {
    match transition {
        SessionAppendTransitionV1::Close {
            phase: SessionClosePhaseV1::Terminal,
            status,
            ..
        } => Some(status),
        _ => None,
    }
}

fn daemon_session_batch_id(kind: &str, identity: &str) -> String {
    let digest = deepcode_kernel_tools::hash_bytes(identity.as_bytes());
    format!(
        "daemon:{kind}:{}",
        digest.strip_prefix("sha256:").unwrap_or(digest.as_str())
    )
}

pub(crate) fn admit_session_domain_batch(
    state: &AppState,
    session_id: &str,
    command: SessionAppendCommandV1,
) -> Result<SessionAppendReceiptV1, SessionDomainStoreError> {
    reconcile_session_run_recovery(state, session_id)?;
    validate_domain_identity(session_id, "sessionId")?;
    validate_session_append_command(&command)?;
    validate_session_domain_events(&command.events, Some(session_id))?;
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let admission_lock = session_domain_admission_lock(&sessions_dir, session_id);
    let _admission_guard = admission_lock
        .lock()
        .expect("session domain admission lock");
    admit_session_domain_batch_locked(state, &sessions_dir, session_id, command)
}

fn validate_session_run_bootstrap_admission_locked(
    sessions_dir: &FsPath,
    session_id: &str,
    command: &SessionAppendCommandV1,
) -> Result<(), SessionDomainStoreError> {
    let SessionAppendTransitionV1::Append {
        intent: SessionAppendIntentV1::BootstrapRun,
        run_id,
        turn_authority_ref: Some(turn_authority_ref),
        bootstrap_admission_id: Some(bootstrap_admission_id),
        ..
    } = &command.transition
    else {
        return Ok(());
    };
    let token = command.bootstrap_token.as_deref().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "A new bootstrapRun batch requires its request-only bootstrap token",
        )
    })?;
    let key = session_run_bootstrap_registry_key(sessions_dir, session_id, run_id);
    {
        let registry = session_run_bootstrap_registry()
            .lock()
            .expect("session run bootstrap registry");
        let entry = registry.get(&key).ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Run bootstrap admission is missing or no longer active",
            )
        })?;
        if entry.admission_id != *bootstrap_admission_id
            || !bootstrap_tokens_equal(&entry.token, token)
        {
            return Err(SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Run bootstrap admission identity does not match its active grant",
            ));
        }
        match &entry.state {
            SessionRunBootstrapAdmissionState::Pending => {}
            SessionRunBootstrapAdmissionState::Committed { .. } => {
                return Err(SessionDomainStoreError::new(
                    "session_append_batch_conflict",
                    "Run bootstrap grant was already consumed by another batch",
                ))
            }
            SessionRunBootstrapAdmissionState::Revoked { .. } => {
                return Err(SessionDomainStoreError::new(
                    "session_append_transition_invalid",
                    "Run bootstrap grant was revoked before durable admission",
                ))
            }
        }
    }
    if !command.preconditions.is_empty()
        || !command.provider_admissions.is_empty()
        || command.events.iter().any(|event| {
            event.get("kind").and_then(Value::as_str) == Some("session_run_state")
                && matches!(
                    event.pointer("/payload/status").and_then(Value::as_str),
                    Some("completed" | "failed" | "cancelled" | "waiting")
                )
        })
    {
        return Err(SessionDomainStoreError::new(
            "session_append_transition_invalid",
            "bootstrapRun must be authority-first, non-terminal and free of Provider or fence preconditions",
        ));
    }
    let authority_matches = command
        .events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            event.get("kind").and_then(Value::as_str) == Some("session_turn_authority")
                && event.get("id").and_then(Value::as_str) == Some(turn_authority_ref.as_str())
        })
        .collect::<Vec<_>>();
    if authority_matches.len() != 1
        || command
            .events
            .iter()
            .filter(|event| {
                event.get("kind").and_then(Value::as_str) == Some("session_turn_authority")
            })
            .count()
            != 1
    {
        return Err(SessionDomainStoreError::new(
            "session_append_lineage_invalid",
            "bootstrapRun must introduce exactly one matching turn authority",
        ));
    }
    let (authority_index, authority) = authority_matches[0];
    let source_message_ids = authority
        .pointer("/payload/sourceMessageIds")
        .and_then(Value::as_array)
        .filter(|ids| !ids.is_empty())
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_lineage_invalid",
                "bootstrapRun authority has no user-message source ids",
            )
        })?;
    let mut unique_sources = std::collections::HashSet::new();
    for source_message_id in source_message_ids {
        let source_message_id = source_message_id
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                SessionDomainStoreError::new(
                    "session_append_lineage_invalid",
                    "bootstrapRun authority contains an invalid user-message source id",
                )
            })?;
        if !unique_sources.insert(source_message_id) {
            return Err(SessionDomainStoreError::new(
                "session_append_lineage_invalid",
                "bootstrapRun authority contains duplicate user-message sources",
            ));
        }
        let matches = command
            .events
            .iter()
            .take(authority_index)
            .filter(|event| {
                event.get("id").and_then(Value::as_str) == Some(source_message_id)
                    && event.get("kind").and_then(Value::as_str) == Some("user_msg")
            })
            .count();
        if matches != 1 {
            return Err(SessionDomainStoreError::new(
                "session_append_lineage_invalid",
                format!(
                    "bootstrapRun authority source {source_message_id} is not one exact earlier user_msg"
                ),
            ));
        }
    }
    let has_running_fact = command.events.iter().any(|event| {
        event.get("kind").and_then(Value::as_str) == Some("session_run_state")
            && event.pointer("/payload/status").and_then(Value::as_str) == Some("running")
            && event
                .pointer("/payload/lineage/turnAuthorityRef")
                .and_then(Value::as_str)
                == Some(turn_authority_ref.as_str())
    });
    if !has_running_fact {
        return Err(SessionDomainStoreError::new(
            "session_append_lineage_invalid",
            "bootstrapRun must include a running Session fact under its new authority",
        ));
    }
    Ok(())
}

fn mark_session_run_bootstrap_committed_locked(
    sessions_dir: &FsPath,
    session_id: &str,
    transition: &SessionAppendTransitionV1,
    batch_id: &str,
) -> Result<(), SessionDomainStoreError> {
    let SessionAppendTransitionV1::Append {
        intent: SessionAppendIntentV1::BootstrapRun,
        run_id,
        turn_authority_ref: Some(turn_authority_ref),
        bootstrap_admission_id: Some(bootstrap_admission_id),
        ..
    } = transition
    else {
        return Ok(());
    };
    let key = session_run_bootstrap_registry_key(sessions_dir, session_id, run_id);
    let mut registry = session_run_bootstrap_registry()
        .lock()
        .expect("session run bootstrap registry");
    let entry = registry.get_mut(&key).ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Durable bootstrapRun has no matching process-local admission",
        )
    })?;
    if entry.admission_id != *bootstrap_admission_id {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Durable bootstrapRun admission identity changed before commit acknowledgement",
        ));
    }
    entry.state = SessionRunBootstrapAdmissionState::Committed {
        batch_id: batch_id.to_string(),
        turn_authority_ref: turn_authority_ref.clone(),
    };
    Ok(())
}

fn admit_session_domain_batch_locked(
    state: &AppState,
    sessions_dir: &FsPath,
    session_id: &str,
    mut command: SessionAppendCommandV1,
) -> Result<SessionAppendReceiptV1, SessionDomainStoreError> {
    let mut snapshot = {
        let _projection_guard =
            session_jsonl_append_lock(&sessions_dir, session_id, "projection.jsonl")
                .lock()
                .expect("session projection JSONL lock");
        load_session_domain_snapshot_unlocked(&sessions_dir, session_id, true)?
    };
    match snapshot.writeability {
        SessionDomainWriteability::LegacyReadOnly => {
            return Err(SessionDomainStoreError::new(
                "session_append_legacy_read_only",
                "Legacy raw-event Session is read-only and cannot accept domain batches",
            ))
        }
        SessionDomainWriteability::Current => {}
        SessionDomainWriteability::Uninitialized => {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session domain store has no genesis record",
            ))
        }
        SessionDomainWriteability::Corrupt => {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session domain store is corrupt",
            ))
        }
    }
    publish_session_domain_snapshot(state, session_id, &snapshot)?;

    let current_head = snapshot.head.clone().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Current Session domain store has no composite head",
        )
    })?;
    if let Some((record_index, existing)) = snapshot
        .records
        .iter()
        .enumerate()
        .find(|(_, record)| record.batch_id == command.batch_id)
    {
        let (projection_digest, projection_revision) =
            submitted_projection_identity(command.timeline.as_mut())?;
        let submitted_batch_digest = session_domain_batch_digest(
            session_id,
            &command.batch_id,
            &command.base_head,
            &command.preconditions,
            &command.transition,
            &command.provider_admissions,
            &command.events,
            projection_digest.as_deref(),
            projection_revision,
        )?;
        if existing.batch_digest != submitted_batch_digest {
            return Err(SessionDomainStoreError {
                code: "session_append_batch_conflict",
                message: format!(
                    "batchId {} already exists with different canonical command material",
                    command.batch_id
                ),
                current_head: Some(current_head),
                failed_precondition: None,
                precondition_index: None,
                batch_id: Some(command.batch_id.clone()),
                existing_batch_digest: Some(existing.batch_digest.clone()),
                submitted_batch_digest: Some(submitted_batch_digest),
                expected_head: None,
                transition: None,
                event_id: None,
            });
        }
        let result_state =
            session_domain_state_for_record(session_id, &snapshot.records, record_index)?;
        return Ok(session_append_receipt(
            session_id,
            existing,
            result_state,
            true,
        ));
    }
    if command.base_head != current_head {
        return Err(SessionDomainStoreError {
            code: "session_append_head_conflict",
            message: format!(
                "Session append batch {} was based on a stale composite head",
                command.batch_id
            ),
            current_head: Some(current_head),
            failed_precondition: None,
            precondition_index: None,
            batch_id: Some(command.batch_id.clone()),
            existing_batch_digest: None,
            submitted_batch_digest: None,
            expected_head: Some(command.base_head.clone()),
            transition: None,
            event_id: None,
        });
    }
    validate_session_run_bootstrap_admission_locked(sessions_dir, session_id, &command)?;
    let mut next_events = snapshot.events.clone();
    next_events.extend(command.events.iter().cloned());
    if let Some(incoming_timeline) = command.timeline.as_ref() {
        if let Some(previous_timeline) = session_timeline(state, session_id) {
            validate_committed_final_history(&previous_timeline, incoming_timeline).map_err(
                |message| {
                    SessionDomainStoreError::new(
                        "session_append_transition_invalid",
                        format!("Session timeline mutates committed final history: {message}"),
                    )
                },
            )?;
            if previous_timeline != *incoming_timeline {
                let previous_revision = previous_timeline
                    .get("revision")
                    .and_then(json_safe_nonnegative_integer)
                    .ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_recovery_required",
                            "Current Shared Projection has no safe revision",
                        )
                    })?;
                let incoming_revision = incoming_timeline
                    .get("revision")
                    .and_then(json_safe_nonnegative_integer)
                    .ok_or_else(|| {
                        SessionDomainStoreError::new(
                            "session_append_transition_invalid",
                            "Incoming Shared Projection has no safe revision",
                        )
                    })?;
                if incoming_revision <= previous_revision {
                    return Err(SessionDomainStoreError::new(
                        "session_append_transition_invalid",
                        "Incoming Shared Projection revision did not advance",
                    ));
                }
            }
        }
    }
    let (projection_digest, projection_revision) =
        prepare_command_projection(session_id, &next_events, command.timeline.as_mut())?;
    validate_open_interaction_projection_binding(&command.transition, command.timeline.as_ref())?;
    let submitted_batch_digest = session_domain_batch_digest(
        session_id,
        &command.batch_id,
        &command.base_head,
        &command.preconditions,
        &command.transition,
        &command.provider_admissions,
        &command.events,
        projection_digest.as_deref(),
        projection_revision,
    )?;

    let provider_admission_values = command
        .provider_admissions
        .iter()
        .map(|admission| {
            serde_json::to_value(admission).map_err(|error| {
                SessionDomainStoreError::new(
                    "session_append_lineage_invalid",
                    format!(
                        "Failed to serialize Provider admission metadata for lineage validation: {error}"
                    ),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_session_fact_lineage_batch(
        session_id,
        &snapshot.events,
        &command.events,
        &provider_admission_values,
        command.timeline.as_ref(),
    )
    .map_err(|error| SessionDomainStoreError {
        code: error.code,
        message: error.message,
        current_head: Some(current_head.clone()),
        failed_precondition: None,
        precondition_index: None,
        batch_id: Some(command.batch_id.clone()),
        existing_batch_digest: None,
        submitted_batch_digest: None,
        expected_head: None,
        transition: None,
        event_id: error.event_id,
    })?;

    let mut derived_state = validate_session_domain_record_chain(session_id, &snapshot.records)?;
    validate_session_append_preconditions(&derived_state, &command.preconditions, &current_head)
        .map_err(|mut error| {
            error.batch_id = Some(command.batch_id.clone());
            error
        })?;
    let incoming_authorities = command
        .events
        .iter()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("session_turn_authority"))
        .filter_map(|event| event.get("id").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    validate_provider_admission_authority_refs(
        &derived_state,
        &command.provider_admissions,
        &incoming_authorities,
    )
    .map_err(|mut error| {
        error.code = "session_append_lineage_invalid";
        error.current_head = Some(current_head.clone());
        error.batch_id = Some(command.batch_id.clone());
        error
    })?;
    for event in &command.events {
        let event_id = event
            .get("id")
            .and_then(Value::as_str)
            .expect("command event id validated");
        if derived_state.event_ids.contains(event_id) {
            return Err(SessionDomainStoreError {
                code: "session_append_transition_invalid",
                message: format!("Session event id {event_id} is already durable"),
                current_head: Some(current_head.clone()),
                failed_precondition: None,
                precondition_index: None,
                batch_id: Some(command.batch_id.clone()),
                existing_batch_digest: None,
                submitted_batch_digest: None,
                expected_head: None,
                transition: Some(command.transition.clone()),
                event_id: Some(event_id.to_string()),
            });
        }
    }
    for admission in &command.provider_admissions {
        if derived_state
            .provider_request_ids
            .contains(&admission.request_id)
        {
            return Err(SessionDomainStoreError {
                code: "session_append_lineage_invalid",
                message: format!(
                    "Provider request id {} is already durable",
                    admission.request_id
                ),
                current_head: Some(current_head.clone()),
                failed_precondition: None,
                precondition_index: None,
                batch_id: Some(command.batch_id.clone()),
                existing_batch_digest: None,
                submitted_batch_digest: None,
                expected_head: None,
                transition: None,
                event_id: None,
            });
        }
    }
    apply_session_append_transition(
        &mut derived_state,
        &command.transition,
        &command.preconditions,
        &command.batch_id,
        &command.events,
    )
    .map_err(|mut error| {
        error.current_head = Some(current_head.clone());
        error.batch_id = Some(command.batch_id.clone());
        error.transition = Some(command.transition.clone());
        error
    })?;
    for event in &command.events {
        let event_id = event
            .get("id")
            .and_then(Value::as_str)
            .expect("command event id validated")
            .to_string();
        if event.get("kind").and_then(Value::as_str) == Some("session_turn_authority") {
            derived_state
                .turn_authority_event_ids
                .insert(event_id.clone());
        }
        derived_state.event_ids.insert(event_id);
    }
    derived_state.provider_request_ids.extend(
        command
            .provider_admissions
            .iter()
            .map(|admission| admission.request_id.clone()),
    );
    let result_head = next_session_domain_head(
        &current_head,
        &command.batch_id,
        &submitted_batch_digest,
        command.events.len(),
    )?;
    let committed_events = command.events.clone();
    let record = SessionDomainBatchRecordV1 {
        schema_version: SESSION_DOMAIN_BATCH_SCHEMA_VERSION.to_string(),
        record_kind: SESSION_DOMAIN_BATCH_RECORD_KIND.to_string(),
        session_id: session_id.to_string(),
        batch_id: command.batch_id.clone(),
        batch_digest: submitted_batch_digest,
        base_head: current_head,
        preconditions: command.preconditions,
        transition: command.transition,
        provider_admissions: command.provider_admissions,
        events: command.events,
        result_head: result_head.clone(),
        projection_digest,
        projection_revision,
        committed_at: now_text(),
    };

    {
        let _projection_guard =
            session_jsonl_append_lock(&sessions_dir, session_id, "projection.jsonl")
                .lock()
                .expect("session projection JSONL lock");
        let fresh = load_session_domain_snapshot_unlocked(&sessions_dir, session_id, true)?;
        let fresh_head = fresh.head.clone().ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                "Session domain store lost its composite head before commit",
            )
        })?;
        if fresh_head != record.base_head {
            return Err(SessionDomainStoreError {
                code: "session_append_head_conflict",
                message: format!(
                    "Session append batch {} lost its composite-head race",
                    record.batch_id
                ),
                current_head: Some(fresh_head),
                failed_precondition: None,
                precondition_index: None,
                batch_id: Some(record.batch_id.clone()),
                existing_batch_digest: None,
                submitted_batch_digest: None,
                expected_head: Some(record.base_head.clone()),
                transition: None,
                event_id: None,
            });
        }
        if let Some(timeline) = command.timeline.as_ref() {
            stage_session_timeline(
                &sessions_dir,
                session_id,
                &record.batch_id,
                timeline,
                record
                    .projection_digest
                    .as_deref()
                    .expect("timeline digest prepared"),
            )?;
        }
        if let Err(write_error) =
            append_session_domain_record_durable(&sessions_dir, session_id, &record)
        {
            let recovered = load_session_domain_snapshot_unlocked(&sessions_dir, session_id, true)
                .ok()
                .and_then(|snapshot| {
                    snapshot.records.into_iter().find(|candidate| {
                        candidate.batch_id == record.batch_id
                            && candidate.batch_digest == record.batch_digest
                            && candidate.result_head == record.result_head
                    })
                });
            if recovered.is_none() {
                return Err(write_error);
            }
        }
        mark_session_run_bootstrap_committed_locked(
            sessions_dir,
            session_id,
            &record.transition,
            &record.batch_id,
        )?;
    }
    snapshot.records.push(record.clone());
    snapshot.events = next_events;
    snapshot.head = Some(result_head.clone());
    publish_session_domain_snapshot(state, session_id, &snapshot)?;
    mirror_committed_session_domain_events(state, session_id, &committed_events);
    let result_state = session_domain_state_snapshot(result_head, &derived_state);
    Ok(session_append_receipt(
        session_id,
        &record,
        result_state,
        false,
    ))
}

fn mirror_committed_session_domain_events(state: &AppState, session_id: &str, events: &[Value]) {
    if events.is_empty() {
        return;
    }
    let (archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, session_id),
        )
    };
    if let Err(error) =
        append_conversation_archive_projection(&archive_root, session_id, session.as_ref(), events)
    {
        eprintln!(
            "Session domain batch committed, but conversation archive projection degraded for {session_id}: {error}"
        );
    }
}

fn prepare_command_projection(
    session_id: &str,
    next_events: &[Value],
    timeline: Option<&mut Value>,
) -> Result<(Option<String>, Option<u64>), SessionDomainStoreError> {
    let Some(timeline) = timeline else {
        return Ok((None, None));
    };
    canonicalize_projection_safe_integers(timeline);
    validate_shared_projection_commit(timeline, session_id, next_events).map_err(|message| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("Session timeline does not match the submitted domain batch: {message}"),
        )
    })?;
    let revision = timeline
        .get("revision")
        .and_then(json_safe_nonnegative_integer)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Session timeline requires a safe non-negative revision",
            )
        })?;
    let digest = deepcode_kernel_tools::hash_bytes(&canonical_json_bytes(timeline)?);
    Ok((Some(digest), Some(revision)))
}

fn submitted_projection_identity(
    timeline: Option<&mut Value>,
) -> Result<(Option<String>, Option<u64>), SessionDomainStoreError> {
    let Some(timeline) = timeline else {
        return Ok((None, None));
    };
    canonicalize_projection_safe_integers(timeline);
    validate_shared_projection_timeline(timeline).map_err(|message| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("Submitted Session timeline is invalid: {message}"),
        )
    })?;
    let revision = timeline
        .get("revision")
        .and_then(json_safe_nonnegative_integer)
        .ok_or_else(|| {
            SessionDomainStoreError::new(
                "session_append_transition_invalid",
                "Submitted Session timeline requires a safe non-negative revision",
            )
        })?;
    let digest = deepcode_kernel_tools::hash_bytes(&canonical_json_bytes(timeline)?);
    Ok((Some(digest), Some(revision)))
}

fn stage_session_timeline(
    sessions_dir: &FsPath,
    session_id: &str,
    batch_id: &str,
    timeline: &Value,
    expected_digest: &str,
) -> Result<(), SessionDomainStoreError> {
    let dir = sessions_dir.join(safe_path_segment(session_id));
    fs::create_dir_all(&dir).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Failed to create Session timeline directory: {error}"),
        )
    })?;
    let pending_path = session_timeline_pending_path(sessions_dir, session_id, batch_id);
    if pending_path.exists() {
        let existing = read_timeline_value_strict(&pending_path)?;
        let existing_digest = deepcode_kernel_tools::hash_bytes(&canonical_json_bytes(&existing)?);
        if existing_digest == expected_digest {
            return Ok(());
        }
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!(
                "Staged timeline {} conflicts with the submitted batch",
                pending_path.display()
            ),
        ));
    }
    let bytes = serde_json::to_vec_pretty(timeline).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_transition_invalid",
            format!("Failed to serialize staged Session timeline: {error}"),
        )
    })?;
    let mut pending = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending_path)
        .map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Failed to create staged Session timeline {}: {error}",
                    pending_path.display()
                ),
            )
        })?;
    pending.write_all(&bytes).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Failed to write staged Session timeline: {error}"),
        )
    })?;
    pending
        .flush()
        .and_then(|_| pending.sync_data())
        .map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!("Failed to sync staged Session timeline: {error}"),
            )
        })
}

fn session_timeline_pending_path(
    sessions_dir: &FsPath,
    session_id: &str,
    batch_id: &str,
) -> PathBuf {
    sessions_dir
        .join(safe_path_segment(session_id))
        .join(format!("timeline.{batch_id}.pending"))
}

fn read_timeline_value_strict(path: &FsPath) -> Result<Value, SessionDomainStoreError> {
    let bytes = fs::read(path).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!(
                "Failed to read Session timeline {}: {error}",
                path.display()
            ),
        )
    })?;
    let mut value = serde_json::from_slice::<Value>(&bytes).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!(
                "Session timeline {} is invalid JSON: {error}",
                path.display()
            ),
        )
    })?;
    canonicalize_projection_safe_integers(&mut value);
    Ok(value)
}

fn latest_projection_record(
    records: &[SessionDomainBatchRecordV1],
) -> Option<&SessionDomainBatchRecordV1> {
    records
        .iter()
        .rev()
        .find(|record| record.projection_digest.is_some())
}

fn finalize_committed_session_timeline(
    sessions_dir: &FsPath,
    session_id: &str,
    records: &[SessionDomainBatchRecordV1],
) -> Result<Option<(Value, SessionProjectionCommitAckV1)>, SessionDomainStoreError> {
    let Some(record) = latest_projection_record(records) else {
        return Ok(None);
    };
    let expected_digest = record
        .projection_digest
        .as_deref()
        .expect("projection record selected by digest");
    let expected_revision = record.projection_revision.ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Committed projection record has no projectionRevision",
        )
    })?;
    let dir = sessions_dir.join(safe_path_segment(session_id));
    let timeline_path = dir.join("timeline.json");
    let pending_path = session_timeline_pending_path(sessions_dir, session_id, &record.batch_id);
    let committed = if timeline_path.exists() {
        match read_timeline_value_strict(&timeline_path) {
            Ok(timeline) => Some(timeline),
            Err(error) if pending_path.exists() => {
                eprintln!(
                    "replacing invalid committed Session timeline {} from durable staged batch {}: {}",
                    timeline_path.display(),
                    record.batch_id,
                    error.message
                );
                None
            }
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    let committed_matches = committed.as_ref().is_some_and(|timeline| {
        canonical_json_bytes(timeline)
            .map(|bytes| deepcode_kernel_tools::hash_bytes(&bytes) == expected_digest)
            .unwrap_or(false)
    });
    let timeline = if committed_matches {
        if pending_path.exists() {
            fs::remove_file(&pending_path).map_err(|error| {
                SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Failed to remove completed staged timeline {}: {error}",
                        pending_path.display()
                    ),
                )
            })?;
        }
        committed.expect("committed timeline matched above")
    } else {
        if !pending_path.exists() {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Committed batch {} requires timeline recovery, but its staged timeline is missing",
                    record.batch_id
                ),
            ));
        }
        let pending = read_timeline_value_strict(&pending_path)?;
        let pending_digest = deepcode_kernel_tools::hash_bytes(&canonical_json_bytes(&pending)?);
        if pending_digest != expected_digest {
            return Err(SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Staged timeline for committed batch {} has a digest mismatch",
                    record.batch_id
                ),
            ));
        }
        fs::rename(&pending_path, &timeline_path).map_err(|error| {
            SessionDomainStoreError::new(
                "session_append_recovery_required",
                format!(
                    "Failed to publish staged timeline for committed batch {}: {error}",
                    record.batch_id
                ),
            )
        })?;
        pending
    };
    let ack = SessionProjectionCommitAckV1 {
        schema_version: "deepcode.session.projection-commit-ack.v1".to_string(),
        revision: expected_revision,
        source_event_version: record.result_head.event_version,
        projection_digest: expected_digest.to_string(),
    };
    Ok(Some((timeline, ack)))
}

fn publish_session_domain_snapshot(
    state: &AppState,
    session_id: &str,
    snapshot: &SessionDomainSnapshot,
) -> Result<Option<SessionProjectionCommitAckV1>, SessionDomainStoreError> {
    let head = snapshot.head.clone().ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Cannot publish Session domain snapshot without a composite head",
        )
    })?;
    let derived_state = validate_session_domain_record_chain(session_id, &snapshot.records)?;
    let domain_state = session_domain_state_snapshot(head.clone(), &derived_state);
    let mut gui = state.gui.lock().expect("gui state lock");
    let sessions_dir = gui.paths.sessions_dir.clone();
    let mut next_sessions = gui.sessions.clone();
    let Some(position) = next_sessions
        .iter()
        .position(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
    else {
        return Err(SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Session domain store has no registered Session index entry",
        ));
    };
    let serialized_domain_state = serde_json::to_value(&domain_state).map_err(|error| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            format!("Failed to serialize Session domain state for index: {error}"),
        )
    })?;
    let index_changed = next_sessions[position]
        .get("eventCount")
        .and_then(Value::as_u64)
        != Some(snapshot.events.len() as u64)
        || next_sessions[position].get("domainState") != Some(&serialized_domain_state);
    next_sessions[position]["eventCount"] = json!(snapshot.events.len());
    next_sessions[position]["domainState"] = serialized_domain_state;
    if index_changed {
        next_sessions[position]["updatedAt"] = json!(now_text());
        persist_session_index_values(&gui.paths.sessions_index_path, &next_sessions).map_err(
            |error| {
                gui.session_projection_cache.remove(session_id);
                gui.session_timeline_cache.remove(session_id);
                SessionDomainStoreError::new(
                    "session_append_recovery_required",
                    format!(
                        "Session domain batch is durable, but Session index publication failed: {error}"
                    ),
                )
                .with_current_head(Some(head.clone()))
            },
        )?;
    }
    gui.sessions = next_sessions;
    let finalized =
        finalize_committed_session_timeline(&sessions_dir, session_id, &snapshot.records).map_err(
            |error| {
                gui.session_projection_cache.remove(session_id);
                gui.session_timeline_cache.remove(session_id);
                error.with_current_head(Some(head.clone()))
            },
        )?;
    gui.session_projection_cache
        .insert(session_id.to_string(), snapshot.events.clone());
    if let Some((timeline, _)) = finalized.as_ref() {
        gui.session_timeline_cache
            .insert(session_id.to_string(), timeline.clone());
    }
    Ok(finalized.map(|(_, ack)| ack))
}

fn session_domain_state_for_record(
    session_id: &str,
    records: &[SessionDomainBatchRecordV1],
    record_index: usize,
) -> Result<SessionDomainStateSnapshotV1, SessionDomainStoreError> {
    let prefix = records.get(..=record_index).ok_or_else(|| {
        SessionDomainStoreError::new(
            "session_append_recovery_required",
            "Session replay record index is outside the durable domain chain",
        )
    })?;
    let state = validate_session_domain_record_chain(session_id, prefix)?;
    let head = prefix
        .last()
        .expect("non-empty record prefix")
        .result_head
        .clone();
    Ok(session_domain_state_snapshot(head, &state))
}

fn session_append_receipt(
    session_id: &str,
    record: &SessionDomainBatchRecordV1,
    result_state: SessionDomainStateSnapshotV1,
    idempotent: bool,
) -> SessionAppendReceiptV1 {
    let projection_ack = match (
        record.projection_digest.as_ref(),
        record.projection_revision,
    ) {
        (Some(digest), Some(revision)) => Some(SessionProjectionCommitAckV1 {
            schema_version: "deepcode.session.projection-commit-ack.v1".to_string(),
            revision,
            source_event_version: record.result_head.event_version,
            projection_digest: digest.clone(),
        }),
        _ => None,
    };
    SessionAppendReceiptV1 {
        schema_version: "deepcode.session.append-receipt.v1".to_string(),
        session_id: session_id.to_string(),
        batch_id: record.batch_id.clone(),
        server_digest: record.batch_digest.clone(),
        base_head: record.base_head.clone(),
        result_state,
        idempotent,
        projection_ack,
        committed_at: record.committed_at.clone(),
    }
}

#[derive(Debug)]
pub(crate) struct SessionProjectionAppendOutcome {
    pub(crate) appended: usize,
    pub(crate) entry_count: usize,
    pub(crate) conversation_archive_error: Option<String>,
}

#[derive(Debug)]
pub(crate) struct SessionProjectionAppendError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

pub(crate) fn append_session_projection(
    state: &AppState,
    session_id: &str,
    events: Vec<Value>,
) -> Result<SessionProjectionAppendOutcome, SessionProjectionAppendError> {
    let incoming_count = events.len();
    let events = sanitize_non_analysis_persistence_entries(events);
    if events.len() != incoming_count {
        eprintln!(
            "discarded {} hidden reasoning projection event(s) before Session persistence",
            incoming_count - events.len()
        );
    }
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    match read_session_domain_snapshot(&sessions_dir, session_id) {
        Ok(snapshot) if snapshot.writeability == SessionDomainWriteability::Current => {
            return Err(SessionProjectionAppendError {
                code: "session_append_transition_invalid",
                message: "Canonical Session domain stores only accept SessionAppendCommandV1"
                    .to_string(),
            })
        }
        Ok(snapshot) if snapshot.writeability == SessionDomainWriteability::LegacyReadOnly => {
            return Err(SessionProjectionAppendError {
                code: "session_append_legacy_read_only",
                message:
                    "Legacy raw-event Session is read-only and cannot accept projection appends"
                        .to_string(),
            })
        }
        Ok(snapshot) if snapshot.writeability == SessionDomainWriteability::Uninitialized => {}
        Ok(_) => {
            return Err(SessionProjectionAppendError {
                code: "session_append_recovery_required",
                message: "Session projection store is not writable".to_string(),
            })
        }
        Err(error) => {
            return Err(SessionProjectionAppendError {
                code: error.code,
                message: error.message,
            })
        }
    }
    if events.is_empty() {
        return Ok(SessionProjectionAppendOutcome {
            appended: 0,
            entry_count: session_projection(state, session_id).len(),
            conversation_archive_error: None,
        });
    }

    // The GUI mutex serializes the projection JSONL, index snapshot, and cache publication.
    // No reader can observe an advanced cache before both core writes have succeeded.
    let mut gui = state.gui.lock().expect("gui state lock");
    let existing_events = gui
        .session_projection_cache
        .get(session_id)
        .cloned()
        .unwrap_or_else(|| {
            canonical_session_projection_events(read_session_projection_jsonl(
                &sessions_dir,
                session_id,
            ))
        });
    let events = new_projection_events(&existing_events, events)?;
    let mut stored_events = existing_events;
    stored_events.extend(events.clone());
    let entry_count = stored_events.len();

    let mut next_sessions = gui.sessions.clone();
    let session_index_position = next_sessions
        .iter_mut()
        .position(|session| session.get("id").and_then(Value::as_str) == Some(session_id));
    let session_index_count_changed = session_index_position.and_then(|position| {
        next_sessions[position]
            .get("eventCount")
            .and_then(Value::as_u64)
    }) != session_index_position.map(|_| entry_count as u64);
    let session_index_needs_write =
        session_index_position.is_some() && (!events.is_empty() || session_index_count_changed);
    if let Some(position) = session_index_position {
        let session = &mut next_sessions[position];
        session["eventCount"] = json!(entry_count);
        if session_index_needs_write {
            session["updatedAt"] = json!(now_text());
        }
    }

    if !events.is_empty() {
        append_session_projection_jsonl(&sessions_dir, session_id, &events).map_err(|error| {
            SessionProjectionAppendError {
                code: "write_session_projection_failed",
                message: format!("append projection JSONL failed: {error}"),
            }
        })?;
    }

    if session_index_needs_write {
        if let Err(error) =
            persist_session_index_values(&gui.paths.sessions_index_path, &next_sessions)
        {
            // The projection JSONL may already contain this batch. Evicting instead of advancing
            // the cache makes the durable log authoritative and lets an identical retry repair
            // the index without appending duplicate event IDs.
            gui.session_projection_cache.remove(session_id);
            return Err(SessionProjectionAppendError {
                code: "write_session_index_failed",
                message: format!(
                    "projection JSONL is durable but agent session index persistence failed: {error}"
                ),
            });
        }
    }

    gui.sessions = next_sessions;
    gui.session_projection_cache
        .insert(session_id.to_string(), stored_events);
    let archive_root = gui.paths.conversation_archives_dir.clone();
    let session = session_metadata(&gui.sessions, session_id);
    drop(gui);

    let conversation_archive_error = if events.is_empty() {
        None
    } else {
        append_conversation_archive_projection(&archive_root, session_id, session.as_ref(), &events)
            .err()
            .map(|error| error.to_string())
    };
    if let Some(error) = conversation_archive_error.as_deref() {
        eprintln!(
            "session projection committed, but conversation archive projection degraded for {session_id}: {error}"
        );
    }

    Ok(SessionProjectionAppendOutcome {
        appended: events.len(),
        entry_count,
        conversation_archive_error,
    })
}

fn new_projection_events(
    existing_events: &[Value],
    incoming_events: Vec<Value>,
) -> Result<Vec<Value>, SessionProjectionAppendError> {
    let mut events_by_id = existing_events
        .iter()
        .filter_map(|event| {
            event
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(|id| (id.to_string(), event.clone()))
        })
        .collect::<HashMap<_, _>>();
    let mut new_events = Vec::with_capacity(incoming_events.len());
    for event in incoming_events {
        let event_id = event
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if let Some(event_id) = event_id {
            if let Some(existing) = events_by_id.get(event_id) {
                if existing == &event {
                    continue;
                }
                return Err(SessionProjectionAppendError {
                    code: "session_projection_event_id_conflict",
                    message: format!(
                        "projection event id {event_id} already exists with different content"
                    ),
                });
            }
            events_by_id.insert(event_id.to_string(), event.clone());
        }
        new_events.push(event);
    }
    Ok(new_events)
}

pub(crate) fn session_projection(state: &AppState, session_id: &str) -> Vec<Value> {
    let (cached, sessions_dir) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.session_projection_cache.get(session_id).cloned(),
            gui.paths.sessions_dir.clone(),
        )
    };
    canonical_session_projection_events(
        cached.unwrap_or_else(|| read_session_projection_jsonl(&sessions_dir, session_id)),
    )
}

pub(crate) fn session_timeline_with_staleness(
    state: &AppState,
    session_id: &str,
) -> Option<(Value, bool)> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let sessions_dir = gui.paths.sessions_dir.clone();
    let mut timeline = gui
        .session_timeline_cache
        .get(session_id)
        .cloned()
        .or_else(|| {
            read_json_file(
                &sessions_dir
                    .join(safe_path_segment(session_id))
                    .join("timeline.json"),
            )
        })?;
    canonicalize_projection_safe_integers(&mut timeline);
    let (timeline, stale) = if timeline.get("schemaVersion").and_then(Value::as_str)
        == Some("deepcode.shared-conversation-projection.v2")
    {
        validate_shared_projection_timeline(&timeline).ok()?;
        let durable_event_count = gui
            .session_projection_cache
            .get(session_id)
            .map(Vec::len)
            .unwrap_or_else(|| {
                canonical_session_projection_events(read_session_projection_jsonl(
                    &sessions_dir,
                    session_id,
                ))
                .len()
            }) as u64;
        let stale = timeline
            .get("eventCount")
            .and_then(json_safe_nonnegative_integer)
            != Some(durable_event_count)
            || timeline
                .get("sourceEventVersion")
                .and_then(json_safe_nonnegative_integer)
                != Some(durable_event_count);
        (timeline, stale)
    } else {
        (canonical_session_timeline(timeline), false)
    };
    if !stale {
        gui.session_timeline_cache
            .insert(session_id.to_string(), timeline.clone());
    }
    Some((timeline, stale))
}

pub(crate) fn session_timeline(state: &AppState, session_id: &str) -> Option<Value> {
    let (timeline, stale) = session_timeline_with_staleness(state, session_id)?;
    (!stale).then_some(timeline)
}

pub(crate) fn canonical_session_projection_events(events: Vec<Value>) -> Vec<Value> {
    sanitize_non_analysis_persistence_entries(events)
}

fn sanitize_non_analysis_persistence_entries(entries: Vec<Value>) -> Vec<Value> {
    entries
        .into_iter()
        .filter(|entry| !is_hidden_reasoning_persistence_record(entry))
        .map(strip_hidden_reasoning_fields)
        .collect()
}

pub(crate) fn is_legacy_raw_reasoning_projection_event(event: &Value) -> bool {
    let kind = event
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = event.get("payload").unwrap_or(&Value::Null);
    let channel = payload
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    matches!(kind, "reasoning_delta" | "provider_reasoning_delta")
        || matches!(channel, "reasoning" | "thinking")
        || payload
            .get("reasoningTrace")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

fn canonical_session_timeline(mut timeline: Value) -> Value {
    let Some(turns) = timeline.get_mut("turns").and_then(Value::as_array_mut) else {
        return strip_hidden_reasoning_fields(timeline);
    };
    for turn in turns {
        let Some(blocks) = turn.get_mut("blocks").and_then(Value::as_array_mut) else {
            continue;
        };
        blocks.retain(|block| !is_legacy_raw_reasoning_timeline_block(block));
    }
    strip_hidden_reasoning_fields(timeline)
}

fn is_legacy_raw_reasoning_timeline_block(block: &Value) -> bool {
    if matches!(block.get("kind").and_then(Value::as_str), Some("thinking"))
        || matches!(
            block.get("narrativeKind").and_then(Value::as_str),
            Some("thinking")
        )
    {
        return true;
    }
    block
        .get("events")
        .and_then(Value::as_array)
        .map(|events| events.iter().any(is_legacy_raw_reasoning_projection_event))
        .unwrap_or(false)
}

pub(crate) fn append_session_projection_jsonl(
    sessions_dir: &FsPath,
    session_id: &str,
    events: &[Value],
) -> std::io::Result<()> {
    append_session_jsonl(sessions_dir, session_id, "projection.jsonl", events)
}

pub(crate) fn read_session_projection_jsonl(sessions_dir: &FsPath, session_id: &str) -> Vec<Value> {
    match read_session_domain_snapshot(sessions_dir, session_id) {
        Ok(snapshot) => snapshot.events,
        Err(error) => {
            eprintln!(
                "Session projection {} failed strict domain-log validation: {} ({})",
                session_id, error.message, error.code
            );
            Vec::new()
        }
    }
}

fn session_jsonl_append_lock(
    sessions_dir: &FsPath,
    session_id: &str,
    file_name: &str,
) -> &'static std::sync::Mutex<()> {
    use std::hash::{Hash, Hasher};

    const SHARD_COUNT: usize = 64;
    static SHARDS: std::sync::OnceLock<Vec<std::sync::Mutex<()>>> = std::sync::OnceLock::new();
    let shards = SHARDS.get_or_init(|| {
        (0..SHARD_COUNT)
            .map(|_| std::sync::Mutex::new(()))
            .collect()
    });
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    sessions_dir
        .join(safe_path_segment(session_id))
        .join(file_name)
        .hash(&mut hasher);
    &shards[(hasher.finish() as usize) % SHARD_COUNT]
}

pub(crate) fn append_session_jsonl(
    sessions_dir: &FsPath,
    session_id: &str,
    file_name: &str,
    entries: &[Value],
) -> std::io::Result<()> {
    use std::io::Write;
    let _append_guard = session_jsonl_append_lock(sessions_dir, session_id, file_name)
        .lock()
        .expect("session jsonl append lock");
    let dir = sessions_dir.join(safe_path_segment(session_id));
    fs::create_dir_all(&dir)?;
    let path = dir.join(file_name);
    let mut bytes = Vec::new();
    for entry in entries {
        bytes.extend(serde_json::to_vec(entry).unwrap_or_else(|_| b"{}".to_vec()));
        bytes.push(b'\n');
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(&bytes)?;
    Ok(())
}

pub(crate) fn read_session_jsonl(
    sessions_dir: &FsPath,
    session_id: &str,
    file_name: &str,
) -> Vec<Value> {
    let _read_guard = session_jsonl_append_lock(sessions_dir, session_id, file_name)
        .lock()
        .expect("session jsonl read lock");
    let path = sessions_dir
        .join(safe_path_segment(session_id))
        .join(file_name);
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    parse_jsonl_records(&content, &path)
}

fn read_last_session_jsonl(
    sessions_dir: &FsPath,
    session_id: &str,
    file_name: &str,
) -> Result<Option<Value>, String> {
    use std::io::{Read, Seek, SeekFrom};

    let path = sessions_dir
        .join(safe_path_segment(session_id))
        .join(file_name);
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("analysis timeline tail open failed: {error}")),
    };
    let mut cursor = file
        .metadata()
        .map_err(|error| format!("analysis timeline tail metadata failed: {error}"))?
        .len();
    if cursor == 0 {
        return Ok(None);
    }

    const BLOCK_BYTES: usize = 8 * 1024;
    let mut reversed_line = Vec::new();
    let mut skipping_trailing_newlines = true;
    while cursor > 0 {
        let block_len = usize::try_from(cursor.min(BLOCK_BYTES as u64))
            .map_err(|error| format!("analysis timeline tail block size failed: {error}"))?;
        cursor -= block_len as u64;
        file.seek(SeekFrom::Start(cursor))
            .map_err(|error| format!("analysis timeline tail seek failed: {error}"))?;
        let mut block = vec![0_u8; block_len];
        file.read_exact(&mut block)
            .map_err(|error| format!("analysis timeline tail read failed: {error}"))?;
        for byte in block.into_iter().rev() {
            if skipping_trailing_newlines && (byte == b'\n' || byte == b'\r') {
                continue;
            }
            skipping_trailing_newlines = false;
            if byte == b'\n' {
                reversed_line.reverse();
                return parse_analysis_timeline_tail(reversed_line);
            }
            reversed_line.push(byte);
        }
    }
    reversed_line.reverse();
    parse_analysis_timeline_tail(reversed_line)
}

fn parse_analysis_timeline_tail(mut line: Vec<u8>) -> Result<Option<Value>, String> {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    if line.is_empty() {
        return Ok(None);
    }
    let text = String::from_utf8(line)
        .map_err(|error| format!("analysis timeline tail is not UTF-8: {error}"))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("analysis timeline tail is not valid JSON: {error}"))
}

#[cfg(test)]
#[path = "session_store_tests.rs"]
mod tests;
