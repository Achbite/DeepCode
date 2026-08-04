use crate::host_run_broker_v2::HostActiveRunBrokerV2;
use crate::host_v2_storage::{
    append_json_line_durable, canonical_json_bytes, canonical_sha256,
    reject_transport_capabilities, sha256_path_component, validate_bounded_identity,
    validate_safe_session_identity, validate_sha256_digest, value_without_field,
    with_storage_path_lock, HostV2StorageError, HostV2StorageErrorKind,
};
use crate::kernel_v2_transport::RUN_TRANSPORT_CAPABILITY_HEADER;
use crate::prelude::*;
use crate::provider_trace_v1::{
    ProviderTraceErrorV1, ProviderTraceIdentityV1, ProviderTraceMetadataV1, ProviderTracePurposeV1,
    ProviderTraceStoreV1, ProviderTraceTerminalKindV1, ProviderTraceTerminalRecoveryV1,
    ProviderTraceTerminalV1, ProviderTraceWriterV1,
};
use crate::session_bootstrap_v2::HostSessionPriorEventsV2;
use crate::AppState;
use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use deepcode_kernel_abi::{RunCapabilityV2, ToolContextBundleV2, ToolContextRefV2};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};

const SESSION_KERNEL_PERSISTENCE_V3_SCHEMA: &str = "deepcode.session.kernel-persistence.v3";
const SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA: &str =
    "deepcode.session.kernel-persistence-record.v3";
const SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-append-request.v2";
const SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-list-reply.v2";
const SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-append-reply.v2";
const SESSION_KERNEL_CHECKPOINT_V3_SCHEMA: &str = "deepcode.session.kernel-checkpoint.v3";
const SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA: &str =
    "deepcode.session.kernel-operation-result.v2";
const SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA: &str = "deepcode.session.provider-turn-dispatch.v3";
const SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA: &str = "deepcode.session.provider-turn-terminal.v3";
const SESSION_KERNEL_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA: &str =
    "deepcode.session.tool-context-snapshot.v3";
const SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA: &str = "deepcode.provider-stream-terminal.v1";
const SESSION_KERNEL_REVIEW_RECORD_V3_SCHEMA: &str = "deepcode.session.review-record.v3";
const SESSION_KERNEL_REVIEW_PROJECTION_V2_SCHEMA: &str =
    "deepcode.session.kernel-review-projection.v2";
const SESSION_KERNEL_PLAN_ACTION_SETTLEMENT_RECORD_V3_SCHEMA: &str =
    "deepcode.session.plan-action-settlement-record.v3";
const SESSION_KERNEL_PUBLIC_REQUEST_SETTLEMENT_V3_SCHEMA: &str =
    "deepcode.session.public-request-settlement.v3";
const SESSION_KERNEL_PROJECTION_RECORD_V3_SCHEMA: &str = "deepcode.session.projection-record.v3";
const SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA: &str =
    "deepcode.session.kernel-host-projection-request.v2";
const SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA: &str =
    "deepcode.session.kernel-host-projection-reply.v2";
const HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA: &str = "deepcode.host.session-prior-events-page.v2";
const HOST_SESSION_PUBLIC_AGENT_EVENT_V2_SCHEMA: &str =
    "deepcode.host.session-public-agent-event.v2";
const HOST_SESSION_PUBLIC_TIMELINE_V2_SCHEMA: &str = "deepcode.host.session-public-timeline.v2";
pub(crate) const SESSION_KERNEL_PRIVATE_BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const MAX_STORE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_STORE_RECORD_BYTES: usize = SESSION_KERNEL_PRIVATE_BODY_LIMIT_BYTES;
const MAX_STORE_RECORDS: usize = 100_000;
const MAX_PRIOR_EVENTS_PAGE_COUNT_V2: usize = 128;
const MAX_PRIOR_EVENTS_PAGE_BYTES_V2: usize = 1024 * 1024;
const MAX_PRIOR_EVENTS_SINGLE_EVENT_PAGE_BYTES_V2: usize = 8 * 1024 * 1024;
const MAX_PRIOR_EVENTS_PROJECTION_BYTES_V2: usize = 12 * 1024 * 1024;
const MAX_PRIOR_EVENTS_PAGE_CACHE_V2: usize = 4;
const MAX_SAFE_INTEGER_V3: u64 = 9_007_199_254_740_991;
const MAX_CONTEXT_READ_WORK_AUTHORITY_OPERATIONS_V3: usize = 8_192;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SessionWorkAuthorityV3 {
    Plan {
        plan_revision: String,
    },
    ContextRead {
        operation_ids: Vec<String>,
        digest: String,
    },
}

pub(crate) fn decode_session_work_authority_v3(
    value: &Value,
) -> Result<SessionWorkAuthorityV3, HostV2StorageError> {
    let authority =
        serde_json::from_value::<SessionWorkAuthorityV3>(value.clone()).map_err(|_| {
            HostV2StorageError::invalid(
                "session_kernel_work_authority_invalid",
                "Session work authority must use the exact discriminated v3 envelope",
            )
        })?;
    validate_session_work_authority_v3(&authority)?;
    Ok(authority)
}

pub(crate) fn validate_session_work_authority_v3(
    authority: &SessionWorkAuthorityV3,
) -> Result<(), HostV2StorageError> {
    match authority {
        SessionWorkAuthorityV3::Plan { plan_revision } => {
            validate_bounded_identity(plan_revision, "workAuthority.planRevision", 512)
        }
        SessionWorkAuthorityV3::ContextRead {
            operation_ids,
            digest,
        } => {
            if operation_ids.is_empty()
                || operation_ids.len() > MAX_CONTEXT_READ_WORK_AUTHORITY_OPERATIONS_V3
            {
                return Err(work_authority_invalid());
            }
            let mut previous: Option<&str> = None;
            for operation_id in operation_ids {
                validate_bounded_identity(operation_id, "workAuthority.operationId", 512)?;
                if previous
                    .is_some_and(|prior| !utf16_lexicographically_before(prior, operation_id))
                {
                    return Err(work_authority_invalid());
                }
                previous = Some(operation_id);
            }
            validate_sha256_digest(digest, "workAuthority.digest")?;
            let expected = canonical_sha256(&json!({
                "kind": "contextRead",
                "operationIds": operation_ids,
            }))?;
            if digest != &expected {
                return Err(HostV2StorageError::invalid(
                    "session_kernel_work_authority_digest_mismatch",
                    "Context-read work authority digest does not match its exact operation identities",
                ));
            }
            Ok(())
        }
    }
}

fn utf16_lexicographically_before(left: &str, right: &str) -> bool {
    left.encode_utf16().cmp(right.encode_utf16()).is_lt()
}

fn work_authority_invalid() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "session_kernel_work_authority_invalid",
        "Session context-read work authority operation identities must be non-empty, unique, and canonically ordered",
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionKernelPersistenceRecordKindV3 {
    StoreHeader,
    Input,
    Plan,
    PlanDecision,
    Review,
    PlanActionSettlement,
    PublicRequest,
    PublicRequestSettled,
    Checkpoint,
    OperationResult,
    Projection,
    ProjectionDelivered,
    ToolContextSnapshot,
    ProviderTurnDispatch,
    ProviderTurnTerminal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionKernelPersistenceRecordV3 {
    pub(crate) schema_version: String,
    pub(crate) record_id: String,
    pub(crate) session_id: String,
    pub(crate) run_id: String,
    pub(crate) record_kind: SessionKernelPersistenceRecordKindV3,
    pub(crate) recorded_at: String,
    pub(crate) data: Value,
    pub(crate) record_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPublicRequestV3 {
    request_id: String,
    lane: String,
    intent: PersistedPublicRequestIntentV3,
    started_at: String,
    attempt_count: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPublicRequestIntentV3 {
    kind: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPublicRequestSettlementV3 {
    schema_version: String,
    request_id: String,
    request_digest: String,
    outcome_digest: String,
    checkpoint_ref: SessionProviderTurnRecordRefV3,
    projection_refs: Vec<SessionProviderTurnRecordRefV3>,
}

#[derive(Debug)]
struct PersistedPublicRequestIdentityV3 {
    request_id: String,
    request_digest: String,
}

#[derive(Debug)]
struct PersistedPublicRequestSettlementIdentityV3 {
    request_id: String,
    request_digest: String,
    outcome_digest: String,
    checkpoint_ref: SessionProviderTurnRecordRefV3,
    projection_refs: Vec<SessionProviderTurnRecordRefV3>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderAuthorityBindingV3 {
    pub(crate) run_id: String,
    pub(crate) input_id: String,
    pub(crate) control_epoch: u64,
    pub(crate) current_input_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) review_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) snapshot_high_water: Option<u64>,
    pub(crate) provider_profile_id: String,
    pub(crate) provider_profile_revision_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionProviderTurnRecordRefV3 {
    pub(crate) record_id: String,
    pub(crate) record_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionProviderTurnTerminalKindV3 {
    Completed,
    Failed,
    Cancelled,
    LimitExceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionProviderTurnDispatchDataV3 {
    schema_version: String,
    provider_turn_id: String,
    purpose: ProviderTracePurposeV1,
    authority_binding: SessionProviderAuthorityBindingV3,
    request_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelToolContextSnapshotDataV3 {
    schema_version: String,
    run_id: String,
    context_ref: ToolContextRefV2,
    tool_context: ToolContextBundleV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionProviderTraceRefV3 {
    terminal_digest: String,
    seal_digest: String,
    record_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionProviderCompletionTraceV1 {
    sealed: bool,
    seal_digest: String,
    terminal_digest: String,
    record_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionProviderCompletionReceiptV1 {
    schema_version: String,
    native_completion: Value,
    reasoning_present: bool,
    reasoning_transport: String,
    reasoning_digest: String,
    response_digest: String,
    trace: SessionProviderCompletionTraceV1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionProviderResultV3 {
    provider_profile_id: String,
    provider: String,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum SessionProviderOrderedItemV3 {
    Text {
        phase: SessionProviderTextPhaseV3,
        text: String,
    },
    ToolCall {
        index: u64,
        call_id: String,
        name: String,
        arguments: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SessionProviderTextPhaseV3 {
    Commentary,
    FinalAnswer,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionProviderTurnTerminalDataV3 {
    schema_version: String,
    provider_turn_id: String,
    dispatch_ref: SessionProviderTurnRecordRefV3,
    authority_binding: SessionProviderAuthorityBindingV3,
    terminal_kind: SessionProviderTurnTerminalKindV3,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completion: Option<SessionProviderCompletionReceiptV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_result: Option<SessionProviderResultV3>,
    trace_ref: SessionProviderTraceRefV3,
    ordered_items: Vec<SessionProviderOrderedItemV3>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum SessionKernelCheckpointCommitScopeV3 {
    Standalone,
    PublicRequestSettlement {
        request_id: String,
        request_digest: String,
        outcome_digest: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelCompactProviderReservationV3 {
    provider_turn_id: String,
    purpose: ProviderTracePurposeV1,
    target: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    plan_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remaining_tool_call_budget: Option<u64>,
    control_epoch: u64,
    context_ref: ToolContextRefV2,
    fact_projection: Value,
    context_assembly: Value,
    started_at: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancellation_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dispatch_ref: Option<SessionProviderTurnRecordRefV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_ref: Option<SessionProviderTurnRecordRefV3>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelCompactToolContextV3 {
    current_ref: ToolContextRefV2,
    refresh_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_context_ref: Option<ToolContextRefV2>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelCompactAuthorityV3 {
    run_id: String,
    workspace_binding_digest: String,
    control_epoch: u64,
    current_input_id: String,
    current_input_ref: SessionProviderTurnRecordRefV3,
    provider_profile_id: String,
    provider_profile_revision_digest: String,
    tool_context: SessionKernelCompactToolContextV3,
    #[serde(skip_serializing_if = "Option::is_none")]
    work_authority: Option<SessionWorkAuthorityV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plan_ref: Option<SessionProviderTurnRecordRefV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plan_decision_ref: Option<SessionProviderTurnRecordRefV3>,
    previews: Value,
    operation_plan_action_bindings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelCompactCursorV3 {
    input_refs: Vec<SessionProviderTurnRecordRefV3>,
    input_history_omitted_count: u64,
    provider_terminal_refs: Vec<SessionProviderTurnRecordRefV3>,
    provider_outcome_history_omitted_count: u64,
    review_facts_after_ledger_sequence: u64,
    after_ledger_sequence: u64,
    snapshot_high_water: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelCompactActiveV3 {
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_epoch_input_ref: Option<SessionProviderTurnRecordRefV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_wait: Option<Value>,
    pending_guidance: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_reservation: Option<SessionKernelCompactProviderReservationV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_queue: Option<Value>,
    fact_barriers: Value,
    public_requests: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_cancellation: Option<Value>,
    kernel_wake_hint: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelCompactRefsV3 {
    #[serde(skip_serializing_if = "Option::is_none")]
    review: Option<SessionProviderTurnRecordRefV3>,
    plan_action_settlements: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionFinalAnswerBindingV3 {
    input_id: String,
    control_epoch: u64,
    work_authority: SessionWorkAuthorityV3,
    review_revision: u64,
    snapshot_high_water: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelCompactFinalAnswerV3 {
    status: String,
    binding: SessionFinalAnswerBindingV3,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stale_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelCompactCheckpointV3 {
    schema_version: String,
    checkpoint_revision: u64,
    saved_at: String,
    parent_ref: Option<SessionProviderTurnRecordRefV3>,
    commit_scope: SessionKernelCheckpointCommitScopeV3,
    authority: SessionKernelCompactAuthorityV3,
    cursor: SessionKernelCompactCursorV3,
    active: SessionKernelCompactActiveV3,
    refs: SessionKernelCompactRefsV3,
    #[serde(skip_serializing_if = "Option::is_none")]
    final_answer: Option<SessionKernelCompactFinalAnswerV3>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelProjectionRecordV3 {
    schema_version: String,
    commit_scope: SessionKernelCheckpointCommitScopeV3,
    event: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelReviewRecordV3 {
    schema_version: String,
    review: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionKernelPersistenceAppendRequestV2 {
    schema_version: String,
    session_id: String,
    run_id: String,
    record: SessionKernelPersistenceRecordV3,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionKernelPersistenceListReplyV2 {
    schema_version: &'static str,
    session_id: String,
    run_id: String,
    records: Vec<SessionKernelPersistenceRecordV3>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionKernelPersistenceAppendReplyV2 {
    schema_version: &'static str,
    session_id: String,
    run_id: String,
    record_id: String,
    record_digest: String,
    replayed: bool,
}

#[derive(Clone)]
pub(crate) struct SessionKernelV2Store {
    sessions_dir: Arc<PathBuf>,
    active_runs: HostActiveRunBrokerV2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionProviderTurnAdmissionV2 {
    pub(crate) provider_turn_id: String,
    pub(crate) purpose: ProviderTracePurposeV1,
    pub(crate) control_epoch: u64,
    pub(crate) current_input_id: String,
    pub(crate) current_input_digest: String,
    pub(crate) provider_profile_id: String,
    pub(crate) provider_profile_revision: String,
    pub(crate) plan_revision: Option<String>,
    pub(crate) work_authority: Option<SessionWorkAuthorityV3>,
    pub(crate) remaining_tool_call_budget: Option<u64>,
    pub(crate) review_revision: Option<u64>,
    pub(crate) snapshot_high_water: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionProviderDispatchBindingV2 {
    pub(crate) provider_turn_id: String,
    pub(crate) run_id: String,
    pub(crate) control_epoch: u64,
    pub(crate) current_input_id: String,
    pub(crate) current_input_digest: String,
    pub(crate) purpose: ProviderTracePurposeV1,
    pub(crate) plan_revision: Option<String>,
    pub(crate) work_authority: Option<SessionWorkAuthorityV3>,
    pub(crate) review_revision: Option<u64>,
    pub(crate) snapshot_high_water: Option<u64>,
}

pub(crate) struct SessionProviderTurnDispatchCommitV3 {
    pub(crate) trace: ProviderTraceWriterV1,
    pub(crate) receipt: SessionProviderTurnDispatchReceiptV3,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionProviderTurnDispatchReceiptV3 {
    session_id: String,
    run_id: String,
    provider_turn_id: String,
    purpose: ProviderTracePurposeV1,
    authority_binding: SessionProviderAuthorityBindingV3,
    dispatch_ref: SessionProviderTurnRecordRefV3,
    request_digest: String,
}

pub(crate) struct SessionProviderTurnTerminalCommitV3 {
    pub(crate) terminal_kind: SessionProviderTurnTerminalKindV3,
    pub(crate) reason_code: Option<String>,
    pub(crate) response_digest: Option<String>,
    pub(crate) completion: Option<Value>,
    pub(crate) provider_result: Option<Value>,
    pub(crate) ordered_items: Vec<Value>,
}

impl SessionKernelV2Store {
    pub(crate) fn new(sessions_dir: PathBuf, active_runs: HostActiveRunBrokerV2) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            active_runs,
        }
    }

    fn list(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<Vec<SessionKernelPersistenceRecordV3>, HostV2StorageError> {
        self.active_runs
            .authorize_session_run_transport(session_id, run_id, capability)?;
        let path = self.run_store_path(session_id, run_id)?;
        with_storage_path_lock(&path, || read_run_store(&path, session_id, run_id))
    }

    pub(crate) fn persist_tool_context_snapshot(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        tool_context: &ToolContextBundleV2,
    ) -> Result<SessionProviderTurnRecordRefV3, HostV2StorageError> {
        tool_context.validate().map_err(|_| {
            HostV2StorageError::invalid(
                "session_kernel_tool_context_snapshot_invalid",
                "Kernel ToolContext snapshot failed strict v2 validation",
            )
        })?;
        let snapshot_data = SessionKernelToolContextSnapshotDataV3 {
            schema_version: SESSION_KERNEL_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA.to_string(),
            run_id: run_id.to_string(),
            context_ref: tool_context.context_ref(),
            tool_context: tool_context.clone(),
        };
        let snapshot_value = serde_json::to_value(&snapshot_data).map_err(|error| {
            HostV2StorageError::invalid(
                "session_kernel_tool_context_snapshot_invalid",
                format!("encode Kernel ToolContext snapshot: {error}"),
            )
        })?;
        reject_transport_capabilities(&snapshot_value)?;
        let path = self.run_store_path(session_id, run_id)?;
        self.active_runs
            .with_authorized_session_run_transport_storage(
                session_id,
                run_id,
                capability,
                &path,
                || {
                    let mut records = read_run_store(&path, session_id, run_id)?;
                    if records.is_empty() {
                        let header = create_daemon_record(
                            session_id,
                            run_id,
                            format!("session-kernel-v3:{run_id}:store"),
                            SessionKernelPersistenceRecordKindV3::StoreHeader,
                            crate::utils::now_rfc3339_text(),
                            json!({
                                "schemaVersion": SESSION_KERNEL_PERSISTENCE_V3_SCHEMA
                            }),
                        )?;
                        append_daemon_record_locked(&path, &records, &header)?;
                        records.push(header);
                    }
                    let record_id = tool_context_snapshot_record_id(
                        run_id,
                        snapshot_data.context_ref.context_digest.as_str(),
                    );
                    if let Some(existing) =
                        records.iter().find(|record| record.record_id == record_id)
                    {
                        if existing.record_kind
                            != SessionKernelPersistenceRecordKindV3::ToolContextSnapshot
                        {
                            return Err(HostV2StorageError::conflict(
                                "session_kernel_tool_context_snapshot_identity_conflict",
                                "ToolContext snapshot identity belongs to another record kind",
                            ));
                        }
                        validate_tool_context_snapshot_record(existing, run_id)?;
                        if existing.data != snapshot_value {
                            return Err(HostV2StorageError::conflict(
                                "session_kernel_tool_context_snapshot_replay_conflict",
                                "ToolContext snapshot replay changed immutable snapshot data",
                            ));
                        }
                        return Ok(SessionProviderTurnRecordRefV3 {
                            record_id: existing.record_id.clone(),
                            record_digest: existing.record_digest.clone(),
                        });
                    }
                    let snapshot = create_daemon_record(
                        session_id,
                        run_id,
                        record_id,
                        SessionKernelPersistenceRecordKindV3::ToolContextSnapshot,
                        crate::utils::now_rfc3339_text(),
                        snapshot_value.clone(),
                    )?;
                    append_daemon_record_locked(&path, &records, &snapshot)?;
                    Ok(SessionProviderTurnRecordRefV3 {
                        record_id: snapshot.record_id,
                        record_digest: snapshot.record_digest,
                    })
                },
            )
    }

    pub(crate) fn persist_tool_context_snapshot_for_capability(
        &self,
        run_id: &str,
        capability: &RunCapabilityV2,
        tool_context: &ToolContextBundleV2,
    ) -> Result<SessionProviderTurnRecordRefV3, HostV2StorageError> {
        let active = self
            .active_runs
            .resolve_session_run_transport(run_id, capability)?;
        self.persist_tool_context_snapshot(&active.session_id, run_id, capability, tool_context)
    }

    pub(crate) fn require_tool_context_snapshot_for_capability(
        &self,
        run_id: &str,
        capability: &RunCapabilityV2,
        context_ref: &ToolContextRefV2,
    ) -> Result<SessionProviderTurnRecordRefV3, HostV2StorageError> {
        let active = self
            .active_runs
            .resolve_session_run_transport(run_id, capability)?;
        let records = self.list(&active.session_id, run_id, capability)?;
        let record_id =
            tool_context_snapshot_record_id(run_id, context_ref.context_digest.as_str());
        let record = records
            .iter()
            .find(|record| record.record_id == record_id)
            .ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_tool_context_snapshot_missing",
                    "Kernel reported a current ToolContext without its immutable snapshot",
                )
            })?;
        let data = validate_tool_context_snapshot_record(record, run_id)?;
        if &data.context_ref != context_ref {
            return Err(HostV2StorageError::conflict(
                "session_kernel_tool_context_snapshot_ref_conflict",
                "Current ToolContext reference conflicts with its immutable snapshot",
            ));
        }
        Ok(SessionProviderTurnRecordRefV3 {
            record_id: record.record_id.clone(),
            record_digest: record.record_digest.clone(),
        })
    }

    pub(crate) fn provider_turn_admission(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        provider_turn_id: &str,
    ) -> Result<SessionProviderTurnAdmissionV2, HostV2StorageError> {
        validate_bounded_identity(provider_turn_id, "providerTurnId", 512)?;
        let records = self.list(session_id, run_id, capability)?;
        provider_turn_admission_from_records(&records, run_id, provider_turn_id)
    }

    pub(crate) fn commit_provider_dispatch(
        &self,
        capability: &RunCapabilityV2,
        expected_admission: &SessionProviderTurnAdmissionV2,
        exact_request_binding: &SessionProviderDispatchBindingV2,
        trace_store: &ProviderTraceStoreV1,
        trace_identity: ProviderTraceIdentityV1,
        exact_request_body: &[u8],
    ) -> Result<SessionProviderTurnDispatchCommitV3, ProviderTraceErrorV1> {
        let session_id = trace_identity.session_id.clone();
        let run_id = trace_identity.run_id.clone();
        let path = self.run_store_path(&session_id, &run_id)?;
        self.active_runs
            .with_authorized_session_run_transport_storage(
                &session_id,
                &run_id,
                capability,
                &path,
                || {
                    let records =
                        read_run_store(&path, &trace_identity.session_id, &trace_identity.run_id)?;
                    let current_admission = provider_turn_admission_from_records(
                        &records,
                        &trace_identity.run_id,
                        &trace_identity.provider_turn_id,
                    )?;
                    if &current_admission != expected_admission
                        || current_admission.provider_turn_id != trace_identity.provider_turn_id
                        || current_admission.control_epoch != trace_identity.control_epoch
                        || current_admission.current_input_id != trace_identity.user_turn_id
                        || current_admission.provider_profile_id != trace_identity.profile_id
                        || current_admission.provider_profile_revision
                            != trace_identity.profile_revision
                        || exact_request_binding.provider_turn_id
                            != current_admission.provider_turn_id
                        || exact_request_binding.run_id != trace_identity.run_id
                        || exact_request_binding.control_epoch != current_admission.control_epoch
                        || exact_request_binding.current_input_id
                            != current_admission.current_input_id
                        || exact_request_binding.current_input_digest
                            != current_admission.current_input_digest
                        || exact_request_binding.purpose != current_admission.purpose
                        || trace_identity.purpose != current_admission.purpose
                        || exact_request_binding.purpose != trace_identity.purpose
                        || exact_request_binding.plan_revision != current_admission.plan_revision
                        || exact_request_binding.work_authority
                            != current_admission.work_authority
                        || (exact_request_binding.purpose == ProviderTracePurposeV1::FinalAnswer
                            && (exact_request_binding.review_revision
                                != current_admission.review_revision
                                || exact_request_binding.snapshot_high_water
                                    != current_admission.snapshot_high_water))
                        || (exact_request_binding.purpose != ProviderTracePurposeV1::FinalAnswer
                            && (exact_request_binding.review_revision.is_some()
                                || exact_request_binding.snapshot_high_water.is_some()))
                    {
                        return Err(provider_dispatch_stale());
                    }
                    let authority_binding = SessionProviderAuthorityBindingV3 {
                        run_id: trace_identity.run_id.clone(),
                        input_id: current_admission.current_input_id.clone(),
                        control_epoch: current_admission.control_epoch,
                        current_input_digest: current_admission.current_input_digest.clone(),
                        plan_revision: exact_request_binding.plan_revision.clone(),
                        review_revision: exact_request_binding.review_revision,
                        snapshot_high_water: exact_request_binding.snapshot_high_water,
                        provider_profile_id: current_admission.provider_profile_id.clone(),
                        provider_profile_revision_digest: current_admission
                            .provider_profile_revision
                            .clone(),
                    };
                    validate_provider_authority_binding(
                        &authority_binding,
                        trace_identity.purpose,
                    )?;
                    let request_digest =
                        crate::host_v2_storage::sha256_prefixed(exact_request_body);
                    let dispatch_data = SessionProviderTurnDispatchDataV3 {
                        schema_version: SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA.to_string(),
                        provider_turn_id: trace_identity.provider_turn_id.clone(),
                        purpose: trace_identity.purpose,
                        authority_binding: authority_binding.clone(),
                        request_digest,
                    };
                    let dispatch_record = provider_turn_dispatch_record(
                        &trace_identity.session_id,
                        &trace_identity.run_id,
                        dispatch_data.clone(),
                        crate::utils::now_rfc3339_text(),
                    )?;
                    if let Some(existing_dispatch) = records.iter().find(|record| {
                        record.record_kind
                            == SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch
                            && record
                                .data
                                .get("providerTurnId")
                                .and_then(Value::as_str)
                                == Some(trace_identity.provider_turn_id.as_str())
                    }) {
                        let existing_data =
                            validate_provider_turn_dispatch_record(existing_dispatch, &run_id)?;
                        let expected_data = serde_json::to_value(&dispatch_data).map_err(|error| {
                            HostV2StorageError::invalid(
                                "provider_dispatch_record_invalid",
                                format!("encode Provider dispatch record data: {error}"),
                            )
                        })?;
                        if existing_dispatch.data != expected_data {
                            return Err(HostV2StorageError::conflict(
                                "provider_dispatch_replay_conflict",
                                "Provider dispatch replay changed immutable dispatch data",
                            ));
                        }
                        let receipt = SessionProviderTurnDispatchReceiptV3 {
                            session_id: session_id.clone(),
                            run_id: run_id.clone(),
                            provider_turn_id: existing_data.provider_turn_id,
                            purpose: existing_data.purpose,
                            authority_binding: existing_data.authority_binding,
                            dispatch_ref: SessionProviderTurnRecordRefV3 {
                                record_id: existing_dispatch.record_id.clone(),
                                record_digest: existing_dispatch.record_digest.clone(),
                            },
                            request_digest: existing_data.request_digest,
                        };
                        let terminal_record_id = provider_turn_terminal_record_id(
                            &run_id,
                            &trace_identity.provider_turn_id,
                        );
                        if !records
                            .iter()
                            .any(|record| record.record_id == terminal_record_id)
                        {
                            let recovery = trace_store
                                .verified_terminal_recovery(
                                    &session_id,
                                    &trace_identity.provider_turn_id,
                                )
                                .map_err(|error| {
                                    HostV2StorageError::conflict(
                                        "provider_dispatch_unresolved_trace",
                                        format!(
                                            "Provider dispatch is durable but its terminal cannot be reconstructed: {}",
                                            error.message
                                        ),
                                    )
                                })?;
                            let terminal = provider_terminal_commit_from_recovery(&recovery)?;
                            validate_provider_terminal_trace_binding(
                                &receipt,
                                &recovery.metadata,
                                terminal.terminal_kind,
                            )?;
                            let terminal_data = provider_turn_terminal_data(
                                &receipt,
                                &recovery.metadata,
                                terminal,
                            )?;
                            let terminal_record = provider_turn_terminal_record(
                                &session_id,
                                &run_id,
                                terminal_data,
                                crate::utils::now_rfc3339_text(),
                            )?;
                            append_daemon_record_locked(
                                &path,
                                &records,
                                &terminal_record,
                            )?;
                        }
                        return Err(HostV2StorageError::conflict(
                            "provider_dispatch_already_committed",
                            "Provider turn already has a durable dispatch and cannot be sent again",
                        ));
                    }
                    let mut trace = trace_store
                        .begin_or_reopen_exact_request_only_turn(
                            trace_identity,
                            exact_request_body,
                        )
                        .map_err(|error| HostV2StorageError::io(error.code, error.message))?;
                    let append_result = append_daemon_record_locked(
                        &path,
                        &records,
                        &dispatch_record,
                    );
                    if let Err(error) = append_result {
                        let _ = trace.finish(ProviderTraceTerminalV1 {
                            kind: ProviderTraceTerminalKindV1::Failed,
                            reason_code: Some(
                                "provider_dispatch_persistence_failed".to_string(),
                            ),
                        });
                        return Err(error);
                    }
                    Ok(SessionProviderTurnDispatchCommitV3 {
                        trace,
                        receipt: SessionProviderTurnDispatchReceiptV3 {
                            session_id: session_id.clone(),
                            run_id: run_id.clone(),
                            provider_turn_id: dispatch_data.provider_turn_id,
                            purpose: dispatch_data.purpose,
                            authority_binding,
                            dispatch_ref: SessionProviderTurnRecordRefV3 {
                                record_id: dispatch_record.record_id,
                                record_digest: dispatch_record.record_digest,
                            },
                            request_digest: dispatch_data.request_digest,
                        },
                    })
                },
            )
            .map_err(ProviderTraceErrorV1::from)
    }

    pub(crate) fn commit_provider_terminal(
        &self,
        dispatch: &SessionProviderTurnDispatchReceiptV3,
        trace: &ProviderTraceMetadataV1,
        terminal: SessionProviderTurnTerminalCommitV3,
    ) -> Result<SessionProviderTurnRecordRefV3, ProviderTraceErrorV1> {
        validate_provider_terminal_trace_binding(dispatch, trace, terminal.terminal_kind)
            .map_err(ProviderTraceErrorV1::from)?;
        let path = self
            .run_store_path(&dispatch.session_id, &dispatch.run_id)
            .map_err(ProviderTraceErrorV1::from)?;
        with_storage_path_lock(&path, || {
            let records = read_run_store(&path, &dispatch.session_id, &dispatch.run_id)?;
            let durable_dispatch = records
                .iter()
                .find(|record| record.record_id == dispatch.dispatch_ref.record_id)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "provider_terminal_dispatch_missing",
                        "Provider terminal has no matching durable dispatch",
                    )
                })?;
            if durable_dispatch.record_kind
                != SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch
                || durable_dispatch.record_digest != dispatch.dispatch_ref.record_digest
            {
                return Err(HostV2StorageError::conflict(
                    "provider_terminal_dispatch_conflict",
                    "Provider terminal dispatch reference conflicts with durable history",
                ));
            }
            let durable_dispatch_data =
                validate_provider_turn_dispatch_record(durable_dispatch, &dispatch.run_id)?;
            if durable_dispatch_data.provider_turn_id != dispatch.provider_turn_id
                || durable_dispatch_data.purpose != dispatch.purpose
                || durable_dispatch_data.authority_binding != dispatch.authority_binding
                || durable_dispatch_data.request_digest != dispatch.request_digest
            {
                return Err(HostV2StorageError::conflict(
                    "provider_terminal_dispatch_conflict",
                    "Provider terminal receipt does not match the exact durable dispatch data",
                ));
            }
            let terminal_data = provider_turn_terminal_data(dispatch, trace, terminal)?;
            let expected_terminal_data = serde_json::to_value(&terminal_data).map_err(|error| {
                HostV2StorageError::invalid(
                    "provider_terminal_record_invalid",
                    format!("encode Provider terminal record data: {error}"),
                )
            })?;
            let terminal_record_id =
                provider_turn_terminal_record_id(&dispatch.run_id, &dispatch.provider_turn_id);
            if let Some(existing) = records
                .iter()
                .find(|record| record.record_id == terminal_record_id)
            {
                if existing.record_kind
                    != SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal
                {
                    return Err(HostV2StorageError::conflict(
                        "provider_terminal_identity_conflict",
                        "Provider terminal deterministic identity belongs to another record kind",
                    ));
                }
                validate_provider_turn_terminal_record(existing, &dispatch.run_id)?;
                if existing.data != expected_terminal_data {
                    return Err(HostV2StorageError::conflict(
                        "provider_terminal_replay_conflict",
                        "Provider terminal replay changed immutable terminal data",
                    ));
                }
                return Ok(SessionProviderTurnRecordRefV3 {
                    record_id: existing.record_id.clone(),
                    record_digest: existing.record_digest.clone(),
                });
            }
            let terminal_record = provider_turn_terminal_record(
                &dispatch.session_id,
                &dispatch.run_id,
                terminal_data,
                crate::utils::now_rfc3339_text(),
            )?;
            append_daemon_record_locked(&path, &records, &terminal_record)?;
            Ok(SessionProviderTurnRecordRefV3 {
                record_id: terminal_record.record_id,
                record_digest: terminal_record.record_digest,
            })
        })
        .map_err(ProviderTraceErrorV1::from)
    }

    fn append(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        request: SessionKernelPersistenceAppendRequestV2,
    ) -> Result<SessionKernelPersistenceAppendReplyV2, HostV2StorageError> {
        self.active_runs
            .authorize_session_run_transport(session_id, run_id, capability)?;
        if request.schema_version != SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA {
            return Err(HostV2StorageError::invalid(
                "session_kernel_persistence_schema_unsupported",
                "Session Kernel persistence append request has an unsupported schema",
            ));
        }
        if request.session_id != session_id
            || request.run_id != run_id
            || request.record.session_id != session_id
            || request.record.run_id != run_id
        {
            return Err(HostV2StorageError::invalid(
                "session_kernel_persistence_store_identity_mismatch",
                "Session Kernel persistence identities do not match the route",
            ));
        }
        if matches!(
            request.record.record_kind,
            SessionKernelPersistenceRecordKindV3::ToolContextSnapshot
                | SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch
                | SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal
        ) {
            return Err(HostV2StorageError::unauthorized(
                "session_kernel_daemon_record_forbidden",
                "ToolContext snapshots and Provider-turn authority records are Daemon-only",
            ));
        }
        validate_persistence_record(&request.record, session_id, run_id)?;
        let path = self.run_store_path(session_id, run_id)?;
        with_storage_path_lock(&path, || {
            let records = read_run_store(&path, session_id, run_id)?;
            if let Some(existing) = records
                .iter()
                .find(|record| record.record_id == request.record.record_id)
            {
                if existing.record_digest != request.record.record_digest {
                    return Err(HostV2StorageError::conflict(
                        "session_kernel_persistence_identity_conflict",
                        "Session Kernel persistence recordId has different durable content",
                    ));
                }
                return Ok(SessionKernelPersistenceAppendReplyV2 {
                    schema_version: SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA,
                    session_id: session_id.to_string(),
                    run_id: run_id.to_string(),
                    record_id: existing.record_id.clone(),
                    record_digest: existing.record_digest.clone(),
                    replayed: true,
                });
            }
            if records.is_empty() {
                require_store_header(&request.record, run_id)?;
            } else if request.record.record_kind
                == SessionKernelPersistenceRecordKindV3::StoreHeader
            {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_persistence_header_conflict",
                    "Session Kernel persistence stream already has its immutable header",
                ));
            }
            validate_public_request_history(
                records.iter().chain(std::iter::once(&request.record)),
            )?;
            validate_checkpoint_authority_append(&records, &request.record)?;
            let value = serde_json::to_value(&request.record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_persistence_record_invalid",
                    format!("encode Session Kernel persistence record: {error}"),
                )
            })?;
            preflight_store_append(&path, records.len(), &value)?;
            append_json_line_durable(&path, &value)?;
            Ok(SessionKernelPersistenceAppendReplyV2 {
                schema_version: SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA,
                session_id: session_id.to_string(),
                run_id: run_id.to_string(),
                record_id: request.record.record_id,
                record_digest: request.record.record_digest,
                replayed: false,
            })
        })
    }

    fn get_record(
        &self,
        session_id: &str,
        run_id: &str,
        record_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<SessionKernelPersistenceRecordV3, HostV2StorageError> {
        self.active_runs
            .authorize_session_run_transport(session_id, run_id, capability)?;
        validate_bounded_identity(record_id, "recordId", 128 * 1024)?;
        let path = self.run_store_path(session_id, run_id)?;
        with_storage_path_lock(&path, || {
            read_run_store(&path, session_id, run_id)?
                .into_iter()
                .find(|record| record.record_id == record_id)
                .ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "session_kernel_persistence_record_not_found",
                        "Session Kernel persistence record was not found",
                    )
                })
        })
    }

    pub(crate) fn resolve_operation_result(
        &self,
        session_id: &str,
        run_id: &str,
        operation_request_id: &str,
        record_id: &str,
        record_digest: &str,
        result_digest: &str,
        capability: &RunCapabilityV2,
    ) -> Result<Value, HostV2StorageError> {
        validate_bounded_identity(operation_request_id, "operationRequestId", 512)?;
        validate_bounded_identity(record_digest, "recordDigest", 512)?;
        validate_bounded_identity(result_digest, "resultDigest", 512)?;
        let record = self.get_record(session_id, run_id, record_id, capability)?;
        if record.record_kind != SessionKernelPersistenceRecordKindV3::OperationResult
            || record.record_digest != record_digest
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_operation_result_reference_conflict",
                "Stored Session operation result does not match its immutable reference",
            ));
        }
        let data = record.data.as_object().ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_operation_result_reference_conflict",
                "Stored Session operation result has an invalid durable envelope",
            )
        })?;
        if data.get("operationRequestId").and_then(Value::as_str) != Some(operation_request_id)
            || data.get("resultDigest").and_then(Value::as_str) != Some(result_digest)
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_operation_result_reference_conflict",
                "Stored Session operation result belongs to another operation or digest",
            ));
        }
        data.get("result").cloned().ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_operation_result_reference_conflict",
                "Stored Session operation result has no durable result payload",
            )
        })
    }

    /// Reads the deterministic Session operation-result record during
    /// Host-owned startup reconciliation. This intentionally bypasses the
    /// process-private Run transport capability because a restarted Host has
    /// not rebound or resumed the Session bridge yet. The full persistence
    /// stream, record digest, deterministic record identity, result digest,
    /// and Session/Run identities are still verified before any value is
    /// returned.
    pub(crate) fn recover_operation_result_for_host(
        &self,
        session_id: &str,
        run_id: &str,
        operation_request_id: &str,
    ) -> Result<Option<Value>, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        validate_bounded_identity(operation_request_id, "operationRequestId", 512)?;
        let record_id =
            format!("session-kernel-v3:{run_id}:operation-result:{operation_request_id}");
        let path = self.run_store_path(session_id, run_id)?;
        with_storage_path_lock(&path, || {
            let Some(record) = read_run_store(&path, session_id, run_id)?
                .into_iter()
                .find(|record| record.record_id == record_id)
            else {
                return Ok(None);
            };
            if record.record_kind != SessionKernelPersistenceRecordKindV3::OperationResult {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_operation_result_identity_conflict",
                    "Deterministic operation-result identity is bound to another record kind",
                ));
            }
            let data = record.data.as_object().ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_operation_result_invalid",
                    "Recovered Session operation result has an invalid durable envelope",
                )
            })?;
            let expected_fields = [
                "schemaVersion",
                "operationRequestId",
                "resultDigest",
                "result",
            ];
            if data.len() != expected_fields.len()
                || expected_fields
                    .iter()
                    .any(|field| !data.contains_key(*field))
                || data.get("schemaVersion").and_then(Value::as_str)
                    != Some(SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA)
                || data.get("operationRequestId").and_then(Value::as_str)
                    != Some(operation_request_id)
            {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_operation_result_identity_conflict",
                    "Recovered Session operation result changed its exact durable envelope",
                ));
            }
            let result_digest = data
                .get("resultDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "session_kernel_operation_result_invalid",
                        "Recovered Session operation result has no result digest",
                    )
                })?;
            validate_sha256_digest(result_digest, "resultDigest")?;
            let result = data.get("result").ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_operation_result_invalid",
                    "Recovered Session operation result has no durable result payload",
                )
            })?;
            if canonical_sha256(result)? != result_digest {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_operation_result_digest_mismatch",
                    "Recovered Session operation result failed its inner result digest",
                ));
            }
            Ok(Some(result.clone()))
        })
    }

    fn run_store_path(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<PathBuf, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        let path_component = format!("{}.jsonl", sha256_path_component(run_id));
        let legacy_path = self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join(&path_component);
        match fs::metadata(&legacy_path) {
            Ok(_) => {
                return Err(HostV2StorageError::conflict(
                    "UnsupportedHistorySchema",
                    "Active Session persistence v2 cannot be resumed or extended by v3",
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(HostV2StorageError::io(
                    "session_kernel_legacy_history_inspection_failed",
                    format!("inspect legacy active Session persistence: {error}"),
                ))
            }
        }
        Ok(self
            .sessions_dir
            .join(session_id)
            .join("kernel-v3")
            .join(path_component))
    }
}

fn provider_turn_dispatch_record_id(run_id: &str, provider_turn_id: &str) -> String {
    format!("session-kernel-v3:{run_id}:provider-turn:{provider_turn_id}:dispatch")
}

fn provider_turn_terminal_record_id(run_id: &str, provider_turn_id: &str) -> String {
    format!("session-kernel-v3:{run_id}:provider-turn:{provider_turn_id}:terminal")
}

fn tool_context_snapshot_record_id(run_id: &str, context_digest: &str) -> String {
    format!("session-kernel-v3:{run_id}:tool-context:{context_digest}")
}

fn provider_turn_dispatch_record(
    session_id: &str,
    run_id: &str,
    data: SessionProviderTurnDispatchDataV3,
    recorded_at: String,
) -> Result<SessionKernelPersistenceRecordV3, HostV2StorageError> {
    create_daemon_record(
        session_id,
        run_id,
        provider_turn_dispatch_record_id(run_id, &data.provider_turn_id),
        SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch,
        recorded_at,
        serde_json::to_value(data).map_err(|error| {
            HostV2StorageError::invalid(
                "provider_dispatch_record_invalid",
                format!("encode Provider dispatch record: {error}"),
            )
        })?,
    )
}

fn provider_turn_terminal_record(
    session_id: &str,
    run_id: &str,
    data: SessionProviderTurnTerminalDataV3,
    recorded_at: String,
) -> Result<SessionKernelPersistenceRecordV3, HostV2StorageError> {
    create_daemon_record(
        session_id,
        run_id,
        provider_turn_terminal_record_id(run_id, &data.provider_turn_id),
        SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal,
        recorded_at,
        serde_json::to_value(data).map_err(|error| {
            HostV2StorageError::invalid(
                "provider_terminal_record_invalid",
                format!("encode Provider terminal record: {error}"),
            )
        })?,
    )
}

fn create_daemon_record(
    session_id: &str,
    run_id: &str,
    record_id: String,
    record_kind: SessionKernelPersistenceRecordKindV3,
    recorded_at: String,
    data: Value,
) -> Result<SessionKernelPersistenceRecordV3, HostV2StorageError> {
    let without_digest = json!({
        "schemaVersion": SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA,
        "recordId": record_id,
        "sessionId": session_id,
        "runId": run_id,
        "recordKind": record_kind,
        "recordedAt": recorded_at,
        "data": data,
    });
    let record_digest = canonical_sha256(&without_digest)?;
    serde_json::from_value(value_with_field(
        without_digest,
        "recordDigest",
        json!(record_digest),
    ))
    .map_err(|error| {
        HostV2StorageError::invalid(
            "session_kernel_persistence_record_invalid",
            format!("construct Daemon persistence record: {error}"),
        )
    })
}

fn append_daemon_record_locked(
    path: &FsPath,
    records: &[SessionKernelPersistenceRecordV3],
    record: &SessionKernelPersistenceRecordV3,
) -> Result<(), HostV2StorageError> {
    if !matches!(
        record.record_kind,
        SessionKernelPersistenceRecordKindV3::StoreHeader
            | SessionKernelPersistenceRecordKindV3::ToolContextSnapshot
            | SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch
            | SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal
    ) {
        return Err(HostV2StorageError::unauthorized(
            "session_kernel_daemon_record_kind_forbidden",
            "The Daemon-only append boundary does not accept this record kind",
        ));
    }
    validate_persistence_record(record, &record.session_id, &record.run_id)?;
    if let Some(existing) = records
        .iter()
        .find(|candidate| candidate.record_id == record.record_id)
    {
        return if existing.record_digest == record.record_digest {
            Ok(())
        } else {
            Err(HostV2StorageError::conflict(
                "session_kernel_persistence_identity_conflict",
                "Daemon Provider record identity changed immutable content",
            ))
        };
    }
    if records.is_empty() {
        require_store_header(record, &record.run_id)?;
    } else if record.record_kind == SessionKernelPersistenceRecordKindV3::StoreHeader {
        return Err(HostV2StorageError::conflict(
            "session_kernel_persistence_header_conflict",
            "Session Kernel persistence stream already has its immutable header",
        ));
    }
    validate_tool_context_snapshot_history(records.iter().chain(std::iter::once(record)))?;
    validate_provider_turn_history(records.iter().chain(std::iter::once(record)))?;
    let value = serde_json::to_value(record).map_err(|error| {
        HostV2StorageError::invalid(
            "session_kernel_persistence_record_invalid",
            format!("encode Daemon persistence record: {error}"),
        )
    })?;
    preflight_store_append(path, records.len(), &value)?;
    append_json_line_durable(path, &value)
}

fn provider_turn_terminal_data(
    dispatch: &SessionProviderTurnDispatchReceiptV3,
    trace: &ProviderTraceMetadataV1,
    terminal: SessionProviderTurnTerminalCommitV3,
) -> Result<SessionProviderTurnTerminalDataV3, HostV2StorageError> {
    let completion = terminal
        .completion
        .map(|value| {
            serde_json::from_value::<SessionProviderCompletionReceiptV1>(value).map_err(|_| {
                HostV2StorageError::invalid(
                    "provider_terminal_completion_invalid",
                    "Provider completed terminal has an invalid completion receipt",
                )
            })
        })
        .transpose()?;
    let provider_result = terminal
        .provider_result
        .map(|value| {
            serde_json::from_value::<SessionProviderResultV3>(value).map_err(|_| {
                HostV2StorageError::invalid(
                    "provider_terminal_result_invalid",
                    "Provider completed terminal has invalid safe result metadata",
                )
            })
        })
        .transpose()?;
    let ordered_items = terminal
        .ordered_items
        .into_iter()
        .map(|value| {
            serde_json::from_value::<SessionProviderOrderedItemV3>(value).map_err(|_| {
                HostV2StorageError::invalid(
                    "provider_terminal_ordered_items_invalid",
                    "Provider completed terminal has an invalid ordered item",
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let data = SessionProviderTurnTerminalDataV3 {
        schema_version: SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA.to_string(),
        provider_turn_id: dispatch.provider_turn_id.clone(),
        dispatch_ref: dispatch.dispatch_ref.clone(),
        authority_binding: dispatch.authority_binding.clone(),
        terminal_kind: terminal.terminal_kind,
        reason_code: terminal.reason_code,
        response_digest: terminal.response_digest,
        completion,
        provider_result,
        trace_ref: SessionProviderTraceRefV3 {
            terminal_digest: trace.terminal_digest.clone(),
            seal_digest: trace.seal_digest.clone(),
            record_count: trace.record_count,
        },
        ordered_items,
    };
    if let Some(result) = &data.provider_result {
        if result.provider_profile_id != trace.profile_id
            || result.provider != trace.provider_kind
            || result.model != trace.model
        {
            return Err(HostV2StorageError::conflict(
                "provider_terminal_result_trace_conflict",
                "Provider result metadata does not bind the sealed Trace identity",
            ));
        }
    }
    validate_provider_turn_terminal_data(&data)?;
    Ok(data)
}

fn provider_terminal_commit_from_recovery(
    recovery: &ProviderTraceTerminalRecoveryV1,
) -> Result<SessionProviderTurnTerminalCommitV3, HostV2StorageError> {
    let terminal_kind = match recovery.metadata.terminal_kind {
        ProviderTraceTerminalKindV1::Completed => SessionProviderTurnTerminalKindV3::Completed,
        ProviderTraceTerminalKindV1::Failed => SessionProviderTurnTerminalKindV3::Failed,
        ProviderTraceTerminalKindV1::Cancelled => SessionProviderTurnTerminalKindV3::Cancelled,
        ProviderTraceTerminalKindV1::LimitExceeded => {
            SessionProviderTurnTerminalKindV3::LimitExceeded
        }
    };
    if terminal_kind != SessionProviderTurnTerminalKindV3::Completed {
        return Ok(SessionProviderTurnTerminalCommitV3 {
            terminal_kind,
            reason_code: recovery.reason_code.clone(),
            response_digest: None,
            completion: None,
            provider_result: None,
            ordered_items: Vec::new(),
        });
    }
    let completed = recovery.completed.as_ref().ok_or_else(|| {
        HostV2StorageError::conflict(
            "provider_terminal_recovery_incomplete",
            "Completed Provider trace lacks deterministic safe completion evidence",
        )
    })?;
    Ok(SessionProviderTurnTerminalCommitV3 {
        terminal_kind,
        reason_code: None,
        response_digest: Some(completed.response_digest.clone()),
        completion: Some(json!({
            "schemaVersion": SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
            "nativeCompletion": completed.native_completion.clone(),
            "reasoningPresent": completed.reasoning_present,
            "reasoningTransport": completed.reasoning_transport.clone(),
            "reasoningDigest": completed.reasoning_digest.clone(),
            "responseDigest": completed.response_digest.clone(),
            "trace": {
                "sealed": true,
                "sealDigest": recovery.metadata.seal_digest.clone(),
                "terminalDigest": recovery.metadata.terminal_digest.clone(),
                "recordCount": recovery.metadata.record_count,
            },
        })),
        provider_result: Some(completed.provider_result.clone()),
        ordered_items: completed.ordered_items.clone(),
    })
}

fn validate_provider_terminal_trace_binding(
    dispatch: &SessionProviderTurnDispatchReceiptV3,
    trace: &ProviderTraceMetadataV1,
    terminal_kind: SessionProviderTurnTerminalKindV3,
) -> Result<(), HostV2StorageError> {
    if trace.session_id != dispatch.session_id
        || trace.run_id != dispatch.run_id
        || trace.provider_turn_id != dispatch.provider_turn_id
        || trace.user_turn_id != dispatch.authority_binding.input_id
        || trace.control_epoch != dispatch.authority_binding.control_epoch
        || trace.profile_id != dispatch.authority_binding.provider_profile_id
        || trace.profile_revision != dispatch.authority_binding.provider_profile_revision_digest
        || trace.purpose != dispatch.purpose
        || trace.request_digest != dispatch.request_digest
        || !trace_terminal_kind_matches(trace.terminal_kind, terminal_kind)
    {
        return Err(HostV2StorageError::conflict(
            "provider_terminal_trace_binding_conflict",
            "Provider terminal does not bind the exact sealed dispatch trace",
        ));
    }
    validate_sha256_digest(&trace.request_digest, "requestDigest")?;
    validate_sha256_digest(&trace.terminal_digest, "terminalDigest")?;
    validate_sha256_digest(&trace.seal_digest, "sealDigest")?;
    if trace.record_count == 0 || trace.record_count > MAX_SAFE_INTEGER_V3 {
        return Err(HostV2StorageError::invalid(
            "provider_terminal_trace_binding_invalid",
            "Provider terminal trace recordCount is invalid",
        ));
    }
    Ok(())
}

fn trace_terminal_kind_matches(
    trace: ProviderTraceTerminalKindV1,
    terminal: SessionProviderTurnTerminalKindV3,
) -> bool {
    matches!(
        (trace, terminal),
        (
            ProviderTraceTerminalKindV1::Completed,
            SessionProviderTurnTerminalKindV3::Completed
        ) | (
            ProviderTraceTerminalKindV1::Failed,
            SessionProviderTurnTerminalKindV3::Failed
        ) | (
            ProviderTraceTerminalKindV1::Cancelled,
            SessionProviderTurnTerminalKindV3::Cancelled
        ) | (
            ProviderTraceTerminalKindV1::LimitExceeded,
            SessionProviderTurnTerminalKindV3::LimitExceeded
        )
    )
}

fn value_with_field(mut value: Value, key: &str, field: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.to_string(), field);
    }
    value
}

fn provider_turn_admission_from_records(
    records: &[SessionKernelPersistenceRecordV3],
    run_id: &str,
    provider_turn_id: &str,
) -> Result<SessionProviderTurnAdmissionV2, HostV2StorageError> {
    let (checkpoint_index, checkpoint) = latest_committed_checkpoint(records)?;
    let authority = &checkpoint.authority;
    if authority.run_id != run_id {
        return Err(provider_turn_admission_invalid());
    }
    require_tool_context_snapshot_before(
        records,
        checkpoint_index,
        run_id,
        &authority.tool_context.current_ref,
    )?;
    let provider_turn = checkpoint
        .active
        .provider_reservation
        .as_ref()
        .ok_or_else(provider_turn_admission_missing)?;
    if provider_turn.provider_turn_id != provider_turn_id
        || provider_turn.control_epoch != authority.control_epoch
        || provider_turn.status != "active"
    {
        return Err(provider_turn_admission_missing());
    }
    if provider_turn.context_ref != authority.tool_context.current_ref {
        return Err(provider_turn_admission_invalid());
    }
    require_tool_context_snapshot_before(
        records,
        checkpoint_index,
        run_id,
        &provider_turn.context_ref,
    )?;
    if let Some(dispatch_ref) = &provider_turn.dispatch_ref {
        let dispatch = resolve_record_ref_before(records, checkpoint_index, dispatch_ref)?;
        if dispatch.record_kind != SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch
            || validate_provider_turn_dispatch_record(dispatch, run_id)?.provider_turn_id
                != provider_turn_id
        {
            return Err(provider_turn_admission_invalid());
        }
    }
    if let Some(terminal_ref) = &provider_turn.terminal_ref {
        let terminal = resolve_record_ref_before(records, checkpoint_index, terminal_ref)?;
        let terminal_data = validate_provider_turn_terminal_record(terminal, run_id)?;
        if terminal.record_kind != SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal
            || terminal_data.provider_turn_id != provider_turn_id
            || provider_turn.dispatch_ref.as_ref() != Some(&terminal_data.dispatch_ref)
        {
            return Err(provider_turn_admission_invalid());
        }
    }
    let current_input =
        resolve_record_ref_before(records, checkpoint_index, &authority.current_input_ref)?;
    if current_input.record_kind != SessionKernelPersistenceRecordKindV3::Input
        || persisted_input_record_id(current_input, run_id)? != authority.current_input_id
    {
        return Err(provider_turn_admission_invalid());
    }
    let context_assembly = provider_turn
        .context_assembly
        .as_object()
        .ok_or_else(provider_turn_admission_invalid)?;
    let profile = context_assembly
        .get("providerProfile")
        .and_then(Value::as_object)
        .ok_or_else(provider_turn_admission_invalid)?;
    let provider_profile_id = profile
        .get("providerProfileId")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_bounded_identity(provider_profile_id, "providerProfileId", 512)?;
    let provider_profile_revision = profile
        .get("providerProfileRevisionDigest")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_sha256_digest(provider_profile_revision, "providerProfileRevisionDigest")?;
    if provider_profile_id != authority.provider_profile_id
        || provider_profile_revision != authority.provider_profile_revision_digest
    {
        return Err(provider_turn_admission_invalid());
    }
    let sections = context_assembly
        .get("trimming")
        .and_then(|value| value.get("sections"))
        .and_then(Value::as_array)
        .ok_or_else(provider_turn_admission_invalid)?;
    let current_input_sections = sections
        .iter()
        .filter(|section| section.get("section").and_then(Value::as_str) == Some("currentInput"))
        .collect::<Vec<_>>();
    if current_input_sections.len() != 1 {
        return Err(provider_turn_admission_invalid());
    }
    let current_input_digest = current_input_sections[0]
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_sha256_digest(current_input_digest, "currentInputDigest")?;
    let plan_sections = sections
        .iter()
        .filter(|section| section.get("section").and_then(Value::as_str) == Some("planDecision"))
        .collect::<Vec<_>>();
    if plan_sections.len() != 1 {
        return Err(provider_turn_admission_invalid());
    }
    let plan_section = plan_sections[0];
    let plan_original_count = plan_section
        .get("originalCount")
        .and_then(Value::as_u64)
        .ok_or_else(provider_turn_admission_invalid)?;
    let plan_selected_count = plan_section
        .get("selectedCount")
        .and_then(Value::as_u64)
        .ok_or_else(provider_turn_admission_invalid)?;
    let plan_omitted_count = plan_section
        .get("omittedCount")
        .and_then(Value::as_u64)
        .ok_or_else(provider_turn_admission_invalid)?;
    let plan_section_digest = plan_section
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_sha256_digest(plan_section_digest, "planDecisionDigest")?;
    if plan_original_count > 1
        || plan_selected_count > 1
        || plan_selected_count > plan_original_count
        || plan_omitted_count != plan_original_count - plan_selected_count
    {
        return Err(provider_turn_admission_invalid());
    }
    let plan_is_in_provider_context = plan_selected_count == 1;
    if authority.plan_ref.is_some() != plan_is_in_provider_context {
        return Err(provider_turn_admission_invalid());
    }
    let plan_revision = authority
        .plan_ref
        .as_ref()
        .map(|plan_ref| {
            let plan = resolve_record_ref_before(records, checkpoint_index, plan_ref)?;
            if plan.record_kind != SessionKernelPersistenceRecordKindV3::Plan {
                return Err(provider_turn_admission_invalid());
            }
            let revision = plan
                .data
                .get("planRevision")
                .and_then(Value::as_str)
                .ok_or_else(provider_turn_admission_invalid)?;
            validate_bounded_identity(revision, "planRevision", 512)?;
            if plan.record_id != format!("session-kernel-v3:{run_id}:plan:{revision}") {
                return Err(provider_turn_admission_invalid());
            }
            Ok(revision.to_string())
        })
        .transpose()?;
    if plan_revision.is_some() != plan_is_in_provider_context
        || provider_turn.plan_revision.as_deref() != plan_revision.as_deref()
    {
        return Err(provider_turn_admission_invalid());
    }
    let target_kind = provider_turn
        .target
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    let (work_authority, review_revision, snapshot_high_water) =
        if provider_turn.purpose == ProviderTracePurposeV1::FinalAnswer {
            if target_kind != "finalAnswer" {
                return Err(provider_turn_admission_invalid());
            }
            let work_authority = authority
                .work_authority
                .as_ref()
                .ok_or_else(provider_turn_admission_invalid)?;
            let (review_revision, snapshot_high_water) = final_answer_review_binding(
                records,
                checkpoint_index,
                &checkpoint,
                provider_turn,
                work_authority,
                plan_revision.as_deref(),
            )?;
            (
                Some(work_authority.clone()),
                review_revision,
                snapshot_high_water,
            )
        } else {
            if target_kind == "finalAnswer" {
                return Err(provider_turn_admission_invalid());
            }
            (None, None, None)
        };
    let admission = SessionProviderTurnAdmissionV2 {
        provider_turn_id: provider_turn_id.to_string(),
        purpose: provider_turn.purpose,
        control_epoch: authority.control_epoch,
        current_input_id: authority.current_input_id.clone(),
        current_input_digest: current_input_digest.to_string(),
        provider_profile_id: provider_profile_id.to_string(),
        provider_profile_revision: provider_profile_revision.to_string(),
        plan_revision,
        work_authority,
        remaining_tool_call_budget: provider_turn.remaining_tool_call_budget,
        review_revision,
        snapshot_high_water,
    };
    validate_final_answer_dispatch_budget(records, run_id, &admission)?;
    Ok(admission)
}

fn latest_committed_checkpoint(
    records: &[SessionKernelPersistenceRecordV3],
) -> Result<(usize, SessionKernelCompactCheckpointV3), HostV2StorageError> {
    committed_checkpoint_chain(records)?
        .last()
        .map(|entry| (entry.record_index, entry.checkpoint.clone()))
        .ok_or_else(provider_turn_admission_missing)
}

struct CommittedCheckpointEntryV3<'a> {
    record_index: usize,
    record: &'a SessionKernelPersistenceRecordV3,
    checkpoint: SessionKernelCompactCheckpointV3,
}

fn committed_checkpoint_chain(
    records: &[SessionKernelPersistenceRecordV3],
) -> Result<Vec<CommittedCheckpointEntryV3<'_>>, HostV2StorageError> {
    let mut committed_refs = HashSet::<(String, String)>::new();
    for record in records {
        if record.record_kind == SessionKernelPersistenceRecordKindV3::PublicRequestSettled {
            let settlement = persisted_public_request_settlement_identity(record, &record.run_id)?;
            committed_refs.insert((
                settlement.checkpoint_ref.record_id,
                settlement.checkpoint_ref.record_digest,
            ));
        }
    }
    let mut committed = Vec::new();
    for (index, record) in records.iter().enumerate() {
        if record.record_kind != SessionKernelPersistenceRecordKindV3::Checkpoint {
            continue;
        }
        let checkpoint = decode_compact_checkpoint_record(record)?;
        let is_committed = match &checkpoint.commit_scope {
            SessionKernelCheckpointCommitScopeV3::Standalone => true,
            SessionKernelCheckpointCommitScopeV3::PublicRequestSettlement { .. } => {
                committed_refs.contains(&(record.record_id.clone(), record.record_digest.clone()))
            }
        };
        if !is_committed {
            continue;
        }
        committed.push(CommittedCheckpointEntryV3 {
            record_index: index,
            record,
            checkpoint,
        });
    }
    committed.sort_by_key(|entry| entry.checkpoint.checkpoint_revision);
    let mut expected_parent: Option<SessionProviderTurnRecordRefV3> = None;
    let mut previous_record_index: Option<usize> = None;
    for (offset, entry) in committed.iter().enumerate() {
        let expected_revision = u64::try_from(offset).unwrap_or(u64::MAX).saturating_add(1);
        if entry.checkpoint.checkpoint_revision != expected_revision
            || entry.checkpoint.parent_ref != expected_parent
            || previous_record_index.is_some_and(|previous| previous >= entry.record_index)
        {
            return Err(checkpoint_parent_conflict(
                "Committed Session checkpoint history is not one continuous parent-linked chain",
            ));
        }
        expected_parent = Some(SessionProviderTurnRecordRefV3 {
            record_id: entry.record.record_id.clone(),
            record_digest: entry.record.record_digest.clone(),
        });
        previous_record_index = Some(entry.record_index);
    }
    Ok(committed)
}

fn validate_checkpoint_authority_append(
    records: &[SessionKernelPersistenceRecordV3],
    candidate: &SessionKernelPersistenceRecordV3,
) -> Result<(), HostV2StorageError> {
    match candidate.record_kind {
        SessionKernelPersistenceRecordKindV3::Checkpoint => {
            let checkpoint = decode_compact_checkpoint_record(candidate)?;
            validate_checkpoint_tool_context_snapshot(records, &checkpoint)?;
            validate_checkpoint_work_authority_records(records, records.len(), &checkpoint)?;
            validate_checkpoint_continuation(records, candidate, &checkpoint)
        }
        SessionKernelPersistenceRecordKindV3::PublicRequestSettled => {
            validate_public_request_settlement_commit(records, candidate)
        }
        _ => Ok(()),
    }
}

fn validate_checkpoint_tool_context_snapshot(
    prior_records: &[SessionKernelPersistenceRecordV3],
    checkpoint: &SessionKernelCompactCheckpointV3,
) -> Result<(), HostV2StorageError> {
    require_tool_context_snapshot_before(
        prior_records,
        prior_records.len(),
        &checkpoint.authority.run_id,
        &checkpoint.authority.tool_context.current_ref,
    )?;
    if let Some(reservation) = &checkpoint.active.provider_reservation {
        if reservation.context_ref != checkpoint.authority.tool_context.current_ref {
            return Err(compact_checkpoint_authority_invalid());
        }
        require_tool_context_snapshot_before(
            prior_records,
            prior_records.len(),
            &checkpoint.authority.run_id,
            &reservation.context_ref,
        )?;
    }
    Ok(())
}

fn validate_checkpoint_work_authority_records(
    records: &[SessionKernelPersistenceRecordV3],
    exclusive_end: usize,
    checkpoint: &SessionKernelCompactCheckpointV3,
) -> Result<(), HostV2StorageError> {
    let authority = &checkpoint.authority;
    match &authority.work_authority {
        Some(SessionWorkAuthorityV3::Plan { plan_revision }) => {
            let plan_ref = authority
                .plan_ref
                .as_ref()
                .ok_or_else(compact_checkpoint_authority_invalid)?;
            let plan = resolve_record_ref_before(records, exclusive_end, plan_ref)?;
            if plan.record_kind != SessionKernelPersistenceRecordKindV3::Plan
                || plan.data.get("planRevision").and_then(Value::as_str)
                    != Some(plan_revision.as_str())
            {
                return Err(compact_checkpoint_authority_invalid());
            }
            if let Some(plan_decision_ref) = &authority.plan_decision_ref {
                let decision =
                    resolve_record_ref_before(records, exclusive_end, plan_decision_ref)?;
                if decision.record_kind != SessionKernelPersistenceRecordKindV3::PlanDecision
                    || decision.data.get("planRevision").and_then(Value::as_str)
                        != Some(plan_revision.as_str())
                {
                    return Err(compact_checkpoint_authority_invalid());
                }
            }
        }
        Some(SessionWorkAuthorityV3::ContextRead { .. }) | None => {}
    }
    if let Some(review_ref) = &checkpoint.refs.review {
        let review_record = resolve_record_ref_before(records, exclusive_end, review_ref)?;
        if review_record.record_kind != SessionKernelPersistenceRecordKindV3::Review {
            return Err(compact_checkpoint_authority_invalid());
        }
        let review_wrapper = decode_review_record(review_record)?;
        let review = review_wrapper
            .review
            .as_object()
            .ok_or_else(compact_checkpoint_authority_invalid)?;
        let review_work_authority = review
            .get("workAuthority")
            .map(decode_session_work_authority_v3)
            .transpose()?;
        if review_work_authority.as_ref() != authority.work_authority.as_ref() {
            return Err(compact_checkpoint_authority_invalid());
        }
        match &authority.work_authority {
            Some(SessionWorkAuthorityV3::Plan { plan_revision })
                if review.get("planRevision").and_then(Value::as_str)
                    == Some(plan_revision.as_str()) => {}
            Some(SessionWorkAuthorityV3::ContextRead { .. })
                if !review.contains_key("planRevision") => {}
            None if !review.contains_key("planRevision") => {}
            _ => return Err(compact_checkpoint_authority_invalid()),
        }
        if let Some(final_answer) = &checkpoint.final_answer {
            if final_answer.binding.review_revision
                != review.get("revision").and_then(Value::as_u64).unwrap_or(0)
                || final_answer.binding.snapshot_high_water
                    != review
                        .get("snapshotHighWater")
                        .and_then(Value::as_u64)
                        .unwrap_or(u64::MAX)
                || Some(&final_answer.binding.work_authority) != review_work_authority.as_ref()
            {
                return Err(compact_final_answer_invalid());
            }
        }
    } else if checkpoint.final_answer.is_some() {
        return Err(compact_final_answer_invalid());
    }
    Ok(())
}

fn validate_checkpoint_continuation(
    records: &[SessionKernelPersistenceRecordV3],
    candidate_record: &SessionKernelPersistenceRecordV3,
    candidate: &SessionKernelCompactCheckpointV3,
) -> Result<(), HostV2StorageError> {
    let chain = committed_checkpoint_chain(records)?;
    let expected_revision = chain
        .last()
        .map(|entry| entry.checkpoint.checkpoint_revision)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| {
            checkpoint_parent_conflict("Session checkpoint revision cannot advance safely")
        })?;
    let expected_parent = chain.last().map(|entry| SessionProviderTurnRecordRefV3 {
        record_id: entry.record.record_id.clone(),
        record_digest: entry.record.record_digest.clone(),
    });
    if candidate.checkpoint_revision != expected_revision
        || candidate.parent_ref != expected_parent
        || candidate_record.record_id
            != format!(
                "session-kernel-v3:{}:checkpoint:{expected_revision}",
                candidate_record.run_id
            )
    {
        return Err(checkpoint_parent_conflict(
            "Session checkpoint does not immediately continue the current committed checkpoint",
        ));
    }
    Ok(())
}

fn validate_public_request_settlement_commit(
    records: &[SessionKernelPersistenceRecordV3],
    marker_record: &SessionKernelPersistenceRecordV3,
) -> Result<(), HostV2StorageError> {
    let settlement =
        persisted_public_request_settlement_identity(marker_record, &marker_record.run_id)?;
    let by_id = records
        .iter()
        .map(|record| (record.record_id.clone(), record))
        .collect::<HashMap<_, _>>();
    let checkpoint_record = resolve_exact_record_ref(&by_id, &settlement.checkpoint_ref)?;
    if checkpoint_record.record_kind != SessionKernelPersistenceRecordKindV3::Checkpoint {
        return Err(public_request_settlement_ref_conflict());
    }
    let checkpoint = decode_compact_checkpoint_record(checkpoint_record)?;
    let checkpoint_index = records
        .iter()
        .position(|record| record.record_id == checkpoint_record.record_id)
        .ok_or_else(public_request_settlement_ref_conflict)?;
    validate_checkpoint_work_authority_records(records, checkpoint_index, &checkpoint)?;
    validate_checkpoint_continuation(records, checkpoint_record, &checkpoint)?;

    let expected_scope = SessionKernelCheckpointCommitScopeV3::PublicRequestSettlement {
        request_id: settlement.request_id.clone(),
        request_digest: settlement.request_digest.clone(),
        outcome_digest: settlement.outcome_digest.clone(),
    };
    if checkpoint.commit_scope != expected_scope {
        return Err(public_request_settlement_ref_conflict());
    }
    let mut scoped_checkpoints = Vec::new();
    for record in records {
        if record.record_kind == SessionKernelPersistenceRecordKindV3::Checkpoint
            && decode_compact_checkpoint_record(record)?.commit_scope == expected_scope
        {
            scoped_checkpoints.push(record);
        }
    }
    if scoped_checkpoints.len() != 1
        || scoped_checkpoints[0].record_id != settlement.checkpoint_ref.record_id
        || scoped_checkpoints[0].record_digest != settlement.checkpoint_ref.record_digest
    {
        return Err(public_request_settlement_ref_conflict());
    }

    let expected_projection_refs = settlement
        .projection_refs
        .iter()
        .map(|record_ref| {
            (
                record_ref.record_id.as_str(),
                record_ref.record_digest.as_str(),
            )
        })
        .collect::<HashSet<_>>();
    let mut scoped_projection_refs = HashSet::new();
    for record in records {
        if record.record_kind == SessionKernelPersistenceRecordKindV3::Projection
            && decode_projection_record(record)?.commit_scope == expected_scope
        {
            scoped_projection_refs
                .insert((record.record_id.as_str(), record.record_digest.as_str()));
        }
    }
    if scoped_projection_refs != expected_projection_refs {
        return Err(public_request_settlement_ref_conflict());
    }

    let active_requests = checkpoint
        .active
        .public_requests
        .as_object()
        .ok_or_else(public_request_settlement_ref_conflict)?;
    for value in active_requests.values() {
        let record_ref: SessionProviderTurnRecordRefV3 = serde_json::from_value(value.clone())
            .map_err(|_| public_request_settlement_ref_conflict())?;
        let request_record = resolve_exact_record_ref(&by_id, &record_ref)?;
        if request_record.record_kind != SessionKernelPersistenceRecordKindV3::PublicRequest {
            return Err(public_request_settlement_ref_conflict());
        }
        if persisted_public_request_identity(request_record, &marker_record.run_id)?.request_id
            == settlement.request_id
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_request_settlement_checkpoint_conflict",
                "Public request settlement checkpoint still retains the settled request as active",
            ));
        }
    }
    Ok(())
}

fn checkpoint_parent_conflict(message: &'static str) -> HostV2StorageError {
    HostV2StorageError::conflict("session_kernel_checkpoint_parent_conflict", message)
}

fn resolve_record_ref_before<'a>(
    records: &'a [SessionKernelPersistenceRecordV3],
    exclusive_end: usize,
    record_ref: &SessionProviderTurnRecordRefV3,
) -> Result<&'a SessionKernelPersistenceRecordV3, HostV2StorageError> {
    records[..exclusive_end]
        .iter()
        .find(|record| {
            record.record_id == record_ref.record_id
                && record.record_digest == record_ref.record_digest
        })
        .ok_or_else(provider_turn_admission_invalid)
}

fn require_tool_context_snapshot_before<'a>(
    records: &'a [SessionKernelPersistenceRecordV3],
    exclusive_end: usize,
    run_id: &str,
    context_ref: &ToolContextRefV2,
) -> Result<&'a SessionKernelPersistenceRecordV3, HostV2StorageError> {
    let before = records.get(..exclusive_end).ok_or_else(|| {
        HostV2StorageError::conflict(
            "session_kernel_tool_context_snapshot_history_invalid",
            "ToolContext snapshot lookup exceeded the durable history boundary",
        )
    })?;
    let record_id = tool_context_snapshot_record_id(run_id, context_ref.context_digest.as_str());
    let record = before
        .iter()
        .find(|record| record.record_id == record_id)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_tool_context_snapshot_missing",
                "Session authority references a ToolContext without a prior immutable snapshot",
            )
        })?;
    if record.record_kind != SessionKernelPersistenceRecordKindV3::ToolContextSnapshot {
        return Err(HostV2StorageError::conflict(
            "session_kernel_tool_context_snapshot_identity_conflict",
            "ToolContext snapshot identity belongs to another record kind",
        ));
    }
    let snapshot = validate_tool_context_snapshot_record(record, run_id)?;
    if &snapshot.context_ref != context_ref {
        return Err(HostV2StorageError::conflict(
            "session_kernel_tool_context_snapshot_ref_conflict",
            "Session authority ToolContext reference conflicts with its immutable snapshot",
        ));
    }
    Ok(record)
}

fn final_answer_review_binding(
    records: &[SessionKernelPersistenceRecordV3],
    checkpoint_index: usize,
    checkpoint: &SessionKernelCompactCheckpointV3,
    reservation: &SessionKernelCompactProviderReservationV3,
    work_authority: &SessionWorkAuthorityV3,
    plan_revision: Option<&str>,
) -> Result<(Option<u64>, Option<u64>), HostV2StorageError> {
    let review_ref = checkpoint
        .refs
        .review
        .as_ref()
        .ok_or_else(provider_turn_admission_invalid)?;
    let review_record = resolve_record_ref_before(records, checkpoint_index, review_ref)?;
    if review_record.record_kind != SessionKernelPersistenceRecordKindV3::Review {
        return Err(provider_turn_admission_invalid());
    }
    let review_wrapper = decode_review_record(review_record)?;
    let review = review_wrapper
        .review
        .as_object()
        .ok_or_else(provider_turn_admission_invalid)?;
    if review.get("projectionVersion").and_then(Value::as_str)
        != Some(SESSION_KERNEL_REVIEW_PROJECTION_V2_SCHEMA)
        || review.get("status").and_then(Value::as_str) != Some("final")
    {
        return Err(provider_turn_admission_invalid());
    }
    let finalized_at = review
        .get("finalizedAt")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_bounded_identity(finalized_at, "review.finalizedAt", 1024)
        .map_err(|_| provider_turn_admission_invalid())?;
    if finalized_at != review_record.recorded_at {
        return Err(provider_turn_admission_invalid());
    }
    let review_revision = review
        .get("revision")
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0 && *revision <= MAX_SAFE_INTEGER_V3)
        .ok_or_else(provider_turn_admission_invalid)?;
    let snapshot_high_water = review
        .get("snapshotHighWater")
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_INTEGER_V3)
        .ok_or_else(provider_turn_admission_invalid)?;
    let review_work_authority = review
        .get("workAuthority")
        .ok_or_else(provider_turn_admission_invalid)
        .and_then(decode_session_work_authority_v3)?;
    if &review_work_authority != work_authority {
        return Err(provider_turn_admission_invalid());
    }
    match work_authority {
        SessionWorkAuthorityV3::Plan {
            plan_revision: authority_plan_revision,
        } if plan_revision == Some(authority_plan_revision.as_str())
            && review.get("planRevision").and_then(Value::as_str)
                == Some(authority_plan_revision.as_str()) => {}
        SessionWorkAuthorityV3::ContextRead { .. }
            if plan_revision.is_none() && !review.contains_key("planRevision") => {}
        _ => return Err(provider_turn_admission_invalid()),
    }
    let facts_query = review
        .get("factsQuery")
        .and_then(Value::as_object)
        .ok_or_else(provider_turn_admission_invalid)?;
    if facts_query.get("runId").and_then(Value::as_str) != Some(review_record.run_id.as_str())
        || facts_query.get("controlEpoch").and_then(Value::as_u64)
            != Some(checkpoint.authority.control_epoch)
        || facts_query.get("snapshotHighWater").and_then(Value::as_u64) != Some(snapshot_high_water)
    {
        return Err(provider_turn_admission_invalid());
    }
    let target = reservation
        .target
        .as_object()
        .ok_or_else(provider_turn_admission_invalid)?;
    let final_answer = checkpoint
        .final_answer
        .as_ref()
        .ok_or_else(provider_turn_admission_invalid)?;
    let final_answer_started_at = final_answer
        .started_at
        .as_deref()
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_bounded_identity(final_answer_started_at, "finalAnswer.startedAt", 1024)
        .map_err(|_| provider_turn_admission_invalid())?;
    if final_answer.status != "requesting"
        || final_answer.provider_turn_id.as_deref() != Some(reservation.provider_turn_id.as_str())
    {
        return Err(provider_turn_admission_invalid());
    }
    require_exact_object_keys(
        target,
        &[
            "kind",
            "inputId",
            "controlEpoch",
            "workAuthority",
            "reviewRevision",
            "snapshotHighWater",
        ],
        "provider_turn_admission_invalid",
    )?;
    let target_work_authority = target
        .get("workAuthority")
        .ok_or_else(provider_turn_admission_invalid)
        .and_then(decode_session_work_authority_v3)?;
    if target.get("inputId").and_then(Value::as_str)
        != Some(checkpoint.authority.current_input_id.as_str())
        || target.get("controlEpoch").and_then(Value::as_u64)
            != Some(checkpoint.authority.control_epoch)
        || &target_work_authority != work_authority
        || target.get("reviewRevision").and_then(Value::as_u64) != Some(review_revision)
        || target.get("snapshotHighWater").and_then(Value::as_u64) != Some(snapshot_high_water)
        || final_answer.binding.input_id != checkpoint.authority.current_input_id
        || final_answer.binding.control_epoch != checkpoint.authority.control_epoch
        || &final_answer.binding.work_authority != work_authority
        || final_answer.binding.review_revision != review_revision
        || final_answer.binding.snapshot_high_water != snapshot_high_water
    {
        return Err(provider_turn_admission_invalid());
    }
    Ok((Some(review_revision), Some(snapshot_high_water)))
}

fn validate_final_answer_dispatch_budget(
    records: &[SessionKernelPersistenceRecordV3],
    run_id: &str,
    admission: &SessionProviderTurnAdmissionV2,
) -> Result<(), HostV2StorageError> {
    if admission.purpose != ProviderTracePurposeV1::FinalAnswer {
        return Ok(());
    }
    let mut matching_dispatch_count = 0usize;
    let mut current_dispatch_matches = None;
    for record in records {
        if record.record_kind != SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch {
            continue;
        }
        let dispatch = validate_provider_turn_dispatch_record(record, run_id)?;
        let matches_current = dispatch_matches_final_answer_admission(&dispatch, run_id, admission);
        if dispatch.provider_turn_id == admission.provider_turn_id {
            current_dispatch_matches = Some(matches_current);
        }
        if dispatch_counts_toward_final_answer_budget(&dispatch, run_id, admission) {
            matching_dispatch_count = matching_dispatch_count.saturating_add(1);
        }
    }
    match current_dispatch_matches {
        Some(true) => return Ok(()),
        Some(false) => return Err(provider_turn_admission_invalid()),
        None => {}
    }
    if matching_dispatch_count >= 3 {
        return Err(HostV2StorageError::conflict(
            "provider_final_answer_dispatch_limit_exceeded",
            "Final-answer authority already has three durable physical Provider dispatches",
        ));
    }
    Ok(())
}

fn dispatch_counts_toward_final_answer_budget(
    dispatch: &SessionProviderTurnDispatchDataV3,
    run_id: &str,
    admission: &SessionProviderTurnAdmissionV2,
) -> bool {
    let authority = &dispatch.authority_binding;
    dispatch.purpose == ProviderTracePurposeV1::FinalAnswer
        && authority.run_id == run_id
        && authority.input_id == admission.current_input_id
        && authority.control_epoch == admission.control_epoch
        && authority.provider_profile_id == admission.provider_profile_id
        && authority.provider_profile_revision_digest == admission.provider_profile_revision
}

fn dispatch_matches_final_answer_admission(
    dispatch: &SessionProviderTurnDispatchDataV3,
    run_id: &str,
    admission: &SessionProviderTurnAdmissionV2,
) -> bool {
    let authority = &dispatch.authority_binding;
    dispatch.purpose == ProviderTracePurposeV1::FinalAnswer
        && authority.run_id == run_id
        && authority.input_id == admission.current_input_id
        && authority.control_epoch == admission.control_epoch
        && authority.plan_revision == admission.plan_revision
        && authority.review_revision == admission.review_revision
        && authority.snapshot_high_water == admission.snapshot_high_water
        && authority.provider_profile_id == admission.provider_profile_id
        && authority.provider_profile_revision_digest == admission.provider_profile_revision
}

fn provider_turn_admission_missing() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "provider_turn_admission_missing",
        "Provider transport has no exact active durable Session turn admission",
    )
}

fn provider_turn_admission_invalid() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "provider_turn_admission_invalid",
        "Provider transport durable Session turn admission is invalid",
    )
}

fn provider_dispatch_stale() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "provider_dispatch_stale",
        "Provider dispatch no longer matches the exact active durable Session turn",
    )
}

fn preflight_store_append(
    path: &FsPath,
    record_count: usize,
    value: &Value,
) -> Result<(), HostV2StorageError> {
    if record_count >= MAX_STORE_RECORDS {
        return Err(HostV2StorageError::conflict(
            "host_v2_storage_limit_exceeded",
            "Host v2 JSONL stream reached its bounded record count",
        ));
    }
    let encoded = serde_json::to_vec(value).map_err(|error| {
        HostV2StorageError::invalid(
            "host_v2_storage_encode_failed",
            format!("encode Host v2 JSONL record: {error}"),
        )
    })?;
    if encoded.is_empty() || encoded.len() > MAX_STORE_RECORD_BYTES {
        return Err(HostV2StorageError::conflict(
            "host_v2_storage_record_invalid",
            "Host v2 JSONL record is empty or exceeds its bounded size",
        ));
    }
    let current_bytes = match fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(HostV2StorageError::io(
                "host_v2_storage_read_failed",
                format!("inspect Host v2 JSONL stream before append: {error}"),
            ))
        }
    };
    let appended_bytes = u64::try_from(encoded.len())
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    if current_bytes.saturating_add(appended_bytes) > MAX_STORE_FILE_BYTES {
        return Err(HostV2StorageError::conflict(
            "host_v2_storage_limit_exceeded",
            "Host v2 JSONL append would exceed its bounded size",
        ));
    }
    Ok(())
}

fn read_run_store(
    path: &FsPath,
    session_id: &str,
    run_id: &str,
) -> Result<Vec<SessionKernelPersistenceRecordV3>, HostV2StorageError> {
    let values = read_bounded_json_lines(path)?;
    let mut unique = Vec::with_capacity(values.len());
    let mut digests = HashMap::new();
    let mut header_count = 0usize;
    for (index, value) in values.into_iter().enumerate() {
        let is_tool_context_snapshot =
            value.get("recordKind").and_then(Value::as_str) == Some("toolContextSnapshot");
        let record: SessionKernelPersistenceRecordV3 =
            serde_json::from_value(value).map_err(|error| {
                HostV2StorageError::conflict(
                    if is_tool_context_snapshot {
                        "UnsupportedHistorySchema"
                    } else {
                        "session_kernel_persistence_history_unsupported"
                    },
                    format!("decode Session Kernel persistence record: {error}"),
                )
            })?;
        validate_persistence_record(&record, session_id, run_id).map_err(|error| {
            HostV2StorageError::conflict(
                if record.record_kind == SessionKernelPersistenceRecordKindV3::ToolContextSnapshot
                    || error.code == "session_kernel_persistence_schema_unsupported"
                    || is_tool_context_history_error_code(error.code)
                {
                    "UnsupportedHistorySchema"
                } else {
                    "session_kernel_persistence_history_unsupported"
                },
                error.message,
            )
        })?;
        if record.record_kind == SessionKernelPersistenceRecordKindV3::StoreHeader {
            header_count += 1;
            if index != 0 {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_persistence_history_unsupported",
                    "Session Kernel persistence header is not the first durable record",
                ));
            }
            require_store_header(&record, run_id)?;
        }
        match digests.get(&record.record_id) {
            Some(existing) if existing != &record.record_digest => {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_persistence_identity_conflict",
                    "Session Kernel persistence history has conflicting recordId content",
                ))
            }
            Some(_) => continue,
            None => {
                digests.insert(record.record_id.clone(), record.record_digest.clone());
                unique.push(record);
            }
        }
    }
    if !unique.is_empty() && header_count != 1 {
        return Err(HostV2StorageError::conflict(
            "session_kernel_persistence_history_unsupported",
            "Session Kernel persistence history has no unique v3 store header",
        ));
    }
    validate_public_request_history(unique.iter())?;
    validate_tool_context_snapshot_history(unique.iter())
        .map_err(map_unsupported_tool_context_history)?;
    validate_checkpoint_tool_context_history(&unique)
        .map_err(map_unsupported_tool_context_history)?;
    validate_provider_turn_history(unique.iter())?;
    Ok(unique)
}

fn is_tool_context_history_error_code(code: &str) -> bool {
    code.starts_with("session_kernel_tool_context_")
}

fn map_unsupported_tool_context_history(error: HostV2StorageError) -> HostV2StorageError {
    if error.kind == HostV2StorageErrorKind::Io {
        error
    } else {
        HostV2StorageError::conflict("UnsupportedHistorySchema", error.message)
    }
}

fn validate_tool_context_snapshot_history<'a>(
    records: impl IntoIterator<Item = &'a SessionKernelPersistenceRecordV3>,
) -> Result<(), HostV2StorageError> {
    let mut catalog_digest = None::<String>;
    let mut contexts_by_version = BTreeMap::<u64, (ToolContextRefV2, ToolContextBundleV2)>::new();
    for record in records {
        if record.record_kind != SessionKernelPersistenceRecordKindV3::ToolContextSnapshot {
            continue;
        }
        let snapshot = validate_tool_context_snapshot_record(record, &record.run_id)?;
        let snapshot_catalog = snapshot.context_ref.catalog_digest.as_str();
        match catalog_digest.as_deref() {
            Some(expected) if expected != snapshot_catalog => {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_tool_context_catalog_conflict",
                    "One Run cannot change its immutable Kernel tool catalog digest",
                ));
            }
            None => catalog_digest = Some(snapshot_catalog.to_string()),
            _ => {}
        }
        let version = snapshot.context_ref.context_version.get();
        match contexts_by_version.get(&version) {
            Some((context_ref, tool_context))
                if context_ref != &snapshot.context_ref
                    || tool_context != &snapshot.tool_context =>
            {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_tool_context_version_conflict",
                    "One ToolContext version cannot identify different immutable context content",
                ));
            }
            Some(_) => {}
            None => {
                contexts_by_version.insert(version, (snapshot.context_ref, snapshot.tool_context));
            }
        }
    }
    Ok(())
}

fn validate_checkpoint_tool_context_history(
    records: &[SessionKernelPersistenceRecordV3],
) -> Result<(), HostV2StorageError> {
    for (index, record) in records.iter().enumerate() {
        if record.record_kind != SessionKernelPersistenceRecordKindV3::Checkpoint {
            continue;
        }
        let checkpoint = decode_compact_checkpoint_record(record)?;
        validate_checkpoint_work_authority_records(records, index, &checkpoint)?;
        require_tool_context_snapshot_before(
            records,
            index,
            &record.run_id,
            &checkpoint.authority.tool_context.current_ref,
        )?;
        if let Some(reservation) = &checkpoint.active.provider_reservation {
            if reservation.context_ref != checkpoint.authority.tool_context.current_ref {
                return Err(compact_checkpoint_authority_invalid());
            }
            require_tool_context_snapshot_before(
                records,
                index,
                &record.run_id,
                &reservation.context_ref,
            )?;
        }
    }
    Ok(())
}

fn validate_persistence_record(
    record: &SessionKernelPersistenceRecordV3,
    session_id: &str,
    run_id: &str,
) -> Result<(), HostV2StorageError> {
    if record.schema_version != SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA {
        return Err(HostV2StorageError::invalid(
            "session_kernel_persistence_schema_unsupported",
            "Session Kernel persistence record has an unsupported schema",
        ));
    }
    if record.session_id != session_id || record.run_id != run_id {
        return Err(HostV2StorageError::invalid(
            "session_kernel_persistence_store_identity_mismatch",
            "Session Kernel persistence record belongs to another Session or Run",
        ));
    }
    validate_safe_session_identity(session_id)?;
    validate_bounded_identity(run_id, "runId", 512)?;
    validate_bounded_identity(&record.record_id, "recordId", 128 * 1024)?;
    validate_bounded_identity(&record.recorded_at, "recordedAt", 128 * 1024)?;
    validate_bounded_identity(&record.record_digest, "recordDigest", 512)?;
    reject_transport_capabilities(&record.data)?;
    let value = serde_json::to_value(record).map_err(|error| {
        HostV2StorageError::invalid(
            "session_kernel_persistence_record_invalid",
            format!("encode Session Kernel persistence record: {error}"),
        )
    })?;
    let expected = canonical_sha256(&value_without_field(&value, "recordDigest")?)?;
    if expected != record.record_digest {
        return Err(HostV2StorageError::invalid(
            "session_kernel_persistence_digest_mismatch",
            "Session Kernel persistence record failed digest verification",
        ));
    }
    match record.record_kind {
        SessionKernelPersistenceRecordKindV3::OperationResult => {
            validate_operation_result_record(record, session_id, run_id)?;
        }
        SessionKernelPersistenceRecordKindV3::Input => {
            persisted_input_record_id(record, run_id)?;
        }
        SessionKernelPersistenceRecordKindV3::PublicRequest => {
            persisted_public_request_identity(record, run_id)?;
        }
        SessionKernelPersistenceRecordKindV3::PublicRequestSettled => {
            persisted_public_request_settlement_identity(record, run_id)?;
        }
        SessionKernelPersistenceRecordKindV3::Checkpoint => {
            decode_compact_checkpoint_record(record)?;
        }
        SessionKernelPersistenceRecordKindV3::Projection => {
            decode_projection_record(record)?;
        }
        SessionKernelPersistenceRecordKindV3::Review => {
            decode_review_record(record)?;
        }
        SessionKernelPersistenceRecordKindV3::PlanActionSettlement => {
            validate_plan_action_settlement_record(record)?;
        }
        SessionKernelPersistenceRecordKindV3::ToolContextSnapshot => {
            validate_tool_context_snapshot_record(record, run_id)?;
        }
        SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch => {
            validate_provider_turn_dispatch_record(record, run_id)?;
        }
        SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal => {
            validate_provider_turn_terminal_record(record, run_id)?;
        }
        _ => {}
    }
    Ok(())
}

fn validate_tool_context_snapshot_record(
    record: &SessionKernelPersistenceRecordV3,
    run_id: &str,
) -> Result<SessionKernelToolContextSnapshotDataV3, HostV2StorageError> {
    let data: SessionKernelToolContextSnapshotDataV3 = serde_json::from_value(record.data.clone())
        .map_err(|_| {
            HostV2StorageError::invalid(
                "session_kernel_tool_context_snapshot_invalid",
                "ToolContext snapshot must use the exact strict v3 envelope",
            )
        })?;
    if data.schema_version != SESSION_KERNEL_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA {
        return Err(HostV2StorageError::invalid(
            "session_kernel_tool_context_snapshot_schema_unsupported",
            "ToolContext snapshot has an unsupported schema",
        ));
    }
    if data.run_id != run_id {
        return Err(HostV2StorageError::invalid(
            "session_kernel_tool_context_snapshot_run_mismatch",
            "ToolContext snapshot belongs to another Run",
        ));
    }
    data.tool_context.validate().map_err(|_| {
        HostV2StorageError::invalid(
            "session_kernel_tool_context_snapshot_invalid",
            "ToolContext snapshot contains an invalid Kernel ToolContext bundle",
        )
    })?;
    if data.context_ref != data.tool_context.context_ref() {
        return Err(HostV2StorageError::invalid(
            "session_kernel_tool_context_snapshot_ref_mismatch",
            "ToolContext snapshot reference does not match its exact bundle",
        ));
    }
    if record.record_id
        != tool_context_snapshot_record_id(run_id, data.context_ref.context_digest.as_str())
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_tool_context_snapshot_identity_mismatch",
            "ToolContext snapshot recordId does not bind its Run and context digest",
        ));
    }
    Ok(data)
}

fn validate_provider_turn_dispatch_record(
    record: &SessionKernelPersistenceRecordV3,
    run_id: &str,
) -> Result<SessionProviderTurnDispatchDataV3, HostV2StorageError> {
    let data: SessionProviderTurnDispatchDataV3 = serde_json::from_value(record.data.clone())
        .map_err(|_| {
            HostV2StorageError::invalid(
                "provider_dispatch_record_invalid",
                "Provider dispatch record must use the exact strict envelope",
            )
        })?;
    if data.schema_version != SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA {
        return Err(HostV2StorageError::invalid(
            "provider_dispatch_schema_unsupported",
            "Provider dispatch record has an unsupported schema",
        ));
    }
    validate_bounded_identity(&data.provider_turn_id, "providerTurnId", 512)?;
    if record.record_id != provider_turn_dispatch_record_id(run_id, &data.provider_turn_id) {
        return Err(HostV2StorageError::invalid(
            "provider_dispatch_identity_mismatch",
            "Provider dispatch recordId does not bind its Provider turn",
        ));
    }
    validate_provider_authority_binding(&data.authority_binding, data.purpose)?;
    if data.authority_binding.run_id != run_id {
        return Err(HostV2StorageError::invalid(
            "provider_dispatch_authority_mismatch",
            "Provider dispatch authority belongs to another Run",
        ));
    }
    validate_sha256_digest(&data.request_digest, "requestDigest")?;
    Ok(data)
}

fn decode_compact_checkpoint_record(
    record: &SessionKernelPersistenceRecordV3,
) -> Result<SessionKernelCompactCheckpointV3, HostV2StorageError> {
    let checkpoint: SessionKernelCompactCheckpointV3 = serde_json::from_value(record.data.clone())
        .map_err(|_| {
            HostV2StorageError::invalid(
                "session_kernel_checkpoint_invalid",
                "Session Kernel checkpoint must use the exact compact v3 envelope",
            )
        })?;
    if checkpoint.schema_version != SESSION_KERNEL_CHECKPOINT_V3_SCHEMA
        || checkpoint.checkpoint_revision == 0
        || checkpoint.checkpoint_revision > MAX_SAFE_INTEGER_V3
        || record.record_id
            != format!(
                "session-kernel-v3:{}:checkpoint:{}",
                record.run_id, checkpoint.checkpoint_revision
            )
        || record.recorded_at != checkpoint.saved_at
        || checkpoint.authority.run_id != record.run_id
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_checkpoint_invalid",
            "Session Kernel compact checkpoint identity is invalid",
        ));
    }
    validate_bounded_identity(&checkpoint.saved_at, "savedAt", 1024)?;
    validate_commit_scope(&checkpoint.commit_scope)?;
    if let Some(parent_ref) = &checkpoint.parent_ref {
        validate_record_ref(parent_ref, "parentRef")?;
    }
    let authority = &checkpoint.authority;
    validate_bounded_identity(&authority.run_id, "runId", 512)?;
    validate_sha256_digest(
        &authority.workspace_binding_digest,
        "workspaceBindingDigest",
    )?;
    if authority.control_epoch == 0 || authority.control_epoch > MAX_SAFE_INTEGER_V3 {
        return Err(compact_checkpoint_authority_invalid());
    }
    validate_bounded_identity(&authority.current_input_id, "currentInputId", 512)?;
    validate_record_ref(&authority.current_input_ref, "currentInputRef")?;
    validate_bounded_identity(&authority.provider_profile_id, "providerProfileId", 512)?;
    validate_sha256_digest(
        &authority.provider_profile_revision_digest,
        "providerProfileRevisionDigest",
    )?;
    if !authority.previews.is_object() || !authority.operation_plan_action_bindings.is_object() {
        return Err(compact_checkpoint_authority_invalid());
    }
    if let Some(work_authority) = &authority.work_authority {
        validate_session_work_authority_v3(work_authority)?;
    }
    match (
        &authority.work_authority,
        &authority.plan_ref,
        &authority.plan_decision_ref,
    ) {
        (None, None, None) => {}
        (Some(SessionWorkAuthorityV3::Plan { .. }), Some(_), _) => {}
        (Some(SessionWorkAuthorityV3::ContextRead { .. }), None, None) => {}
        _ => return Err(compact_checkpoint_authority_invalid()),
    }
    if let Some(plan_ref) = &authority.plan_ref {
        validate_record_ref(plan_ref, "planRef")?;
    }
    if let Some(plan_decision_ref) = &authority.plan_decision_ref {
        validate_record_ref(plan_decision_ref, "planDecisionRef")?;
    }
    let cursor = &checkpoint.cursor;
    if cursor.input_history_omitted_count > MAX_SAFE_INTEGER_V3
        || cursor.provider_outcome_history_omitted_count > MAX_SAFE_INTEGER_V3
        || cursor.review_facts_after_ledger_sequence > MAX_SAFE_INTEGER_V3
        || cursor.after_ledger_sequence > MAX_SAFE_INTEGER_V3
        || cursor.snapshot_high_water > MAX_SAFE_INTEGER_V3
        || cursor.review_facts_after_ledger_sequence > cursor.after_ledger_sequence
    {
        return Err(compact_checkpoint_authority_invalid());
    }
    for record_ref in cursor
        .input_refs
        .iter()
        .chain(cursor.provider_terminal_refs.iter())
    {
        validate_record_ref(record_ref, "cursorRef")?;
    }
    if let Some(record_ref) = &checkpoint.active.pending_epoch_input_ref {
        validate_record_ref(record_ref, "pendingEpochInputRef")?;
    }
    if checkpoint.active.pending_guidance.len() > 64
        || !checkpoint.active.fact_barriers.is_object()
        || !checkpoint.active.public_requests.is_object()
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_checkpoint_active_invalid",
            "Session Kernel compact checkpoint active control state is invalid",
        ));
    }
    for guidance in &checkpoint.active.pending_guidance {
        validate_bounded_identity(guidance, "pendingGuidance", 64 * 1024)?;
    }
    if let Some(reservation) = &checkpoint.active.provider_reservation {
        validate_provider_reservation(reservation, authority)?;
    }
    if let Some(review_ref) = &checkpoint.refs.review {
        validate_record_ref(review_ref, "reviewRef")?;
    }
    if !checkpoint.refs.plan_action_settlements.is_object() {
        return Err(HostV2StorageError::invalid(
            "session_kernel_checkpoint_refs_invalid",
            "Session Kernel compact checkpoint immutable refs are invalid",
        ));
    }
    if let Some(final_answer) = &checkpoint.final_answer {
        validate_compact_final_answer(final_answer, authority)?;
    }
    Ok(checkpoint)
}

fn validate_compact_final_answer(
    final_answer: &SessionKernelCompactFinalAnswerV3,
    authority: &SessionKernelCompactAuthorityV3,
) -> Result<(), HostV2StorageError> {
    if !matches!(
        final_answer.status.as_str(),
        "pending" | "requesting" | "stale" | "committed" | "finalAnswerFailed"
    ) {
        return Err(compact_final_answer_invalid());
    }
    let binding = &final_answer.binding;
    validate_bounded_identity(&binding.input_id, "finalAnswer.binding.inputId", 512)?;
    validate_session_work_authority_v3(&binding.work_authority)?;
    if binding.control_epoch == 0
        || binding.control_epoch > MAX_SAFE_INTEGER_V3
        || binding.review_revision == 0
        || binding.review_revision > MAX_SAFE_INTEGER_V3
        || binding.snapshot_high_water > MAX_SAFE_INTEGER_V3
        || binding.input_id != authority.current_input_id
        || binding.control_epoch != authority.control_epoch
        || Some(&binding.work_authority) != authority.work_authority.as_ref()
    {
        return Err(compact_final_answer_invalid());
    }
    for (field, value) in [
        ("providerTurnId", final_answer.provider_turn_id.as_deref()),
        ("startedAt", final_answer.started_at.as_deref()),
        ("staleAt", final_answer.stale_at.as_deref()),
        ("failedAt", final_answer.failed_at.as_deref()),
        ("lastErrorCode", final_answer.last_error_code.as_deref()),
    ] {
        if let Some(value) = value {
            validate_bounded_identity(value, field, 1024)?;
        }
    }
    let shape_invalid = match final_answer.status.as_str() {
        "pending" => final_answer.provider_turn_id.is_some(),
        "requesting" => {
            final_answer.provider_turn_id.is_none() || final_answer.started_at.is_none()
        }
        "stale" => false,
        "committed" => final_answer.provider_turn_id.is_none(),
        "finalAnswerFailed" => {
            final_answer.failed_at.is_none() || final_answer.last_error_code.is_none()
        }
        _ => true,
    };
    if shape_invalid {
        return Err(compact_final_answer_invalid());
    }
    Ok(())
}

fn compact_final_answer_invalid() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "session_kernel_checkpoint_final_answer_invalid",
        "Session Kernel compact checkpoint finalAnswer control is invalid",
    )
}

fn validate_provider_reservation(
    reservation: &SessionKernelCompactProviderReservationV3,
    authority: &SessionKernelCompactAuthorityV3,
) -> Result<(), HostV2StorageError> {
    validate_bounded_identity(&reservation.provider_turn_id, "providerTurnId", 512)?;
    validate_bounded_identity(&reservation.started_at, "startedAt", 1024)?;
    if let Some(plan_revision) = &reservation.plan_revision {
        validate_bounded_identity(plan_revision, "planRevision", 512)?;
    }
    let target_kind = reservation
        .target
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(provider_turn_admission_invalid)?;
    validate_bounded_identity(target_kind, "target.kind", 128)?;
    if reservation.control_epoch != authority.control_epoch
        || !matches!(
            target_kind,
            "planning" | "planAction" | "contextRead" | "finalAnswer"
        )
        || (target_kind == "planAction") != reservation.remaining_tool_call_budget.is_some()
        || reservation
            .remaining_tool_call_budget
            .is_some_and(|budget| budget == 0 || budget > 256)
        || !reservation.fact_projection.is_object()
        || !reservation.context_assembly.is_object()
    {
        return Err(provider_turn_admission_invalid());
    }
    validate_bounded_identity(&reservation.status, "providerStatus", 128)?;
    if let Some(reason) = &reservation.cancellation_reason {
        validate_bounded_identity(reason, "cancellationReason", 128)?;
    }
    if let Some(dispatch_ref) = &reservation.dispatch_ref {
        validate_record_ref(dispatch_ref, "dispatchRef")?;
    }
    if let Some(terminal_ref) = &reservation.terminal_ref {
        validate_record_ref(terminal_ref, "terminalRef")?;
    }
    Ok(())
}

fn decode_projection_record(
    record: &SessionKernelPersistenceRecordV3,
) -> Result<SessionKernelProjectionRecordV3, HostV2StorageError> {
    let projection: SessionKernelProjectionRecordV3 = serde_json::from_value(record.data.clone())
        .map_err(|_| {
        HostV2StorageError::invalid(
            "session_kernel_projection_record_invalid",
            "Session Kernel projection must use the exact v3 wrapper",
        )
    })?;
    if projection.schema_version != SESSION_KERNEL_PROJECTION_RECORD_V3_SCHEMA {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_record_invalid",
            "Session Kernel projection wrapper has an unsupported schema",
        ));
    }
    validate_commit_scope(&projection.commit_scope)?;
    let event = projection.event.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_projection_record_invalid",
            "Session Kernel projection wrapper has no exact event",
        )
    })?;
    require_exact_object_keys(
        event,
        &["projectionId", "runId", "recordedAt", "kind", "data"],
        "session_kernel_projection_record_invalid",
    )?;
    let projection_id = event
        .get("projectionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_projection_record_invalid",
                "Session Kernel projection has no projectionId",
            )
        })?;
    validate_bounded_identity(projection_id, "projectionId", 512)?;
    if event.get("runId").and_then(Value::as_str) != Some(record.run_id.as_str())
        || event.get("recordedAt").and_then(Value::as_str) != Some(record.recorded_at.as_str())
        || record.record_id
            != format!(
                "session-kernel-v3:{}:projection:{projection_id}",
                record.run_id
            )
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_record_invalid",
            "Session Kernel projection wrapper identity is invalid",
        ));
    }
    Ok(projection)
}

fn decode_review_record(
    record: &SessionKernelPersistenceRecordV3,
) -> Result<SessionKernelReviewRecordV3, HostV2StorageError> {
    let wrapper: SessionKernelReviewRecordV3 = serde_json::from_value(record.data.clone())
        .map_err(|_| {
            HostV2StorageError::invalid(
                "session_kernel_review_record_invalid",
                "Session Kernel Review must use the exact v3 wrapper",
            )
        })?;
    let review = wrapper.review.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_review_record_invalid",
            "Session Kernel Review wrapper has no Review",
        )
    })?;
    let revision = review
        .get("revision")
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0 && *revision <= MAX_SAFE_INTEGER_V3)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_review_record_invalid",
                "Session Kernel Review has an invalid revision",
            )
        })?;
    if wrapper.schema_version != SESSION_KERNEL_REVIEW_RECORD_V3_SCHEMA
        || record.record_id != format!("session-kernel-v3:{}:review:{revision}", record.run_id)
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_review_record_invalid",
            "Session Kernel Review wrapper identity is invalid",
        ));
    }
    Ok(wrapper)
}

fn validate_plan_action_settlement_record(
    record: &SessionKernelPersistenceRecordV3,
) -> Result<(), HostV2StorageError> {
    let object = record.data.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_plan_action_settlement_record_invalid",
            "PlanAction settlement must use the exact v3 wrapper",
        )
    })?;
    require_exact_object_keys(
        object,
        &["schemaVersion", "settlement"],
        "session_kernel_plan_action_settlement_record_invalid",
    )?;
    let settlement = object
        .get("settlement")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_plan_action_settlement_record_invalid",
                "PlanAction settlement wrapper has no settlement",
            )
        })?;
    let plan_action_id = settlement
        .get("planActionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_plan_action_settlement_record_invalid",
                "PlanAction settlement has no planActionId",
            )
        })?;
    validate_bounded_identity(plan_action_id, "planActionId", 512)?;
    if object.get("schemaVersion").and_then(Value::as_str)
        != Some(SESSION_KERNEL_PLAN_ACTION_SETTLEMENT_RECORD_V3_SCHEMA)
        || record.record_id
            != format!(
                "session-kernel-v3:{}:plan-action-settlement:{plan_action_id}",
                record.run_id
            )
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_plan_action_settlement_record_invalid",
            "PlanAction settlement wrapper identity is invalid",
        ));
    }
    Ok(())
}

fn validate_commit_scope(
    scope: &SessionKernelCheckpointCommitScopeV3,
) -> Result<(), HostV2StorageError> {
    if let SessionKernelCheckpointCommitScopeV3::PublicRequestSettlement {
        request_id,
        request_digest,
        outcome_digest,
    } = scope
    {
        validate_bounded_identity(request_id, "requestId", 512)?;
        validate_sha256_digest(request_digest, "requestDigest")?;
        validate_sha256_digest(outcome_digest, "outcomeDigest")?;
    }
    Ok(())
}

fn compact_checkpoint_authority_invalid() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "session_kernel_checkpoint_authority_invalid",
        "Session Kernel compact checkpoint authority is invalid",
    )
}

fn validate_provider_turn_terminal_record(
    record: &SessionKernelPersistenceRecordV3,
    run_id: &str,
) -> Result<SessionProviderTurnTerminalDataV3, HostV2StorageError> {
    let data: SessionProviderTurnTerminalDataV3 = serde_json::from_value(record.data.clone())
        .map_err(|_| {
            HostV2StorageError::invalid(
                "provider_terminal_record_invalid",
                "Provider terminal record must use the exact strict envelope",
            )
        })?;
    if data.schema_version != SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA {
        return Err(HostV2StorageError::invalid(
            "provider_terminal_schema_unsupported",
            "Provider terminal record has an unsupported schema",
        ));
    }
    validate_bounded_identity(&data.provider_turn_id, "providerTurnId", 512)?;
    if record.record_id != provider_turn_terminal_record_id(run_id, &data.provider_turn_id)
        || data.dispatch_ref.record_id
            != provider_turn_dispatch_record_id(run_id, &data.provider_turn_id)
        || data.authority_binding.run_id != run_id
    {
        return Err(HostV2StorageError::invalid(
            "provider_terminal_identity_mismatch",
            "Provider terminal identity does not bind its Run and dispatch",
        ));
    }
    validate_sha256_digest(&data.dispatch_ref.record_digest, "dispatchRef.recordDigest")?;
    validate_provider_authority_binding_common(&data.authority_binding)?;
    validate_provider_turn_terminal_data(&data)?;
    Ok(data)
}

fn validate_provider_authority_binding(
    binding: &SessionProviderAuthorityBindingV3,
    purpose: ProviderTracePurposeV1,
) -> Result<(), HostV2StorageError> {
    validate_provider_authority_binding_common(binding)?;
    match purpose {
        ProviderTracePurposeV1::FinalAnswer => {
            if binding.review_revision.is_none() || binding.snapshot_high_water.is_none() {
                return Err(HostV2StorageError::invalid(
                    "provider_authority_final_answer_binding_missing",
                    "finalAnswer authority requires Review revision and facts high-water",
                ));
            }
        }
        ProviderTracePurposeV1::Primary | ProviderTracePurposeV1::Continuation => {
            if binding.review_revision.is_some() || binding.snapshot_high_water.is_some() {
                return Err(HostV2StorageError::invalid(
                    "provider_authority_review_binding_forbidden",
                    "Only finalAnswer authority may bind Review revision and facts high-water",
                ));
            }
        }
    }
    Ok(())
}

fn validate_provider_authority_binding_common(
    binding: &SessionProviderAuthorityBindingV3,
) -> Result<(), HostV2StorageError> {
    validate_bounded_identity(&binding.run_id, "runId", 512)?;
    validate_bounded_identity(&binding.input_id, "inputId", 512)?;
    if binding.control_epoch == 0 || binding.control_epoch > MAX_SAFE_INTEGER_V3 {
        return Err(HostV2StorageError::invalid(
            "provider_authority_control_epoch_invalid",
            "Provider authority controlEpoch is invalid",
        ));
    }
    validate_sha256_digest(&binding.current_input_digest, "currentInputDigest")?;
    if let Some(plan_revision) = &binding.plan_revision {
        validate_bounded_identity(plan_revision, "planRevision", 512)?;
    }
    if binding.review_revision.is_some() != binding.snapshot_high_water.is_some()
        || binding
            .review_revision
            .is_some_and(|revision| revision == 0 || revision > MAX_SAFE_INTEGER_V3)
        || binding
            .snapshot_high_water
            .is_some_and(|high_water| high_water > MAX_SAFE_INTEGER_V3)
    {
        return Err(HostV2StorageError::invalid(
            "provider_authority_review_binding_invalid",
            "Provider authority Review binding is incomplete or invalid",
        ));
    }
    validate_bounded_identity(&binding.provider_profile_id, "providerProfileId", 512)?;
    validate_sha256_digest(
        &binding.provider_profile_revision_digest,
        "providerProfileRevisionDigest",
    )?;
    Ok(())
}

fn validate_provider_turn_terminal_data(
    data: &SessionProviderTurnTerminalDataV3,
) -> Result<(), HostV2StorageError> {
    validate_sha256_digest(&data.trace_ref.terminal_digest, "traceRef.terminalDigest")?;
    validate_sha256_digest(&data.trace_ref.seal_digest, "traceRef.sealDigest")?;
    if data.trace_ref.record_count == 0 || data.trace_ref.record_count > MAX_SAFE_INTEGER_V3 {
        return Err(HostV2StorageError::invalid(
            "provider_terminal_trace_ref_invalid",
            "Provider terminal traceRef has an invalid recordCount",
        ));
    }
    match data.terminal_kind {
        SessionProviderTurnTerminalKindV3::Completed => {
            if data.reason_code.is_some() {
                return Err(provider_completed_terminal_invalid());
            }
            let response_digest = data
                .response_digest
                .as_deref()
                .ok_or_else(provider_completed_terminal_invalid)?;
            validate_sha256_digest(response_digest, "responseDigest")?;
            let completion = data
                .completion
                .as_ref()
                .ok_or_else(provider_completed_terminal_invalid)?;
            let provider_result = data
                .provider_result
                .as_ref()
                .ok_or_else(provider_completed_terminal_invalid)?;
            validate_provider_completion(completion)?;
            validate_provider_result(provider_result, &data.authority_binding)?;
            validate_provider_ordered_items(&data.ordered_items, &completion.native_completion)?;
            if completion.response_digest != response_digest
                || completion.trace.sealed != true
                || completion.trace.seal_digest != data.trace_ref.seal_digest
                || completion.trace.terminal_digest != data.trace_ref.terminal_digest
                || completion.trace.record_count != data.trace_ref.record_count
            {
                return Err(provider_completed_terminal_invalid());
            }
        }
        SessionProviderTurnTerminalKindV3::Failed
        | SessionProviderTurnTerminalKindV3::Cancelled
        | SessionProviderTurnTerminalKindV3::LimitExceeded => {
            let reason_code = data
                .reason_code
                .as_deref()
                .ok_or_else(provider_noncompleted_terminal_invalid)?;
            validate_bounded_identity(reason_code, "reasonCode", 256)?;
            if data.response_digest.is_some()
                || data.completion.is_some()
                || data.provider_result.is_some()
                || !data.ordered_items.is_empty()
            {
                return Err(provider_noncompleted_terminal_invalid());
            }
        }
    }
    Ok(())
}

fn validate_provider_completion(
    completion: &SessionProviderCompletionReceiptV1,
) -> Result<(), HostV2StorageError> {
    if completion.schema_version != SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA
        || !completion.reasoning_present
    {
        return Err(provider_completed_terminal_invalid());
    }
    validate_sha256_digest(&completion.reasoning_digest, "reasoningDigest")?;
    validate_sha256_digest(&completion.response_digest, "completion.responseDigest")?;
    validate_sha256_digest(&completion.trace.seal_digest, "completion.trace.sealDigest")?;
    validate_sha256_digest(
        &completion.trace.terminal_digest,
        "completion.trace.terminalDigest",
    )?;
    if !completion.trace.sealed
        || completion.trace.record_count == 0
        || completion.trace.record_count > MAX_SAFE_INTEGER_V3
    {
        return Err(provider_completed_terminal_invalid());
    }
    let provider_kind = validate_provider_native_completion(&completion.native_completion)?;
    let expected_transport = match provider_kind {
        "openaiCompatible" => "openaiPlaintext",
        "anthropic" => "anthropicPlaintext",
        "ollama" => "ollamaPlaintext",
        _ => return Err(provider_completed_terminal_invalid()),
    };
    if completion.reasoning_transport != expected_transport {
        return Err(provider_completed_terminal_invalid());
    }
    Ok(())
}

fn validate_provider_native_completion(native: &Value) -> Result<&str, HostV2StorageError> {
    let object = native
        .as_object()
        .ok_or_else(provider_completed_terminal_invalid)?;
    let provider_kind = object
        .get("providerKind")
        .and_then(Value::as_str)
        .ok_or_else(provider_completed_terminal_invalid)?;
    match provider_kind {
        "openaiCompatible" => {
            require_exact_object_keys(
                object,
                &["providerKind", "terminalSignal", "finishReason"],
                "provider_terminal_native_completion_invalid",
            )?;
            if object.get("terminalSignal").and_then(Value::as_str) != Some("[DONE]")
                || !matches!(
                    object.get("finishReason").and_then(Value::as_str),
                    Some("stop" | "tool_calls")
                )
            {
                return Err(provider_completed_terminal_invalid());
            }
        }
        "anthropic" => {
            require_exact_object_keys(
                object,
                &["providerKind", "terminalSignal"],
                "provider_terminal_native_completion_invalid",
            )?;
            if object.get("terminalSignal").and_then(Value::as_str) != Some("message_stop") {
                return Err(provider_completed_terminal_invalid());
            }
        }
        "ollama" => {
            require_exact_object_keys(
                object,
                &["providerKind", "terminalSignal"],
                "provider_terminal_native_completion_invalid",
            )?;
            if object.get("terminalSignal").and_then(Value::as_str) != Some("done:true") {
                return Err(provider_completed_terminal_invalid());
            }
        }
        _ => return Err(provider_completed_terminal_invalid()),
    }
    Ok(provider_kind)
}

fn validate_provider_result(
    result: &SessionProviderResultV3,
    authority: &SessionProviderAuthorityBindingV3,
) -> Result<(), HostV2StorageError> {
    validate_bounded_identity(&result.provider_profile_id, "providerProfileId", 512)?;
    validate_bounded_identity(&result.provider, "provider", 1024)?;
    validate_bounded_identity(&result.model, "model", 1024)?;
    if result.provider_profile_id != authority.provider_profile_id
        || result
            .usage
            .as_ref()
            .is_some_and(|usage| !usage.is_object())
    {
        return Err(HostV2StorageError::invalid(
            "provider_terminal_result_invalid",
            "Provider safe result metadata conflicts with dispatch authority",
        ));
    }
    Ok(())
}

fn validate_provider_ordered_items(
    items: &[SessionProviderOrderedItemV3],
    native_completion: &Value,
) -> Result<(), HostV2StorageError> {
    if items.len() > 96 {
        return Err(HostV2StorageError::invalid(
            "provider_terminal_ordered_items_invalid",
            "Provider completed terminal contains too many ordered items",
        ));
    }
    let mut total_text_bytes = 0usize;
    let mut tool_count = 0usize;
    let mut call_ids = HashSet::new();
    let mut final_started = false;
    for item in items {
        match item {
            SessionProviderOrderedItemV3::Text { phase, text } => {
                if text.trim().is_empty() {
                    return Err(provider_ordered_items_invalid());
                }
                total_text_bytes = total_text_bytes.saturating_add(text.len());
                if total_text_bytes > 1024 * 1024
                    || (final_started && matches!(phase, SessionProviderTextPhaseV3::Commentary))
                {
                    return Err(provider_ordered_items_invalid());
                }
                if matches!(phase, SessionProviderTextPhaseV3::FinalAnswer) {
                    final_started = true;
                }
            }
            SessionProviderOrderedItemV3::ToolCall {
                index,
                call_id,
                name,
                arguments,
            } => {
                if final_started || *index != u64::try_from(tool_count).unwrap_or(u64::MAX) {
                    return Err(provider_ordered_items_invalid());
                }
                validate_bounded_identity(call_id, "callId", 1024)?;
                validate_bounded_identity(name, "name", 1024)?;
                if !call_ids.insert(call_id.as_str())
                    || arguments.len() > 1024 * 1024
                    || serde_json::from_str::<Value>(arguments).is_err()
                {
                    return Err(provider_ordered_items_invalid());
                }
                tool_count += 1;
            }
        }
    }
    if final_started && tool_count > 0 {
        return Err(provider_ordered_items_invalid());
    }
    let native = native_completion
        .as_object()
        .ok_or_else(provider_ordered_items_invalid)?;
    if native.get("providerKind").and_then(Value::as_str) == Some("openaiCompatible") {
        let expected = if tool_count > 0 { "tool_calls" } else { "stop" };
        if native.get("finishReason").and_then(Value::as_str) != Some(expected) {
            return Err(provider_ordered_items_invalid());
        }
    }
    Ok(())
}

fn require_exact_object_keys(
    object: &serde_json::Map<String, Value>,
    expected: &[&str],
    code: &'static str,
) -> Result<(), HostV2StorageError> {
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(HostV2StorageError::invalid(
            code,
            "Provider persistence object has an invalid strict envelope",
        ));
    }
    Ok(())
}

fn validate_record_ref(
    record_ref: &SessionProviderTurnRecordRefV3,
    field: &'static str,
) -> Result<(), HostV2StorageError> {
    validate_bounded_identity(&record_ref.record_id, field, 128 * 1024)?;
    validate_sha256_digest(&record_ref.record_digest, "recordDigest")
}

fn provider_completed_terminal_invalid() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "provider_completed_terminal_invalid",
        "Completed Provider terminal evidence is incomplete or inconsistent",
    )
}

fn provider_noncompleted_terminal_invalid() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "provider_noncompleted_terminal_invalid",
        "Non-completed Provider terminal must contain only reason and trace evidence",
    )
}

fn provider_ordered_items_invalid() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "provider_terminal_ordered_items_invalid",
        "Provider completed terminal ordered items are invalid",
    )
}

fn persisted_input_record_id<'a>(
    record: &'a SessionKernelPersistenceRecordV3,
    run_id: &str,
) -> Result<&'a str, HostV2StorageError> {
    let object = record.data.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_input_record_invalid",
            "Session Kernel input record data must be an exact object",
        )
    })?;
    let expected_keys = [
        "attachments",
        "inputId",
        "opaqueInputRef",
        "recordedAt",
        "text",
    ];
    if object.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !object.contains_key(*key))
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_input_record_invalid",
            "Session Kernel input record has an invalid strict envelope",
        ));
    }
    let input_id = object
        .get("inputId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_input_record_invalid",
                "Session Kernel input record has no inputId",
            )
        })?;
    validate_bounded_identity(input_id, "inputId", 512)?;
    if record.record_id != format!("session-kernel-v3:{run_id}:input:{input_id}") {
        return Err(HostV2StorageError::invalid(
            "session_kernel_input_record_identity_mismatch",
            "Session Kernel input recordId does not bind its inputId",
        ));
    }
    let opaque_input_ref = object
        .get("opaqueInputRef")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_input_record_invalid",
                "Session Kernel input record has no opaqueInputRef",
            )
        })?;
    validate_bounded_identity(opaque_input_ref, "opaqueInputRef", 64 * 1024)?;
    let text = object.get("text").and_then(Value::as_str).ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_input_record_invalid",
            "Session Kernel input record has no text",
        )
    })?;
    if text.is_empty() || text.len() > 64 * 1024 {
        return Err(HostV2StorageError::invalid(
            "session_kernel_input_record_invalid",
            "Session Kernel input record text is empty or exceeds its bounded size",
        ));
    }
    let recorded_at = object
        .get("recordedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_input_record_invalid",
                "Session Kernel input record has no recordedAt",
            )
        })?;
    validate_bounded_identity(recorded_at, "recordedAt", 1024)?;
    deepcode_kernel_abi::decode_agent_input_attachments_v2(object.get("attachments").ok_or_else(
        || {
            HostV2StorageError::invalid(
                "session_kernel_input_record_invalid",
                "Session Kernel input record has no attachments",
            )
        },
    )?)
    .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;
    Ok(input_id)
}

fn persisted_public_request_identity(
    record: &SessionKernelPersistenceRecordV3,
    run_id: &str,
) -> Result<PersistedPublicRequestIdentityV3, HostV2StorageError> {
    let request: PersistedPublicRequestV3 =
        serde_json::from_value(record.data.clone()).map_err(|_| {
            HostV2StorageError::invalid(
                "session_kernel_public_request_invalid",
                "Session Kernel public request must use the exact persisted envelope",
            )
        })?;
    validate_bounded_identity(&request.request_id, "requestId", 512)?;
    validate_bounded_identity(&request.started_at, "startedAt", 1024)?;
    if request.attempt_count == 0
        || !request.intent.payload.is_object()
        || record.recorded_at != request.started_at
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_request_invalid",
            "Session Kernel public request has an invalid attempt, payload, or timestamp binding",
        ));
    }
    let expected_lane = match request.intent.kind.as_str() {
        "controlEpochAdvance" | "invocationCancel" => "control",
        "toolIntentSubmit" => "effect",
        "toolContextGet" | "capabilityPreview" | "factsQuery" => "query",
        _ => {
            return Err(HostV2StorageError::invalid(
                "session_kernel_public_request_invalid",
                "Session Kernel public request has an unknown intent kind",
            ))
        }
    };
    if request.lane != expected_lane
        || record.record_id
            != format!(
                "session-kernel-v3:{run_id}:request:{}:attempt:{}",
                request.request_id, request.attempt_count
            )
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_request_identity_mismatch",
            "Session Kernel public request recordId or lane does not bind its immutable identity",
        ));
    }
    let intent = serde_json::to_value(&request.intent).map_err(|_| {
        HostV2StorageError::invalid(
            "session_kernel_public_request_invalid",
            "Session Kernel public request intent could not be canonicalized",
        )
    })?;
    let request_digest = canonical_sha256(&json!({
        "requestId": &request.request_id,
        "lane": &request.lane,
        "intent": intent,
    }))?;
    Ok(PersistedPublicRequestIdentityV3 {
        request_id: request.request_id,
        request_digest,
    })
}

fn persisted_public_request_settlement_identity(
    record: &SessionKernelPersistenceRecordV3,
    run_id: &str,
) -> Result<PersistedPublicRequestSettlementIdentityV3, HostV2StorageError> {
    let settlement: PersistedPublicRequestSettlementV3 =
        serde_json::from_value(record.data.clone()).map_err(|_| {
            HostV2StorageError::invalid(
                "session_kernel_public_request_settlement_invalid",
                "Session Kernel public request settlement must use the exact persisted envelope",
            )
        })?;
    if settlement.schema_version != SESSION_KERNEL_PUBLIC_REQUEST_SETTLEMENT_V3_SCHEMA {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_request_settlement_schema_unsupported",
            "Session Kernel public request settlement has an unsupported schema",
        ));
    }
    validate_bounded_identity(&settlement.request_id, "requestId", 512)?;
    validate_sha256_digest(&settlement.request_digest, "requestDigest")?;
    validate_sha256_digest(&settlement.outcome_digest, "outcomeDigest")?;
    validate_record_ref(&settlement.checkpoint_ref, "checkpointRef")?;
    if settlement.projection_refs.len() > 128 {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_request_settlement_invalid",
            "Session Kernel public request settlement has too many projection refs",
        ));
    }
    let mut projection_ids = HashSet::new();
    for projection_ref in &settlement.projection_refs {
        validate_record_ref(projection_ref, "projectionRef")?;
        if !projection_ids.insert(projection_ref.record_id.as_str()) {
            return Err(HostV2StorageError::invalid(
                "session_kernel_public_request_settlement_invalid",
                "Session Kernel public request settlement repeats a projection ref",
            ));
        }
    }
    if record.record_id
        != format!(
            "session-kernel-v3:{run_id}:request:{}:settled",
            settlement.request_id
        )
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_request_settlement_identity_mismatch",
            "Session Kernel public request settlement recordId does not bind its requestId",
        ));
    }
    Ok(PersistedPublicRequestSettlementIdentityV3 {
        request_id: settlement.request_id,
        request_digest: settlement.request_digest,
        outcome_digest: settlement.outcome_digest,
        checkpoint_ref: settlement.checkpoint_ref,
        projection_refs: settlement.projection_refs,
    })
}

fn validate_public_request_history<'a>(
    records: impl IntoIterator<Item = &'a SessionKernelPersistenceRecordV3>,
) -> Result<(), HostV2StorageError> {
    let mut request_digests = HashMap::<String, String>::new();
    let mut settled_request_ids = HashSet::<String>::new();
    let mut prior_records = HashMap::<String, &SessionKernelPersistenceRecordV3>::new();
    for record in records {
        match record.record_kind {
            SessionKernelPersistenceRecordKindV3::PublicRequest => {
                let identity = persisted_public_request_identity(record, &record.run_id)?;
                if settled_request_ids.contains(&identity.request_id) {
                    return Err(HostV2StorageError::conflict(
                        "session_kernel_public_request_reopened",
                        "A settled Session Kernel public request has a later durable attempt",
                    ));
                }
                match request_digests.get(&identity.request_id) {
                    Some(digest) if digest != &identity.request_digest => {
                        return Err(HostV2StorageError::conflict(
                            "session_kernel_public_request_identity_conflict",
                            "Session Kernel public requestId changed its immutable lane or intent",
                        ));
                    }
                    Some(_) => {}
                    None => {
                        request_digests.insert(identity.request_id, identity.request_digest);
                    }
                }
            }
            SessionKernelPersistenceRecordKindV3::PublicRequestSettled => {
                let identity =
                    persisted_public_request_settlement_identity(record, &record.run_id)?;
                if settled_request_ids.contains(&identity.request_id)
                    || request_digests.get(&identity.request_id) != Some(&identity.request_digest)
                {
                    return Err(HostV2StorageError::conflict(
                        "session_kernel_public_request_settlement_identity_mismatch",
                        "Session Kernel public request settlement does not bind one unresolved request",
                    ));
                }
                validate_public_request_settlement_refs(&prior_records, &identity)?;
                settled_request_ids.insert(identity.request_id);
            }
            _ => {}
        }
        prior_records.insert(record.record_id.clone(), record);
    }
    Ok(())
}

fn validate_public_request_settlement_refs(
    records: &HashMap<String, &SessionKernelPersistenceRecordV3>,
    settlement: &PersistedPublicRequestSettlementIdentityV3,
) -> Result<(), HostV2StorageError> {
    let checkpoint = resolve_exact_record_ref(records, &settlement.checkpoint_ref)?;
    if checkpoint.record_kind != SessionKernelPersistenceRecordKindV3::Checkpoint {
        return Err(public_request_settlement_ref_conflict());
    }
    let checkpoint_data = decode_compact_checkpoint_record(checkpoint)?;
    let expected_scope = SessionKernelCheckpointCommitScopeV3::PublicRequestSettlement {
        request_id: settlement.request_id.clone(),
        request_digest: settlement.request_digest.clone(),
        outcome_digest: settlement.outcome_digest.clone(),
    };
    if checkpoint_data.commit_scope != expected_scope {
        return Err(public_request_settlement_ref_conflict());
    }
    for projection_ref in &settlement.projection_refs {
        let projection = resolve_exact_record_ref(records, projection_ref)?;
        if projection.record_kind != SessionKernelPersistenceRecordKindV3::Projection
            || decode_projection_record(projection)?.commit_scope != expected_scope
        {
            return Err(public_request_settlement_ref_conflict());
        }
    }
    Ok(())
}

fn resolve_exact_record_ref<'a>(
    records: &HashMap<String, &'a SessionKernelPersistenceRecordV3>,
    record_ref: &SessionProviderTurnRecordRefV3,
) -> Result<&'a SessionKernelPersistenceRecordV3, HostV2StorageError> {
    records
        .get(&record_ref.record_id)
        .copied()
        .filter(|record| record.record_digest == record_ref.record_digest)
        .ok_or_else(public_request_settlement_ref_conflict)
}

fn public_request_settlement_ref_conflict() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "session_kernel_public_request_settlement_ref_conflict",
        "Public request settlement refs do not bind prior immutable records with the exact commit scope",
    )
}

fn validate_provider_turn_history<'a>(
    records: impl IntoIterator<Item = &'a SessionKernelPersistenceRecordV3>,
) -> Result<(), HostV2StorageError> {
    let mut dispatches = HashMap::<
        String,
        (
            SessionProviderTurnRecordRefV3,
            SessionProviderTurnDispatchDataV3,
        ),
    >::new();
    let mut terminals = HashSet::<String>::new();
    for record in records {
        match record.record_kind {
            SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch => {
                let data = validate_provider_turn_dispatch_record(record, &record.run_id)?;
                if dispatches
                    .insert(
                        data.provider_turn_id.clone(),
                        (
                            SessionProviderTurnRecordRefV3 {
                                record_id: record.record_id.clone(),
                                record_digest: record.record_digest.clone(),
                            },
                            data,
                        ),
                    )
                    .is_some()
                {
                    return Err(HostV2StorageError::conflict(
                        "provider_dispatch_duplicate",
                        "Provider turn has more than one durable dispatch",
                    ));
                }
            }
            SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal => {
                let data = validate_provider_turn_terminal_record(record, &record.run_id)?;
                let Some((dispatch_ref, dispatch)) = dispatches.get(&data.provider_turn_id) else {
                    return Err(HostV2StorageError::conflict(
                        "provider_terminal_dispatch_missing",
                        "Provider terminal precedes or lacks its durable dispatch",
                    ));
                };
                validate_provider_authority_binding(&data.authority_binding, dispatch.purpose)?;
                if data.dispatch_ref != *dispatch_ref
                    || data.authority_binding != dispatch.authority_binding
                    || !terminals.insert(data.provider_turn_id)
                {
                    return Err(HostV2StorageError::conflict(
                        "provider_terminal_dispatch_conflict",
                        "Provider terminal does not exactly settle one durable dispatch",
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_operation_result_record(
    record: &SessionKernelPersistenceRecordV3,
    session_id: &str,
    run_id: &str,
) -> Result<(), HostV2StorageError> {
    let object = record.data.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_operation_result_invalid",
            "Session Kernel operation result data must be an object",
        )
    })?;
    let expected_keys = [
        "operationRequestId",
        "result",
        "resultDigest",
        "schemaVersion",
    ];
    if object.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !object.contains_key(*key))
        || object.get("schemaVersion").and_then(Value::as_str)
            != Some(SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA)
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_operation_result_invalid",
            "Session Kernel operation result has an invalid strict envelope",
        ));
    }
    let operation_request_id = object
        .get("operationRequestId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_operation_result_invalid",
                "Session Kernel operation result has no operationRequestId",
            )
        })?;
    validate_bounded_identity(operation_request_id, "operationRequestId", 512)?;
    if record.record_id
        != format!("session-kernel-v3:{run_id}:operation-result:{operation_request_id}")
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_operation_result_identity_mismatch",
            "Session Kernel operation result recordId does not bind its operationRequestId",
        ));
    }
    let result = object.get("result").ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_operation_result_invalid",
            "Session Kernel operation result payload is missing",
        )
    })?;
    let result_object = result.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_operation_result_invalid",
            "Session Kernel operation result payload must be an object",
        )
    })?;
    if result_object.get("ok").and_then(Value::as_bool) != Some(true)
        || result_object.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || result_object.get("runId").and_then(Value::as_str) != Some(run_id)
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_operation_result_identity_mismatch",
            "Session Kernel operation result payload belongs to another Session or Run",
        ));
    }
    let result_digest = object
        .get("resultDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_operation_result_invalid",
                "Session Kernel operation result has no resultDigest",
            )
        })?;
    validate_bounded_identity(result_digest, "resultDigest", 512)?;
    if canonical_sha256(result)? != result_digest {
        return Err(HostV2StorageError::invalid(
            "session_kernel_operation_result_digest_mismatch",
            "Session Kernel operation result failed digest verification",
        ));
    }
    Ok(())
}

fn require_store_header(
    record: &SessionKernelPersistenceRecordV3,
    run_id: &str,
) -> Result<(), HostV2StorageError> {
    if record.record_kind != SessionKernelPersistenceRecordKindV3::StoreHeader
        || record.record_id != format!("session-kernel-v3:{run_id}:store")
        || record.data
            != json!({
                "schemaVersion": SESSION_KERNEL_PERSISTENCE_V3_SCHEMA
            })
    {
        return Err(HostV2StorageError::conflict(
            "session_kernel_persistence_history_unsupported",
            "Session Kernel persistence stream requires the exact v3 store header",
        ));
    }
    Ok(())
}

fn read_bounded_json_lines(path: &FsPath) -> Result<Vec<Value>, HostV2StorageError> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(HostV2StorageError::io(
                "host_v2_storage_read_failed",
                format!("open Host v2 JSONL stream: {error}"),
            ))
        }
    };
    let size = file.metadata().map_err(|error| {
        HostV2StorageError::io(
            "host_v2_storage_read_failed",
            format!("inspect Host v2 JSONL stream: {error}"),
        )
    })?;
    if size.len() > MAX_STORE_FILE_BYTES {
        return Err(HostV2StorageError::conflict(
            "host_v2_storage_limit_exceeded",
            "Host v2 JSONL stream exceeds its bounded size",
        ));
    }
    let mut values = Vec::new();
    for line in BufReader::new(file).lines() {
        if values.len() >= MAX_STORE_RECORDS {
            return Err(HostV2StorageError::conflict(
                "host_v2_storage_limit_exceeded",
                "Host v2 JSONL stream exceeds its bounded record count",
            ));
        }
        let line = line.map_err(|error| {
            HostV2StorageError::io(
                "host_v2_storage_read_failed",
                format!("read Host v2 JSONL stream: {error}"),
            )
        })?;
        if line.is_empty() || line.len() > MAX_STORE_RECORD_BYTES {
            return Err(HostV2StorageError::conflict(
                "host_v2_storage_record_invalid",
                "Host v2 JSONL stream contains an empty or oversized record",
            ));
        }
        values.push(serde_json::from_str(&line).map_err(|error| {
            HostV2StorageError::conflict(
                "host_v2_storage_record_invalid",
                format!("decode Host v2 JSONL record: {error}"),
            )
        })?);
    }
    Ok(values)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelProjectionEventV2 {
    projection_id: String,
    run_id: String,
    recorded_at: String,
    kind: String,
    data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionKernelHostProjectionRequestV2 {
    schema_version: String,
    session_id: String,
    host_run_id: String,
    projection_id: String,
    projection_digest: String,
    event: SessionKernelProjectionEventV2,
    agent_event: Value,
    timeline: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionKernelHostProjectionReplyV2 {
    schema_version: &'static str,
    projection_id: String,
    projection_digest: String,
    replayed: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostSessionPriorEventsPageQueryV2 {
    continuation: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSessionPriorEventsPageReplyV2 {
    schema_version: &'static str,
    session_id: String,
    host_run_id: String,
    run_id: String,
    source_event_version: u64,
    source_events_digest: String,
    snapshot_digest: String,
    start_event_index: u64,
    end_event_index_exclusive: u64,
    event_count: u64,
    events: Vec<Value>,
    events_digest: String,
    next_continuation: Option<String>,
    page_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSessionPublicAgentEventRecordV2 {
    schema_version: String,
    projection_id: String,
    projection_digest: String,
    agent_event_digest: String,
    agent_event: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSessionPublicTimelineRecordV2 {
    schema_version: String,
    projection_id: String,
    projection_digest: String,
    timeline_revision: u64,
    source_event_version: u64,
    timeline_digest: String,
    timeline: Value,
}

#[derive(Clone)]
pub(crate) struct SessionKernelProjectionSinkV2 {
    sessions_dir: Arc<PathBuf>,
    active_runs: HostActiveRunBrokerV2,
    projections: Arc<Mutex<HashMap<String, BTreeMap<String, (String, Value)>>>>,
    prior_event_prefixes: Arc<Mutex<HashMap<String, Arc<Vec<Value>>>>>,
}

impl SessionKernelProjectionSinkV2 {
    pub(crate) fn new(sessions_dir: PathBuf, active_runs: HostActiveRunBrokerV2) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            active_runs,
            projections: Arc::new(Mutex::new(HashMap::new())),
            prior_event_prefixes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn publish(
        &self,
        session_id: &str,
        host_run_id: &str,
        capability: &RunCapabilityV2,
        request: SessionKernelHostProjectionRequestV2,
    ) -> Result<SessionKernelHostProjectionReplyV2, HostV2StorageError> {
        validate_projection_request(&request, session_id, host_run_id)?;
        let active = self.active_runs.resolve(session_id, host_run_id)?;
        if active.run_id != request.event.run_id {
            return Err(HostV2StorageError::invalid(
                "session_kernel_projection_run_mismatch",
                "Session Kernel projection belongs to another Kernel Run",
            ));
        }
        self.active_runs.authorize_host_run_transport(
            session_id,
            host_run_id,
            &request.event.run_id,
            capability,
        )?;
        let path = self.projection_path(session_id, host_run_id)?;
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        let replayed = with_storage_path_lock(&guard_path, || {
            self.preflight_public_projection(session_id, &request)?;
            let replayed = if projection_request_replayed(&path, session_id, host_run_id, &request)?
            {
                true
            } else {
                self.preflight_public_projection_appends(session_id, host_run_id, &request, false)?;
                append_json_line_durable(
                    &path,
                    &serde_json::to_value(&request).map_err(|error| {
                        HostV2StorageError::invalid(
                            "session_kernel_projection_record_invalid",
                            format!("encode Host projection record: {error}"),
                        )
                    })?,
                )?;
                false
            };
            if replayed {
                self.preflight_public_projection_appends(session_id, host_run_id, &request, true)?;
            }
            self.publish_agent_event_locked(session_id, &request)?;
            self.publish_timeline_locked(session_id, &request)?;
            Ok(replayed)
        })?;
        self.remember_projection(session_id, host_run_id, &request)?;
        Ok(SessionKernelHostProjectionReplyV2 {
            schema_version: SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA,
            projection_id: request.projection_id,
            projection_digest: request.projection_digest,
            replayed,
        })
    }

    pub(crate) fn require_durable_run_cancelled_projection(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        projection_id: &str,
        projection_digest: &str,
        expected_data: &Value,
    ) -> Result<(), HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        for (field, value) in [
            ("hostRunId", host_run_id),
            ("runId", run_id),
            ("projectionId", projection_id),
        ] {
            validate_bounded_identity(value, field, 512)?;
        }
        validate_sha256_digest(projection_digest, "projectionDigest")?;
        reject_transport_capabilities(expected_data)?;
        let projection_path = self.projection_path(session_id, host_run_id)?;
        let mut durable_projection = None;
        for value in read_bounded_json_lines(&projection_path)? {
            let request: SessionKernelHostProjectionRequestV2 = serde_json::from_value(value)
                .map_err(|_| {
                    HostV2StorageError::conflict(
                        "session_kernel_projection_record_invalid",
                        "Host projection store contains an invalid strict v2 record",
                    )
                })?;
            validate_projection_request(&request, session_id, host_run_id)?;
            if request.projection_id == projection_id {
                durable_projection = Some(request);
                break;
            }
        }
        let request = durable_projection.ok_or_else(|| {
            HostV2StorageError::not_found(
                "session_kernel_cancel_projection_missing",
                "Canonical Session cancellation projection is not durable in the Host",
            )
        })?;
        if request.projection_digest != projection_digest
            || request.event.projection_id != projection_id
            || request.event.run_id != run_id
            || request.event.kind != "run.cancelled"
            || &request.event.data != expected_data
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_cancel_projection_conflict",
                "Canonical Session cancellation projection changed exact identity or content",
            ));
        }
        let agent_path = public_agent_event_path(self.sessions_dir.as_ref(), session_id)?;
        let mut public_agent_event = None;
        for value in read_bounded_json_lines(&agent_path)? {
            let record = decode_public_agent_event_record(value, session_id)?;
            if record.projection_id == projection_id {
                public_agent_event = Some(record);
                break;
            }
        }
        let public_agent_event = public_agent_event.ok_or_else(|| {
            HostV2StorageError::not_found(
                "session_kernel_cancel_public_event_missing",
                "Canonical Session cancellation AgentEvent is not durable",
            )
        })?;
        if public_agent_event.projection_digest != projection_digest
            || public_agent_event.agent_event != request.agent_event
            || public_agent_event
                .agent_event
                .get("kind")
                .and_then(Value::as_str)
                != Some("session_run_state")
            || public_agent_event
                .agent_event
                .pointer("/payload/projectionKind")
                .and_then(Value::as_str)
                != Some("run.cancelled")
            || public_agent_event
                .agent_event
                .pointer("/payload/status")
                .and_then(Value::as_str)
                != Some("cancelled")
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_cancel_public_event_conflict",
                "Canonical Session cancellation AgentEvent does not match its Host projection",
            ));
        }
        let timeline_path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
        let timeline = read_public_timeline_records(&timeline_path, session_id)?
            .into_iter()
            .find(|record| record.projection_id == projection_id)
            .ok_or_else(|| {
                HostV2StorageError::not_found(
                    "session_kernel_cancel_public_timeline_missing",
                    "Canonical Session cancellation timeline is not durable",
                )
            })?;
        if timeline.projection_digest != projection_digest
            || timeline
                .timeline
                .pointer("/runProjection/runId")
                .and_then(Value::as_str)
                != Some(run_id)
            || timeline
                .timeline
                .pointer("/runProjection/status")
                .and_then(Value::as_str)
                != Some("cancelled")
            || timeline
                .timeline
                .pointer("/runProjection/phase")
                .and_then(Value::as_str)
                != Some("settled")
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_cancel_public_timeline_conflict",
                "Canonical Session cancellation timeline has conflicting identity or terminal state",
            ));
        }
        Ok(())
    }

    fn prior_events_page(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        frozen: &HostSessionPriorEventsV2,
        continuation: Option<&str>,
    ) -> Result<HostSessionPriorEventsPageReplyV2, HostV2StorageError> {
        frozen.validate(session_id)?;
        self.active_runs.authorize_host_run_transport(
            session_id,
            host_run_id,
            run_id,
            capability,
        )?;
        let (cache_key, source_events) =
            self.frozen_prior_event_prefix(session_id, host_run_id, run_id, frozen)?;
        let frozen_count = source_events.len();
        let start = decode_prior_events_continuation(
            continuation,
            session_id,
            host_run_id,
            run_id,
            frozen,
        )?;
        if start > frozen_count {
            return Err(HostV2StorageError::invalid(
                "host_session_prior_events_continuation_invalid",
                "Prior Session event continuation exceeds the frozen prefix",
            ));
        }
        let mut events = Vec::new();
        let mut encoded_bytes = 2usize;
        for event in source_events
            .iter()
            .skip(start)
            .take(MAX_PRIOR_EVENTS_PAGE_COUNT_V2)
        {
            let separator_bytes = usize::from(!events.is_empty());
            let event_bytes = canonical_json_bytes(event)?.len();
            let candidate_bytes = encoded_bytes
                .saturating_add(separator_bytes)
                .saturating_add(event_bytes);
            if events.is_empty() && candidate_bytes > MAX_PRIOR_EVENTS_SINGLE_EVENT_PAGE_BYTES_V2 {
                return Err(HostV2StorageError::invalid(
                    "host_session_prior_event_projection_limit_exceeded",
                    "A prior Session event exceeds the bounded projection page limit",
                ));
            }
            if !events.is_empty() && candidate_bytes > MAX_PRIOR_EVENTS_PAGE_BYTES_V2 {
                break;
            }
            events.push(event.clone());
            encoded_bytes = candidate_bytes;
        }
        let end = start.checked_add(events.len()).ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_session_prior_events_index_invalid",
                "Prior Session event page index is exhausted",
            )
        })?;
        let start_event_index = u64::try_from(start).map_err(|_| {
            HostV2StorageError::conflict(
                "host_session_prior_events_index_invalid",
                "Prior Session event page index is not representable",
            )
        })?;
        let end_event_index_exclusive = u64::try_from(end).map_err(|_| {
            HostV2StorageError::conflict(
                "host_session_prior_events_index_invalid",
                "Prior Session event page index is not representable",
            )
        })?;
        let event_count = u64::try_from(events.len()).map_err(|_| {
            HostV2StorageError::conflict(
                "host_session_prior_events_count_invalid",
                "Prior Session event page count is not representable",
            )
        })?;
        let events_digest = canonical_sha256(&Value::Array(events.clone()))?;
        let next_continuation = if end < frozen_count {
            Some(prior_events_continuation(
                end,
                session_id,
                host_run_id,
                run_id,
                frozen,
            )?)
        } else {
            None
        };
        let page_digest = canonical_sha256(&json!({
            "schemaVersion": HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA,
            "sessionId": session_id,
            "hostRunId": host_run_id,
            "runId": run_id,
            "sourceEventVersion": frozen.source_event_version,
            "sourceEventsDigest": frozen.source_events_digest,
            "snapshotDigest": frozen.snapshot_digest,
            "startEventIndex": start_event_index,
            "endEventIndexExclusive": end_event_index_exclusive,
            "eventCount": event_count,
            "events": events,
            "eventsDigest": events_digest,
            "nextContinuation": next_continuation,
        }))?;
        if next_continuation.is_none() {
            if let Ok(mut prefixes) = self.prior_event_prefixes.lock() {
                prefixes.remove(&cache_key);
            }
        }
        Ok(HostSessionPriorEventsPageReplyV2 {
            schema_version: HOST_SESSION_PRIOR_EVENTS_PAGE_V2_SCHEMA,
            session_id: session_id.to_string(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
            source_event_version: frozen.source_event_version,
            source_events_digest: frozen.source_events_digest.clone(),
            snapshot_digest: frozen.snapshot_digest.clone(),
            start_event_index,
            end_event_index_exclusive,
            event_count,
            events,
            events_digest,
            next_continuation,
            page_digest,
        })
    }

    fn frozen_prior_event_prefix(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        frozen: &HostSessionPriorEventsV2,
    ) -> Result<(String, Arc<Vec<Value>>), HostV2StorageError> {
        let cache_key = canonical_sha256(&json!({
            "schemaVersion": "deepcode.host.session-prior-events-cache-key.v2",
            "sessionId": session_id,
            "hostRunId": host_run_id,
            "runId": run_id,
            "snapshotDigest": frozen.snapshot_digest,
        }))?;
        if let Some(events) = self
            .prior_event_prefixes
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_session_prior_events_cache_unavailable",
                    "Prior Session event cache is unavailable",
                )
            })?
            .get(&cache_key)
            .cloned()
        {
            return Ok((cache_key, events));
        }
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        let source_events = with_storage_path_lock(&guard_path, || {
            let durable = read_session_kernel_v2_public_agent_events_unlocked(
                self.sessions_dir.as_ref(),
                session_id,
            )?;
            let frozen_count = usize::try_from(frozen.source_event_version).map_err(|_| {
                HostV2StorageError::conflict(
                    "host_session_prior_events_version_invalid",
                    "Frozen prior Session event version is not representable",
                )
            })?;
            if durable.len() < frozen_count {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_events_prefix_missing",
                    "Durable Session history no longer covers the frozen Run prefix",
                ));
            }
            let source_events = durable[..frozen_count].to_vec();
            let source_value = Value::Array(source_events.clone());
            if canonical_json_bytes(&source_value)?.len() > MAX_PRIOR_EVENTS_PROJECTION_BYTES_V2 {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_events_projection_limit_exceeded",
                    "Frozen Session history exceeds the bounded full-timeline projection limit",
                ));
            }
            if canonical_sha256(&source_value)? != frozen.source_events_digest {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_events_source_digest_mismatch",
                    "Durable Session history does not match the Run-bound frozen prefix",
                ));
            }
            let suffix_start = frozen_count
                .checked_sub(frozen.events.len())
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_session_prior_events_suffix_invalid",
                        "Frozen prior Session event suffix is inconsistent",
                    )
                })?;
            if source_events[suffix_start..] != frozen.events {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_events_suffix_mismatch",
                    "Durable Session history does not match the bounded Run bootstrap suffix",
                ));
            }
            Ok(Arc::new(source_events))
        })?;
        let mut prefixes = self.prior_event_prefixes.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_session_prior_events_cache_unavailable",
                "Prior Session event cache is unavailable",
            )
        })?;
        if prefixes.len() >= MAX_PRIOR_EVENTS_PAGE_CACHE_V2 {
            if let Some(oldest_key) = prefixes.keys().next().cloned() {
                prefixes.remove(&oldest_key);
            }
        }
        let events = prefixes
            .entry(cache_key.clone())
            .or_insert_with(|| Arc::clone(&source_events))
            .clone();
        Ok((cache_key, events))
    }

    pub(crate) fn status(&self) -> Value {
        let (run_count, projection_count) = self
            .projections
            .lock()
            .map(|projections| {
                (
                    projections.len(),
                    projections.values().map(BTreeMap::len).sum::<usize>(),
                )
            })
            .unwrap_or_default();
        json!({
            "status": "ready",
            "cachedRunCount": run_count,
            "cachedProjectionCount": projection_count
        })
    }

    fn preflight_public_projection(
        &self,
        session_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
    ) -> Result<(), HostV2StorageError> {
        let incoming_event_id = public_agent_event_id(&request.agent_event)?;
        let events = read_session_kernel_v2_public_agent_events_unlocked(
            self.sessions_dir.as_ref(),
            session_id,
        )?;
        let (anticipated_event_count, agent_event_replayed) = match events
            .iter()
            .find(|event| public_agent_event_id(event).ok() == Some(incoming_event_id))
        {
            Some(existing) if existing == &request.agent_event => (events.len() as u64, true),
            Some(_) => {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_event_identity_conflict",
                    "Session public AgentEvent id has different durable content",
                ))
            }
            None => (
                (events.len() as u64).checked_add(1).ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "session_kernel_public_event_limit",
                        "Session public AgentEvent count is exhausted",
                    )
                })?,
                false,
            ),
        };
        let incoming = public_timeline_record(request)?;
        let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
        let records = read_public_timeline_records(&path, session_id)?;
        if let Some(existing) = records
            .iter()
            .find(|record| record.projection_id == request.projection_id)
        {
            if existing == &incoming && agent_event_replayed {
                return Ok(());
            }
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_identity_conflict",
                "Session public timeline projection has different durable content",
            ));
        }
        if incoming.source_event_version != anticipated_event_count {
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_event_gap",
                "Session public timeline does not cover the exact durable AgentEvent prefix",
            ));
        }
        if let Some(latest) = records.last() {
            if incoming.timeline_revision <= latest.timeline_revision
                || incoming.source_event_version <= latest.source_event_version
            {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_timeline_stale",
                    "Session public timeline revision cannot replace a newer durable snapshot",
                ));
            }
        }
        validate_preserved_legacy_prefix(&records, &request.timeline)?;
        Ok(())
    }

    fn preflight_public_projection_appends(
        &self,
        session_id: &str,
        host_run_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
        host_projection_replayed: bool,
    ) -> Result<(), HostV2StorageError> {
        let projection_path = self.projection_path(session_id, host_run_id)?;
        if !host_projection_replayed {
            let projection_value = serde_json::to_value(request).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_projection_record_invalid",
                    format!("encode Host projection record: {error}"),
                )
            })?;
            let record_count = read_bounded_json_lines(&projection_path)?.len();
            preflight_projection_store_append(&projection_path, record_count, &projection_value)?;
        }

        let agent_record = HostSessionPublicAgentEventRecordV2 {
            schema_version: HOST_SESSION_PUBLIC_AGENT_EVENT_V2_SCHEMA.to_string(),
            projection_id: request.projection_id.clone(),
            projection_digest: request.projection_digest.clone(),
            agent_event_digest: canonical_sha256(&request.agent_event)?,
            agent_event: request.agent_event.clone(),
        };
        let agent_path = public_agent_event_path(self.sessions_dir.as_ref(), session_id)?;
        let agent_values = read_bounded_json_lines(&agent_path)?;
        let mut agent_replayed = false;
        for value in &agent_values {
            let existing = decode_public_agent_event_record(value.clone(), session_id)?;
            if public_agent_event_id(&existing.agent_event)?
                == public_agent_event_id(&agent_record.agent_event)?
            {
                if existing != agent_record {
                    return Err(HostV2StorageError::conflict(
                        "session_kernel_public_event_identity_conflict",
                        "Session public AgentEvent id has different durable content",
                    ));
                }
                agent_replayed = true;
                break;
            }
        }
        if !agent_replayed {
            let agent_value = serde_json::to_value(&agent_record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_public_event_invalid",
                    format!("encode Session public AgentEvent: {error}"),
                )
            })?;
            preflight_projection_store_append(&agent_path, agent_values.len(), &agent_value)?;
        }

        let timeline_record = public_timeline_record(request)?;
        let timeline_path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
        let timeline_records = read_public_timeline_records(&timeline_path, session_id)?;
        let timeline_replayed = timeline_records
            .iter()
            .find(|existing| existing.projection_id == request.projection_id)
            .is_some_and(|existing| existing == &timeline_record);
        if !timeline_replayed {
            let timeline_value = serde_json::to_value(&timeline_record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_public_timeline_invalid",
                    format!("encode Session public timeline: {error}"),
                )
            })?;
            preflight_projection_store_append(
                &timeline_path,
                timeline_records.len(),
                &timeline_value,
            )?;
        }
        Ok(())
    }

    fn publish_agent_event_locked(
        &self,
        session_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
    ) -> Result<(), HostV2StorageError> {
        let record = HostSessionPublicAgentEventRecordV2 {
            schema_version: HOST_SESSION_PUBLIC_AGENT_EVENT_V2_SCHEMA.to_string(),
            projection_id: request.projection_id.clone(),
            projection_digest: request.projection_digest.clone(),
            agent_event_digest: canonical_sha256(&request.agent_event)?,
            agent_event: request.agent_event.clone(),
        };
        let path = public_agent_event_path(self.sessions_dir.as_ref(), session_id)?;
        for value in read_bounded_json_lines(&path)? {
            let existing = decode_public_agent_event_record(value, session_id)?;
            if public_agent_event_id(&existing.agent_event)?
                == public_agent_event_id(&record.agent_event)?
            {
                if existing == record {
                    return Ok(());
                }
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_event_identity_conflict",
                    "Session public AgentEvent id has different durable content",
                ));
            }
        }
        append_json_line_durable(
            &path,
            &serde_json::to_value(record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_public_event_invalid",
                    format!("encode Session public AgentEvent: {error}"),
                )
            })?,
        )
    }

    fn publish_timeline_locked(
        &self,
        session_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
    ) -> Result<(), HostV2StorageError> {
        let record = public_timeline_record(request)?;
        let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
        let records = read_public_timeline_records(&path, session_id)?;
        if let Some(existing) = records
            .iter()
            .find(|existing| existing.projection_id == request.projection_id)
        {
            if existing == &record {
                return Ok(());
            }
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_identity_conflict",
                "Session public timeline projection has different durable content",
            ));
        }
        append_json_line_durable(
            &path,
            &serde_json::to_value(record).map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_public_timeline_invalid",
                    format!("encode Session public timeline: {error}"),
                )
            })?,
        )
    }

    pub(crate) fn latest_timeline(
        &self,
        session_id: &str,
    ) -> Result<Option<Value>, HostV2StorageError> {
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        with_storage_path_lock(&guard_path, || {
            let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
            let records = read_public_timeline_records(&path, session_id)?;
            records
                .last()
                .map(|record| normalize_latest_public_timeline(&record.timeline))
                .transpose()
        })
    }

    pub(crate) fn latest_timeline_for_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<Value>, HostV2StorageError> {
        validate_bounded_identity(run_id, "runId", 512)?;
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        with_storage_path_lock(&guard_path, || {
            let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
            let records = read_public_timeline_records(&path, session_id)?;
            records
                .iter()
                .rev()
                .find(|record| {
                    record
                        .timeline
                        .get("runProjection")
                        .and_then(Value::as_object)
                        .and_then(|run| run.get("runId"))
                        .and_then(Value::as_str)
                        == Some(run_id)
                })
                .map(|record| normalize_latest_public_timeline(&record.timeline))
                .transpose()
        })
    }

    pub(crate) fn frozen_prior_timeline(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        frozen: &HostSessionPriorEventsV2,
    ) -> Result<Option<Value>, HostV2StorageError> {
        frozen.validate(session_id)?;
        self.active_runs.authorize_host_run_transport(
            session_id,
            host_run_id,
            run_id,
            capability,
        )?;
        let (_, source_events) =
            self.frozen_prior_event_prefix(session_id, host_run_id, run_id, frozen)?;
        if u64::try_from(source_events.len()).ok() != Some(frozen.source_event_version) {
            return Err(HostV2StorageError::conflict(
                "host_session_prior_timeline_event_prefix_mismatch",
                "Run-bound prior Session timeline does not match the frozen event prefix",
            ));
        }
        if frozen.source_event_version == 0 {
            return Ok(None);
        }
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        with_storage_path_lock(&guard_path, || {
            let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
            let records = read_public_timeline_records(&path, session_id)?;
            let record = records
                .iter()
                .find(|record| record.source_event_version == frozen.source_event_version)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_session_prior_timeline_missing",
                        "Run-bound prior Session timeline is missing its frozen event version",
                    )
                })?;
            if timeline_u64(&record.timeline, "eventCount")? != frozen.source_event_version {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_timeline_event_count_mismatch",
                    "Run-bound prior Session timeline does not cover the exact frozen event prefix",
                ));
            }
            let timeline = normalize_latest_public_timeline(&record.timeline)?;
            let run_projection = timeline
                .get("runProjection")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_session_prior_timeline_state_invalid",
                        "Run-bound prior Session timeline has no canonical Run projection",
                    )
                })?;
            if run_projection.get("phase").and_then(Value::as_str) != Some("settled")
                || !matches!(
                    run_projection.get("status").and_then(Value::as_str),
                    Some("succeeded" | "failed" | "cancelled")
                )
            {
                return Err(HostV2StorageError::conflict(
                    "host_session_prior_timeline_not_terminal",
                    "Run-bound prior Session timeline is not terminal and settled",
                ));
            }
            Ok(Some(timeline))
        })
    }

    fn remember_projection(
        &self,
        session_id: &str,
        host_run_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
    ) -> Result<(), HostV2StorageError> {
        let key = format!("{session_id}\0{host_run_id}");
        let mapped = request.agent_event.clone();
        let mut projections = self.projections.lock().map_err(|_| {
            HostV2StorageError::io(
                "session_kernel_projection_cache_unavailable",
                "Session Kernel projection cache is unavailable",
            )
        })?;
        let run = projections.entry(key).or_default();
        if let Some((digest, _)) = run.get(&request.projection_id) {
            if digest != &request.projection_digest {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_projection_identity_conflict",
                    "Session Kernel projection cache has different immutable content",
                ));
            }
            return Ok(());
        }
        run.insert(
            request.projection_id.clone(),
            (request.projection_digest.clone(), mapped),
        );
        Ok(())
    }

    fn projection_path(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<PathBuf, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        Ok(self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join("host-projections")
            .join(format!("{}.jsonl", sha256_path_component(host_run_id))))
    }
}

fn preflight_projection_store_append(
    path: &FsPath,
    record_count: usize,
    value: &Value,
) -> Result<(), HostV2StorageError> {
    preflight_store_append(path, record_count, value).map_err(|error| {
        if matches!(
            error.code,
            "host_v2_storage_limit_exceeded" | "host_v2_storage_record_invalid"
        ) {
            HostV2StorageError::conflict(
                "session_kernel_projection_limit_exceeded",
                "Session projection would exceed the bounded durable Host projection store",
            )
        } else {
            error
        }
    })
}

fn projection_request_replayed(
    path: &FsPath,
    session_id: &str,
    host_run_id: &str,
    request: &SessionKernelHostProjectionRequestV2,
) -> Result<bool, HostV2StorageError> {
    for value in read_bounded_json_lines(path)? {
        let existing: SessionKernelHostProjectionRequestV2 = serde_json::from_value(value)
            .map_err(|error| {
                HostV2StorageError::conflict(
                    "session_kernel_projection_history_corrupt",
                    format!("decode Host projection record: {error}"),
                )
            })?;
        validate_projection_request(&existing, session_id, host_run_id).map_err(|error| {
            HostV2StorageError::conflict("session_kernel_projection_history_corrupt", error.message)
        })?;
        if existing.projection_id != request.projection_id {
            continue;
        }
        if existing.projection_digest == request.projection_digest
            && existing.event == request.event
            && existing.agent_event == request.agent_event
            && existing.timeline == request.timeline
        {
            return Ok(true);
        }
        return Err(HostV2StorageError::conflict(
            "session_kernel_projection_identity_conflict",
            "Session Kernel projectionId has different durable content",
        ));
    }
    Ok(false)
}

fn validate_projection_request(
    request: &SessionKernelHostProjectionRequestV2,
    session_id: &str,
    host_run_id: &str,
) -> Result<(), HostV2StorageError> {
    if request.schema_version != SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_schema_unsupported",
            "Session Kernel projection request has an unsupported schema",
        ));
    }
    if request.session_id != session_id
        || request.host_run_id != host_run_id
        || request.projection_id != request.event.projection_id
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_identity_mismatch",
            "Session Kernel projection identities do not match the route or event",
        ));
    }
    validate_safe_session_identity(session_id)?;
    for (field, value) in [
        ("hostRunId", host_run_id),
        ("projectionId", request.projection_id.as_str()),
        ("projectionDigest", request.projection_digest.as_str()),
        ("runId", request.event.run_id.as_str()),
        ("recordedAt", request.event.recorded_at.as_str()),
    ] {
        validate_bounded_identity(value, field, 512)?;
    }
    if !matches!(
        request.event.kind.as_str(),
        "plan.persisted"
            | "plan.decided"
            | "input.persisted"
            | "scope.previewed"
            | "provider.started"
            | "provider.composing"
            | "provider.completed"
            | "provider.stale"
            | "toolIntent.submitted"
            | "capability.awaiting"
            | "kernelFacts.reconciled"
            | "authorization.decided"
            | "review.revised"
            | "planAction.skipped"
            | "planAction.completed"
            | "run.cancelled"
            | "wait.changed"
            | "diagnostic"
    ) {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_kind_invalid",
            "Session Kernel projection kind is not supported",
        ));
    }
    let event = serde_json::to_value(&request.event).map_err(|error| {
        HostV2StorageError::invalid(
            "session_kernel_projection_record_invalid",
            format!("encode Session Kernel projection event: {error}"),
        )
    })?;
    reject_transport_capabilities(&event)?;
    validate_public_agent_event(
        &request.agent_event,
        session_id,
        Some((&request.projection_id, &request.event.recorded_at)),
    )?;
    reject_transport_capabilities(&request.timeline)?;
    crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
        &request.timeline,
    )
    .map_err(|message| {
        HostV2StorageError::invalid("session_kernel_public_timeline_invalid", message)
    })?;
    if request.timeline.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_timeline_identity_mismatch",
            "Session public timeline belongs to another Session",
        ));
    }
    let projection_payload = json!({
        "event": event,
        "agentEvent": request.agent_event,
        "timeline": request.timeline
    });
    if canonical_sha256(&projection_payload)? != request.projection_digest {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_digest_mismatch",
            "Session Kernel projection failed digest verification",
        ));
    }
    Ok(())
}

fn prior_events_continuation(
    next_event_index: usize,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
    frozen: &HostSessionPriorEventsV2,
) -> Result<String, HostV2StorageError> {
    let digest = canonical_sha256(&json!({
        "schemaVersion": "deepcode.host.session-prior-events-continuation.v2",
        "sessionId": session_id,
        "hostRunId": host_run_id,
        "runId": run_id,
        "sourceEventVersion": frozen.source_event_version,
        "sourceEventsDigest": frozen.source_events_digest,
        "snapshotDigest": frozen.snapshot_digest,
        "nextEventIndex": next_event_index,
    }))?;
    Ok(format!(
        "v2.{next_event_index}.{}",
        digest.strip_prefix("sha256:").unwrap_or(&digest)
    ))
}

fn decode_prior_events_continuation(
    continuation: Option<&str>,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
    frozen: &HostSessionPriorEventsV2,
) -> Result<usize, HostV2StorageError> {
    let Some(continuation) = continuation else {
        return Ok(0);
    };
    validate_bounded_identity(continuation, "continuation", 256)?;
    let mut fields = continuation.split('.');
    if fields.next() != Some("v2") {
        return Err(HostV2StorageError::invalid(
            "host_session_prior_events_continuation_invalid",
            "Prior Session event continuation is invalid",
        ));
    }
    let index = fields
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_session_prior_events_continuation_invalid",
                "Prior Session event continuation is invalid",
            )
        })?;
    if fields.next().is_none() || fields.next().is_some() {
        return Err(HostV2StorageError::invalid(
            "host_session_prior_events_continuation_invalid",
            "Prior Session event continuation is invalid",
        ));
    }
    if prior_events_continuation(index, session_id, host_run_id, run_id, frozen)? != continuation {
        return Err(HostV2StorageError::invalid(
            "host_session_prior_events_continuation_invalid",
            "Prior Session event continuation does not match the frozen Run prefix",
        ));
    }
    Ok(index)
}

pub(crate) fn read_session_kernel_v2_public_agent_events(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<Vec<Value>, HostV2StorageError> {
    let guard_path = public_projection_guard_path(sessions_dir, session_id)?;
    with_storage_path_lock(&guard_path, || {
        read_session_kernel_v2_public_agent_events_unlocked(sessions_dir, session_id)
    })
}

fn read_session_kernel_v2_public_agent_events_unlocked(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<Vec<Value>, HostV2StorageError> {
    let path = public_agent_event_path(sessions_dir, session_id)?;
    let mut events = Vec::new();
    let mut events_by_id = HashMap::new();
    for value in read_bounded_json_lines(&path)? {
        let record = decode_public_agent_event_record(value, session_id)?;
        let event_id = public_agent_event_id(&record.agent_event)?.to_string();
        if let Some(existing) = events_by_id.get(&event_id) {
            if existing != &record.agent_event {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_event_identity_conflict",
                    "Session public AgentEvent history has conflicting event content",
                ));
            }
            continue;
        }
        events_by_id.insert(event_id, record.agent_event.clone());
        events.push(record.agent_event);
    }
    Ok(events)
}

fn public_projection_guard_path(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<PathBuf, HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    Ok(sessions_dir
        .join(session_id)
        .join("kernel-v2")
        .join(".public-projection-v2.lock"))
}

fn public_agent_event_path(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<PathBuf, HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    Ok(sessions_dir
        .join(session_id)
        .join("kernel-v2")
        .join("public-agent-events.jsonl"))
}

fn public_timeline_path(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<PathBuf, HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    Ok(sessions_dir
        .join(session_id)
        .join("kernel-v2")
        .join("public-timelines.jsonl"))
}

fn read_public_timeline_records(
    path: &FsPath,
    session_id: &str,
) -> Result<Vec<HostSessionPublicTimelineRecordV2>, HostV2StorageError> {
    let mut records: Vec<HostSessionPublicTimelineRecordV2> = Vec::new();
    let mut projections = HashMap::new();
    let mut legacy_prefix: Option<Vec<Value>> = None;
    let mut latest_flat_was_unsupported = false;
    let mut work_segments_shape_seen = false;
    for value in read_bounded_json_lines(path)? {
        let record: HostSessionPublicTimelineRecordV2 =
            serde_json::from_value(value).map_err(|error| {
                HostV2StorageError::conflict(
                    "session_kernel_public_timeline_history_corrupt",
                    format!("decode Session public timeline record: {error}"),
                )
            })?;
        if record.schema_version != HOST_SESSION_PUBLIC_TIMELINE_V2_SCHEMA
            || canonical_sha256(&record.timeline)? != record.timeline_digest
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Session public timeline failed schema or digest validation",
            ));
        }
        reject_transport_capabilities(&record.timeline)?;
        let timeline_kind =
            crate::session_public_projection_v2::classify_shared_projection_timeline(
                &record.timeline,
            )
            .map_err(|message| {
                HostV2StorageError::conflict(
                    "session_kernel_public_timeline_history_corrupt",
                    message,
                )
            })?;
        match timeline_kind {
            crate::session_public_projection_v2::SharedProjectionTimelineKind::LegacyFlatV2 => {
                if work_segments_shape_seen {
                    return Err(HostV2StorageError::conflict(
                        "session_kernel_public_timeline_history_corrupt",
                        "Session public timeline cannot downgrade from work-segments to flat-v2",
                    ));
                }
                latest_flat_was_unsupported = !legacy_flat_projection_is_terminal(&record.timeline);
                legacy_prefix = if latest_flat_was_unsupported {
                    None
                } else {
                    Some(normalized_turns_from_settled_flat(&record.timeline)?)
                };
            }
            crate::session_public_projection_v2::SharedProjectionTimelineKind::NativeWorkSegmentsV1 => {
                if latest_flat_was_unsupported {
                    return Err(HostV2StorageError::conflict(
                        "UnsupportedHistorySchema",
                        "Active flat-v2 Session projection lacks ordered work segments and cannot be resumed",
                    ));
                }
                let compatible_prefix_len =
                    crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
                        &record.timeline,
                    )
                    .map_err(|message| {
                        HostV2StorageError::conflict(
                            "session_kernel_public_timeline_history_corrupt",
                            message,
                        )
                    })?;
                match legacy_prefix.as_deref() {
                    Some(prefix) => ensure_legacy_turn_prefix(
                        &record.timeline,
                        prefix,
                        compatible_prefix_len,
                    )?,
                    None if compatible_prefix_len > 0 => {
                        return Err(HostV2StorageError::conflict(
                            "session_kernel_public_timeline_history_corrupt",
                            "Session public timeline created legacy-compatible turns without a settled flat-v2 source",
                        ))
                    }
                    None => {}
                }
                work_segments_shape_seen = true;
            }
        }
        if record.timeline.get("sessionId").and_then(Value::as_str) != Some(session_id)
            || timeline_u64(&record.timeline, "revision")? != record.timeline_revision
            || timeline_u64(&record.timeline, "sourceEventVersion")? != record.source_event_version
            || timeline_u64(&record.timeline, "eventCount")? > record.source_event_version
        {
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Session public timeline record has inconsistent identity or version",
            ));
        }
        if let Some(existing) = projections.get(&record.projection_id) {
            if existing != &record {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_timeline_identity_conflict",
                    "Session public timeline history has conflicting projection content",
                ));
            }
            continue;
        }
        if let Some(previous) = records.last() {
            if record.timeline_revision <= previous.timeline_revision
                || record.source_event_version <= previous.source_event_version
            {
                return Err(HostV2StorageError::conflict(
                    "session_kernel_public_timeline_history_corrupt",
                    "Session public timeline history is not strictly monotonic",
                ));
            }
        }
        projections.insert(record.projection_id.clone(), record.clone());
        records.push(record);
    }
    Ok(records)
}

fn validate_preserved_legacy_prefix(
    records: &[HostSessionPublicTimelineRecordV2],
    incoming: &Value,
) -> Result<(), HostV2StorageError> {
    let compatible_prefix_len =
        crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
            incoming,
        )
        .map_err(|message| {
            HostV2StorageError::invalid("session_kernel_public_timeline_invalid", message)
        })?;
    let mut legacy_prefix = None;
    let mut latest_flat_was_unsupported = false;
    for record in records {
        match crate::session_public_projection_v2::classify_shared_projection_timeline(
            &record.timeline,
        )
        .map_err(|message| {
            HostV2StorageError::conflict("session_kernel_public_timeline_history_corrupt", message)
        })? {
            crate::session_public_projection_v2::SharedProjectionTimelineKind::LegacyFlatV2 => {
                latest_flat_was_unsupported = !legacy_flat_projection_is_terminal(&record.timeline);
                legacy_prefix = if latest_flat_was_unsupported {
                    None
                } else {
                    Some(normalized_turns_from_settled_flat(&record.timeline)?)
                };
            }
            crate::session_public_projection_v2::SharedProjectionTimelineKind::NativeWorkSegmentsV1 => {
                latest_flat_was_unsupported = false;
            }
        }
    }
    if latest_flat_was_unsupported {
        return Err(HostV2StorageError::conflict(
            "UnsupportedHistorySchema",
            "Active flat-v2 Session projection lacks ordered work segments and cannot be resumed",
        ));
    }
    match legacy_prefix.as_deref() {
        Some(prefix) => ensure_legacy_turn_prefix(incoming, prefix, compatible_prefix_len),
        None if compatible_prefix_len > 0 => Err(HostV2StorageError::invalid(
            "session_kernel_public_timeline_legacy_source_missing",
            "Session public timeline cannot create legacy-compatible turns without a settled flat-v2 source",
        )),
        None => Ok(()),
    }
}

fn normalized_turns_from_settled_flat(timeline: &Value) -> Result<Vec<Value>, HostV2StorageError> {
    let normalized = normalize_settled_legacy_flat_projection(timeline)?;
    normalized
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Settled flat-v2 Session projection does not contain turns",
            )
        })
}

fn ensure_legacy_turn_prefix(
    timeline: &Value,
    legacy_prefix: &[Value],
    compatible_prefix_len: usize,
) -> Result<(), HostV2StorageError> {
    let turns = timeline
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_public_timeline_invalid",
                "Session public timeline does not contain turns",
            )
        })?;
    if compatible_prefix_len != legacy_prefix.len()
        || turns.len() < legacy_prefix.len()
        || turns[..legacy_prefix.len()] != *legacy_prefix
    {
        return Err(HostV2StorageError::conflict(
            "session_kernel_public_timeline_legacy_prefix_changed",
            "Session public timeline changed the immutable settled flat-v2 turn prefix",
        ));
    }
    Ok(())
}

fn normalize_latest_public_timeline(timeline: &Value) -> Result<Value, HostV2StorageError> {
    match crate::session_public_projection_v2::classify_shared_projection_timeline(timeline)
        .map_err(|message| {
            HostV2StorageError::conflict("session_kernel_public_timeline_history_corrupt", message)
        })? {
        crate::session_public_projection_v2::SharedProjectionTimelineKind::NativeWorkSegmentsV1 => {
            Ok(timeline.clone())
        }
        crate::session_public_projection_v2::SharedProjectionTimelineKind::LegacyFlatV2 => {
            if !legacy_flat_projection_is_terminal(timeline) {
                return Err(HostV2StorageError::conflict(
                    "UnsupportedHistorySchema",
                    "Active flat-v2 Session projection lacks ordered work segments and cannot be resumed",
                ));
            }
            normalize_settled_legacy_flat_projection(timeline)
        }
    }
}

fn legacy_flat_projection_is_terminal(timeline: &Value) -> bool {
    let turns = timeline
        .get("turns")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let turns_are_terminal = turns.iter().all(|turn| {
        matches!(
            turn.get("status").and_then(Value::as_str),
            Some("completed" | "cancelled" | "failed")
        )
    });
    let run_is_terminal = timeline
        .get("runProjection")
        .and_then(Value::as_object)
        .map(|run| {
            run.get("phase").and_then(Value::as_str) == Some("settled")
                && matches!(
                    run.get("status").and_then(Value::as_str),
                    Some("succeeded" | "failed" | "cancelled")
                )
        });
    turns_are_terminal && run_is_terminal.unwrap_or(false)
}

fn normalize_settled_legacy_flat_projection(timeline: &Value) -> Result<Value, HostV2StorageError> {
    let mut normalized = timeline.clone();
    let root = normalized.as_object_mut().ok_or_else(|| {
        HostV2StorageError::conflict(
            "session_kernel_public_timeline_history_corrupt",
            "Legacy Session projection root is not an object",
        )
    })?;
    root.insert(
        "shapeVersion".to_string(),
        Value::String("deepcode.shared-conversation.work-segments.v1".to_string()),
    );
    if let Some(run) = root.get_mut("runProjection").and_then(Value::as_object_mut) {
        run.remove("waitReason");
        run.remove("activeInteractionId");
        run.insert("currentActivity".to_string(), Value::Null);
        run.insert("wait".to_string(), Value::Null);
    }
    let turns = root
        .get_mut("turns")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Legacy Session projection does not contain turns",
            )
        })?;
    let legacy_prefix_turn_count = turns.len();
    for turn in turns {
        let turn = turn.as_object_mut().ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Legacy Session projection contains an invalid turn",
            )
        })?;
        let parts = turn
            .get("blocks")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_public_timeline_history_corrupt",
                    "Legacy Session projection turn does not contain blocks",
                )
            })?
            .iter()
            .map(|block| {
                let block_id = block.get("id").and_then(Value::as_str).ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "session_kernel_public_timeline_history_corrupt",
                        "Legacy Session projection contains a block without an identity",
                    )
                })?;
                Ok(json!({
                    "kind": "block",
                    "blockId": block_id,
                }))
            })
            .collect::<Result<Vec<_>, HostV2StorageError>>()?;
        turn.insert("workSegments".to_string(), Value::Array(Vec::new()));
        turn.insert("parts".to_string(), Value::Array(parts));
    }
    root.insert(
        "legacyPrefixTurnCount".to_string(),
        Value::from(legacy_prefix_turn_count),
    );
    Ok(normalized)
}

fn public_timeline_record(
    request: &SessionKernelHostProjectionRequestV2,
) -> Result<HostSessionPublicTimelineRecordV2, HostV2StorageError> {
    let timeline_revision = timeline_u64(&request.timeline, "revision")?;
    let source_event_version = timeline_u64(&request.timeline, "sourceEventVersion")?;
    if timeline_u64(&request.timeline, "eventCount")? > source_event_version {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_timeline_version_mismatch",
            "Session public timeline eventCount exceeds sourceEventVersion",
        ));
    }
    Ok(HostSessionPublicTimelineRecordV2 {
        schema_version: HOST_SESSION_PUBLIC_TIMELINE_V2_SCHEMA.to_string(),
        projection_id: request.projection_id.clone(),
        projection_digest: request.projection_digest.clone(),
        timeline_revision,
        source_event_version,
        timeline_digest: canonical_sha256(&request.timeline)?,
        timeline: request.timeline.clone(),
    })
}

fn timeline_u64(timeline: &Value, field: &'static str) -> Result<u64, HostV2StorageError> {
    timeline.get(field).and_then(Value::as_u64).ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_public_timeline_invalid",
            format!("Session public timeline requires a safe integer {field}"),
        )
    })
}

fn decode_public_agent_event_record(
    value: Value,
    session_id: &str,
) -> Result<HostSessionPublicAgentEventRecordV2, HostV2StorageError> {
    let record: HostSessionPublicAgentEventRecordV2 =
        serde_json::from_value(value).map_err(|error| {
            HostV2StorageError::conflict(
                "session_kernel_public_event_history_corrupt",
                format!("decode Session public AgentEvent record: {error}"),
            )
        })?;
    if record.schema_version != HOST_SESSION_PUBLIC_AGENT_EVENT_V2_SCHEMA
        || canonical_sha256(&record.agent_event)? != record.agent_event_digest
    {
        return Err(HostV2StorageError::conflict(
            "session_kernel_public_event_history_corrupt",
            "Session public AgentEvent record failed schema or digest validation",
        ));
    }
    validate_public_agent_event(&record.agent_event, session_id, None).map_err(|error| {
        HostV2StorageError::conflict("session_kernel_public_event_history_corrupt", error.message)
    })?;
    Ok(record)
}

fn validate_public_agent_event(
    event: &Value,
    session_id: &str,
    expected: Option<(&str, &str)>,
) -> Result<(), HostV2StorageError> {
    reject_transport_capabilities(event)?;
    let object = event.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_public_event_invalid",
            "Session public AgentEvent must be an object",
        )
    })?;
    for field in ["id", "sessionId", "ts", "kind"] {
        let value = object.get(field).and_then(Value::as_str).ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_public_event_invalid",
                format!("Session public AgentEvent requires {field}"),
            )
        })?;
        validate_bounded_identity(value, field, 64 * 1024)?;
    }
    if object.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || !object.contains_key("payload")
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_event_identity_mismatch",
            "Session public AgentEvent does not match the Session or has no payload",
        ));
    }
    if object.get("kind").and_then(Value::as_str) == Some("user_msg") {
        let attachments = object
            .get("payload")
            .and_then(Value::as_object)
            .and_then(|payload| payload.get("attachments"))
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "session_kernel_public_event_attachment_invalid",
                    "Session v2 user event requires the exact nested attachment DTO",
                )
            })?;
        deepcode_kernel_abi::decode_agent_input_attachments_v2(attachments).map_err(|error| {
            HostV2StorageError::invalid(
                "session_kernel_public_event_attachment_invalid",
                format!(
                    "Session v2 user event has invalid attachments: {}",
                    error.code
                ),
            )
        })?;
    }
    if let Some((projection_id, recorded_at)) = expected {
        let expected_id = format!("kernel-v2:{projection_id}");
        if object.get("id").and_then(Value::as_str) != Some(expected_id.as_str())
            || object.get("ts").and_then(Value::as_str) != Some(recorded_at)
        {
            return Err(HostV2StorageError::invalid(
                "session_kernel_public_event_identity_mismatch",
                "Session public AgentEvent does not match the private projection identity",
            ));
        }
    } else if !object
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|value| value.starts_with("kernel-v2:"))
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_event_identity_mismatch",
            "Session public AgentEvent has an invalid v2 event identity",
        ));
    }
    Ok(())
}

fn public_agent_event_id(event: &Value) -> Result<&str, HostV2StorageError> {
    event.get("id").and_then(Value::as_str).ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_public_event_invalid",
            "Session public AgentEvent has no event id",
        )
    })
}

fn session_private_write_unavailable_response(
    state: &AppState,
    session_id: &str,
) -> Option<Response> {
    let gui = state.gui.lock().expect("gui state lock");
    if let Some(error) = gui.session_metadata_error.as_deref() {
        return Some(v2_error_response(
            StatusCode::CONFLICT,
            "unsupported_history_schema",
            error,
        ));
    }
    if let Err(response) = crate::verified_selectable_session(&gui, session_id) {
        let payload = response.0;
        let code = payload
            .error
            .as_deref()
            .unwrap_or("agent_session_unavailable");
        let message = payload
            .message
            .as_deref()
            .unwrap_or("Session private storage is unavailable");
        let status = if code == "agent_session_not_found" {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::CONFLICT
        };
        return Some(v2_error_response(status, code, message));
    }
    None
}

pub(crate) async fn session_kernel_v3_store_get(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session Kernel v3 persistence accepts only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let store = state.host_services.session_kernel_v2.clone();
    let read_session_id = session_id.clone();
    let read_run_id = run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        store.list(&read_session_id, &read_run_id, &capability)
    })
    .await
    {
        Ok(Ok(records)) => v2_success_response(
            StatusCode::OK,
            &SessionKernelPersistenceListReplyV2 {
                schema_version: SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA,
                session_id,
                run_id,
                records,
            },
        ),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_kernel_persistence_task_failed",
            "Session Kernel persistence read task failed",
        ),
    }
}

pub(crate) async fn session_kernel_v3_store_append(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<SessionKernelPersistenceAppendRequestV2>, JsonRejection>,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session Kernel v3 persistence accepts only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let Json(request) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return v2_error_response(
                rejection.status(),
                "session_kernel_persistence_request_invalid",
                "Session Kernel persistence request body is invalid",
            )
        }
    };
    let store = state.host_services.session_kernel_v2.clone();
    let write_session_id = session_id.clone();
    let write_run_id = run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        store.append(&write_session_id, &write_run_id, &capability, request)
    })
    .await
    {
        Ok(Ok(reply)) => v2_success_response(StatusCode::OK, &reply),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_kernel_persistence_task_failed",
            "Session Kernel persistence append task failed",
        ),
    }
}

pub(crate) async fn session_kernel_v3_store_record_get(
    State(state): State<AppState>,
    Path((session_id, run_id, record_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session Kernel v3 persistence accepts only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let store = state.host_services.session_kernel_v2.clone();
    let read_session_id = session_id.clone();
    let read_run_id = run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        store.get_record(&read_session_id, &read_run_id, &record_id, &capability)
    })
    .await
    {
        Ok(Ok(record)) => v2_success_response(StatusCode::OK, &record),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_kernel_persistence_task_failed",
            "Session Kernel persistence record read task failed",
        ),
    }
}

pub(crate) async fn session_kernel_v2_projection_append(
    State(state): State<AppState>,
    Path((session_id, host_run_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<SessionKernelHostProjectionRequestV2>, JsonRejection>,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_projection_origin_forbidden",
            "Session Kernel v2 projection accepts only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let Json(request) = match body {
        Ok(body) => body,
        Err(rejection) => {
            let code = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                "session_kernel_projection_limit_exceeded"
            } else {
                "session_kernel_projection_request_invalid"
            };
            return v2_error_response(
                rejection.status(),
                code,
                "Session Kernel projection request body is invalid",
            );
        }
    };
    let sink = state.host_services.projection_v2.clone();
    let write_session_id = session_id.clone();
    let write_host_run_id = host_run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        sink.publish(&write_session_id, &write_host_run_id, &capability, request)
    })
    .await
    {
        Ok(Ok(reply)) => v2_success_response(StatusCode::OK, &reply),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "session_kernel_projection_task_failed",
            "Session Kernel projection task failed",
        ),
    }
}

pub(crate) async fn session_kernel_v2_prior_events_page(
    State(state): State<AppState>,
    Path((session_id, host_run_id)): Path<(String, String)>,
    Query(query): Query<HostSessionPriorEventsPageQueryV2>,
    headers: HeaderMap,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "host_session_prior_events_origin_forbidden",
            "Prior Session events accept only trusted local clients",
        );
    }
    let io_guard = crate::session_private_io_lock(&session_id)
        .read_owned()
        .await;
    if let Some(response) = session_private_write_unavailable_response(&state, &session_id) {
        return response;
    }
    let capability = match run_transport_capability(&headers) {
        Ok(capability) => capability,
        Err(error) => return storage_error_response(error),
    };
    let active = match state
        .host_services
        .active_runs_v2
        .authorize_host_run_transport_binding(&session_id, &host_run_id, &capability)
    {
        Ok(active) => active,
        Err(error) => return storage_error_response(error),
    };
    let bootstrap = match state
        .host_services
        .kernel_operations_v2
        .get_bootstrap(&session_id, &host_run_id)
    {
        Ok(bootstrap) => bootstrap,
        Err(error) => return storage_error_response(error),
    };
    if bootstrap.run_id != active.run_id {
        return storage_error_response(HostV2StorageError::unauthorized(
            "host_run_transport_capability_invalid",
            "Host Run transport capability is invalid for this Session and Run",
        ));
    }
    let sink = state.host_services.projection_v2.clone();
    let read_session_id = session_id.clone();
    let read_host_run_id = host_run_id.clone();
    match tokio::task::spawn_blocking(move || {
        let _io_guard = io_guard;
        sink.prior_events_page(
            &read_session_id,
            &read_host_run_id,
            &bootstrap.run_id,
            &capability,
            &bootstrap.prior_session_events,
            query.continuation.as_deref(),
        )
    })
    .await
    {
        Ok(Ok(reply)) => v2_success_response(StatusCode::OK, &reply),
        Ok(Err(error)) => storage_error_response(error),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "host_session_prior_events_task_failed",
            "Prior Session event page read failed",
        ),
    }
}

fn storage_error_response(error: HostV2StorageError) -> Response {
    let status = match error.kind {
        HostV2StorageErrorKind::Invalid => StatusCode::BAD_REQUEST,
        HostV2StorageErrorKind::Unauthorized => StatusCode::UNAUTHORIZED,
        HostV2StorageErrorKind::Conflict => StatusCode::CONFLICT,
        HostV2StorageErrorKind::NotFound => StatusCode::NOT_FOUND,
        HostV2StorageErrorKind::Io => StatusCode::INTERNAL_SERVER_ERROR,
    };
    v2_error_response(status, error.code, &error.message)
}

fn run_transport_capability(headers: &HeaderMap) -> Result<RunCapabilityV2, HostV2StorageError> {
    let submitted = headers
        .get(RUN_TRANSPORT_CAPABILITY_HEADER)
        .ok_or_else(|| {
            HostV2StorageError::unauthorized(
                "host_run_transport_capability_required",
                "Host Run transport capability is required",
            )
        })?
        .to_str()
        .map_err(|_| {
            HostV2StorageError::unauthorized(
                "host_run_transport_capability_invalid",
                "Host Run transport capability header is invalid",
            )
        })?;
    RunCapabilityV2::new(submitted.to_string()).map_err(|_| {
        HostV2StorageError::unauthorized(
            "host_run_transport_capability_invalid",
            "Host Run transport capability header is invalid",
        )
    })
}

fn v2_success_response(status: StatusCode, data: &impl Serialize) -> Response {
    match serde_json::to_vec(&json!({ "ok": true, "data": data })) {
        Ok(body) => v2_json_response(status, body),
        Err(_) => v2_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "host_v2_response_encode_failed",
            "Host v2 response encoding failed",
        ),
    }
}

fn v2_error_response(status: StatusCode, code: &str, message: &str) -> Response {
    let body = serde_json::to_vec(&json!({
        "ok": false,
        "error": {
            "code": code,
            "message": message
        }
    }))
    .unwrap_or_else(|_| b"{\"ok\":false,\"error\":{\"code\":\"host_v2_error\"}}".to_vec());
    v2_json_response(status, body)
}

fn v2_json_response(status: StatusCode, body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
#[path = "session_kernel_v2_store_dispatch_tests.rs"]
mod dispatch_tests;
