use crate::host_run_broker_v2::HostActiveRunBrokerV2;
use crate::host_v2_storage::{
    append_json_line_durable, canonical_json_bytes, canonical_sha256,
    reject_transport_capabilities, sha256_path_component, sha256_prefixed, stable_json_sha256,
    validate_bounded_identity, validate_safe_session_identity, validate_sha256_digest,
    value_without_field, with_storage_path_lock, HostV2StorageError, HostV2StorageErrorKind,
};
use crate::kernel_v2_transport::RUN_TRANSPORT_CAPABILITY_HEADER;
use crate::prelude::*;
use crate::provider_cache_admission_v2::{
    SessionProviderControlSettlementSidecarV2, SessionProviderConversationHeadV1,
    SessionProviderStructuredRepairSidecarV1, SessionProviderToolContextRefSidecarV1,
};
use crate::provider_trace_v1::{
    ProviderTraceErrorV1, ProviderTraceIdentityV1, ProviderTraceMetadataV1, ProviderTracePurposeV1,
    ProviderTraceStoreV1, ProviderTraceTerminalKindV1, ProviderTraceTerminalRecoveryV1,
    ProviderTraceTerminalV1, ProviderTraceWriterV1,
};
use crate::session_bootstrap_v2::HostSessionPriorEventsV2;
use crate::user_attachment_v1::{validate_user_attachment_contexts_v1, UserAttachmentContextV1};
use crate::AppState;
use crate::{
    PROVIDER_STRUCTURED_OUTPUT_FAILURE_SCHEMA_V1, PROVIDER_STRUCTURED_OUTPUT_RECOVERY_SCHEMA_V1,
};
use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use deepcode_kernel_abi::v2_command::CapabilityScopePreviewRecordV2;
use deepcode_kernel_abi::{
    RequestedResourceV2, RunCapabilityV2, ScopeIntentV2, ToolContextBundleV2, ToolContextRefV2,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};

const SESSION_KERNEL_PERSISTENCE_V3_SCHEMA: &str = "deepcode.session.kernel-persistence.v4";
const SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA: &str =
    "deepcode.session.kernel-persistence-record.v4";
const SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-append-request.v2";
const SESSION_KERNEL_PERSISTENCE_LIST_REPLY_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-list-reply.v2";
const SESSION_KERNEL_PERSISTENCE_APPEND_REPLY_V2_SCHEMA: &str =
    "deepcode.session.kernel-persistence-append-reply.v2";
const SESSION_KERNEL_CHECKPOINT_V3_SCHEMA: &str = "deepcode.session.kernel-checkpoint.v4";
const SESSION_KERNEL_OPERATION_RESULT_V2_SCHEMA: &str =
    "deepcode.session.kernel-operation-result.v2";
const SESSION_PROVIDER_TURN_DISPATCH_V3_SCHEMA: &str = "deepcode.session.provider-turn-dispatch.v4";
const SESSION_PROVIDER_TURN_TERMINAL_V3_SCHEMA: &str = "deepcode.session.provider-turn-terminal.v4";
const SESSION_KERNEL_TOOL_CONTEXT_SNAPSHOT_V3_SCHEMA: &str =
    "deepcode.session.tool-context-snapshot.v4";
const SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA: &str = "deepcode.provider-stream-terminal.v1";
const SESSION_KERNEL_REVIEW_RECORD_V3_SCHEMA: &str = "deepcode.session.review-record.v4";
const SESSION_KERNEL_REVIEW_PROJECTION_V2_SCHEMA: &str =
    "deepcode.session.kernel-review-projection.v2";
const SESSION_KERNEL_PLAN_ACTION_SETTLEMENT_RECORD_V3_SCHEMA: &str =
    "deepcode.session.plan-action-settlement-record.v4";
const SESSION_KERNEL_PUBLIC_REQUEST_SETTLEMENT_V3_SCHEMA: &str =
    "deepcode.session.public-request-settlement.v4";
const SESSION_KERNEL_PROJECTION_RECORD_V3_SCHEMA: &str = "deepcode.session.projection-record.v4";
const SESSION_TERMINAL_ANSWER_CANDIDATE_V1_SCHEMA: &str =
    "deepcode.session.terminal-answer-candidate.v1";
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
        batch_sequence: u64,
        predecessor_digest: Option<String>,
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
            batch_sequence,
            predecessor_digest,
            operation_ids,
            digest,
        } => {
            if *batch_sequence == 0
                || *batch_sequence > MAX_SAFE_INTEGER_V3
                || (*batch_sequence == 1 && predecessor_digest.is_some())
                || (*batch_sequence > 1 && predecessor_digest.is_none())
                || operation_ids.is_empty()
            {
                return Err(work_authority_invalid());
            }
            if let Some(predecessor_digest) = predecessor_digest {
                validate_sha256_digest(predecessor_digest, "workAuthority.predecessorDigest")?;
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
                "batchSequence": batch_sequence,
                "predecessorDigest": predecessor_digest,
                "operationIds": operation_ids,
            }))?;
            if digest != &expected {
                return Err(HostV2StorageError::invalid(
                    "session_kernel_work_authority_digest_mismatch",
                    "Context-read work authority digest does not match its current batch and predecessor chain",
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
#[serde(rename_all = "camelCase")]
enum PersistedPublicRequestKindV3 {
    ControlEpochAdvance,
    InvocationCancel,
    ToolIntentSubmit,
    ToolContextGet,
    CapabilityPreviewBatch,
    FactsQuery,
}

impl PersistedPublicRequestKindV3 {
    fn expected_lane(&self) -> &'static str {
        match self {
            Self::ControlEpochAdvance | Self::InvocationCancel => "control",
            Self::ToolIntentSubmit => "effect",
            Self::ToolContextGet | Self::CapabilityPreviewBatch | Self::FactsQuery => "query",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPublicRequestIntentV3 {
    kind: PersistedPublicRequestKindV3,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    structured_output_recovery: Option<Value>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    structured_failure: Option<Value>,
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
    correction: Option<SessionKernelToolCorrectionV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    structured_repair: Option<SessionProviderStructuredRepairSidecarV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_structured_repair: Option<SessionProviderStructuredRepairSidecarV1>,
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
struct SessionKernelToolCorrectionV3 {
    retry_group_id: String,
    predecessor_operation_id: String,
    retry_ordinal: u64,
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
struct SessionPlanConfirmationProjectionRefV2 {
    projection_id: String,
    projection_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionPlanConfirmationAuthorityV2 {
    plan_revision: String,
    provider_turn_id: String,
    provider_response_digest: String,
    control_epoch: u64,
    tool_context_ref: ToolContextRefV2,
    plan_digest: String,
    scope_previews_digest: String,
    authority_digest: String,
    recorded_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    commentary_projection: Option<SessionPlanConfirmationProjectionRefV2>,
    confirmation_projection: SessionPlanConfirmationProjectionRefV2,
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
    plan_confirmation: Option<SessionPlanConfirmationAuthorityV2>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    intervention_research: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_intervention: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_intervention_decision: Option<Value>,
    pending_guidance: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_reservation: Option<SessionKernelCompactProviderReservationV3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_queue: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_provider_control_settlement: Option<SessionProviderControlSettlementSidecarV2>,
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
    committed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelCompactTerminalAnswerCandidateV1 {
    schema_version: String,
    provider_turn_id: String,
    input_id: String,
    control_epoch: u64,
    language_revision: u64,
    snapshot_high_water: u64,
    work_authority: SessionWorkAuthorityV3,
    text_digest: String,
    source_event_refs: Vec<String>,
    recorded_at: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_answer_candidate: Option<SessionKernelCompactTerminalAnswerCandidateV1>,
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
    pub(crate) run_id: String,
    pub(crate) purpose: ProviderTracePurposeV1,
    pub(crate) control_epoch: u64,
    pub(crate) current_input_id: String,
    pub(crate) current_input_digest: String,
    pub(crate) context_assembly_digest: String,
    pub(crate) provider_conversation_head: Option<SessionProviderConversationHeadV1>,
    pub(crate) target: Value,
    pub(crate) tool_context_ref: SessionProviderToolContextRefSidecarV1,
    pub(crate) provider_profile_id: String,
    pub(crate) provider_profile_revision: String,
    pub(crate) plan_revision: Option<String>,
    pub(crate) work_authority: Option<SessionWorkAuthorityV3>,
    pub(crate) review_revision: Option<u64>,
    pub(crate) snapshot_high_water: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionProviderTurnPredecessorEvidenceV3 {
    pub(crate) admission: SessionProviderTurnAdmissionV2,
    pub(crate) request_digest: String,
    pub(crate) terminal_kind: SessionProviderTurnTerminalKindV3,
    pub(crate) terminal_reason_code: Option<String>,
    pub(crate) trace_terminal_digest: String,
    pub(crate) trace_seal_digest: String,
    pub(crate) trace_record_count: u64,
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
    pub(crate) structured_failure: Option<Value>,
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

    pub(crate) fn provider_turn_predecessor_evidence(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        provider_turn_id: &str,
    ) -> Result<SessionProviderTurnPredecessorEvidenceV3, HostV2StorageError> {
        validate_bounded_identity(provider_turn_id, "providerTurnId", 512)?;
        let records = self.list(session_id, run_id, capability)?;
        provider_turn_predecessor_evidence_from_records(&records, run_id, provider_turn_id)
    }

    #[cfg(test)]
    pub(crate) fn commit_provider_dispatch(
        &self,
        capability: &RunCapabilityV2,
        expected_admission: &SessionProviderTurnAdmissionV2,
        exact_request_binding: &SessionProviderDispatchBindingV2,
        trace_store: &ProviderTraceStoreV1,
        trace_identity: ProviderTraceIdentityV1,
        exact_request_body: &[u8],
    ) -> Result<SessionProviderTurnDispatchCommitV3, ProviderTraceErrorV1> {
        self.commit_provider_dispatch_with_private_binding(
            capability,
            expected_admission,
            exact_request_binding,
            trace_store,
            trace_identity,
            exact_request_body,
            None,
        )
    }

    pub(crate) fn commit_provider_dispatch_with_private_binding(
        &self,
        capability: &RunCapabilityV2,
        expected_admission: &SessionProviderTurnAdmissionV2,
        exact_request_binding: &SessionProviderDispatchBindingV2,
        trace_store: &ProviderTraceStoreV1,
        trace_identity: ProviderTraceIdentityV1,
        exact_request_body: &[u8],
        admission_sidecar: Option<&Value>,
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
                        .begin_or_reopen_exact_request_only_turn_with_private_binding(
                            trace_identity,
                            exact_request_body,
                            admission_sidecar,
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
        let session_directory = self.sessions_dir.join(session_id);
        let path_component = format!("{}.jsonl", sha256_path_component(run_id));
        reject_pre_cutover_session_layout(&session_directory)?;
        let kernel_v2_directory = session_directory.join("kernel-v2");
        Ok(kernel_v2_directory
            .join("session-runs")
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
        structured_failure: terminal.structured_failure,
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
            provider_result: recovery.structured_failure_provider_result.clone(),
            structured_failure: recovery.structured_failure.clone(),
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
            "structuredOutputRecovery": completed.structured_output_recovery.clone(),
        })),
        provider_result: Some(completed.provider_result.clone()),
        structured_failure: None,
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
    let checkpoints = committed_checkpoint_chain(records)?;
    let latest = checkpoints
        .last()
        .ok_or_else(provider_turn_admission_missing)?;
    provider_turn_admission_from_checkpoint(
        records,
        run_id,
        provider_turn_id,
        latest.record_index,
        &latest.checkpoint,
    )
}

fn provider_turn_admission_from_checkpoint(
    records: &[SessionKernelPersistenceRecordV3],
    run_id: &str,
    provider_turn_id: &str,
    checkpoint_index: usize,
    checkpoint: &SessionKernelCompactCheckpointV3,
) -> Result<SessionProviderTurnAdmissionV2, HostV2StorageError> {
    if !checkpoint
        .active
        .provider_reservation
        .as_ref()
        .is_some_and(|reservation| {
            reservation.provider_turn_id == provider_turn_id && reservation.status == "active"
        })
    {
        return Err(provider_turn_admission_missing());
    }
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
    let context_memory = context_assembly
        .get("memory")
        .and_then(Value::as_object)
        .ok_or_else(provider_turn_admission_invalid)?;
    let memory_source_event_version = context_memory
        .get("sourceEventVersion")
        .and_then(Value::as_u64)
        .ok_or_else(provider_turn_admission_invalid)?;
    let provider_conversation_head = context_memory
        .get("providerConversationHead")
        .cloned()
        .map(|value| {
            let head: SessionProviderConversationHeadV1 =
                serde_json::from_value(value).map_err(|_| provider_turn_admission_invalid())?;
            head.validate(&current_input.session_id)?;
            if head.source_event_version > memory_source_event_version {
                return Err(provider_turn_admission_invalid());
            }
            Ok(head)
        })
        .transpose()?;
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
                checkpoint,
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
        run_id: run_id.to_string(),
        purpose: provider_turn.purpose,
        control_epoch: authority.control_epoch,
        current_input_id: authority.current_input_id.clone(),
        current_input_digest: current_input_digest.to_string(),
        context_assembly_digest: stable_json_sha256(&Value::Object(context_assembly.clone()))?,
        provider_conversation_head,
        target: provider_turn.target.clone(),
        tool_context_ref: SessionProviderToolContextRefSidecarV1 {
            context_version: u64::from(provider_turn.context_ref.context_version.get()),
            catalog_digest: provider_turn
                .context_ref
                .catalog_digest
                .as_str()
                .to_string(),
            context_digest: provider_turn
                .context_ref
                .context_digest
                .as_str()
                .to_string(),
        },
        provider_profile_id: provider_profile_id.to_string(),
        provider_profile_revision: provider_profile_revision.to_string(),
        plan_revision,
        work_authority,
        review_revision,
        snapshot_high_water,
    };
    validate_final_answer_dispatch_budget(records, run_id, &admission)?;
    Ok(admission)
}

fn provider_turn_predecessor_evidence_from_records(
    records: &[SessionKernelPersistenceRecordV3],
    run_id: &str,
    provider_turn_id: &str,
) -> Result<SessionProviderTurnPredecessorEvidenceV3, HostV2StorageError> {
    let dispatch_record_id = provider_turn_dispatch_record_id(run_id, provider_turn_id);
    let (dispatch_index, dispatch_record) = records
        .iter()
        .enumerate()
        .find(|(_, record)| record.record_id == dispatch_record_id)
        .ok_or_else(provider_turn_predecessor_dispatch_missing)?;
    if dispatch_record.record_kind != SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch {
        return Err(provider_turn_predecessor_invalid());
    }
    let dispatch = validate_provider_turn_dispatch_record(dispatch_record, run_id)?;
    if dispatch.provider_turn_id != provider_turn_id {
        return Err(provider_turn_predecessor_invalid());
    }

    let checkpoints = committed_checkpoint_chain(records)?;
    let admitted_checkpoint = checkpoints
        .iter()
        .rev()
        .find(|entry| {
            entry.record_index < dispatch_index
                && entry
                    .checkpoint
                    .active
                    .provider_reservation
                    .as_ref()
                    .is_some_and(|reservation| {
                        reservation.provider_turn_id == provider_turn_id
                            && reservation.status == "active"
                    })
        })
        .ok_or_else(provider_turn_admission_missing)?;
    let admission = provider_turn_admission_from_checkpoint(
        records,
        run_id,
        provider_turn_id,
        admitted_checkpoint.record_index,
        &admitted_checkpoint.checkpoint,
    )?;
    if !provider_dispatch_matches_admission(&dispatch, run_id, &admission) {
        return Err(provider_turn_predecessor_invalid());
    }

    let terminal_record_id = provider_turn_terminal_record_id(run_id, provider_turn_id);
    let (terminal_index, terminal_record) = records
        .iter()
        .enumerate()
        .find(|(_, record)| record.record_id == terminal_record_id)
        .ok_or_else(provider_turn_predecessor_terminal_missing)?;
    if terminal_index <= dispatch_index
        || terminal_record.record_kind != SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal
    {
        return Err(provider_turn_predecessor_invalid());
    }
    let terminal = validate_provider_turn_terminal_record(terminal_record, run_id)?;
    if terminal.provider_turn_id != provider_turn_id
        || terminal.dispatch_ref.record_id != dispatch_record.record_id
        || terminal.dispatch_ref.record_digest != dispatch_record.record_digest
        || terminal.authority_binding != dispatch.authority_binding
    {
        return Err(provider_turn_predecessor_invalid());
    }

    Ok(SessionProviderTurnPredecessorEvidenceV3 {
        admission,
        request_digest: dispatch.request_digest,
        terminal_kind: terminal.terminal_kind,
        terminal_reason_code: terminal.reason_code,
        trace_terminal_digest: terminal.trace_ref.terminal_digest,
        trace_seal_digest: terminal.trace_ref.seal_digest,
        trace_record_count: terminal.trace_ref.record_count,
    })
}

fn provider_dispatch_matches_admission(
    dispatch: &SessionProviderTurnDispatchDataV3,
    run_id: &str,
    admission: &SessionProviderTurnAdmissionV2,
) -> bool {
    let authority = &dispatch.authority_binding;
    dispatch.provider_turn_id == admission.provider_turn_id
        && dispatch.purpose == admission.purpose
        && authority.run_id == run_id
        && authority.input_id == admission.current_input_id
        && authority.control_epoch == admission.control_epoch
        && authority.current_input_digest == admission.current_input_digest
        && authority.plan_revision == admission.plan_revision
        && authority.review_revision == admission.review_revision
        && authority.snapshot_high_water == admission.snapshot_high_water
        && authority.provider_profile_id == admission.provider_profile_id
        && authority.provider_profile_revision_digest == admission.provider_profile_revision
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
        Some(SessionWorkAuthorityV3::ContextRead { .. }) => {
            validate_context_read_work_authority_chain(records, exclusive_end, checkpoint)?;
        }
        None => {}
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
    validate_terminal_answer_candidate_records(records, exclusive_end, checkpoint)?;
    Ok(())
}

fn validate_context_read_work_authority_chain(
    records: &[SessionKernelPersistenceRecordV3],
    exclusive_end: usize,
    checkpoint: &SessionKernelCompactCheckpointV3,
) -> Result<(), HostV2StorageError> {
    let Some(SessionWorkAuthorityV3::ContextRead {
        batch_sequence,
        predecessor_digest,
        operation_ids,
        digest,
    }) = checkpoint.authority.work_authority.as_ref()
    else {
        return Err(compact_checkpoint_authority_invalid());
    };
    let previous = checkpoint
        .parent_ref
        .as_ref()
        .map(|parent_ref| resolve_record_ref_before(records, exclusive_end, parent_ref))
        .transpose()?
        .map(decode_compact_checkpoint_record)
        .transpose()?;
    let previous_authority = previous.as_ref().and_then(|parent| {
        (parent.authority.control_epoch == checkpoint.authority.control_epoch)
            .then_some(parent.authority.work_authority.as_ref())
            .flatten()
    });
    match previous_authority {
        Some(SessionWorkAuthorityV3::ContextRead {
            batch_sequence: previous_sequence,
            operation_ids: previous_operation_ids,
            digest: previous_digest,
            predecessor_digest: previous_predecessor_digest,
        }) if previous_sequence == batch_sequence => {
            if previous_predecessor_digest != predecessor_digest
                || previous_operation_ids != operation_ids
                || previous_digest != digest
            {
                return Err(compact_checkpoint_authority_invalid());
            }
        }
        Some(SessionWorkAuthorityV3::ContextRead {
            batch_sequence: previous_sequence,
            digest: previous_digest,
            ..
        }) => {
            if previous_sequence.checked_add(1) != Some(*batch_sequence)
                || predecessor_digest.as_deref() != Some(previous_digest.as_str())
            {
                return Err(compact_checkpoint_authority_invalid());
            }
        }
        Some(SessionWorkAuthorityV3::Plan { .. }) | None => {
            if *batch_sequence != 1 || predecessor_digest.is_some() {
                return Err(compact_checkpoint_authority_invalid());
            }
        }
    }
    Ok(())
}

fn validate_terminal_answer_candidate_records(
    records: &[SessionKernelPersistenceRecordV3],
    exclusive_end: usize,
    checkpoint: &SessionKernelCompactCheckpointV3,
) -> Result<(), HostV2StorageError> {
    let Some(candidate) = &checkpoint.terminal_answer_candidate else {
        return Ok(());
    };
    let before = records
        .get(..exclusive_end)
        .ok_or_else(terminal_answer_candidate_invalid)?;
    let terminal_record_id =
        provider_turn_terminal_record_id(&checkpoint.authority.run_id, &candidate.provider_turn_id);
    let terminal_record = before
        .iter()
        .find(|record| record.record_id == terminal_record_id)
        .ok_or_else(terminal_answer_candidate_invalid)?;
    let terminal =
        validate_provider_turn_terminal_record(terminal_record, &checkpoint.authority.run_id)?;
    if terminal.terminal_kind != SessionProviderTurnTerminalKindV3::Completed
        || terminal.authority_binding.input_id != candidate.input_id
        || terminal.authority_binding.control_epoch != candidate.control_epoch
        || terminal_record.recorded_at != candidate.recorded_at
    {
        return Err(terminal_answer_candidate_invalid());
    }
    let dispatch_record =
        resolve_record_ref_before(records, exclusive_end, &terminal.dispatch_ref)?;
    let dispatch =
        validate_provider_turn_dispatch_record(dispatch_record, &checkpoint.authority.run_id)?;
    if dispatch.provider_turn_id != candidate.provider_turn_id
        || dispatch.purpose == ProviderTracePurposeV1::FinalAnswer
        || dispatch.authority_binding != terminal.authority_binding
    {
        return Err(terminal_answer_candidate_invalid());
    }
    let terminal_text = provider_terminal_final_text(&terminal.ordered_items);
    if terminal_text.trim().is_empty()
        || sha256_prefixed(terminal_text.as_bytes()) != candidate.text_digest
    {
        return Err(terminal_answer_candidate_invalid());
    }
    for source_ref in &candidate.source_event_refs {
        let mut matched = false;
        for record in before
            .iter()
            .filter(|record| record.record_kind == SessionKernelPersistenceRecordKindV3::Projection)
        {
            let projection = decode_projection_record(record)?;
            let Some(event) = projection.event.as_object() else {
                return Err(terminal_answer_candidate_invalid());
            };
            if event.get("projectionId").and_then(Value::as_str) != Some(source_ref.as_str()) {
                continue;
            }
            let data = event
                .get("data")
                .and_then(Value::as_object)
                .ok_or_else(terminal_answer_candidate_invalid)?;
            matched = event.get("kind").and_then(Value::as_str) == Some("provider.completed")
                && data.get("providerTurnId").and_then(Value::as_str)
                    == Some(candidate.provider_turn_id.as_str())
                && data.get("outputKind").and_then(Value::as_str) == Some("answer");
            break;
        }
        if !matched {
            return Err(terminal_answer_candidate_invalid());
        }
    }
    let reservation = checkpoint
        .active
        .provider_reservation
        .as_ref()
        .ok_or_else(terminal_answer_candidate_invalid)?;
    let terminal_ref = SessionProviderTurnRecordRefV3 {
        record_id: terminal_record.record_id.clone(),
        record_digest: terminal_record.record_digest.clone(),
    };
    if reservation.provider_turn_id != candidate.provider_turn_id
        || reservation.status != "completed"
        || reservation.terminal_ref.as_ref() != Some(&terminal_ref)
    {
        return Err(terminal_answer_candidate_invalid());
    }
    Ok(())
}

fn provider_terminal_final_text(items: &[SessionProviderOrderedItemV3]) -> String {
    let text_items = items
        .iter()
        .filter_map(|item| match item {
            SessionProviderOrderedItemV3::Text { phase, text } => Some((phase, text)),
            SessionProviderOrderedItemV3::ToolCall { .. } => None,
        })
        .collect::<Vec<_>>();
    let first_final = text_items
        .iter()
        .position(|(phase, _)| matches!(phase, SessionProviderTextPhaseV3::FinalAnswer));
    let last_commentary = text_items
        .iter()
        .rposition(|(phase, _)| matches!(phase, SessionProviderTextPhaseV3::Commentary));
    text_items
        .iter()
        .enumerate()
        .filter(|(index, (phase, _))| match first_final {
            Some(first) => *index >= first,
            None => {
                last_commentary.is_none_or(|last| *index > last)
                    && matches!(phase, SessionProviderTextPhaseV3::Unknown)
            }
        })
        .map(|(_, (_, text))| text.as_str())
        .collect()
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

fn provider_turn_predecessor_dispatch_missing() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "provider_turn_predecessor_dispatch_missing",
        "Provider cache predecessor has no exact durable dispatch",
    )
}

fn provider_turn_predecessor_terminal_missing() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "provider_turn_predecessor_terminal_missing",
        "Provider cache predecessor has no exact durable terminal",
    )
}

fn provider_turn_predecessor_invalid() -> HostV2StorageError {
    HostV2StorageError::conflict(
        "provider_turn_predecessor_invalid",
        "Provider cache predecessor durable admission, dispatch, and terminal do not form one exact chain",
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
                    || record.record_kind == SessionKernelPersistenceRecordKindV3::Plan
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
        SessionKernelPersistenceRecordKindV3::Plan => {
            validate_persisted_plan_record(record, run_id)?;
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

fn validate_persisted_plan_record(
    record: &SessionKernelPersistenceRecordV3,
    run_id: &str,
) -> Result<(), HostV2StorageError> {
    let plan = record.data.as_object().ok_or_else(|| {
        private_projection_data_invalid("Session private Plan must be an exact current object")
    })?;
    validate_private_plan(plan)?;
    let plan_revision = plan
        .get("planRevision")
        .and_then(Value::as_str)
        .expect("validated private Plan revision");
    if plan.get("runId").and_then(Value::as_str) != Some(run_id)
        || plan.get("recordedAt").and_then(Value::as_str) != Some(record.recorded_at.as_str())
        || record.record_id != format!("session-kernel-v3:{run_id}:plan:{plan_revision}")
    {
        return Err(private_projection_data_invalid(
            "Session private Plan record identity does not match its durable wrapper",
        ));
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
    validate_compact_checkpoint_scope_previews(
        &authority.previews,
        &authority.run_id,
        authority.control_epoch,
    )?;
    if !authority.operation_plan_action_bindings.is_object() {
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
    if authority.plan_confirmation.is_some() && authority.plan_ref.is_none() {
        return Err(compact_checkpoint_authority_invalid());
    }
    if let Some(plan_ref) = &authority.plan_ref {
        validate_record_ref(plan_ref, "planRef")?;
    }
    if let Some(plan_confirmation) = &authority.plan_confirmation {
        validate_plan_confirmation_authority_v2(
            plan_confirmation,
            &authority.run_id,
            authority.control_epoch,
        )?;
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
    if let Some(settlement) = &checkpoint.active.pending_provider_control_settlement {
        settlement.validate()?;
        if settlement.run_id() != authority.run_id
            || settlement.input_id() != authority.current_input_id
            || settlement.control_epoch() != authority.control_epoch
        {
            return Err(HostV2StorageError::invalid(
                "session_kernel_checkpoint_control_settlement_invalid",
                "Session Kernel checkpoint control settlement does not bind current authority",
            ));
        }
    }
    validate_compact_intervention_state(&checkpoint.active, authority)?;
    if authority.plan_decision_ref.is_some()
        && authority.plan_confirmation.is_none()
        && !compact_checkpoint_has_intervention_accepted_plan(&checkpoint)
    {
        return Err(compact_checkpoint_authority_invalid());
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
    if let Some(candidate) = &checkpoint.terminal_answer_candidate {
        validate_compact_terminal_answer_candidate(candidate, &checkpoint)?;
    }
    match (
        checkpoint
            .final_answer
            .as_ref()
            .and_then(|answer| answer.commit_kind.as_deref()),
        checkpoint.final_answer.as_ref(),
        checkpoint.terminal_answer_candidate.as_ref(),
    ) {
        (Some("candidatePromotion"), Some(final_answer), Some(candidate))
            if final_answer.provider_turn_id.as_deref()
                == Some(candidate.provider_turn_id.as_str())
                && final_answer.binding.input_id == candidate.input_id
                && final_answer.binding.control_epoch == candidate.control_epoch
                && final_answer.binding.snapshot_high_water == candidate.snapshot_high_water
                && final_answer.binding.work_authority == candidate.work_authority => {}
        (Some("candidatePromotion"), _, _) => {
            return Err(compact_final_answer_invalid());
        }
        _ => {}
    }
    Ok(checkpoint)
}

fn compact_checkpoint_has_intervention_accepted_plan(
    checkpoint: &SessionKernelCompactCheckpointV3,
) -> bool {
    let Some(SessionWorkAuthorityV3::Plan { plan_revision }) =
        checkpoint.authority.work_authority.as_ref()
    else {
        return false;
    };
    let Some(intervention) = checkpoint
        .active
        .user_intervention
        .as_ref()
        .and_then(Value::as_object)
    else {
        return false;
    };
    let Some(decision) = checkpoint
        .active
        .user_intervention_decision
        .as_ref()
        .and_then(Value::as_object)
    else {
        return false;
    };
    if decision.get("decision").and_then(Value::as_str) != Some("select") {
        return false;
    }
    let Some(option_id) = decision.get("optionId").and_then(Value::as_str) else {
        return false;
    };
    intervention
        .get("options")
        .and_then(Value::as_array)
        .is_some_and(|options| {
            options.iter().any(|option| {
                let Some(option) = option.as_object() else {
                    return false;
                };
                option.get("optionId").and_then(Value::as_str) == Some(option_id)
                    && option.get("kind").and_then(Value::as_str) == Some("executable")
                    && option
                        .get("candidatePlan")
                        .and_then(Value::as_object)
                        .and_then(|plan| plan.get("planRevision"))
                        .and_then(Value::as_str)
                        == Some(plan_revision.as_str())
            })
        })
}

fn validate_compact_intervention_state(
    active: &SessionKernelCompactActiveV3,
    authority: &SessionKernelCompactAuthorityV3,
) -> Result<(), HostV2StorageError> {
    let research = active
        .intervention_research
        .as_ref()
        .map(|value| {
            value
                .as_object()
                .ok_or_else(compact_intervention_state_invalid)
        })
        .transpose()?;
    let intervention = active
        .user_intervention
        .as_ref()
        .map(|value| {
            value
                .as_object()
                .ok_or_else(compact_intervention_state_invalid)
        })
        .transpose()?;
    let decision = active
        .user_intervention_decision
        .as_ref()
        .map(|value| {
            value
                .as_object()
                .ok_or_else(compact_intervention_state_invalid)
        })
        .transpose()?;

    let user_intervention_wait = active
        .active_wait
        .as_ref()
        .and_then(Value::as_object)
        .filter(|wait| wait.get("kind").and_then(Value::as_str) == Some("userIntervention"));

    let Some(research) = research else {
        if intervention.is_some() || decision.is_some() || user_intervention_wait.is_some() {
            return Err(compact_intervention_state_invalid());
        }
        return Ok(());
    };

    validate_private_projection_fields(
        research,
        &[
            "schemaVersion",
            "runId",
            "inputId",
            "controlEpoch",
            "researchId",
            "triggerProviderTurnId",
            "predecessorPlanRef",
            "triggerCandidates",
            "triggerCandidateSetDigest",
            "evidenceProgressDigest",
            "guidanceRevision",
            "startedAt",
            "updatedAt",
        ],
        &["previousEvidenceProgressDigest", "lastCandidateSetDigest"],
        &[
            "runId",
            "inputId",
            "researchId",
            "triggerProviderTurnId",
            "startedAt",
            "updatedAt",
        ],
        &[],
        &["triggerCandidates"],
        &["predecessorPlanRef"],
        &["controlEpoch", "guidanceRevision"],
        &[],
    )
    .map_err(|_| compact_intervention_state_invalid())?;
    if research.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.session.intervention-research.v1")
        || research.get("runId").and_then(Value::as_str) != Some(authority.run_id.as_str())
        || research.get("inputId").and_then(Value::as_str)
            != Some(authority.current_input_id.as_str())
        || research.get("controlEpoch").and_then(Value::as_u64) != Some(authority.control_epoch)
    {
        return Err(compact_intervention_state_invalid());
    }
    for field in [
        "triggerCandidateSetDigest",
        "evidenceProgressDigest",
        "previousEvidenceProgressDigest",
        "lastCandidateSetDigest",
    ] {
        if let Some(value) = research.get(field) {
            validate_sha256_digest(
                value
                    .as_str()
                    .ok_or_else(compact_intervention_state_invalid)?,
                "interventionDigest",
            )
            .map_err(|_| compact_intervention_state_invalid())?;
        }
    }
    let predecessor = research
        .get("predecessorPlanRef")
        .and_then(Value::as_object)
        .ok_or_else(compact_intervention_state_invalid)?;
    validate_private_projection_fields(
        predecessor,
        &["planRevision", "planDigest"],
        &[],
        &["planRevision"],
        &[],
        &[],
        &[],
        &[],
        &[],
    )
    .map_err(|_| compact_intervention_state_invalid())?;
    validate_sha256_digest(
        predecessor
            .get("planDigest")
            .and_then(Value::as_str)
            .ok_or_else(compact_intervention_state_invalid)?,
        "interventionPredecessorPlanDigest",
    )
    .map_err(|_| compact_intervention_state_invalid())?;

    let candidates = research
        .get("triggerCandidates")
        .and_then(Value::as_array)
        .ok_or_else(compact_intervention_state_invalid)?;
    if candidates.is_empty() || candidates.len() > 128 {
        return Err(compact_intervention_state_invalid());
    }
    let mut discovery_ids = HashSet::new();
    let mut operation_ids = HashSet::new();
    let mut digest_candidates = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let candidate = candidate
            .as_object()
            .ok_or_else(compact_intervention_state_invalid)?;
        validate_private_projection_fields(
            candidate,
            &[
                "discoveryId",
                "operationId",
                "toolId",
                "argumentsDigest",
                "classification",
            ],
            &["preview", "rejection"],
            &["discoveryId", "operationId", "toolId"],
            &[],
            &[],
            &["preview", "rejection"],
            &[],
            &[],
        )
        .map_err(|_| compact_intervention_state_invalid())?;
        let discovery_id = candidate
            .get("discoveryId")
            .and_then(Value::as_str)
            .ok_or_else(compact_intervention_state_invalid)?;
        let operation_id = candidate
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(compact_intervention_state_invalid)?;
        let tool_id = candidate
            .get("toolId")
            .and_then(Value::as_str)
            .ok_or_else(compact_intervention_state_invalid)?;
        let arguments_digest = candidate
            .get("argumentsDigest")
            .and_then(Value::as_str)
            .ok_or_else(compact_intervention_state_invalid)?;
        validate_sha256_digest(arguments_digest, "interventionArgumentsDigest")
            .map_err(|_| compact_intervention_state_invalid())?;
        if !discovery_ids.insert(discovery_id)
            || !operation_ids.insert(operation_id)
            || !matches!(
                candidate.get("classification").and_then(Value::as_str),
                Some("planned" | "outOfPlan")
            )
            || candidate.contains_key("preview") == candidate.contains_key("rejection")
        {
            return Err(compact_intervention_state_invalid());
        }

        let mut digest_candidate = serde_json::Map::new();
        digest_candidate.insert(
            "discoveryId".to_string(),
            Value::String(discovery_id.to_string()),
        );
        digest_candidate.insert(
            "operationId".to_string(),
            Value::String(operation_id.to_string()),
        );
        digest_candidate.insert("toolId".to_string(), Value::String(tool_id.to_string()));
        digest_candidate.insert(
            "argumentsDigest".to_string(),
            Value::String(arguments_digest.to_string()),
        );
        digest_candidate.insert(
            "classification".to_string(),
            candidate
                .get("classification")
                .expect("validated intervention classification")
                .clone(),
        );
        if let Some(preview_value) = candidate.get("preview") {
            let preview = decode_private_scope_preview(preview_value, "interventionPreview")
                .map_err(|_| compact_intervention_state_invalid())?;
            let preview_object = preview_value
                .as_object()
                .ok_or_else(compact_intervention_state_invalid)?;
            let origin = preview_object
                .get("origin")
                .and_then(Value::as_object)
                .ok_or_else(compact_intervention_state_invalid)?;
            let origin_data = origin
                .get("data")
                .and_then(Value::as_object)
                .ok_or_else(compact_intervention_state_invalid)?;
            if preview.run_id.as_str() != authority.run_id
                || preview.control_epoch.get() != authority.control_epoch
                || preview.operation_id.as_str() != operation_id
                || preview.tool_id.as_str() != tool_id
                || origin.get("kind").and_then(Value::as_str) != Some("planDiscovery")
                || origin_data.get("discoveryId").and_then(Value::as_str) != Some(discovery_id)
            {
                return Err(compact_intervention_state_invalid());
            }
            digest_candidate.insert(
                "previewId".to_string(),
                preview_object
                    .get("previewId")
                    .expect("validated intervention preview id")
                    .clone(),
            );
            digest_candidate.insert(
                "scopeDigest".to_string(),
                preview_object
                    .get("scopeDigest")
                    .expect("validated intervention scope digest")
                    .clone(),
            );
        } else {
            let rejection = candidate
                .get("rejection")
                .and_then(Value::as_object)
                .ok_or_else(compact_intervention_state_invalid)?;
            validate_private_projection_fields(
                rejection,
                &["reason", "guidance"],
                &[],
                &["reason"],
                &["guidance"],
                &[],
                &[],
                &[],
                &[],
            )
            .map_err(|_| compact_intervention_state_invalid())?;
            if rejection
                .get("guidance")
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
            {
                return Err(compact_intervention_state_invalid());
            }
            digest_candidate.insert("rejection".to_string(), Value::Object(rejection.clone()));
        }
        digest_candidates.push(Value::Object(digest_candidate));
    }
    let expected_trigger_digest = canonical_sha256(&Value::Array(digest_candidates))
        .map_err(|_| compact_intervention_state_invalid())?;
    if research
        .get("triggerCandidateSetDigest")
        .and_then(Value::as_str)
        != Some(expected_trigger_digest.as_str())
    {
        return Err(compact_intervention_state_invalid());
    }

    let interaction_id = format!(
        "user-intervention-{}",
        research
            .get("researchId")
            .and_then(Value::as_str)
            .expect("validated research identity")
    );
    let mut option_ids = HashSet::new();
    if let Some(intervention) = intervention {
        validate_compact_user_intervention(
            intervention,
            research,
            authority,
            &interaction_id,
            &mut option_ids,
        )?;
    }
    if let Some(decision) = decision {
        validate_compact_user_intervention_decision(
            decision,
            intervention,
            research,
            &interaction_id,
            &option_ids,
        )?;
    }

    match (intervention, decision, user_intervention_wait) {
        (Some(card), None, Some(wait)) => {
            validate_private_projection_fields(
                wait,
                &[
                    "kind",
                    "interactionId",
                    "interactionRevision",
                    "candidateSetDigest",
                    "sinceHighWater",
                ],
                &[],
                &["interactionId", "interactionRevision"],
                &[],
                &[],
                &[],
                &[],
                &["sinceHighWater"],
            )
            .map_err(|_| compact_intervention_state_invalid())?;
            if wait.get("interactionId") != card.get("interactionId")
                || wait.get("interactionRevision") != card.get("interactionRevision")
                || wait.get("candidateSetDigest") != card.get("candidateSetDigest")
            {
                return Err(compact_intervention_state_invalid());
            }
        }
        (Some(_), None, None) | (_, Some(_), Some(_)) | (None, _, Some(_)) => {
            return Err(compact_intervention_state_invalid());
        }
        _ => {}
    }

    Ok(())
}

fn validate_compact_user_intervention(
    intervention: &serde_json::Map<String, Value>,
    research: &serde_json::Map<String, Value>,
    authority: &SessionKernelCompactAuthorityV3,
    expected_interaction_id: &str,
    option_ids: &mut HashSet<String>,
) -> Result<(), HostV2StorageError> {
    validate_private_projection_fields(
        intervention,
        &[
            "schemaVersion",
            "runId",
            "inputId",
            "controlEpoch",
            "interactionId",
            "interactionRevision",
            "candidateSetDigest",
            "problemSummary",
            "relevantFactRefs",
            "affectedPlanActionIds",
            "options",
            "evidenceProgressDigest",
            "recordedAt",
        ],
        &["recommendation"],
        &[
            "runId",
            "inputId",
            "interactionId",
            "interactionRevision",
            "recordedAt",
        ],
        &["problemSummary", "recommendation"],
        &["relevantFactRefs", "affectedPlanActionIds", "options"],
        &[],
        &["controlEpoch"],
        &[],
    )
    .map_err(|_| compact_intervention_state_invalid())?;
    let candidate_set_digest = intervention
        .get("candidateSetDigest")
        .and_then(Value::as_str)
        .ok_or_else(compact_intervention_state_invalid)?;
    validate_sha256_digest(candidate_set_digest, "interventionCandidateSetDigest")
        .map_err(|_| compact_intervention_state_invalid())?;
    validate_sha256_digest(
        intervention
            .get("evidenceProgressDigest")
            .and_then(Value::as_str)
            .ok_or_else(compact_intervention_state_invalid)?,
        "interventionEvidenceProgressDigest",
    )
    .map_err(|_| compact_intervention_state_invalid())?;
    if intervention.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.session.user-intervention.v1")
        || intervention.get("runId").and_then(Value::as_str) != Some(authority.run_id.as_str())
        || intervention.get("inputId").and_then(Value::as_str)
            != Some(authority.current_input_id.as_str())
        || intervention.get("controlEpoch").and_then(Value::as_u64) != Some(authority.control_epoch)
        || intervention.get("interactionId").and_then(Value::as_str)
            != Some(expected_interaction_id)
        || intervention.get("evidenceProgressDigest") != research.get("evidenceProgressDigest")
        || intervention
            .get("interactionRevision")
            .and_then(Value::as_str)
            != Some(
                format!(
                    "intervention-revision-{}",
                    candidate_set_digest.trim_start_matches("sha256:")
                )
                .as_str(),
            )
        || research.get("lastCandidateSetDigest") != intervention.get("candidateSetDigest")
        || intervention
            .get("problemSummary")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(compact_intervention_state_invalid());
    }
    for (field, require_non_empty) in [
        ("relevantFactRefs", false),
        ("affectedPlanActionIds", false),
    ] {
        validate_private_unique_identities(
            intervention
                .get(field)
                .and_then(Value::as_array)
                .ok_or_else(compact_intervention_state_invalid)?,
            "interventionIdentity",
            require_non_empty,
        )
        .map_err(|_| compact_intervention_state_invalid())?;
    }

    let options = intervention
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(compact_intervention_state_invalid)?;
    if options.is_empty() || options.len() > 16 {
        return Err(compact_intervention_state_invalid());
    }
    for option in options {
        let option = option
            .as_object()
            .ok_or_else(compact_intervention_state_invalid)?;
        validate_private_projection_fields(
            option,
            &[
                "optionId",
                "kind",
                "title",
                "description",
                "tradeoffs",
                "recommended",
                "actions",
            ],
            &["candidatePlan"],
            &["optionId"],
            &["title", "description"],
            &["tradeoffs", "actions"],
            &["candidatePlan"],
            &[],
            &[],
        )
        .map_err(|_| compact_intervention_state_invalid())?;
        let option_id = option
            .get("optionId")
            .and_then(Value::as_str)
            .ok_or_else(compact_intervention_state_invalid)?;
        let kind = option
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(compact_intervention_state_invalid)?;
        let tradeoffs = option
            .get("tradeoffs")
            .and_then(Value::as_array)
            .ok_or_else(compact_intervention_state_invalid)?;
        let actions = option
            .get("actions")
            .and_then(Value::as_array)
            .ok_or_else(compact_intervention_state_invalid)?;
        if !option_ids.insert(option_id.to_string())
            || !matches!(kind, "executable" | "guidanceOnly")
            || option.get("recommended").and_then(Value::as_bool).is_none()
            || ["title", "description"].iter().any(|field| {
                option
                    .get(*field)
                    .and_then(Value::as_str)
                    .is_none_or(|value| value.trim().is_empty())
            })
            || tradeoffs.is_empty()
            || tradeoffs.len() > 32
            || tradeoffs.iter().any(|tradeoff| {
                tradeoff
                    .as_str()
                    .is_none_or(|value| value.trim().is_empty())
            })
            || (kind == "executable") != option.contains_key("candidatePlan")
            || (kind == "executable") != !actions.is_empty()
        {
            return Err(compact_intervention_state_invalid());
        }
        if kind == "guidanceOnly" {
            continue;
        }
        let plan = option
            .get("candidatePlan")
            .and_then(Value::as_object)
            .ok_or_else(compact_intervention_state_invalid)?;
        validate_private_plan(plan).map_err(|_| compact_intervention_state_invalid())?;
        if plan.get("runId").and_then(Value::as_str) != Some(authority.run_id.as_str())
            || plan.get("inputId").and_then(Value::as_str)
                != Some(authority.current_input_id.as_str())
            || plan.get("predecessorPlanRef") != research.get("predecessorPlanRef")
            || plan
                .get("actions")
                .and_then(Value::as_array)
                .is_none_or(|plan_actions| plan_actions.len() != actions.len())
        {
            return Err(compact_intervention_state_invalid());
        }
        let plan_actions = plan
            .get("actions")
            .and_then(Value::as_array)
            .expect("validated candidate Plan actions");
        for (candidate_action, plan_action) in actions.iter().zip(plan_actions) {
            validate_compact_intervention_candidate_action(
                candidate_action,
                plan_action,
                authority,
                intervention,
                option_id,
            )?;
        }
    }
    Ok(())
}

fn validate_compact_intervention_candidate_action(
    candidate_action: &Value,
    plan_action: &Value,
    authority: &SessionKernelCompactAuthorityV3,
    intervention: &serde_json::Map<String, Value>,
    option_id: &str,
) -> Result<(), HostV2StorageError> {
    let action = candidate_action
        .as_object()
        .ok_or_else(compact_intervention_state_invalid)?;
    validate_private_projection_fields(
        action,
        &[
            "planActionId",
            "operationId",
            "toolId",
            "summary",
            "preview",
        ],
        &[],
        &["planActionId", "operationId", "toolId"],
        &["summary"],
        &[],
        &["preview"],
        &[],
        &[],
    )
    .map_err(|_| compact_intervention_state_invalid())?;
    if action
        .get("summary")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err(compact_intervention_state_invalid());
    }
    let manifest = plan_action
        .get("manifest")
        .and_then(Value::as_object)
        .ok_or_else(compact_intervention_state_invalid)?;
    for field in ["planActionId", "operationId", "toolId"] {
        if action.get(field) != manifest.get(field) {
            return Err(compact_intervention_state_invalid());
        }
    }
    let preview_value = action
        .get("preview")
        .ok_or_else(compact_intervention_state_invalid)?;
    let preview = decode_private_scope_preview(preview_value, "interventionCandidatePreview")
        .map_err(|_| compact_intervention_state_invalid())?;
    let preview_object = preview_value
        .as_object()
        .ok_or_else(compact_intervention_state_invalid)?;
    let origin = preview_object
        .get("origin")
        .and_then(Value::as_object)
        .ok_or_else(compact_intervention_state_invalid)?;
    let origin_data = origin
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(compact_intervention_state_invalid)?;
    if preview.run_id.as_str() != authority.run_id
        || preview.control_epoch.get() != authority.control_epoch
        || preview.plan_revision.as_str()
            != manifest
                .get("planRevision")
                .and_then(Value::as_str)
                .ok_or_else(compact_intervention_state_invalid)?
        || preview.plan_action_id.as_str()
            != action
                .get("planActionId")
                .and_then(Value::as_str)
                .ok_or_else(compact_intervention_state_invalid)?
        || preview.operation_id.as_str()
            != action
                .get("operationId")
                .and_then(Value::as_str)
                .ok_or_else(compact_intervention_state_invalid)?
        || preview.tool_id.as_str()
            != action
                .get("toolId")
                .and_then(Value::as_str)
                .ok_or_else(compact_intervention_state_invalid)?
        || origin.get("kind").and_then(Value::as_str) != Some("interventionCandidate")
        || origin_data.get("interactionId") != intervention.get("interactionId")
        || origin_data.get("interactionRevision") != intervention.get("interactionRevision")
        || origin_data.get("candidateSetDigest") != intervention.get("candidateSetDigest")
        || origin_data.get("optionId").and_then(Value::as_str) != Some(option_id)
    {
        return Err(compact_intervention_state_invalid());
    }
    Ok(())
}

fn validate_compact_user_intervention_decision(
    decision: &serde_json::Map<String, Value>,
    intervention: Option<&serde_json::Map<String, Value>>,
    research: &serde_json::Map<String, Value>,
    expected_interaction_id: &str,
    option_ids: &HashSet<String>,
) -> Result<(), HostV2StorageError> {
    validate_private_projection_fields(
        decision,
        &[
            "interactionId",
            "interactionRevision",
            "candidateSetDigest",
            "decision",
            "callerRequestId",
            "recordedAt",
        ],
        &["optionId", "guidance"],
        &[
            "interactionId",
            "interactionRevision",
            "callerRequestId",
            "recordedAt",
        ],
        &["guidance"],
        &[],
        &[],
        &[],
        &[],
    )
    .map_err(|_| compact_intervention_state_invalid())?;
    let decision_kind = decision
        .get("decision")
        .and_then(Value::as_str)
        .ok_or_else(compact_intervention_state_invalid)?;
    let option_id = decision.get("optionId").and_then(Value::as_str);
    let guidance = decision.get("guidance").and_then(Value::as_str);
    if !matches!(decision_kind, "select" | "revise" | "reject")
        || decision.get("interactionId").and_then(Value::as_str) != Some(expected_interaction_id)
        || guidance.is_some_and(|value| value.trim().is_empty())
    {
        return Err(compact_intervention_state_invalid());
    }
    match decision_kind {
        "select" => {
            let card = intervention.ok_or_else(compact_intervention_state_invalid)?;
            if option_id.is_none_or(|value| !option_ids.contains(value))
                || decision.get("interactionRevision") != card.get("interactionRevision")
                || decision.get("candidateSetDigest") != card.get("candidateSetDigest")
            {
                return Err(compact_intervention_state_invalid());
            }
        }
        "revise" => {
            if option_id.is_some()
                || guidance.is_none()
                || intervention.is_some()
                || decision.get("candidateSetDigest") != research.get("lastCandidateSetDigest")
            {
                return Err(compact_intervention_state_invalid());
            }
        }
        "reject" => {
            let card = intervention.ok_or_else(compact_intervention_state_invalid)?;
            if option_id.is_some()
                || decision.get("interactionRevision") != card.get("interactionRevision")
                || decision.get("candidateSetDigest") != card.get("candidateSetDigest")
            {
                return Err(compact_intervention_state_invalid());
            }
        }
        _ => unreachable!("validated intervention decision kind"),
    }
    Ok(())
}

fn compact_intervention_state_invalid() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "session_kernel_checkpoint_intervention_invalid",
        "Session Kernel compact checkpoint intervention state is not one exact current authority",
    )
}

fn validate_compact_terminal_answer_candidate(
    candidate: &SessionKernelCompactTerminalAnswerCandidateV1,
    checkpoint: &SessionKernelCompactCheckpointV3,
) -> Result<(), HostV2StorageError> {
    if candidate.schema_version != SESSION_TERMINAL_ANSWER_CANDIDATE_V1_SCHEMA
        || candidate.control_epoch == 0
        || candidate.control_epoch > MAX_SAFE_INTEGER_V3
        || candidate.language_revision != candidate.control_epoch
        || candidate.snapshot_high_water > checkpoint.cursor.snapshot_high_water
        || candidate.input_id != checkpoint.authority.current_input_id
        || candidate.control_epoch != checkpoint.authority.control_epoch
        || Some(&candidate.work_authority) != checkpoint.authority.work_authority.as_ref()
        || candidate.source_event_refs.is_empty()
    {
        return Err(terminal_answer_candidate_invalid());
    }
    validate_bounded_identity(
        &candidate.provider_turn_id,
        "terminalAnswerCandidate.providerTurnId",
        512,
    )?;
    validate_bounded_identity(&candidate.input_id, "terminalAnswerCandidate.inputId", 512)?;
    validate_session_work_authority_v3(&candidate.work_authority)?;
    validate_sha256_digest(&candidate.text_digest, "terminalAnswerCandidate.textDigest")?;
    validate_bounded_identity(
        &candidate.recorded_at,
        "terminalAnswerCandidate.recordedAt",
        1024,
    )?;
    let mut source_refs = HashSet::new();
    for source_ref in &candidate.source_event_refs {
        validate_bounded_identity(source_ref, "terminalAnswerCandidate.sourceEventRef", 512)?;
        if !source_refs.insert(source_ref.as_str()) {
            return Err(terminal_answer_candidate_invalid());
        }
    }
    Ok(())
}

fn validate_plan_confirmation_authority_v2(
    authority: &SessionPlanConfirmationAuthorityV2,
    run_id: &str,
    control_epoch: u64,
) -> Result<(), HostV2StorageError> {
    for (field, value) in [
        ("planRevision", authority.plan_revision.as_str()),
        ("providerTurnId", authority.provider_turn_id.as_str()),
        ("recordedAt", authority.recorded_at.as_str()),
    ] {
        validate_bounded_identity(value, field, 64 * 1024)?;
    }
    for (field, value) in [
        (
            "providerResponseDigest",
            authority.provider_response_digest.as_str(),
        ),
        ("planDigest", authority.plan_digest.as_str()),
        (
            "scopePreviewsDigest",
            authority.scope_previews_digest.as_str(),
        ),
        ("authorityDigest", authority.authority_digest.as_str()),
        (
            "toolContext.catalogDigest",
            authority.tool_context_ref.catalog_digest.as_str(),
        ),
        (
            "toolContext.contextDigest",
            authority.tool_context_ref.context_digest.as_str(),
        ),
    ] {
        validate_sha256_digest(value, field)?;
    }
    if authority.control_epoch != control_epoch
        || authority.control_epoch == 0
        || authority.control_epoch > MAX_SAFE_INTEGER_V3
        || authority.tool_context_ref.context_version.get() == 0
        || authority.tool_context_ref.context_version.get() > MAX_SAFE_INTEGER_V3
    {
        return Err(compact_checkpoint_authority_invalid());
    }
    let prefix = format!("run:{run_id}:plan:{}", authority.plan_revision);
    validate_plan_confirmation_projection_ref_v2(
        &authority.confirmation_projection,
        &format!("{prefix}:confirmation-ready"),
    )?;
    if let Some(commentary) = &authority.commentary_projection {
        validate_plan_confirmation_projection_ref_v2(
            commentary,
            &format!("{prefix}:commentary-ready"),
        )?;
    }
    let mut value =
        serde_json::to_value(authority).map_err(|_| compact_checkpoint_authority_invalid())?;
    value
        .as_object_mut()
        .ok_or_else(compact_checkpoint_authority_invalid)?
        .remove("authorityDigest");
    if canonical_sha256(&value)? != authority.authority_digest {
        return Err(compact_checkpoint_authority_invalid());
    }
    Ok(())
}

fn validate_plan_confirmation_projection_ref_v2(
    projection: &SessionPlanConfirmationProjectionRefV2,
    expected_projection_id: &str,
) -> Result<(), HostV2StorageError> {
    validate_bounded_identity(&projection.projection_id, "projectionId", 64 * 1024)?;
    validate_sha256_digest(&projection.projection_digest, "projectionDigest")?;
    if projection.projection_id != expected_projection_id {
        return Err(compact_checkpoint_authority_invalid());
    }
    Ok(())
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
        ("committedAt", final_answer.committed_at.as_deref()),
        ("failedAt", final_answer.failed_at.as_deref()),
        ("lastErrorCode", final_answer.last_error_code.as_deref()),
        ("commitKind", final_answer.commit_kind.as_deref()),
    ] {
        if let Some(value) = value {
            validate_bounded_identity(value, field, 1024)?;
        }
    }
    let commit_shape_invalid = final_answer.status != "committed"
        && (final_answer.committed_at.is_some() || final_answer.commit_kind.is_some())
        || final_answer
            .commit_kind
            .as_deref()
            .is_some_and(|kind| !matches!(kind, "candidatePromotion" | "finalSynthesis"));
    let shape_invalid = commit_shape_invalid
        || match final_answer.status.as_str() {
            "pending" => final_answer.provider_turn_id.is_some(),
            "requesting" => {
                final_answer.provider_turn_id.is_none() || final_answer.started_at.is_none()
            }
            "stale" => false,
            "committed" => {
                final_answer.provider_turn_id.is_none()
                    || final_answer.committed_at.is_none()
                    || final_answer.commit_kind.is_none()
            }
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

fn terminal_answer_candidate_invalid() -> HostV2StorageError {
    HostV2StorageError::invalid(
        "session_kernel_terminal_answer_candidate_invalid",
        "Session Kernel terminal answer candidate does not bind exact durable Provider and Session facts",
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
            "planning" | "planAction" | "contextRead" | "interventionResearch" | "finalAnswer"
        )
        || !reservation.fact_projection.is_object()
        || !reservation.context_assembly.is_object()
    {
        return Err(provider_turn_admission_invalid());
    }
    validate_bounded_identity(&reservation.status, "providerStatus", 128)?;
    if let Some(reason) = &reservation.cancellation_reason {
        validate_bounded_identity(reason, "cancellationReason", 128)?;
    }
    if let Some(correction) = &reservation.correction {
        validate_bounded_identity(&correction.retry_group_id, "correction.retryGroupId", 512)?;
        validate_bounded_identity(
            &correction.predecessor_operation_id,
            "correction.predecessorOperationId",
            512,
        )?;
        if correction.retry_ordinal < 2 || correction.retry_ordinal > MAX_SAFE_INTEGER_V3 {
            return Err(provider_turn_admission_invalid());
        }
    }
    for repair in [
        reservation.structured_repair.as_ref(),
        reservation.next_structured_repair.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if repair.schema_version != "deepcode.session.provider-structured-repair.v1"
            || !matches!(repair.source_terminal_kind.as_str(), "failed" | "completed")
            || (repair.source_terminal_kind == "completed")
                != repair.source_response_digest.is_some()
        {
            return Err(provider_turn_admission_invalid());
        }
        validate_bounded_identity(
            &repair.predecessor_provider_turn_id,
            "structuredRepair.predecessorProviderTurnId",
            512,
        )?;
        validate_bounded_identity(&repair.error_code, "structuredRepair.errorCode", 256)?;
        validate_sha256_digest(&repair.failure_digest, "structuredRepair.failureDigest")?;
        if let Some(response_digest) = &repair.source_response_digest {
            validate_sha256_digest(response_digest, "structuredRepair.sourceResponseDigest")?;
        }
    }
    if reservation
        .structured_repair
        .as_ref()
        .is_some_and(|repair| {
            reservation.purpose != ProviderTracePurposeV1::Continuation
                || repair.predecessor_provider_turn_id == reservation.provider_turn_id
        })
        || reservation
            .next_structured_repair
            .as_ref()
            .is_some_and(|repair| {
                reservation.status != "failed"
                    || repair.predecessor_provider_turn_id != reservation.provider_turn_id
            })
    {
        return Err(provider_turn_admission_invalid());
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

fn validate_compact_checkpoint_scope_previews(
    value: &Value,
    run_id: &str,
    control_epoch: u64,
) -> Result<(), HostV2StorageError> {
    let previews = value
        .as_object()
        .ok_or_else(compact_checkpoint_authority_invalid)?;
    let mut preview_ids = HashSet::new();
    let mut plan_action_ids = HashSet::new();
    for (operation_id, value) in previews {
        let preview: CapabilityScopePreviewRecordV2 = serde_json::from_value(value.clone())
            .map_err(|_| compact_checkpoint_authority_invalid())?;
        preview
            .validate()
            .map_err(|_| compact_checkpoint_authority_invalid())?;
        if preview.operation_id.as_str() != operation_id
            || preview.run_id.as_str() != run_id
            || preview.control_epoch.get() != control_epoch
            || !preview_ids.insert(preview.preview_id.as_str().to_string())
            || !plan_action_ids.insert(preview.plan_action_id.as_str().to_string())
        {
            return Err(compact_checkpoint_authority_invalid());
        }
    }
    Ok(())
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
            if data.structured_failure.is_some() {
                return Err(provider_completed_terminal_invalid());
            }
        }
        SessionProviderTurnTerminalKindV3::Failed => {
            let reason_code = data
                .reason_code
                .as_deref()
                .ok_or_else(provider_noncompleted_terminal_invalid)?;
            validate_bounded_identity(reason_code, "reasonCode", 256)?;
            if data.response_digest.is_some()
                || data.completion.is_some()
                || !data.ordered_items.is_empty()
            {
                return Err(provider_noncompleted_terminal_invalid());
            }
            match (&data.structured_failure, &data.provider_result) {
                (Some(failure), Some(result)) => {
                    validate_provider_structured_failure(failure)?;
                    validate_provider_result(result, &data.authority_binding)?;
                    if failure.get("errorCode").and_then(Value::as_str) != Some(reason_code) {
                        return Err(provider_noncompleted_terminal_invalid());
                    }
                }
                (None, None) => {}
                _ => return Err(provider_noncompleted_terminal_invalid()),
            }
        }
        SessionProviderTurnTerminalKindV3::Cancelled
        | SessionProviderTurnTerminalKindV3::LimitExceeded => {
            let reason_code = data
                .reason_code
                .as_deref()
                .ok_or_else(provider_noncompleted_terminal_invalid)?;
            validate_bounded_identity(reason_code, "reasonCode", 256)?;
            if data.response_digest.is_some()
                || data.completion.is_some()
                || data.provider_result.is_some()
                || data.structured_failure.is_some()
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
    if let Some(recovery) = &completion.structured_output_recovery {
        validate_provider_structured_recovery(recovery)?;
    }
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

fn validate_provider_structured_recovery(value: &Value) -> Result<(), HostV2StorageError> {
    let object = value
        .as_object()
        .ok_or_else(provider_completed_terminal_invalid)?;
    require_exact_object_keys(
        object,
        &[
            "schemaVersion",
            "disposition",
            "errorCode",
            "failureDigest",
            "calls",
        ],
        "provider_structured_output_recovery_invalid",
    )?;
    if object.get("schemaVersion").and_then(Value::as_str)
        != Some(PROVIDER_STRUCTURED_OUTPUT_RECOVERY_SCHEMA_V1)
        || object.get("disposition").and_then(Value::as_str) != Some("normalizedProposalControl")
        || object.get("errorCode").and_then(Value::as_str)
            != Some("provider_tool_call_arguments_invalid")
    {
        return Err(provider_completed_terminal_invalid());
    }
    validate_provider_structured_calls(object, true)?;
    Ok(())
}

fn validate_provider_structured_failure(value: &Value) -> Result<(), HostV2StorageError> {
    let object = value
        .as_object()
        .ok_or_else(provider_noncompleted_terminal_invalid)?;
    require_exact_object_keys(
        object,
        &[
            "schemaVersion",
            "disposition",
            "errorCode",
            "failureDigest",
            "nativeCompletion",
            "calls",
        ],
        "provider_structured_output_failure_invalid",
    )?;
    if object.get("schemaVersion").and_then(Value::as_str)
        != Some(PROVIDER_STRUCTURED_OUTPUT_FAILURE_SCHEMA_V1)
        || object.get("disposition").and_then(Value::as_str) != Some("repairableNoMutation")
        || object.get("errorCode").and_then(Value::as_str)
            != Some("provider_tool_call_arguments_invalid")
    {
        return Err(provider_noncompleted_terminal_invalid());
    }
    validate_provider_native_completion(
        object
            .get("nativeCompletion")
            .ok_or_else(provider_noncompleted_terminal_invalid)?,
    )?;
    validate_provider_structured_calls(object, false)?;
    Ok(())
}

fn validate_provider_structured_calls(
    object: &serde_json::Map<String, Value>,
    normalized: bool,
) -> Result<(), HostV2StorageError> {
    let calls = object
        .get("calls")
        .and_then(Value::as_array)
        .filter(|calls| !calls.is_empty() && calls.len() <= 32)
        .ok_or_else(provider_noncompleted_terminal_invalid)?;
    let mut digest_calls = Vec::with_capacity(calls.len());
    for call in calls {
        let call = call
            .as_object()
            .ok_or_else(provider_noncompleted_terminal_invalid)?;
        let expected_keys = if normalized {
            [
                "index",
                "callId",
                "toolName",
                "originalArgumentsDigest",
                "normalizedArgumentsDigest",
                "appendedSuffix",
            ]
            .as_slice()
        } else {
            ["index", "callId", "toolName", "originalArgumentsDigest"].as_slice()
        };
        require_exact_object_keys(
            call,
            expected_keys,
            "provider_structured_output_call_invalid",
        )?;
        let index = call
            .get("index")
            .and_then(Value::as_i64)
            .filter(|index| *index >= 0 && *index < 32)
            .ok_or_else(provider_noncompleted_terminal_invalid)?;
        let call_id = call
            .get("callId")
            .and_then(Value::as_str)
            .ok_or_else(provider_noncompleted_terminal_invalid)?;
        let tool_name = call
            .get("toolName")
            .and_then(Value::as_str)
            .ok_or_else(provider_noncompleted_terminal_invalid)?;
        let original_digest = call
            .get("originalArgumentsDigest")
            .and_then(Value::as_str)
            .ok_or_else(provider_noncompleted_terminal_invalid)?;
        validate_bounded_identity(call_id, "structuredOutput.callId", 1024)?;
        validate_bounded_identity(tool_name, "structuredOutput.toolName", 1024)?;
        validate_sha256_digest(original_digest, "structuredOutput.originalArgumentsDigest")?;
        if normalized {
            if !matches!(
                tool_name,
                "deepcode_session_plan_propose_v5" | "deepcode_session_intervention_propose_v1"
            ) {
                return Err(provider_completed_terminal_invalid());
            }
            let normalized_digest = call
                .get("normalizedArgumentsDigest")
                .and_then(Value::as_str)
                .ok_or_else(provider_completed_terminal_invalid)?;
            validate_sha256_digest(
                normalized_digest,
                "structuredOutput.normalizedArgumentsDigest",
            )?;
            let suffix = call
                .get("appendedSuffix")
                .and_then(Value::as_str)
                .filter(|suffix| {
                    !suffix.is_empty()
                        && suffix.len() <= 32
                        && suffix
                            .chars()
                            .all(|character| matches!(character, '}' | ']'))
                })
                .ok_or_else(provider_completed_terminal_invalid)?;
            let _ = suffix;
        }
        digest_calls.push(json!({
            "index": index,
            "toolName": tool_name,
            "originalArgumentsDigest": original_digest,
        }));
    }
    let expected_digest = stable_json_sha256(&json!({
        "errorCode": "provider_tool_call_arguments_invalid",
        "calls": digest_calls,
    }))?;
    if object.get("failureDigest").and_then(Value::as_str) != Some(expected_digest.as_str()) {
        return Err(provider_noncompleted_terminal_invalid());
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
        "attachmentContexts",
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
    let attachments = deepcode_kernel_abi::decode_agent_input_attachments_v3(
        object.get("attachments").ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_input_record_invalid",
                "Session Kernel input record has no attachments",
            )
        })?,
    )
    .map_err(|error| HostV2StorageError::invalid(error.code, error.message))?;
    let attachment_contexts: Vec<UserAttachmentContextV1> = serde_json::from_value(
        object
            .get("attachmentContexts")
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "session_kernel_input_record_invalid",
                    "Session Kernel input record has no attachmentContexts",
                )
            })?
            .clone(),
    )
    .map_err(|_| {
        HostV2StorageError::invalid(
            "session_kernel_input_record_invalid",
            "Session Kernel attachmentContexts use an invalid strict envelope",
        )
    })?;
    validate_user_attachment_contexts_v1(&attachments, &attachment_contexts)?;
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
    let expected_lane = request.intent.kind.expected_lane();
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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum SessionKernelTimelineUpdateV2 {
    Snapshot { snapshot: Value },
    Delta { delta: SessionKernelTimelineDeltaV2 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionKernelTimelineDeltaV2 {
    schema_version: String,
    shape_version: String,
    session_id: String,
    base_revision: u64,
    revision: u64,
    source_event_version: u64,
    generated_at: String,
    event_count: u64,
    turn_replacements: Vec<Value>,
    removed_turn_ids: Vec<String>,
    operations: Vec<Value>,
    root_replacements: BTreeMap<String, Value>,
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
    timeline_update: SessionKernelTimelineUpdateV2,
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
    latest_timelines: Arc<Mutex<HashMap<String, Value>>>,
}

impl SessionKernelProjectionSinkV2 {
    pub(crate) fn new(sessions_dir: PathBuf, active_runs: HostActiveRunBrokerV2) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            active_runs,
            projections: Arc::new(Mutex::new(HashMap::new())),
            prior_event_prefixes: Arc::new(Mutex::new(HashMap::new())),
            latest_timelines: Arc::new(Mutex::new(HashMap::new())),
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
        let (replayed, timeline) = with_storage_path_lock(&guard_path, || {
            let timeline = self.preflight_public_projection(session_id, &request)?;
            let replayed = if projection_request_replayed(&path, session_id, host_run_id, &request)?
            {
                true
            } else {
                self.preflight_public_projection_appends(
                    session_id,
                    host_run_id,
                    &request,
                    &timeline,
                    false,
                )?;
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
                self.preflight_public_projection_appends(
                    session_id,
                    host_run_id,
                    &request,
                    &timeline,
                    true,
                )?;
            }
            self.publish_agent_event_locked(session_id, &request)?;
            self.publish_timeline_locked(session_id, &request, &timeline)?;
            Ok((replayed, timeline))
        })?;
        self.remember_projection(session_id, host_run_id, &request)?;
        self.remember_latest_timeline(session_id, &timeline)?;
        if composer_projection_may_change_for_session_event(&request.event.kind) {
            self.active_runs
                .notify_composer_projection(session_id, "sessionInteractionUpdated");
        }
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
    ) -> Result<Value, HostV2StorageError> {
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
        let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
        let records = read_public_timeline_records(&path, session_id)?;
        if let Some(existing) = records
            .iter()
            .find(|record| record.projection_id == request.projection_id)
        {
            if existing.projection_digest == request.projection_digest && agent_event_replayed {
                validate_resolved_projection_digest(request, &existing.timeline)?;
                return Ok(existing.timeline.clone());
            }
            return Err(HostV2StorageError::conflict(
                "session_kernel_public_timeline_identity_conflict",
                "Session public timeline projection has different durable content",
            ));
        }
        let timeline = resolve_projection_timeline(
            session_id,
            request,
            records.last().map(|record| &record.timeline),
        )?;
        validate_resolved_projection_digest(request, &timeline)?;
        let incoming = public_timeline_record(request, &timeline)?;
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
        Ok(timeline)
    }

    fn preflight_public_projection_appends(
        &self,
        session_id: &str,
        host_run_id: &str,
        request: &SessionKernelHostProjectionRequestV2,
        timeline: &Value,
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

        let timeline_record = public_timeline_record(request, timeline)?;
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
        timeline: &Value,
    ) -> Result<(), HostV2StorageError> {
        let record = public_timeline_record(request, timeline)?;
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
        if let Some(timeline) = self.cached_latest_timeline(session_id)? {
            return normalize_public_timeline_for_view(&timeline).map(Some);
        }
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        let timeline = with_storage_path_lock(&guard_path, || {
            let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
            let records = read_public_timeline_records_for_view(&path, session_id)?;
            Ok(records.last().map(|record| record.timeline.clone()))
        })?;
        let Some(timeline) = timeline else {
            return Ok(None);
        };
        self.remember_latest_timeline(session_id, &timeline)?;
        normalize_public_timeline_for_view(&timeline).map(Some)
    }

    pub(crate) fn latest_timeline_for_run(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<Value>, HostV2StorageError> {
        validate_bounded_identity(run_id, "runId", 512)?;
        if let Some(timeline) = self.cached_latest_timeline(session_id)? {
            let cached_run_id = timeline
                .get("runProjection")
                .and_then(Value::as_object)
                .and_then(|run| run.get("runId"))
                .and_then(Value::as_str);
            if cached_run_id == Some(run_id) {
                return normalize_latest_public_timeline(&timeline).map(Some);
            }
        }
        let guard_path = public_projection_guard_path(self.sessions_dir.as_ref(), session_id)?;
        let (timeline, latest) = with_storage_path_lock(&guard_path, || {
            let path = public_timeline_path(self.sessions_dir.as_ref(), session_id)?;
            let records = read_public_timeline_records(&path, session_id)?;
            let timeline = records
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
                .map(|record| record.timeline.clone());
            let latest = records.last().map(|record| record.timeline.clone());
            Ok((timeline, latest))
        })?;
        if let Some(latest) = latest {
            self.remember_latest_timeline(session_id, &latest)?;
        }
        timeline
            .map(|timeline| normalize_latest_public_timeline(&timeline))
            .transpose()
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

    fn cached_latest_timeline(
        &self,
        session_id: &str,
    ) -> Result<Option<Value>, HostV2StorageError> {
        self.latest_timelines
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "session_kernel_public_timeline_cache_unavailable",
                    "Session public timeline cache is unavailable",
                )
            })
            .map(|timelines| timelines.get(session_id).cloned())
    }

    fn remember_latest_timeline(
        &self,
        session_id: &str,
        timeline: &Value,
    ) -> Result<(), HostV2StorageError> {
        self.latest_timelines
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "session_kernel_public_timeline_cache_unavailable",
                    "Session public timeline cache is unavailable",
                )
            })?
            .insert(session_id.to_string(), timeline.clone());
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

fn composer_projection_may_change_for_session_event(kind: &str) -> bool {
    matches!(
        kind,
        "plan.confirmationReady"
            | "plan.decided"
            | "capability.awaiting"
            | "authorization.decided"
            | "userIntervention.changed"
            | "wait.changed"
            | "review.revised"
            | "run.cancelled"
    )
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
            | "plan.commentaryReleased"
            | "plan.confirmationReady"
            | "input.persisted"
            | "scope.previewed"
            | "provider.started"
            | "provider.composing"
            | "provider.completed"
            | "provider.answerState"
            | "provider.stale"
            | "toolIntent.submitted"
            | "capability.awaiting"
            | "kernelFacts.reconciled"
            | "authorization.decided"
            | "review.revised"
            | "planAction.completed"
            | "userIntervention.changed"
            | "run.cancelled"
            | "wait.changed"
            | "diagnostic"
    ) {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_kind_invalid",
            "Session Kernel projection kind is not supported",
        ));
    }
    validate_private_projection_event_data(&request.event)?;
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
        Some((
            &request.projection_id,
            &request.event.recorded_at,
            &request.event.run_id,
            &request.event.kind,
        )),
    )?;
    let timeline_update = serde_json::to_value(&request.timeline_update).map_err(|error| {
        HostV2StorageError::invalid(
            "session_kernel_projection_record_invalid",
            format!("encode Session timeline update: {error}"),
        )
    })?;
    reject_transport_capabilities(&timeline_update)?;
    validate_projection_timeline_update(request, session_id)?;
    Ok(())
}

fn validate_projection_timeline_update(
    request: &SessionKernelHostProjectionRequestV2,
    session_id: &str,
) -> Result<(), HostV2StorageError> {
    match &request.timeline_update {
        SessionKernelTimelineUpdateV2::Snapshot { snapshot } => {
            validate_projection_snapshot(snapshot, session_id)
        }
        SessionKernelTimelineUpdateV2::Delta { delta } => {
            if request.event.kind != "provider.composing" {
                return Err(HostV2StorageError::invalid(
                    "session_kernel_timeline_delta_kind_invalid",
                    "Only Provider composing projections may use a timeline delta",
                ));
            }
            if delta.schema_version != "deepcode.shared-conversation-projection.v4"
                || delta.shape_version != "deepcode.shared-conversation.work-segments.v4"
                || delta.session_id != session_id
            {
                return Err(HostV2StorageError::invalid(
                    "session_kernel_timeline_delta_identity_invalid",
                    "Session timeline delta has an unsupported schema, shape, or Session identity",
                ));
            }
            for (field, value) in [
                ("baseRevision", delta.base_revision),
                ("revision", delta.revision),
                ("sourceEventVersion", delta.source_event_version),
                ("eventCount", delta.event_count),
            ] {
                if value > MAX_SAFE_INTEGER_V3 {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_delta_version_invalid",
                        format!("Session timeline delta {field} is not a safe integer"),
                    ));
                }
            }
            validate_bounded_identity(&delta.generated_at, "generatedAt", 512)?;
            if delta.generated_at != request.event.recorded_at {
                return Err(HostV2StorageError::invalid(
                    "session_kernel_timeline_delta_time_mismatch",
                    "Session timeline delta time does not match the projected event",
                ));
            }
            let allowed_roots = HashSet::from([
                "taskProjection",
                "interactionProjection",
                "tokenUsageProjection",
                "workspaceProjection",
            ]);
            if delta
                .root_replacements
                .keys()
                .any(|key| !allowed_roots.contains(key.as_str()))
            {
                return Err(HostV2StorageError::invalid(
                    "session_kernel_timeline_delta_root_invalid",
                    "Session timeline delta contains an unsupported root replacement",
                ));
            }
            let mut replacement_ids = HashSet::new();
            for turn in &delta.turn_replacements {
                let turn_id = turn.get("id").and_then(Value::as_str).ok_or_else(|| {
                    HostV2StorageError::invalid(
                        "session_kernel_timeline_delta_turn_invalid",
                        "Session timeline delta replacement requires a turn identity",
                    )
                })?;
                validate_bounded_identity(turn_id, "turnId", 512)?;
                if !replacement_ids.insert(turn_id) {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_delta_turn_invalid",
                        "Session timeline delta repeats a turn replacement",
                    ));
                }
            }
            let mut removed_ids = HashSet::new();
            for turn_id in &delta.removed_turn_ids {
                validate_bounded_identity(turn_id, "removedTurnId", 512)?;
                if !removed_ids.insert(turn_id.as_str())
                    || replacement_ids.contains(turn_id.as_str())
                {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_delta_turn_invalid",
                        "Session timeline delta repeats or conflicts with a removed turn",
                    ));
                }
            }
            validate_timeline_delta_operations_v3(
                &delta.operations,
                &replacement_ids,
                &removed_ids,
            )?;
            Ok(())
        }
    }
}

fn validate_projection_snapshot(
    snapshot: &Value,
    session_id: &str,
) -> Result<(), HostV2StorageError> {
    reject_transport_capabilities(snapshot)?;
    crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
        snapshot,
    )
    .map_err(|message| {
        HostV2StorageError::invalid("session_kernel_public_timeline_invalid", message)
    })?;
    if snapshot.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_timeline_identity_mismatch",
            "Session public timeline belongs to another Session",
        ));
    }
    Ok(())
}

fn validate_timeline_delta_operations_v3(
    operations: &[Value],
    replacement_ids: &HashSet<&str>,
    removed_ids: &HashSet<&str>,
) -> Result<(), HostV2StorageError> {
    let mut run_updates = 0_u8;
    let mut append_targets = HashSet::new();
    for operation in operations {
        let object = operation.as_object().ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_timeline_operation_invalid",
                "Session timeline delta operation must be an exact object",
            )
        })?;
        match object.get("kind").and_then(Value::as_str) {
            Some("run.updated") => {
                if object.len() != 2 || !object.contains_key("runProjection") {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_run_update_invalid",
                        "Session timeline run.updated must contain only kind and runProjection",
                    ));
                }
                run_updates = run_updates.saturating_add(1);
                if run_updates > 1 {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_run_update_duplicate",
                        "Session timeline delta contains more than one run.updated operation",
                    ));
                }
                let run_projection = object
                    .get("runProjection")
                    .expect("run.updated field checked");
                if !run_projection.is_null() && !run_projection.is_object() {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_run_update_invalid",
                        "Session timeline run.updated projection must be an object or null",
                    ));
                }
            }
            Some("text.append") => {
                if object.len() != 2 {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_text_append_invalid",
                        "Session timeline text.append must contain only kind and append",
                    ));
                }
                let append = object
                    .get("append")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        HostV2StorageError::invalid(
                            "session_kernel_timeline_text_append_invalid",
                            "Session timeline text.append requires an append object",
                        )
                    })?;
                let required = [
                    "turnId",
                    "blockId",
                    "baseBlockRevision",
                    "blockRevision",
                    "textDelta",
                    "sourceEventRefs",
                ];
                if append.len() != required.len()
                    || required.iter().any(|field| !append.contains_key(*field))
                {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_text_append_invalid",
                        "Session timeline text.append does not use the exact v3 shape",
                    ));
                }
                let turn_id = append
                    .get("turnId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        HostV2StorageError::invalid(
                            "session_kernel_timeline_text_append_invalid",
                            "Session timeline text.append requires turnId",
                        )
                    })?;
                let block_id = append
                    .get("blockId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        HostV2StorageError::invalid(
                            "session_kernel_timeline_text_append_invalid",
                            "Session timeline text.append requires blockId",
                        )
                    })?;
                validate_bounded_identity(turn_id, "textAppend.turnId", 512)?;
                validate_bounded_identity(block_id, "textAppend.blockId", 512)?;
                if replacement_ids.contains(turn_id) || removed_ids.contains(turn_id) {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_text_append_conflict",
                        "Session timeline text.append conflicts with a turn replacement or removal",
                    ));
                }
                if !append_targets.insert((turn_id, block_id)) {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_text_append_duplicate",
                        "Session timeline delta repeats a text append target",
                    ));
                }
                let base_revision = append
                    .get("baseBlockRevision")
                    .and_then(Value::as_u64)
                    .filter(|value| *value > 0 && *value <= MAX_SAFE_INTEGER_V3)
                    .ok_or_else(|| {
                        HostV2StorageError::invalid(
                            "session_kernel_timeline_text_append_invalid",
                            "Session timeline text.append base revision must be positive and safe",
                        )
                    })?;
                let block_revision = append
                    .get("blockRevision")
                    .and_then(Value::as_u64)
                    .filter(|value| *value <= MAX_SAFE_INTEGER_V3)
                    .ok_or_else(|| {
                        HostV2StorageError::invalid(
                            "session_kernel_timeline_text_append_invalid",
                            "Session timeline text.append revision must be safe",
                        )
                    })?;
                if base_revision.checked_add(1) != Some(block_revision) {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_text_append_revision_invalid",
                        "Session timeline text.append must advance exactly one block revision",
                    ));
                }
                if append
                    .get("textDelta")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_text_append_invalid",
                        "Session timeline text.append textDelta must be non-empty",
                    ));
                }
                let source_refs = append
                    .get("sourceEventRefs")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        HostV2StorageError::invalid(
                            "session_kernel_timeline_text_append_invalid",
                            "Session timeline text.append requires sourceEventRefs",
                        )
                    })?;
                let mut unique_refs = HashSet::new();
                if source_refs.is_empty()
                    || source_refs.iter().any(|source_ref| {
                        source_ref
                            .as_str()
                            .filter(|value| !value.is_empty())
                            .is_none_or(|value| !unique_refs.insert(value))
                    })
                {
                    return Err(HostV2StorageError::invalid(
                        "session_kernel_timeline_text_append_source_invalid",
                        "Session timeline text.append source refs must be non-empty and unique",
                    ));
                }
            }
            _ => {
                return Err(HostV2StorageError::invalid(
                    "session_kernel_timeline_operation_invalid",
                    "Session timeline delta operation kind is unsupported",
                ))
            }
        }
    }
    if run_updates != 1 {
        return Err(HostV2StorageError::invalid(
            "session_kernel_timeline_run_update_missing",
            "Provider composing timeline delta requires exactly one run.updated operation",
        ));
    }
    Ok(())
}

fn resolve_projection_timeline(
    session_id: &str,
    request: &SessionKernelHostProjectionRequestV2,
    current: Option<&Value>,
) -> Result<Value, HostV2StorageError> {
    let timeline = match &request.timeline_update {
        SessionKernelTimelineUpdateV2::Snapshot { snapshot } => snapshot.clone(),
        SessionKernelTimelineUpdateV2::Delta { delta } => {
            let current = current.ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_timeline_delta_base_missing",
                    "Session timeline delta has no canonical base snapshot",
                )
            })?;
            apply_projection_timeline_delta(current, delta)?
        }
    };
    validate_projection_snapshot(&timeline, session_id)?;
    if timeline.get("generatedAt").and_then(Value::as_str)
        != Some(request.event.recorded_at.as_str())
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_timeline_time_mismatch",
            "Session public timeline time does not match the projected event",
        ));
    }
    Ok(timeline)
}

fn apply_projection_timeline_delta(
    current: &Value,
    delta: &SessionKernelTimelineDeltaV2,
) -> Result<Value, HostV2StorageError> {
    let current_revision = timeline_u64(current, "revision")?;
    let current_source_event_version = timeline_u64(current, "sourceEventVersion")?;
    let current_event_count = timeline_u64(current, "eventCount")?;
    if delta.base_revision != current_revision
        || delta.revision
            != current_revision.checked_add(1).ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_timeline_delta_version_exhausted",
                    "Session timeline revision is exhausted",
                )
            })?
        || delta.source_event_version
            != current_source_event_version.checked_add(1).ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_timeline_delta_version_exhausted",
                    "Session timeline source-event version is exhausted",
                )
            })?
        || delta.event_count
            != current_event_count.checked_add(1).ok_or_else(|| {
                HostV2StorageError::conflict(
                    "session_kernel_timeline_delta_version_exhausted",
                    "Session timeline event count is exhausted",
                )
            })?
    {
        return Err(HostV2StorageError::conflict(
            "session_kernel_timeline_delta_revision_gap",
            "Session timeline delta does not extend the exact canonical revision",
        ));
    }
    let current_object = current.as_object().ok_or_else(|| {
        HostV2StorageError::conflict(
            "session_kernel_public_timeline_history_corrupt",
            "Canonical Session timeline is not an object",
        )
    })?;
    let mut timeline = current_object.clone();
    let current_turns = current_object
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Canonical Session timeline has no turn array",
            )
        })?;
    let removed = delta
        .removed_turn_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let replacements = delta
        .turn_replacements
        .iter()
        .map(|turn| {
            let turn_id = turn
                .get("id")
                .and_then(Value::as_str)
                .expect("timeline delta validated before application");
            (turn_id, turn.clone())
        })
        .collect::<BTreeMap<_, _>>();
    let mut known_turn_ids = HashSet::new();
    let mut turns = Vec::new();
    for turn in current_turns {
        let turn_id = turn.get("id").and_then(Value::as_str).ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Canonical Session timeline turn has no identity",
            )
        })?;
        if removed.contains(turn_id) {
            continue;
        }
        turns.push(
            replacements
                .get(turn_id)
                .cloned()
                .unwrap_or_else(|| turn.clone()),
        );
        known_turn_ids.insert(turn_id);
    }
    for (turn_id, replacement) in &replacements {
        if !known_turn_ids.contains(turn_id) {
            turns.push(replacement.clone());
        }
    }
    turns.sort_by_key(|turn| {
        turn.get("sequence")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
    });
    for operation in &delta.operations {
        if operation.get("kind").and_then(Value::as_str) == Some("text.append") {
            let append = operation
                .get("append")
                .and_then(Value::as_object)
                .expect("timeline text.append validated before application");
            apply_timeline_text_append_v3(&mut turns, append)?;
        }
    }
    timeline.insert("schemaVersion".to_string(), json!(delta.schema_version));
    timeline.insert("shapeVersion".to_string(), json!(delta.shape_version));
    timeline.insert("sessionId".to_string(), json!(delta.session_id));
    timeline.insert("revision".to_string(), json!(delta.revision));
    timeline.insert(
        "sourceEventVersion".to_string(),
        json!(delta.source_event_version),
    );
    timeline.insert("generatedAt".to_string(), json!(delta.generated_at));
    timeline.insert("eventCount".to_string(), json!(delta.event_count));
    timeline.insert("turns".to_string(), Value::Array(turns));
    for (field, replacement) in &delta.root_replacements {
        if replacement.is_null() {
            timeline.remove(field);
        } else {
            timeline.insert(field.clone(), replacement.clone());
        }
    }
    for operation in &delta.operations {
        if operation.get("kind").and_then(Value::as_str) != Some("run.updated") {
            continue;
        }
        let run_projection = operation
            .get("runProjection")
            .expect("timeline run.updated validated before application");
        if run_projection.is_null() {
            timeline.remove("runProjection");
        } else {
            timeline.insert("runProjection".to_string(), run_projection.clone());
        }
    }
    Ok(Value::Object(timeline))
}

fn apply_timeline_text_append_v3(
    turns: &mut [Value],
    append: &serde_json::Map<String, Value>,
) -> Result<(), HostV2StorageError> {
    let turn_id = append
        .get("turnId")
        .and_then(Value::as_str)
        .expect("timeline text.append turnId validated");
    let block_id = append
        .get("blockId")
        .and_then(Value::as_str)
        .expect("timeline text.append blockId validated");
    let base_revision = append
        .get("baseBlockRevision")
        .and_then(Value::as_u64)
        .expect("timeline text.append base revision validated");
    let block_revision = append
        .get("blockRevision")
        .and_then(Value::as_u64)
        .expect("timeline text.append block revision validated");
    let text_delta = append
        .get("textDelta")
        .and_then(Value::as_str)
        .expect("timeline text.append text validated");
    let source_refs = append
        .get("sourceEventRefs")
        .and_then(Value::as_array)
        .expect("timeline text.append source refs validated");
    let turn = turns
        .iter_mut()
        .find(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_timeline_text_append_turn_missing",
                "Session timeline text.append target turn does not exist",
            )
        })?;
    let blocks = turn
        .get_mut("blocks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Canonical Session timeline turn has no blocks",
            )
        })?;
    let block = blocks
        .iter_mut()
        .find(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_timeline_text_append_block_missing",
                "Session timeline text.append target block does not exist",
            )
        })?;
    if block.get("kind").and_then(Value::as_str) != Some("assistant")
        || block.get("narrativeKind").and_then(Value::as_str) != Some("assistantText")
        || block.get("revision").and_then(Value::as_u64) != Some(base_revision)
    {
        return Err(HostV2StorageError::conflict(
            "session_kernel_timeline_text_append_contract_invalid",
            "Session timeline text.append does not match the canonical assistant block",
        ));
    }
    let summary = block
        .get("summary")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Canonical Session timeline block has no summary",
            )
        })?;
    let body = block
        .get("bodyMarkdown")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let next_summary = format!("{summary}{text_delta}");
    let next_body = format!("{body}{text_delta}");
    let provenance = block
        .get_mut("provenance")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Canonical Session timeline block has no provenance",
            )
        })?;
    let current_refs = provenance
        .get_mut("sourceEventRefs")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            HostV2StorageError::conflict(
                "session_kernel_public_timeline_history_corrupt",
                "Canonical Session timeline block has no source refs",
            )
        })?;
    if source_refs
        .iter()
        .any(|source_ref| current_refs.contains(source_ref))
    {
        return Err(HostV2StorageError::conflict(
            "session_kernel_timeline_text_append_source_conflict",
            "Session timeline text.append source refs do not monotonically extend the block",
        ));
    }
    current_refs.extend(source_refs.iter().cloned());
    block.insert("revision".to_string(), json!(block_revision));
    block.insert("summary".to_string(), json!(next_summary));
    block.insert("bodyMarkdown".to_string(), json!(next_body));
    Ok(())
}

fn validate_resolved_projection_digest(
    request: &SessionKernelHostProjectionRequestV2,
    timeline: &Value,
) -> Result<(), HostV2StorageError> {
    let event = serde_json::to_value(&request.event).map_err(|error| {
        HostV2StorageError::invalid(
            "session_kernel_projection_record_invalid",
            format!("encode Session Kernel projection event: {error}"),
        )
    })?;
    let projection_payload = json!({
        "event": event,
        "agentEvent": request.agent_event,
        "timeline": timeline,
    });
    if canonical_sha256(&projection_payload)? != request.projection_digest {
        return Err(HostV2StorageError::invalid(
            "session_kernel_projection_digest_mismatch",
            "Session Kernel projection failed digest verification",
        ));
    }
    Ok(())
}

fn validate_private_projection_event_data(
    event: &SessionKernelProjectionEventV2,
) -> Result<(), HostV2StorageError> {
    let data = match event.kind.as_str() {
        "wait.changed" if event.data.is_null() => return Ok(()),
        _ => event.data.as_object().ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_projection_data_invalid",
                "Session private projection data must use the exact current object shape",
            )
        })?,
    };

    match event.kind.as_str() {
        "input.persisted" => {
            validate_private_projection_fields(
                data,
                &[
                    "inputId",
                    "opaqueInputRef",
                    "text",
                    "attachments",
                    "recordedAt",
                    "controlEpoch",
                ],
                &[],
                &["inputId", "opaqueInputRef", "recordedAt"],
                &["text"],
                &["attachments"],
                &[],
                &["controlEpoch"],
                &[],
            )?;
            deepcode_kernel_abi::decode_agent_input_attachments_v3(
                data.get("attachments").expect("required attachments"),
            )
            .map_err(|error| {
                HostV2StorageError::invalid(
                    "session_kernel_projection_data_invalid",
                    format!(
                        "Session private input attachments are invalid: {}",
                        error.code
                    ),
                )
            })?;
        }
        "plan.persisted" => {
            validate_private_plan(data)?;
            if data.get("runId").and_then(Value::as_str) != Some(event.run_id.as_str()) {
                return Err(private_projection_data_invalid(
                    "Plan runId does not match the private projection Run",
                ));
            }
        }
        "plan.decided" => {
            validate_private_projection_fields(
                data,
                &["planRevision", "decision", "recordedAt"],
                &["guidance"],
                &["planRevision", "recordedAt"],
                &["guidance"],
                &[],
                &[],
                &[],
                &[],
            )?;
            require_private_enum(data, "decision", &["accept", "reject", "revise"])?;
        }
        "plan.commentaryReleased" => validate_private_plan_commentary_released(data)?,
        "plan.confirmationReady" => validate_private_plan_confirmation_ready(data)?,
        "scope.previewed" => validate_private_scope_projection(data)?,
        "provider.started" => {
            if data.contains_key("currentActivityCode") {
                validate_private_projection_fields(
                    data,
                    &[
                        "providerTurnId",
                        "controlEpoch",
                        "activitySequence",
                        "currentActivityCode",
                    ],
                    &[],
                    &["providerTurnId"],
                    &[],
                    &[],
                    &[],
                    &["controlEpoch", "activitySequence"],
                    &[],
                )?;
                require_private_enum(
                    data,
                    "currentActivityCode",
                    &["provider.reasoning", "provider.composing"],
                )?;
            } else {
                validate_private_projection_fields(
                    data,
                    &[
                        "providerTurnId",
                        "controlEpoch",
                        "contextRef",
                        "factProjection",
                        "contextAssembly",
                    ],
                    &[],
                    &["providerTurnId"],
                    &[],
                    &[],
                    &["contextRef", "factProjection", "contextAssembly"],
                    &["controlEpoch"],
                    &[],
                )?;
            }
        }
        "provider.composing" => {
            validate_private_projection_fields(
                data,
                &[
                    "providerTurnId",
                    "controlEpoch",
                    "streamSequence",
                    "textOrdinal",
                    "textDelta",
                ],
                &["providerPhase"],
                &["providerTurnId"],
                &["textDelta"],
                &[],
                &[],
                &["controlEpoch", "streamSequence", "textOrdinal"],
                &[],
            )?;
            if data.contains_key("providerPhase") {
                require_private_enum(data, "providerPhase", &["commentary", "final_answer"])?;
            }
        }
        "provider.completed" => validate_private_provider_completed(data)?,
        "provider.answerState" => {
            validate_private_projection_fields(
                data,
                &[
                    "providerTurnId",
                    "controlEpoch",
                    "answerState",
                    "reasonCode",
                ],
                &[],
                &["providerTurnId", "reasonCode"],
                &["answerState"],
                &[],
                &[],
                &["controlEpoch"],
                &[],
            )?;
            require_private_enum(data, "answerState", &["stale", "rejected"])?;
        }
        "provider.stale" => validate_private_projection_fields(
            data,
            &["providerTurnId"],
            &["controlEpoch"],
            &["providerTurnId"],
            &[],
            &[],
            &[],
            &["controlEpoch"],
            &[],
        )?,
        "toolIntent.submitted" => validate_private_tool_intent(data)?,
        "capability.awaiting" => {
            validate_private_projection_fields(
                data,
                &["operationId", "invocationId", "preview"],
                &[],
                &["operationId", "invocationId"],
                &[],
                &[],
                &["preview"],
                &[],
                &[],
            )?;
            let preview = decode_private_scope_preview(
                data.get("preview").expect("required preview"),
                "capability.awaiting.preview",
            )?;
            if data.get("operationId").and_then(Value::as_str)
                != Some(preview.operation_id.as_str())
            {
                return Err(private_projection_data_invalid(
                    "Capability wait operationId does not match its canonical preview",
                ));
            }
        }
        "kernelFacts.reconciled" => validate_private_projection_fields(
            data,
            &[
                "requestId",
                "pageFactIds",
                "pageFactCount",
                "operationFacts",
                "nextAfterLedgerSequence",
                "snapshotHighWater",
            ],
            &[],
            &["requestId"],
            &[],
            &["pageFactIds", "operationFacts"],
            &[],
            &[],
            &[
                "pageFactCount",
                "nextAfterLedgerSequence",
                "snapshotHighWater",
            ],
        )?,
        "authorization.decided" => {
            validate_private_projection_fields(
                data,
                &[
                    "factId",
                    "factKind",
                    "controlEpoch",
                    "planActionIds",
                    "operationId",
                    "resourceIds",
                    "details",
                ],
                &[
                    "previewId",
                    "toolId",
                    "capabilityLease",
                    "guidance",
                    "scopeDelta",
                ],
                &["factId", "operationId", "previewId", "toolId"],
                &["guidance"],
                &["planActionIds", "resourceIds"],
                &["details", "capabilityLease"],
                &["controlEpoch"],
                &[],
            )?;
            require_private_enum(
                data,
                "factKind",
                &[
                    "capabilityIssued",
                    "capabilityDenied",
                    "expansionAllowed",
                    "expansionDenied",
                ],
            )?;
        }
        "review.revised" => {
            validate_private_projection_fields(
                data,
                &[
                    "projectionVersion",
                    "revision",
                    "status",
                    "planActionSettlementDigest",
                    "snapshotHighWater",
                    "planned",
                    "scopeExpansions",
                    "actualEffects",
                    "unexecuted",
                    "denied",
                    "rejections",
                    "completions",
                    "cleanup",
                    "indeterminate",
                    "priorEpochLateFacts",
                    "factCoverage",
                    "factsQuery",
                    "pendingCleanupCount",
                    "createdAt",
                ],
                &[
                    "workAuthority",
                    "planRevision",
                    "planDecision",
                    "plan",
                    "finalizedAt",
                ],
                &[
                    "projectionVersion",
                    "planActionSettlementDigest",
                    "planRevision",
                    "createdAt",
                    "finalizedAt",
                ],
                &[],
                &[
                    "planned",
                    "scopeExpansions",
                    "actualEffects",
                    "unexecuted",
                    "denied",
                    "rejections",
                    "completions",
                    "cleanup",
                    "indeterminate",
                    "priorEpochLateFacts",
                ],
                &[
                    "workAuthority",
                    "planDecision",
                    "plan",
                    "factCoverage",
                    "factsQuery",
                ],
                &["revision"],
                &["snapshotHighWater", "pendingCleanupCount"],
            )?;
            if data.get("projectionVersion").and_then(Value::as_str)
                != Some("deepcode.session.kernel-review-projection.v2")
            {
                return Err(private_projection_data_invalid(
                    "Review projectionVersion is not current",
                ));
            }
            require_private_enum(data, "status", &["final"])?;
        }
        "planAction.completed" => {
            validate_private_projection_fields(
                data,
                &[
                    "kind",
                    "planRevision",
                    "planActionId",
                    "controlEpoch",
                    "outcome",
                    "providerTurnId",
                    "controlCallId",
                    "controlArgumentsDigest",
                    "snapshotHighWater",
                    "recordedAt",
                ],
                &[],
                &[
                    "planRevision",
                    "planActionId",
                    "providerTurnId",
                    "controlCallId",
                    "controlArgumentsDigest",
                    "recordedAt",
                ],
                &["outcome"],
                &[],
                &[],
                &["controlEpoch"],
                &["snapshotHighWater"],
            )?;
            require_private_enum(data, "kind", &["planActionComplete"])?;
            require_private_enum(
                data,
                "outcome",
                &["completed", "no_op", "blocked", "skipped", "unexecuted"],
            )?;
        }
        "userIntervention.changed" => validate_private_user_intervention(data)?,
        "run.cancelled" => validate_private_projection_fields(
            data,
            &[
                "callerRequestId",
                "callerRequestDigest",
                "cancelOperationId",
                "controlEpoch",
                "cancellation",
                "facts",
            ],
            &[],
            &[
                "callerRequestId",
                "callerRequestDigest",
                "cancelOperationId",
            ],
            &[],
            &[],
            &["cancellation", "facts"],
            &["controlEpoch"],
            &[],
        )?,
        "wait.changed" => validate_private_wait(data)?,
        "diagnostic" => validate_private_diagnostic(data)?,
        _ => {
            return Err(private_projection_data_invalid(
                "Session private projection kind is not current",
            ))
        }
    }
    Ok(())
}

fn validate_private_user_intervention(
    data: &serde_json::Map<String, Value>,
) -> Result<(), HostV2StorageError> {
    let state = data
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match state {
        "open" => validate_private_projection_fields(
            data,
            &["state", "wait", "intervention"],
            &[],
            &[],
            &["state"],
            &[],
            &["wait", "intervention"],
            &[],
            &[],
        )?,
        "accepted" => validate_private_projection_fields(
            data,
            &["state", "intervention", "decision", "acceptedPlanRevision"],
            &[],
            &["acceptedPlanRevision"],
            &["state"],
            &[],
            &["intervention", "decision"],
            &[],
            &[],
        )?,
        "needsRevision" | "guidanceReplan" | "rejected" => {
            validate_private_projection_fields(
                data,
                &["state", "intervention", "decision"],
                &[],
                &[],
                &["state"],
                &[],
                &["intervention", "decision"],
                &[],
                &[],
            )?;
        }
        _ => {
            return Err(private_projection_data_invalid(
                "User intervention state is not current",
            ))
        }
    }
    let intervention = data
        .get("intervention")
        .and_then(Value::as_object)
        .ok_or_else(|| private_projection_data_invalid("User intervention card is invalid"))?;
    for field in [
        "runId",
        "inputId",
        "interactionId",
        "interactionRevision",
        "candidateSetDigest",
        "evidenceProgressDigest",
        "recordedAt",
    ] {
        let value = intervention
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| {
                private_projection_data_invalid("User intervention identity is missing")
            })?;
        validate_bounded_identity(value, field, 64 * 1024)?;
    }
    if intervention.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.session.user-intervention.v1")
        || intervention
            .get("problemSummary")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        || intervention
            .get("controlEpoch")
            .and_then(Value::as_u64)
            .is_none_or(|value| value == 0)
        || intervention
            .get("options")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
    {
        return Err(private_projection_data_invalid(
            "User intervention card is incomplete",
        ));
    }
    if state == "open" {
        let wait = data
            .get("wait")
            .and_then(Value::as_object)
            .ok_or_else(|| private_projection_data_invalid("User intervention wait is invalid"))?;
        if wait.get("kind").and_then(Value::as_str) != Some("userIntervention")
            || wait.get("interactionId") != intervention.get("interactionId")
            || wait.get("interactionRevision") != intervention.get("interactionRevision")
            || wait.get("candidateSetDigest") != intervention.get("candidateSetDigest")
        {
            return Err(private_projection_data_invalid(
                "User intervention wait identity does not match its card",
            ));
        }
    } else {
        let decision = data
            .get("decision")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                private_projection_data_invalid("User intervention decision is invalid")
            })?;
        if decision.get("interactionId") != intervention.get("interactionId")
            || decision.get("interactionRevision") != intervention.get("interactionRevision")
            || decision.get("candidateSetDigest") != intervention.get("candidateSetDigest")
        {
            return Err(private_projection_data_invalid(
                "User intervention decision identity does not match its card",
            ));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_private_projection_fields(
    data: &serde_json::Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    identities: &[&str],
    strings: &[&str],
    arrays: &[&str],
    objects: &[&str],
    positive_integers: &[&str],
    non_negative_integers: &[&str],
) -> Result<(), HostV2StorageError> {
    let unknown_fields = data
        .keys()
        .filter(|field| !required.contains(&field.as_str()) && !optional.contains(&field.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let missing_fields = required
        .iter()
        .filter(|field| !data.contains_key(**field) || data.get(**field) == Some(&Value::Null))
        .copied()
        .collect::<Vec<_>>();
    if !unknown_fields.is_empty() || !missing_fields.is_empty() {
        return Err(private_projection_data_invalid(format!(
            "Session private projection fields are not current (unknown: [{}]; missing: [{}])",
            unknown_fields.join(", "),
            missing_fields.join(", ")
        )));
    }
    for field in identities {
        if let Some(value) = data.get(*field) {
            let value = value.as_str().ok_or_else(|| {
                private_projection_data_invalid("Session private projection identity is invalid")
            })?;
            validate_bounded_identity(value, "projectionDataIdentity", 64 * 1024)?;
        }
    }
    for field in strings {
        if data.get(*field).is_some_and(|value| !value.is_string()) {
            return Err(private_projection_data_invalid(
                "Session private projection string field is invalid",
            ));
        }
    }
    for field in arrays {
        if data.get(*field).is_some_and(|value| !value.is_array()) {
            return Err(private_projection_data_invalid(
                "Session private projection array field is invalid",
            ));
        }
    }
    for field in objects {
        if data.get(*field).is_some_and(|value| !value.is_object()) {
            return Err(private_projection_data_invalid(
                "Session private projection object field is invalid",
            ));
        }
    }
    for field in positive_integers {
        if let Some(value) = data.get(*field) {
            if value.as_u64().is_none_or(|value| value == 0) {
                return Err(private_projection_data_invalid(
                    "Session private projection positive integer is invalid",
                ));
            }
        }
    }
    for field in non_negative_integers {
        if let Some(value) = data.get(*field) {
            if value.as_u64().is_none() {
                return Err(private_projection_data_invalid(
                    "Session private projection non-negative integer is invalid",
                ));
            }
        }
    }
    Ok(())
}

fn private_projection_data_invalid(message: impl Into<String>) -> HostV2StorageError {
    HostV2StorageError::invalid("session_kernel_projection_data_invalid", message)
}

fn require_private_enum(
    data: &serde_json::Map<String, Value>,
    field: &str,
    allowed: &[&str],
) -> Result<(), HostV2StorageError> {
    if !data
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(|value| allowed.contains(&value))
    {
        return Err(private_projection_data_invalid(
            "Session private projection discriminant is not current",
        ));
    }
    Ok(())
}

fn validate_private_plan(data: &serde_json::Map<String, Value>) -> Result<(), HostV2StorageError> {
    validate_private_projection_fields(
        data,
        &[
            "runId",
            "inputId",
            "controlEpoch",
            "planRevision",
            "title",
            "objective",
            "narrative",
            "evidence",
            "carriedSettlementRefs",
            "actions",
            "recordedAt",
        ],
        &["predecessorPlanRef"],
        &["runId", "inputId", "planRevision", "recordedAt"],
        &["title", "objective", "narrative"],
        &["carriedSettlementRefs", "actions"],
        &["evidence", "predecessorPlanRef"],
        &["controlEpoch"],
        &[],
    )?;
    if ["title", "objective", "narrative"].iter().any(|field| {
        data.get(*field)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
    }) {
        return Err(private_projection_data_invalid(
            "Session private Plan text must be non-empty",
        ));
    }
    let run_id = data
        .get("runId")
        .and_then(Value::as_str)
        .expect("validated private Plan run identity");
    let control_epoch = data
        .get("controlEpoch")
        .and_then(Value::as_u64)
        .expect("validated private Plan control epoch");
    validate_private_plan_evidence(
        data.get("evidence")
            .and_then(Value::as_object)
            .expect("validated private Plan evidence"),
        run_id,
        control_epoch,
    )?;
    if let Some(predecessor) = data.get("predecessorPlanRef") {
        let predecessor = predecessor
            .as_object()
            .expect("validated predecessor Plan ref");
        validate_private_projection_fields(
            predecessor,
            &["planRevision", "planDigest"],
            &[],
            &["planRevision"],
            &[],
            &[],
            &[],
            &[],
            &[],
        )?;
        validate_sha256_digest(
            predecessor
                .get("planDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    private_projection_data_invalid("Predecessor Plan digest is invalid")
                })?,
            "predecessorPlanRef.planDigest",
        )
        .map_err(|_| private_projection_data_invalid("Predecessor Plan digest is invalid"))?;
    }
    validate_private_carried_settlements(
        data.get("carriedSettlementRefs")
            .and_then(Value::as_array)
            .expect("validated carried settlement refs"),
    )?;
    let plan_revision = data
        .get("planRevision")
        .and_then(Value::as_str)
        .expect("validated private Plan revision");
    let actions = data
        .get("actions")
        .and_then(Value::as_array)
        .expect("validated private Plan actions");
    if actions.is_empty() || actions.len() > 128 {
        return Err(private_projection_data_invalid(
            "Session private Plan must contain 1..=128 current PlanActions",
        ));
    }
    for action in actions {
        validate_private_plan_action(action, plan_revision)?;
    }
    Ok(())
}

fn validate_private_plan_evidence(
    evidence: &serde_json::Map<String, Value>,
    run_id: &str,
    control_epoch: u64,
) -> Result<(), HostV2StorageError> {
    validate_private_projection_fields(
        evidence,
        &[
            "kernelFactRefs",
            "readResources",
            "historicalRebinds",
            "blockingUnknowns",
            "nonBlockingUnknowns",
            "coverage",
        ],
        &[],
        &[],
        &["coverage"],
        &[
            "kernelFactRefs",
            "readResources",
            "historicalRebinds",
            "blockingUnknowns",
            "nonBlockingUnknowns",
        ],
        &[],
        &[],
        &[],
    )?;
    if evidence
        .get("coverage")
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err(private_projection_data_invalid(
            "Session private Plan evidence coverage must be non-empty",
        ));
    }
    let fact_refs = evidence
        .get("kernelFactRefs")
        .and_then(Value::as_array)
        .expect("validated Plan fact refs");
    if fact_refs.len() > 512 {
        return Err(private_projection_data_invalid(
            "Session private Plan evidence contains too many Kernel fact refs",
        ));
    }
    validate_private_unique_identities(fact_refs, "planEvidence.kernelFactRef", false)?;

    let resources = evidence
        .get("readResources")
        .and_then(Value::as_array)
        .expect("validated Plan read resources");
    if resources.len() > 512 {
        return Err(private_projection_data_invalid(
            "Session private Plan evidence contains too many read resources",
        ));
    }
    let mut resource_refs = HashSet::new();
    let mut resource_evidence = HashMap::<String, (String, HashSet<String>)>::new();
    for resource in resources {
        let resource = resource.as_object().ok_or_else(|| {
            private_projection_data_invalid("Session private Plan read evidence is invalid")
        })?;
        validate_private_projection_fields(
            resource,
            &["resourceRef", "digest", "summary", "factRefs"],
            &[],
            &["resourceRef"],
            &["summary"],
            &["factRefs"],
            &[],
            &[],
            &[],
        )?;
        let resource_ref = resource
            .get("resourceRef")
            .and_then(Value::as_str)
            .expect("validated resource ref");
        if !resource_refs.insert(resource_ref) {
            return Err(private_projection_data_invalid(
                "Session private Plan read evidence resource refs are not unique",
            ));
        }
        if resource
            .get("summary")
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(private_projection_data_invalid(
                "Session private Plan read evidence summary must be non-empty",
            ));
        }
        let resource_digest = resource
            .get("digest")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                private_projection_data_invalid(
                    "Session private Plan read evidence digest is invalid",
                )
            })?;
        validate_sha256_digest(resource_digest, "planEvidence.readResource.digest").map_err(
            |_| {
                private_projection_data_invalid(
                    "Session private Plan read evidence digest is invalid",
                )
            },
        )?;
        let resource_fact_refs = resource
            .get("factRefs")
            .and_then(Value::as_array)
            .expect("validated resource fact refs");
        validate_private_unique_identities(
            resource_fact_refs,
            "planEvidence.resourceFactRef",
            true,
        )?;
        resource_evidence.insert(
            resource_ref.to_owned(),
            (
                resource_digest.to_owned(),
                resource_fact_refs
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            ),
        );
    }

    let historical_rebinds = evidence
        .get("historicalRebinds")
        .and_then(Value::as_array)
        .expect("validated historical evidence rebinds");
    if historical_rebinds.len() > 512 {
        return Err(private_projection_data_invalid(
            "Session private Plan contains too many historical evidence rebinds",
        ));
    }
    let mut rebind_ids = HashSet::new();
    for rebind in historical_rebinds {
        let rebind = rebind.as_object().ok_or_else(|| {
            private_projection_data_invalid("Session private historical evidence rebind is invalid")
        })?;
        validate_private_projection_fields(
            rebind,
            &[
                "rebindId",
                "sourceEventId",
                "sourceEventDigest",
                "sourceEventVersion",
                "sourceRunId",
                "sourceFactId",
                "sourceControlEpoch",
                "sourceOperationId",
                "sourceToolId",
                "subjectDigest",
                "sourceEvidenceDigest",
                "sourceCandidateDigest",
                "currentRunId",
                "currentControlEpoch",
                "currentFactRef",
                "currentEvidenceDigest",
                "resourceRef",
                "contentRelation",
            ],
            &[],
            &[
                "rebindId",
                "sourceEventId",
                "sourceRunId",
                "sourceFactId",
                "sourceOperationId",
                "sourceToolId",
                "currentRunId",
                "currentFactRef",
                "resourceRef",
            ],
            &["contentRelation"],
            &[],
            &[],
            &[
                "sourceEventVersion",
                "sourceControlEpoch",
                "currentControlEpoch",
            ],
            &[],
        )?;
        for digest_field in [
            "sourceEventDigest",
            "subjectDigest",
            "sourceEvidenceDigest",
            "sourceCandidateDigest",
            "currentEvidenceDigest",
        ] {
            validate_sha256_digest(
                rebind
                    .get(digest_field)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        private_projection_data_invalid(
                            "Session private historical evidence digest is invalid",
                        )
                    })?,
                "planEvidence.historicalRebind.digest",
            )
            .map_err(|_| {
                private_projection_data_invalid(
                    "Session private historical evidence digest is invalid",
                )
            })?;
        }
        let rebind_id = rebind
            .get("rebindId")
            .and_then(Value::as_str)
            .expect("validated historical rebind identity");
        let source_run_id = rebind
            .get("sourceRunId")
            .and_then(Value::as_str)
            .expect("validated historical source run identity");
        let current_run_id = rebind
            .get("currentRunId")
            .and_then(Value::as_str)
            .expect("validated historical current run identity");
        let current_control_epoch = rebind
            .get("currentControlEpoch")
            .and_then(Value::as_u64)
            .expect("validated historical current control epoch");
        let resource_ref = rebind
            .get("resourceRef")
            .and_then(Value::as_str)
            .expect("validated historical resource identity");
        let current_fact_ref = rebind
            .get("currentFactRef")
            .and_then(Value::as_str)
            .expect("validated historical current fact identity");
        let current_evidence_digest = rebind
            .get("currentEvidenceDigest")
            .and_then(Value::as_str)
            .expect("validated historical current evidence digest");
        let content_relation = rebind
            .get("contentRelation")
            .and_then(Value::as_str)
            .expect("validated historical content relation");
        let bound_resource = resource_evidence.get(resource_ref);
        if !rebind_ids.insert(rebind_id)
            || source_run_id == run_id
            || current_run_id != run_id
            || current_control_epoch != control_epoch
            || !matches!(content_relation, "sameDigest" | "changedDigest")
            || bound_resource.is_none_or(|(digest, fact_refs)| {
                digest != current_evidence_digest || !fact_refs.contains(current_fact_ref)
            })
        {
            return Err(private_projection_data_invalid(
                "Session private historical rebind must bind an earlier Run to exact current read evidence",
            ));
        }
    }

    let blocking = evidence
        .get("blockingUnknowns")
        .and_then(Value::as_array)
        .expect("validated blocking unknowns");
    let non_blocking = evidence
        .get("nonBlockingUnknowns")
        .and_then(Value::as_array)
        .expect("validated non-blocking unknowns");
    if blocking.len() > 128 || non_blocking.len() > 128 {
        return Err(private_projection_data_invalid(
            "Session private Plan evidence contains too many unknowns",
        ));
    }
    let mut unknown_ids = HashSet::new();
    for unknown in blocking.iter().chain(non_blocking.iter()) {
        let unknown = unknown.as_object().ok_or_else(|| {
            private_projection_data_invalid("Session private Plan unknown is invalid")
        })?;
        validate_private_projection_fields(
            unknown,
            &["unknownId", "question", "impact"],
            &[],
            &["unknownId"],
            &["question", "impact"],
            &[],
            &[],
            &[],
            &[],
        )?;
        let unknown_id = unknown
            .get("unknownId")
            .and_then(Value::as_str)
            .expect("validated unknown identity");
        if !unknown_ids.insert(unknown_id)
            || ["question", "impact"].iter().any(|field| {
                unknown
                    .get(*field)
                    .and_then(Value::as_str)
                    .is_none_or(|value| value.trim().is_empty())
            })
        {
            return Err(private_projection_data_invalid(
                "Session private Plan unknowns are incomplete or not unique",
            ));
        }
    }
    Ok(())
}

fn validate_private_carried_settlements(settlements: &[Value]) -> Result<(), HostV2StorageError> {
    let mut action_ids = HashSet::new();
    for settlement in settlements {
        let settlement = settlement.as_object().ok_or_else(|| {
            private_projection_data_invalid("Session private carried settlement is invalid")
        })?;
        validate_private_projection_fields(
            settlement,
            &[
                "planRevision",
                "planActionId",
                "settlementDigest",
                "kernelFactRefs",
            ],
            &[],
            &["planRevision", "planActionId"],
            &[],
            &["kernelFactRefs"],
            &[],
            &[],
            &[],
        )?;
        let action_id = settlement
            .get("planActionId")
            .and_then(Value::as_str)
            .expect("validated carried action identity");
        if !action_ids.insert(action_id) {
            return Err(private_projection_data_invalid(
                "Session private carried PlanAction identities are not unique",
            ));
        }
        validate_sha256_digest(
            settlement
                .get("settlementDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    private_projection_data_invalid("Carried settlement digest is invalid")
                })?,
            "carriedSettlement.settlementDigest",
        )
        .map_err(|_| private_projection_data_invalid("Carried settlement digest is invalid"))?;
        validate_private_unique_identities(
            settlement
                .get("kernelFactRefs")
                .and_then(Value::as_array)
                .expect("validated carried settlement fact refs"),
            "carriedSettlement.kernelFactRef",
            false,
        )?;
    }
    Ok(())
}

fn validate_private_unique_identities(
    values: &[Value],
    field: &'static str,
    require_non_empty: bool,
) -> Result<(), HostV2StorageError> {
    if require_non_empty && values.is_empty() {
        return Err(private_projection_data_invalid(
            "Session private identity list must be non-empty",
        ));
    }
    let mut identities = HashSet::new();
    for value in values {
        let value = value.as_str().ok_or_else(|| {
            private_projection_data_invalid("Session private identity list is invalid")
        })?;
        validate_bounded_identity(value, field, 64 * 1024).map_err(|_| {
            private_projection_data_invalid("Session private identity list is invalid")
        })?;
        if !identities.insert(value) {
            return Err(private_projection_data_invalid(
                "Session private identity list is not unique",
            ));
        }
    }
    Ok(())
}

fn validate_private_plan_action(
    value: &Value,
    plan_revision: &str,
) -> Result<(), HostV2StorageError> {
    let action = value.as_object().ok_or_else(|| {
        private_projection_data_invalid("Session private PlanAction must be an object")
    })?;
    validate_private_projection_fields(
        action,
        &["taskId", "manifest", "idempotencyKey", "deadline"],
        &[],
        &["taskId", "idempotencyKey"],
        &[],
        &[],
        &["manifest", "deadline"],
        &[],
        &[],
    )?;
    let manifest = action
        .get("manifest")
        .and_then(Value::as_object)
        .expect("validated private ScopeManifest");
    validate_private_projection_fields(
        manifest,
        &[
            "planRevision",
            "planActionId",
            "operationId",
            "toolId",
            "scopeIntent",
        ],
        &[],
        &["planRevision", "planActionId", "operationId", "toolId"],
        &[],
        &[],
        &["scopeIntent"],
        &[],
        &[],
    )?;
    if manifest.get("planRevision").and_then(Value::as_str) != Some(plan_revision) {
        return Err(private_projection_data_invalid(
            "Session private ScopeManifest does not bind its enclosing Plan revision",
        ));
    }
    let scope_intent: ScopeIntentV2 = serde_json::from_value(
        manifest
            .get("scopeIntent")
            .expect("validated private ScopeIntent")
            .clone(),
    )
    .map_err(|_| {
        private_projection_data_invalid(
            "Session private ScopeIntent must use the exact current ABI shape",
        )
    })?;
    scope_intent.validate().map_err(|_| {
        private_projection_data_invalid("Session private ScopeIntent violates current invariants")
    })?;
    validate_private_deadline(
        action
            .get("deadline")
            .expect("validated private PlanAction deadline"),
    )
}

fn validate_private_deadline(value: &Value) -> Result<(), HostV2StorageError> {
    let deadline = value.as_object().ok_or_else(|| {
        private_projection_data_invalid("Session private deadline must be an object")
    })?;
    validate_private_projection_fields(
        deadline,
        &["kind", "data"],
        &[],
        &[],
        &[],
        &[],
        &["data"],
        &[],
        &[],
    )?;
    let data = deadline
        .get("data")
        .and_then(Value::as_object)
        .expect("validated private deadline data");
    match deadline.get("kind").and_then(Value::as_str) {
        Some("contractDefault") if data.is_empty() => Ok(()),
        Some("exactMilliseconds") => {
            validate_private_projection_fields(
                data,
                &["value"],
                &[],
                &[],
                &[],
                &[],
                &[],
                &["value"],
                &[],
            )?;
            if data.get("value").and_then(Value::as_u64) == Some(0) {
                return Err(private_projection_data_invalid(
                    "Session private exact deadline must be positive",
                ));
            }
            Ok(())
        }
        _ => Err(private_projection_data_invalid(
            "Session private deadline kind or data is not current",
        )),
    }
}

fn decode_private_scope_preview(
    value: &Value,
    _field: &'static str,
) -> Result<CapabilityScopePreviewRecordV2, HostV2StorageError> {
    let preview: CapabilityScopePreviewRecordV2 =
        serde_json::from_value(value.clone()).map_err(|_| {
            private_projection_data_invalid(
                "Session private scope preview must use the exact current ABI shape",
            )
        })?;
    preview.validate().map_err(|_| {
        private_projection_data_invalid(
            "Session private scope preview violates its current ABI invariants",
        )
    })?;
    Ok(preview)
}

fn validate_private_scope_preview(
    value: &Value,
    field: &'static str,
) -> Result<(), HostV2StorageError> {
    decode_private_scope_preview(value, field).map(|_| ())
}

fn validate_private_scope_projection(
    data: &serde_json::Map<String, Value>,
) -> Result<(), HostV2StorageError> {
    validate_private_projection_fields(
        data,
        &[
            "kind",
            "data",
            "plan",
            "scopePreviews",
            "planRevision",
            "planActionId",
            "operationId",
        ],
        &[],
        &["planRevision", "planActionId", "operationId"],
        &[],
        &["scopePreviews"],
        &["data", "plan"],
        &[],
        &[],
    )?;
    let plan = data
        .get("plan")
        .and_then(Value::as_object)
        .expect("required plan object");
    validate_private_plan(plan)?;
    let plan_revision = data
        .get("planRevision")
        .and_then(Value::as_str)
        .expect("required plan revision");
    if plan.get("planRevision").and_then(Value::as_str) != Some(plan_revision) {
        return Err(private_projection_data_invalid(
            "Scope projection Plan revision does not match its projection binding",
        ));
    }
    let mut preview_ids = HashSet::new();
    let mut preview_operations = HashSet::new();
    for preview in data
        .get("scopePreviews")
        .and_then(Value::as_array)
        .expect("required scope preview array")
    {
        let preview = decode_private_scope_preview(preview, "scopePreviews")?;
        if preview.plan_revision.as_str() != plan_revision
            || !preview_ids.insert(preview.preview_id.as_str().to_string())
            || !preview_operations.insert(preview.operation_id.as_str().to_string())
        {
            return Err(private_projection_data_invalid(
                "Scope preview list is not uniquely bound to its Plan revision",
            ));
        }
    }
    let reply = data
        .get("data")
        .and_then(Value::as_object)
        .expect("required scope reply object");
    match data.get("kind").and_then(Value::as_str) {
        Some("previewed") => {
            validate_private_projection_fields(
                reply,
                &["preview"],
                &[],
                &[],
                &[],
                &[],
                &["preview"],
                &[],
                &[],
            )?;
            let preview = decode_private_scope_preview(
                reply.get("preview").expect("required preview"),
                "scope.previewed.data.preview",
            )?;
            if preview.plan_revision.as_str() != plan_revision
                || data.get("planActionId").and_then(Value::as_str)
                    != Some(preview.plan_action_id.as_str())
                || data.get("operationId").and_then(Value::as_str)
                    != Some(preview.operation_id.as_str())
            {
                return Err(private_projection_data_invalid(
                    "Current scope preview does not match its PlanAction projection binding",
                ));
            }
        }
        Some("rejected") => {
            validate_private_projection_fields(
                reply,
                &[
                    "planActionId",
                    "operationId",
                    "toolId",
                    "reason",
                    "guidance",
                ],
                &[],
                &["planActionId", "operationId", "toolId", "reason"],
                &["guidance"],
                &[],
                &[],
                &[],
                &[],
            )?;
            if reply.get("planActionId") != data.get("planActionId")
                || reply.get("operationId") != data.get("operationId")
            {
                return Err(private_projection_data_invalid(
                    "Rejected scope preview does not match its PlanAction projection binding",
                ));
            }
        }
        _ => {
            return Err(private_projection_data_invalid(
                "Session private scope reply kind is not current",
            ))
        }
    }
    Ok(())
}

fn validate_private_plan_commentary_released(
    data: &serde_json::Map<String, Value>,
) -> Result<(), HostV2StorageError> {
    validate_private_projection_fields(
        data,
        &[
            "planRevision",
            "providerTurnId",
            "controlEpoch",
            "orderedItems",
            "recordedAt",
        ],
        &[],
        &["planRevision", "providerTurnId", "recordedAt"],
        &[],
        &["orderedItems"],
        &[],
        &["controlEpoch"],
        &[],
    )?;
    let items = data
        .get("orderedItems")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= 96)
        .ok_or_else(|| {
            private_projection_data_invalid(
                "Released Plan commentary must contain a bounded non-empty item list",
            )
        })?;
    for item in items {
        let item = item.as_object().ok_or_else(|| {
            private_projection_data_invalid("Released Plan commentary item is not an object")
        })?;
        if item.len() != 3
            || item.get("kind").and_then(Value::as_str) != Some("text")
            || item.get("phase").and_then(Value::as_str) != Some("commentary")
            || item
                .get("text")
                .and_then(Value::as_str)
                .is_none_or(|text| text.is_empty() || text.len() > 1024 * 1024)
        {
            return Err(private_projection_data_invalid(
                "Released Plan commentary item is not exact sealed commentary text",
            ));
        }
    }
    Ok(())
}

fn validate_private_plan_confirmation_ready(
    data: &serde_json::Map<String, Value>,
) -> Result<(), HostV2StorageError> {
    validate_private_projection_fields(
        data,
        &[
            "planRevision",
            "providerTurnId",
            "plan",
            "scopePreviews",
            "recordedAt",
        ],
        &["commentaryProjectionId"],
        &[
            "planRevision",
            "providerTurnId",
            "recordedAt",
            "commentaryProjectionId",
        ],
        &[],
        &["scopePreviews"],
        &["plan"],
        &[],
        &[],
    )?;
    let plan = data
        .get("plan")
        .and_then(Value::as_object)
        .expect("required Plan object");
    validate_private_plan(plan)?;
    let plan_revision = data
        .get("planRevision")
        .and_then(Value::as_str)
        .expect("required Plan revision");
    if plan.get("planRevision").and_then(Value::as_str) != Some(plan_revision) {
        return Err(private_projection_data_invalid(
            "Confirmation-ready Plan revision does not match its projection binding",
        ));
    }
    let actions = plan
        .get("actions")
        .and_then(Value::as_array)
        .expect("validated Plan actions");
    let preview_values = data
        .get("scopePreviews")
        .and_then(Value::as_array)
        .expect("required scope previews");
    if actions.is_empty() || preview_values.len() != actions.len() {
        return Err(private_projection_data_invalid(
            "Confirmation-ready Plan requires one preview for every PlanAction",
        ));
    }
    let mut preview_ids = HashSet::new();
    let mut preview_operations = HashSet::new();
    let mut previews = Vec::with_capacity(preview_values.len());
    for preview in preview_values {
        let preview = decode_private_scope_preview(preview, "scopePreviews")?;
        if preview.plan_revision.as_str() != plan_revision
            || !preview_ids.insert(preview.preview_id.as_str().to_string())
            || !preview_operations.insert(preview.operation_id.as_str().to_string())
        {
            return Err(private_projection_data_invalid(
                "Confirmation-ready scope previews are not uniquely bound to the Plan",
            ));
        }
        previews.push(preview);
    }
    for action in actions {
        let manifest = action
            .get("manifest")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                private_projection_data_invalid("Confirmation-ready PlanAction manifest is missing")
            })?;
        let plan_action_id = manifest
            .get("planActionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                private_projection_data_invalid("Confirmation-ready PlanAction identity is missing")
            })?;
        let operation_id = manifest
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                private_projection_data_invalid("Confirmation-ready operation identity is missing")
            })?;
        let tool_id = manifest
            .get("toolId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                private_projection_data_invalid("Confirmation-ready tool identity is missing")
            })?;
        if !previews.iter().any(|preview| {
            preview.plan_action_id.as_str() == plan_action_id
                && preview.operation_id.as_str() == operation_id
                && preview.tool_id.as_str() == tool_id
        }) {
            return Err(private_projection_data_invalid(
                "Confirmation-ready PlanAction has no matching canonical scope preview",
            ));
        }
    }
    Ok(())
}

fn validate_private_provider_completed(
    data: &serde_json::Map<String, Value>,
) -> Result<(), HostV2StorageError> {
    validate_private_projection_fields(
        data,
        &[
            "providerTurnId",
            "controlEpoch",
            "outputKind",
            "terminalScope",
            "orderedItems",
            "providerOutcome",
        ],
        &[
            "status",
            "result",
            "toolCallReceipt",
            "reviewRevision",
            "snapshotHighWater",
            "candidateSourceEventRefs",
            "answerState",
        ],
        &["providerTurnId"],
        &[],
        &["orderedItems", "candidateSourceEventRefs"],
        &["providerOutcome", "result", "toolCallReceipt"],
        &["controlEpoch", "reviewRevision"],
        &["snapshotHighWater"],
    )?;
    require_private_enum(
        data,
        "outputKind",
        &[
            "plan",
            "answer",
            "noTool",
            "toolIntent",
            "planEvidenceRefresh",
            "planActionComplete",
            "intervention",
        ],
    )?;
    require_private_enum(data, "terminalScope", &["turn", "providerTurn"])?;
    if data.get("outputKind").and_then(Value::as_str) == Some("planEvidenceRefresh")
        && data.get("terminalScope").and_then(Value::as_str) != Some("providerTurn")
    {
        return Err(private_projection_data_invalid(
            "Plan evidence refresh can settle only the current Provider turn",
        ));
    }
    if let Some(answer_state) = data.get("answerState").and_then(Value::as_str) {
        if !matches!(answer_state, "provisional" | "committed")
            || data.get("outputKind").and_then(Value::as_str) != Some("answer")
            || (answer_state == "provisional"
                && data.get("terminalScope").and_then(Value::as_str) != Some("providerTurn"))
            || (answer_state == "committed"
                && data.get("terminalScope").and_then(Value::as_str) != Some("turn"))
        {
            return Err(private_projection_data_invalid(
                "Session private answerState does not match Provider answer settlement",
            ));
        }
    }
    if data.contains_key("status") {
        require_private_enum(data, "status", &["responseAccepted"])?;
    }
    if data.contains_key("status") == data.contains_key("result") {
        return Err(private_projection_data_invalid(
            "Session private Provider completion variant is inconsistent",
        ));
    }
    let has_review_revision = data.contains_key("reviewRevision");
    let has_snapshot_high_water = data.contains_key("snapshotHighWater");
    if has_review_revision != has_snapshot_high_water
        || (has_review_revision
            && (data.get("outputKind").and_then(Value::as_str) != Some("answer")
                || data.get("terminalScope").and_then(Value::as_str) != Some("turn")))
    {
        return Err(private_projection_data_invalid(
            "Session private final Review binding does not match a terminal Provider answer",
        ));
    }
    if let Some(source_refs) = data.get("candidateSourceEventRefs") {
        let source_refs = source_refs
            .as_array()
            .expect("validated candidate source refs array");
        let mut unique_refs = HashSet::new();
        if source_refs.is_empty()
            || !has_review_revision
            || data.get("outputKind").and_then(Value::as_str) != Some("answer")
            || data.get("terminalScope").and_then(Value::as_str) != Some("turn")
        {
            return Err(private_projection_data_invalid(
                "Session private candidate refs do not bind a reviewed terminal answer",
            ));
        }
        for source_ref in source_refs {
            let source_ref = source_ref.as_str().ok_or_else(|| {
                private_projection_data_invalid(
                    "Session private candidate source ref is not an identity",
                )
            })?;
            validate_bounded_identity(source_ref, "candidateSourceEventRef", 512)?;
            if !unique_refs.insert(source_ref) {
                return Err(private_projection_data_invalid(
                    "Session private candidate source refs are not unique",
                ));
            }
        }
    }
    Ok(())
}

fn validate_private_tool_intent(
    data: &serde_json::Map<String, Value>,
) -> Result<(), HostV2StorageError> {
    validate_private_projection_fields(
        data,
        &[
            "requestId",
            "operationId",
            "toolId",
            "expectedControlEpoch",
            "authorityKind",
            "replyKind",
        ],
        &[
            "planRevision",
            "planActionId",
            "invocationId",
            "replyReason",
        ],
        &[
            "requestId",
            "operationId",
            "toolId",
            "planRevision",
            "planActionId",
            "invocationId",
            "replyReason",
        ],
        &[],
        &[],
        &[],
        &["expectedControlEpoch"],
        &[],
    )?;
    require_private_enum(data, "authorityKind", &["planAction", "read"])?;
    require_private_enum(
        data,
        "replyKind",
        &["admitted", "awaitingCapability", "rejected"],
    )?;
    let plan_authority = data.get("authorityKind").and_then(Value::as_str) == Some("planAction");
    if plan_authority != data.contains_key("planRevision")
        || plan_authority != data.contains_key("planActionId")
    {
        return Err(private_projection_data_invalid(
            "Session private ToolIntent PlanAction binding is inconsistent",
        ));
    }
    let rejected = data.get("replyKind").and_then(Value::as_str) == Some("rejected");
    if rejected != data.contains_key("replyReason") || rejected == data.contains_key("invocationId")
    {
        return Err(private_projection_data_invalid(
            "Session private ToolIntent reply fields are inconsistent",
        ));
    }
    Ok(())
}

fn validate_private_wait(data: &serde_json::Map<String, Value>) -> Result<(), HostV2StorageError> {
    match data.get("kind").and_then(Value::as_str) {
        Some("capability") => {
            validate_private_projection_fields(
                data,
                &[
                    "kind",
                    "operationId",
                    "invocationId",
                    "previewId",
                    "sinceHighWater",
                ],
                &["decisionHint", "denialGuidance"],
                &["operationId", "invocationId", "previewId"],
                &["denialGuidance"],
                &[],
                &[],
                &[],
                &["sinceHighWater"],
            )?;
            if data.contains_key("decisionHint") {
                require_private_enum(data, "decisionHint", &["allow", "deny"])?;
            }
        }
        Some("invocation") => validate_private_projection_fields(
            data,
            &["kind", "operationId", "invocationId", "sinceHighWater"],
            &[],
            &["operationId", "invocationId"],
            &[],
            &[],
            &[],
            &[],
            &["sinceHighWater"],
        )?,
        Some("backpressure") => {
            validate_private_projection_fields(
                data,
                &["kind", "operationId", "reason", "retryAt", "guidance"],
                &[],
                &["operationId", "retryAt"],
                &["guidance"],
                &[],
                &[],
                &[],
                &[],
            )?;
            require_private_enum(data, "reason", &["runBusy", "capacityExceeded"])?;
        }
        Some("manualRecovery") => {
            validate_private_projection_fields(
                data,
                &["kind", "operationId", "reason", "factIds"],
                &["invocationId"],
                &["operationId", "invocationId"],
                &[],
                &["factIds"],
                &[],
                &[],
                &[],
            )?;
            require_private_enum(data, "reason", &["indeterminate"])?;
        }
        _ => {
            return Err(private_projection_data_invalid(
                "Session private wait kind is not current",
            ))
        }
    }
    Ok(())
}

fn validate_private_diagnostic(
    data: &serde_json::Map<String, Value>,
) -> Result<(), HostV2StorageError> {
    match data.get("stage").and_then(Value::as_str) {
        Some("provider.structuredRepair") => {
            validate_private_projection_fields(
                data,
                &[
                    "providerTurnId",
                    "status",
                    "code",
                    "stage",
                    "currentActivityCode",
                ],
                &[],
                &["providerTurnId", "code"],
                &[],
                &[],
                &[],
                &[],
                &[],
            )?;
            require_private_enum(data, "status", &["recovering"])?;
            require_private_enum(data, "currentActivityCode", &["session.validating"])?;
        }
        Some("provider.structuredRepairNoProgress") => {
            validate_private_projection_fields(
                data,
                &[
                    "providerTurnId",
                    "status",
                    "terminalScope",
                    "code",
                    "message",
                    "stage",
                ],
                &["providerOutcome"],
                &["providerTurnId", "code"],
                &["message"],
                &[],
                &["providerOutcome"],
                &[],
                &[],
            )?;
            require_private_enum(data, "status", &["failed"])?;
            require_private_enum(data, "terminalScope", &["turn"])?;
        }
        Some("provider.toolCallQueue") => {
            validate_private_projection_fields(
                data,
                &[
                    "providerTurnId",
                    "status",
                    "code",
                    "stage",
                    "reason",
                    "orderedItems",
                    "unexecutedOrdinals",
                    "toolCallReceipt",
                ],
                &[],
                &["providerTurnId", "code"],
                &["reason"],
                &["orderedItems", "unexecutedOrdinals"],
                &["toolCallReceipt"],
                &[],
                &[],
            )?;
            require_private_enum(data, "status", &["blocked"])?;
        }
        Some("provider.finalAnswer") => {
            validate_private_projection_fields(
                data,
                &[
                    "stage",
                    "status",
                    "terminalScope",
                    "code",
                    "message",
                    "physicalRequestCount",
                    "controlEpoch",
                    "reviewRevision",
                    "snapshotHighWater",
                ],
                &["providerTurnId", "providerOutcome"],
                &["providerTurnId", "code"],
                &["message"],
                &[],
                &["providerOutcome"],
                &["physicalRequestCount", "controlEpoch", "reviewRevision"],
                &["snapshotHighWater"],
            )?;
            require_private_enum(data, "status", &["failed"])?;
            require_private_enum(data, "terminalScope", &["turn"])?;
        }
        Some("provider.requestTurn" | "provider.outputValidation") => {
            validate_private_projection_fields(
                data,
                &[
                    "providerTurnId",
                    "status",
                    "terminalScope",
                    "code",
                    "message",
                    "stage",
                ],
                &["providerOutcome"],
                &["providerTurnId", "code"],
                &["message"],
                &[],
                &["providerOutcome"],
                &[],
                &[],
            )?;
            require_private_enum(data, "status", &["failed"])?;
            require_private_enum(data, "terminalScope", &["turn"])?;
        }
        Some("provider.outputAdmission") => validate_private_projection_fields(
            data,
            &[
                "providerTurnId",
                "code",
                "message",
                "stage",
                "providerOutcome",
            ],
            &[],
            &["providerTurnId", "code"],
            &["message"],
            &[],
            &["providerOutcome"],
            &[],
            &[],
        )?,
        _ => {
            return Err(private_projection_data_invalid(
                "Session private diagnostic stage is not current",
            ))
        }
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
    let timeline_path = public_timeline_path(sessions_dir, session_id)?;
    let committed_source_event_version = read_public_timeline_records(&timeline_path, session_id)?
        .last()
        .map(|record| record.source_event_version)
        .unwrap_or(0);
    let committed_event_count = usize::try_from(committed_source_event_version).map_err(|_| {
        HostV2StorageError::conflict(
            "session_kernel_public_event_version_invalid",
            "Committed Session public event version is not representable",
        )
    })?;
    if events.len() < committed_event_count {
        return Err(HostV2StorageError::conflict(
            "session_kernel_public_event_prefix_missing",
            "Committed Session public timeline exceeds its durable AgentEvent prefix",
        ));
    }
    // AgentEvent records are appended before the matching timeline snapshot.
    // A crash may therefore leave a valid but uncommitted suffix. Public
    // readers, Run recovery, and count paths must observe only the prefix
    // committed by the latest canonical timeline.
    events.truncate(committed_event_count);
    Ok(events)
}

fn public_projection_guard_path(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<PathBuf, HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    let session_directory = sessions_dir.join(session_id);
    reject_pre_cutover_session_layout(&session_directory)?;
    Ok(session_directory
        .join("kernel-v2")
        .join(".public-projection-v2.lock"))
}

fn public_agent_event_path(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<PathBuf, HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    let session_directory = sessions_dir.join(session_id);
    reject_pre_cutover_session_layout(&session_directory)?;
    let kernel_v2 = session_directory.join("kernel-v2");
    Ok(kernel_v2.join("public").join("agent-events.jsonl"))
}

fn public_timeline_path(
    sessions_dir: &FsPath,
    session_id: &str,
) -> Result<PathBuf, HostV2StorageError> {
    validate_safe_session_identity(session_id)?;
    let session_directory = sessions_dir.join(session_id);
    reject_pre_cutover_session_layout(&session_directory)?;
    let kernel_v2 = session_directory.join("kernel-v2");
    Ok(kernel_v2.join("public").join("timelines.jsonl"))
}

fn reject_pre_cutover_session_layout(session_directory: &FsPath) -> Result<(), HostV2StorageError> {
    match fs::symlink_metadata(session_directory.join("kernel-v3")) {
        Ok(_) => {
            return Err(HostV2StorageError::conflict(
                "UnsupportedHistorySchema",
                "Pre-cutover Session persistence cannot be read, resumed, or extended",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(HostV2StorageError::io(
                "session_kernel_pre_cutover_history_inspection_failed",
                format!("inspect pre-cutover Session persistence: {error}"),
            ))
        }
    }

    let kernel_v2 = session_directory.join("kernel-v2");
    let entries = match fs::read_dir(&kernel_v2) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(HostV2StorageError::io(
                "session_kernel_pre_cutover_history_inspection_failed",
                format!("inspect Session persistence root: {error}"),
            ))
        }
    };
    for entry in entries {
        let entry = entry.map_err(|error| {
            HostV2StorageError::io(
                "session_kernel_pre_cutover_history_inspection_failed",
                format!("inspect Session persistence entry: {error}"),
            )
        })?;
        if entry.file_name().to_string_lossy().ends_with(".jsonl") {
            return Err(HostV2StorageError::conflict(
                "UnsupportedHistorySchema",
                "Pre-cutover root-level Session persistence cannot be read, resumed, or extended",
            ));
        }
    }
    Ok(())
}

fn read_public_timeline_records(
    path: &FsPath,
    session_id: &str,
) -> Result<Vec<HostSessionPublicTimelineRecordV2>, HostV2StorageError> {
    let mut records: Vec<HostSessionPublicTimelineRecordV2> = Vec::new();
    let mut projections = HashMap::new();
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
        if record.timeline.get("schemaVersion").and_then(Value::as_str)
            != Some("deepcode.shared-conversation-projection.v4")
            || record.timeline.get("shapeVersion").and_then(Value::as_str)
                != Some("deepcode.shared-conversation.work-segments.v4")
        {
            return Err(HostV2StorageError::conflict(
                "UnsupportedHistorySchema",
                "Prior public Session projection uses an unsupported schema or shape",
            ));
        }
        crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
            &record.timeline,
        )
        .map_err(|message| {
            HostV2StorageError::conflict("session_kernel_public_timeline_history_corrupt", message)
        })?;
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

fn read_public_timeline_records_for_view(
    path: &FsPath,
    session_id: &str,
) -> Result<Vec<HostSessionPublicTimelineRecordV2>, HostV2StorageError> {
    let mut records: Vec<HostSessionPublicTimelineRecordV2> = Vec::new();
    let mut projections = HashMap::new();
    let mut history_schema: Option<&'static str> = None;
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
        let schema = match (
            record.timeline.get("schemaVersion").and_then(Value::as_str),
            record.timeline.get("shapeVersion").and_then(Value::as_str),
        ) {
            (
                Some("deepcode.shared-conversation-projection.v4"),
                Some("deepcode.shared-conversation.work-segments.v4"),
            ) => "v3",
            (
                Some("deepcode.shared-conversation-projection.v2"),
                Some("deepcode.shared-conversation.work-segments.v2"),
            ) => "v2",
            _ => {
                return Err(HostV2StorageError::conflict(
                    "UnsupportedHistorySchema",
                    "Prior public Session projection uses an unsupported schema or shape",
                ))
            }
        };
        if history_schema.is_some_and(|existing| existing != schema) {
            return Err(HostV2StorageError::conflict(
                "UnsupportedHistorySchema",
                "Mixed v2/v3 public Session projection history is not readable",
            ));
        }
        history_schema = Some(schema);
        if schema == "v3" {
            normalize_latest_public_timeline(&record.timeline)?;
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

fn normalize_public_timeline_for_view(timeline: &Value) -> Result<Value, HostV2StorageError> {
    if timeline.get("schemaVersion").and_then(Value::as_str)
        == Some("deepcode.shared-conversation-projection.v4")
        && timeline.get("shapeVersion").and_then(Value::as_str)
            == Some("deepcode.shared-conversation.work-segments.v4")
    {
        return normalize_latest_public_timeline(timeline);
    }
    if timeline.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.shared-conversation-projection.v2")
        || timeline.get("shapeVersion").and_then(Value::as_str)
            != Some("deepcode.shared-conversation.work-segments.v2")
    {
        return Err(HostV2StorageError::conflict(
            "UnsupportedHistorySchema",
            "Prior public Session projection uses an unsupported schema or shape",
        ));
    }
    let mut normalized = timeline.clone();
    let object = normalized.as_object_mut().ok_or_else(|| {
        HostV2StorageError::conflict(
            "session_kernel_public_timeline_history_corrupt",
            "Legacy public Session projection is not an object",
        )
    })?;
    if let Some(run_projection) = object
        .get_mut("runProjection")
        .and_then(Value::as_object_mut)
    {
        let terminal = run_projection.get("phase").and_then(Value::as_str) == Some("settled")
            && matches!(
                run_projection.get("status").and_then(Value::as_str),
                Some("succeeded" | "failed" | "cancelled")
            );
        if !terminal {
            return Err(HostV2StorageError::conflict(
                "session_language_policy_unavailable",
                "Legacy v2 Session can only be viewed after its Run reached a terminal state",
            ));
        }
        run_projection.insert("currentActivity".to_string(), Value::Null);
        run_projection.insert("wait".to_string(), Value::Null);
    }
    object.insert(
        "schemaVersion".to_string(),
        json!("deepcode.shared-conversation-projection.v4"),
    );
    object.insert(
        "shapeVersion".to_string(),
        json!("deepcode.shared-conversation.work-segments.v4"),
    );
    crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
        &normalized,
    )
    .map_err(|message| {
        HostV2StorageError::conflict(
            "UnsupportedHistorySchema",
            format!("Legacy v2 Session cannot be normalized as a read-only v3 view: {message}"),
        )
    })?;
    Ok(normalized)
}

fn normalize_latest_public_timeline(timeline: &Value) -> Result<Value, HostV2StorageError> {
    if timeline.get("schemaVersion").and_then(Value::as_str)
        != Some("deepcode.shared-conversation-projection.v4")
        || timeline.get("shapeVersion").and_then(Value::as_str)
            != Some("deepcode.shared-conversation.work-segments.v4")
    {
        return Err(HostV2StorageError::conflict(
            "UnsupportedHistorySchema",
            "Prior public Session projection uses an unsupported schema or shape",
        ));
    }
    crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
        timeline,
    )
    .map_err(|message| {
        HostV2StorageError::conflict("session_kernel_public_timeline_history_corrupt", message)
    })?;
    Ok(timeline.clone())
}

fn public_timeline_record(
    request: &SessionKernelHostProjectionRequestV2,
    timeline: &Value,
) -> Result<HostSessionPublicTimelineRecordV2, HostV2StorageError> {
    let timeline_revision = timeline_u64(timeline, "revision")?;
    let source_event_version = timeline_u64(timeline, "sourceEventVersion")?;
    if timeline_u64(timeline, "eventCount")? > source_event_version {
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
        timeline_digest: canonical_sha256(timeline)?,
        timeline: timeline.clone(),
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
    expected: Option<(&str, &str, &str, &str)>,
) -> Result<(), HostV2StorageError> {
    reject_transport_capabilities(event)?;
    let object = event.as_object().ok_or_else(|| {
        HostV2StorageError::invalid(
            "session_kernel_public_event_invalid",
            "Session public AgentEvent must be an object",
        )
    })?;
    const EVENT_FIELDS: &[&str] = &["id", "sessionId", "ts", "kind", "payload"];
    if object.len() != EVENT_FIELDS.len()
        || object
            .keys()
            .any(|field| !EVENT_FIELDS.contains(&field.as_str()))
    {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_event_invalid",
            "Session public AgentEvent must use the exact current envelope",
        ));
    }
    for field in ["id", "sessionId", "ts", "kind"] {
        let value = object.get(field).and_then(Value::as_str).ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_public_event_invalid",
                format!("Session public AgentEvent requires {field}"),
            )
        })?;
        validate_bounded_identity(value, field, 64 * 1024)?;
    }
    if object.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_event_identity_mismatch",
            "Session public AgentEvent does not match the Session",
        ));
    }
    validate_public_agent_event_payload(object, expected)?;
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
        deepcode_kernel_abi::decode_agent_input_attachments_v3(attachments).map_err(|error| {
            HostV2StorageError::invalid(
                "session_kernel_public_event_attachment_invalid",
                format!(
                    "Session v2 user event has invalid attachments: {}",
                    error.code
                ),
            )
        })?;
    }
    if let Some((projection_id, recorded_at, _, _)) = expected {
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

fn validate_public_agent_event_payload(
    event: &serde_json::Map<String, Value>,
    expected: Option<(&str, &str, &str, &str)>,
) -> Result<(), HostV2StorageError> {
    const COMMON_FIELDS: &[&str] = &[
        "schemaVersion",
        "projectionId",
        "runId",
        "projectionKind",
        "channel",
        "visibility",
    ];
    let payload = event
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            HostV2StorageError::invalid(
                "session_kernel_public_event_payload_invalid",
                "Session public AgentEvent payload must be an object",
            )
        })?;
    let required_text = |field: &'static str| -> Result<&str, HostV2StorageError> {
        payload
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                HostV2StorageError::invalid(
                    "session_kernel_public_event_payload_invalid",
                    format!("Session public AgentEvent payload requires {field}"),
                )
            })
    };
    if required_text("schemaVersion")? != "deepcode.session.kernel-public-projection.v2" {
        return Err(HostV2StorageError::conflict(
            "UnsupportedHistorySchema",
            "Session public AgentEvent payload uses an unsupported schema",
        ));
    }
    let projection_id = required_text("projectionId")?;
    let run_id = required_text("runId")?;
    let projection_kind = required_text("projectionKind")?;
    let channel = required_text("channel")?;
    let visibility = required_text("visibility")?;
    let event_kind = event
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();

    for (field, value) in [
        ("projectionId", projection_id),
        ("runId", run_id),
        ("projectionKind", projection_kind),
        ("channel", channel),
        ("visibility", visibility),
    ] {
        validate_bounded_identity(value, field, 512)?;
    }

    let (fields, required_fields): (&[&str], &[&str]) = match projection_kind {
        "input.persisted" => (
            &["content", "inputId", "attachments", "controlEpoch"],
            &["content", "inputId", "attachments", "controlEpoch"],
        ),
        "plan.persisted" => (
            &["planRevision", "status", "summary"],
            &["planRevision", "status", "summary"],
        ),
        "plan.decided" => (
            &[
                "planId",
                "planRevision",
                "status",
                "decision",
                "guidance",
                "confirmable",
                "summary",
            ],
            &[
                "planId",
                "planRevision",
                "status",
                "decision",
                "confirmable",
                "summary",
            ],
        ),
        "plan.commentaryReleased" => (
            &[
                "status",
                "planRevision",
                "providerTurnId",
                "controlEpoch",
                "orderedItems",
            ],
            &[
                "status",
                "planRevision",
                "providerTurnId",
                "controlEpoch",
                "orderedItems",
            ],
        ),
        "plan.confirmationReady" => (
            &[
                "planId",
                "planRevision",
                "title",
                "summary",
                "userPlan",
                "status",
                "confirmable",
                "tasks",
                "scopePreviews",
                "scopeApprovalView",
                "readablePlan",
            ],
            &[
                "planId",
                "planRevision",
                "title",
                "summary",
                "userPlan",
                "status",
                "confirmable",
                "tasks",
                "scopePreviews",
                "scopeApprovalView",
                "readablePlan",
            ],
        ),
        "scope.previewed" if event_kind == "plan_review" => (
            &[
                "planId",
                "planRevision",
                "status",
                "decision",
                "guidance",
                "confirmable",
                "operationId",
                "planActionId",
                "summary",
            ],
            &[
                "planId",
                "planRevision",
                "status",
                "decision",
                "confirmable",
                "operationId",
                "planActionId",
                "summary",
            ],
        ),
        "scope.previewed" => (
            &[
                "planRevision",
                "planActionId",
                "operationId",
                "toolId",
                "status",
                "summary",
            ],
            &[
                "planRevision",
                "planActionId",
                "operationId",
                "toolId",
                "status",
                "summary",
            ],
        ),
        "capability.awaiting" => (
            &[
                "id",
                "permissionId",
                "requestKind",
                "operationId",
                "invocationId",
                "affectedOperationIds",
                "toolId",
                "toolName",
                "riskLevel",
                "summary",
                "argumentsPreview",
                "preview",
                "status",
            ],
            &[
                "id",
                "permissionId",
                "requestKind",
                "operationId",
                "invocationId",
                "affectedOperationIds",
                "toolId",
                "toolName",
                "riskLevel",
                "summary",
                "argumentsPreview",
                "preview",
                "status",
            ],
        ),
        "toolIntent.submitted" => (
            &[
                "status",
                "operationId",
                "invocationId",
                "requestId",
                "toolId",
                "replyReason",
                "controlEpoch",
                "authorityKind",
                "planRevision",
                "planActionId",
                "summary",
            ],
            &[
                "status",
                "operationId",
                "requestId",
                "toolId",
                "controlEpoch",
                "authorityKind",
                "summary",
            ],
        ),
        "kernelFacts.reconciled" => (
            &[
                "status",
                "factIds",
                "operationFacts",
                "snapshotHighWater",
                "summary",
            ],
            &[
                "status",
                "factIds",
                "operationFacts",
                "snapshotHighWater",
                "summary",
            ],
        ),
        "authorization.decided" => (
            &[
                "id",
                "permissionId",
                "previewId",
                "status",
                "decision",
                "factId",
                "factKind",
                "operationId",
                "toolId",
                "planActionIds",
                "leaseId",
                "leaseVersion",
                "scopeDigest",
                "scopeDelta",
                "guidance",
                "details",
                "summary",
            ],
            &[
                "id",
                "permissionId",
                "previewId",
                "status",
                "decision",
                "factId",
                "factKind",
                "operationId",
                "planActionIds",
                "details",
                "summary",
            ],
        ),
        "review.revised" => (
            &[
                "reviewId",
                "status",
                "revision",
                "snapshotHighWater",
                "summary",
                "review",
            ],
            &[
                "reviewId",
                "status",
                "revision",
                "snapshotHighWater",
                "summary",
                "review",
            ],
        ),
        "planAction.completed" => (
            &[
                "status",
                "planRevision",
                "planActionId",
                "controlEpoch",
                "providerTurnId",
                "outcome",
                "snapshotHighWater",
                "summary",
            ],
            &[
                "status",
                "planRevision",
                "planActionId",
                "controlEpoch",
                "providerTurnId",
                "outcome",
                "snapshotHighWater",
                "summary",
            ],
        ),
        "userIntervention.changed" => (
            &[
                "status",
                "decisionKind",
                "interactionId",
                "interactionRevision",
                "candidateSetDigest",
                "targetId",
                "blockId",
                "title",
                "summary",
                "intervention",
                "decision",
                "selectedOptionId",
                "guidance",
                "acceptedPlanRevision",
            ],
            &[
                "status",
                "decisionKind",
                "interactionId",
                "interactionRevision",
                "candidateSetDigest",
                "targetId",
                "blockId",
                "title",
                "summary",
                "intervention",
            ],
        ),
        "provider.composing" => (
            &[
                "status",
                "providerTurnId",
                "controlEpoch",
                "streamSequence",
                "textOrdinal",
                "providerPhase",
                "content",
            ],
            &[
                "status",
                "providerTurnId",
                "controlEpoch",
                "streamSequence",
                "textOrdinal",
                "content",
            ],
        ),
        "provider.completed" => (
            &[
                "status",
                "orderedItems",
                "terminalScope",
                "outputKind",
                "providerTurnId",
                "controlEpoch",
                "providerOutcome",
                "reviewRevision",
                "snapshotHighWater",
                "answerState",
            ],
            &[
                "status",
                "providerTurnId",
                "controlEpoch",
                "terminalScope",
                "outputKind",
                "providerOutcome",
            ],
        ),
        "provider.answerState" => (
            &[
                "status",
                "providerTurnId",
                "controlEpoch",
                "answerState",
                "reasonCode",
            ],
            &[
                "status",
                "providerTurnId",
                "controlEpoch",
                "answerState",
                "reasonCode",
            ],
        ),
        "provider.started" if payload.contains_key("currentActivityCode") => (
            &[
                "status",
                "providerTurnId",
                "controlEpoch",
                "currentActivityCode",
                "activitySequence",
            ],
            &[
                "status",
                "providerTurnId",
                "controlEpoch",
                "currentActivityCode",
                "activitySequence",
            ],
        ),
        "provider.started" => (
            &[
                "status",
                "providerTurnId",
                "controlEpoch",
                "contextAssembly",
                "summary",
            ],
            &[
                "status",
                "providerTurnId",
                "controlEpoch",
                "contextAssembly",
                "summary",
            ],
        ),
        "provider.stale" => (
            &["status", "providerTurnId", "controlEpoch", "summary"],
            &["status", "providerTurnId", "summary"],
        ),
        "run.cancelled" => (
            &[
                "status",
                "reason",
                "callerRequestId",
                "cancelOperationId",
                "controlEpoch",
                "facts",
                "summary",
            ],
            &[
                "status",
                "reason",
                "callerRequestId",
                "cancelOperationId",
                "controlEpoch",
                "facts",
                "summary",
            ],
        ),
        "wait.changed" if payload.get("status").and_then(Value::as_str) == Some("completed") => (
            &["status", "reason", "summary"],
            &["status", "reason", "summary"],
        ),
        "wait.changed" => (
            &["status", "reason", "targetId", "decisionKind", "summary"],
            &["status", "reason", "summary"],
        ),
        "diagnostic"
            if event_kind == "workflow_stage"
                && payload.get("status").and_then(Value::as_str) == Some("recovering") =>
        {
            (
                &[
                    "status",
                    "code",
                    "providerTurnId",
                    "currentActivityCode",
                    "summary",
                ],
                &[
                    "status",
                    "code",
                    "providerTurnId",
                    "currentActivityCode",
                    "summary",
                ],
            )
        }
        "diagnostic" if event_kind == "workflow_stage" => (
            &["status", "code", "providerTurnId", "reason", "orderedItems"],
            &["status", "code", "providerTurnId", "orderedItems"],
        ),
        "diagnostic" => (
            &[
                "status",
                "code",
                "providerTurnId",
                "terminalScope",
                "providerOutcome",
                "message",
            ],
            &["status", "code", "message"],
        ),
        _ => {
            return Err(HostV2StorageError::conflict(
                "UnsupportedHistorySchema",
                "Session public AgentEvent payload uses an unsupported projection kind",
            ))
        }
    };
    if payload
        .keys()
        .any(|field| !COMMON_FIELDS.contains(&field.as_str()) && !fields.contains(&field.as_str()))
    {
        return Err(HostV2StorageError::conflict(
            "UnsupportedHistorySchema",
            "Session public AgentEvent payload contains fields outside the current projection shape",
        ));
    }
    if required_fields
        .iter()
        .any(|field| !payload.contains_key(*field) || payload.get(*field) == Some(&Value::Null))
    {
        return Err(HostV2StorageError::conflict(
            "UnsupportedHistorySchema",
            "Session public AgentEvent payload is missing fields required by the current projection shape",
        ));
    }
    validate_public_projection_payload_types(projection_kind, event_kind, payload)?;

    let payload_text = |field: &str| payload.get(field).and_then(Value::as_str);
    let status = payload_text("status");
    let decision = payload_text("decision");
    let presentation_matches = match projection_kind {
        "input.persisted" => {
            event_kind == "user_msg" && channel == "user" && visibility == "conversation"
        }
        "plan.persisted" => {
            event_kind == "workflow_stage"
                && channel == "progress"
                && visibility == "trace"
                && status == Some("running")
        }
        "plan.decided" => {
            event_kind == "plan_review"
                && visibility == "both"
                && matches!(
                    (decision, status, channel),
                    (Some("accept"), Some("accepted"), "progress")
                        | (Some("reject"), Some("rejected"), "task")
                        | (Some("revise"), Some("needsRevision"), "task")
                )
        }
        "plan.commentaryReleased" => {
            event_kind == "assistant_msg"
                && channel == "progress"
                && visibility == "conversation"
                && status == Some("completed")
        }
        "plan.confirmationReady" => {
            event_kind == "plan_card"
                && channel == "task"
                && visibility == "both"
                && status == Some("awaitingUserApproval")
                && decision.is_none()
        }
        "scope.previewed" => {
            (event_kind == "workflow_stage"
                && channel == "progress"
                && visibility == "trace"
                && status == Some("running")
                && decision.is_none())
                || (event_kind == "plan_review"
                    && channel == "task"
                    && visibility == "both"
                    && status == Some("needsRevision")
                    && decision == Some("revise"))
        }
        "capability.awaiting" => {
            event_kind == "permission_request"
                && channel == "tool"
                && visibility == "conversation"
                && status == Some("awaitingUserDecision")
                && payload_text("requestKind") == Some("scopeExpansion")
                && payload_text("id") == payload_text("permissionId")
        }
        "toolIntent.submitted" => {
            event_kind == "tool_call"
                && channel == "tool"
                && visibility == "both"
                && matches!(status, Some("admitted" | "awaitingCapability" | "rejected"))
                && matches!(payload_text("authorityKind"), Some("planAction" | "read"))
                && match status {
                    Some("admitted" | "awaitingCapability") => {
                        payload.contains_key("invocationId") && !payload.contains_key("replyReason")
                    }
                    Some("rejected") => {
                        payload.contains_key("replyReason") && !payload.contains_key("invocationId")
                    }
                    _ => false,
                }
                && match payload_text("authorityKind") {
                    Some("planAction") => {
                        payload.contains_key("planRevision") && payload.contains_key("planActionId")
                    }
                    Some("read") => {
                        !payload.contains_key("planRevision")
                            && !payload.contains_key("planActionId")
                    }
                    _ => false,
                }
        }
        "kernelFacts.reconciled" => {
            event_kind == "tool_result"
                && channel == "observation"
                && visibility == "trace"
                && status == Some("reconciled")
        }
        "authorization.decided" => {
            event_kind == "permission_result"
                && channel == "tool"
                && visibility == "conversation"
                && payload_text("id") == payload_text("permissionId")
                && payload_text("id") == payload_text("previewId")
                && match payload_text("factKind") {
                    Some("capabilityIssued" | "expansionAllowed") => {
                        status == Some("allowed")
                            && decision == Some("allow")
                            && payload.contains_key("leaseId")
                            && payload.contains_key("leaseVersion")
                            && payload.contains_key("scopeDigest")
                    }
                    Some("capabilityDenied" | "expansionDenied") => {
                        status == Some("denied")
                            && decision == Some("deny")
                            && !payload.contains_key("leaseId")
                            && !payload.contains_key("leaseVersion")
                            && !payload.contains_key("scopeDigest")
                    }
                    _ => false,
                }
        }
        "review.revised" => {
            event_kind == "review_summary"
                && channel == "final"
                && visibility == "both"
                && matches!(status, Some("completed" | "waitingUserReview"))
        }
        "planAction.completed" => {
            event_kind == "workflow_stage"
                && channel == "task"
                && visibility == "both"
                && status == Some("completed")
                && matches!(
                    payload_text("outcome"),
                    Some("completed" | "no_op" | "blocked" | "skipped" | "unexecuted")
                )
        }
        "userIntervention.changed" => {
            event_kind == "user_intervention"
                && channel == "task"
                && visibility == "both"
                && payload_text("decisionKind") == Some("userIntervention")
                && payload_text("targetId") == payload_text("interactionId")
                && matches!(
                    status,
                    Some("awaitingUserDecision" | "accepted" | "rejected" | "needsRevision")
                )
                && match status {
                    Some("awaitingUserDecision") => !payload.contains_key("decision"),
                    Some("accepted") => {
                        payload_text("decision") == Some("select")
                            && payload.contains_key("acceptedPlanRevision")
                    }
                    Some("rejected") => payload_text("decision") == Some("reject"),
                    Some("needsRevision") => {
                        matches!(payload_text("decision"), Some("select" | "revise"))
                    }
                    _ => false,
                }
        }
        "provider.composing" => {
            event_kind == "assistant_msg"
                && channel == "progress"
                && visibility == "conversation"
                && status == Some("running")
                && matches!(
                    payload_text("providerPhase"),
                    None | Some("commentary" | "final_answer")
                )
        }
        "provider.completed" => {
            status == Some("completed")
                && visibility == "conversation"
                && matches!(
                    payload_text("outputKind"),
                    Some(
                        "plan"
                            | "toolIntent"
                            | "answer"
                            | "noTool"
                            | "planEvidenceRefresh"
                            | "planActionComplete"
                            | "intervention"
                    )
                )
                && match payload_text("terminalScope") {
                    Some("turn") => {
                        event_kind == "assistant_msg"
                            && channel == "final"
                            && payload_text("outputKind") == Some("answer")
                            && payload.contains_key("orderedItems")
                    }
                    Some("providerTurn") => event_kind == "workflow_stage" && channel == "progress",
                    _ => false,
                }
        }
        "provider.answerState" => {
            event_kind == "workflow_stage"
                && channel == "progress"
                && visibility == "conversation"
                && status == Some("completed")
                && matches!(payload_text("answerState"), Some("stale" | "rejected"))
        }
        "provider.started" => {
            event_kind == "workflow_stage"
                && channel == "progress"
                && visibility == "trace"
                && status == Some("running")
                && match payload_text("currentActivityCode") {
                    Some("provider.reasoning" | "provider.composing") => {
                        payload.contains_key("activitySequence")
                            && !payload.contains_key("contextAssembly")
                            && !payload.contains_key("summary")
                    }
                    None => {
                        payload.contains_key("contextAssembly")
                            && payload.contains_key("summary")
                            && !payload.contains_key("activitySequence")
                    }
                    _ => false,
                }
        }
        "provider.stale" => {
            event_kind == "workflow_stage"
                && channel == "progress"
                && visibility == "trace"
                && status == Some("cancelled")
        }
        "run.cancelled" => {
            event_kind == "session_run_state"
                && channel == "progress"
                && visibility == "conversation"
                && status == Some("cancelled")
                && payload_text("reason") == Some("userRequested")
        }
        "wait.changed" => {
            event_kind == "session_run_state"
                && channel == "progress"
                && visibility == "conversation"
                && match status {
                    Some("completed") => payload_text("reason") == Some("waitCleared"),
                    Some("waiting") => {
                        matches!(
                            payload_text("reason"),
                            Some("capability" | "invocation" | "backpressure" | "manualRecovery")
                        ) && payload.contains_key("targetId")
                    }
                    _ => false,
                }
        }
        "diagnostic" => {
            (event_kind == "workflow_stage"
                && channel == "progress"
                && visibility == "trace"
                && ((status == Some("blocked")
                    && payload_text("code") == Some("session_kernel_provider_tool_calls_aborted"))
                    || (status == Some("recovering")
                        && payload_text("currentActivityCode") == Some("session.validating"))))
                || (event_kind == "error"
                    && channel == "error"
                    && visibility == "conversation"
                    && status == Some("failed"))
        }
        _ => false,
    };
    if !presentation_matches {
        return Err(HostV2StorageError::conflict(
            "UnsupportedHistorySchema",
            "Session public AgentEvent presentation does not match its current projection kind",
        ));
    }

    let expected_event_id = format!("kernel-v2:{projection_id}");
    if event.get("id").and_then(Value::as_str) != Some(expected_event_id.as_str()) {
        return Err(HostV2StorageError::invalid(
            "session_kernel_public_event_identity_mismatch",
            "Session public AgentEvent id does not match payload projectionId",
        ));
    }
    if let Some((expected_projection_id, _, expected_run_id, expected_projection_kind)) = expected {
        if projection_id != expected_projection_id
            || run_id != expected_run_id
            || projection_kind != expected_projection_kind
        {
            return Err(HostV2StorageError::invalid(
                "session_kernel_public_event_identity_mismatch",
                "Session public AgentEvent payload does not match its private projection",
            ));
        }
    }
    Ok(())
}

fn validate_public_projection_payload_types(
    projection_kind: &str,
    event_kind: &str,
    payload: &serde_json::Map<String, Value>,
) -> Result<(), HostV2StorageError> {
    match projection_kind {
        "input.persisted" => {
            public_string(payload, "content", false)?;
            public_string(payload, "inputId", true)?;
            public_array(payload, "attachments")?;
            public_integer(payload, "controlEpoch", true)?;
        }
        "plan.persisted" => {
            public_string(payload, "planRevision", true)?;
            public_string(payload, "status", false)?;
            public_string(payload, "summary", false)?;
        }
        "plan.decided" => {
            for field in ["planId", "planRevision"] {
                public_string(payload, field, true)?;
            }
            for field in ["status", "decision", "summary"] {
                public_string(payload, field, false)?;
            }
            public_optional_string(payload, "guidance", false)?;
            if public_boolean(payload, "confirmable")? {
                return Err(public_projection_shape_invalid(
                    "Plan decision cannot remain confirmable",
                ));
            }
        }
        "plan.commentaryReleased" => {
            for field in ["planRevision", "providerTurnId"] {
                public_string(payload, field, true)?;
            }
            public_string(payload, "status", false)?;
            public_integer(payload, "controlEpoch", true)?;
            let ordered_items = payload
                .get("orderedItems")
                .expect("required released commentary items");
            validate_public_ordered_items(ordered_items)?;
            let items = ordered_items
                .as_array()
                .expect("validated released commentary items");
            if items.is_empty()
                || items.iter().any(|item| {
                    item.get("kind").and_then(Value::as_str) != Some("text")
                        || item.get("phase").and_then(Value::as_str) != Some("commentary")
                })
            {
                return Err(public_projection_shape_invalid(
                    "Released Plan commentary contains non-commentary Provider items",
                ));
            }
        }
        "plan.confirmationReady" => {
            public_plan_fields(payload, true)?;
            if !public_boolean(payload, "confirmable")? {
                return Err(public_projection_shape_invalid(
                    "Confirmation-ready Plan must be confirmable",
                ));
            }
            let scope_previews = public_array(payload, "scopePreviews")?;
            for preview in scope_previews {
                validate_private_scope_preview(preview, "public.scopePreviews").map_err(|_| {
                    public_projection_shape_invalid("Public scope preview is invalid")
                })?;
            }
            if scope_previews.len() != public_array(payload, "tasks")?.len() {
                return Err(public_projection_shape_invalid(
                    "Confirmation-ready Plan requires one preview for every PlanAction",
                ));
            }
            validate_public_scope_preview_bindings(payload, scope_previews)?;
            validate_public_scope_approval_view(
                payload
                    .get("scopeApprovalView")
                    .expect("required scope approval view"),
                public_string(payload, "planRevision", true)?,
                scope_previews,
            )?;
            validate_public_readable_plan(
                payload.get("readablePlan").expect("required readable Plan"),
                payload,
                scope_previews,
            )?;
        }
        "scope.previewed" if event_kind == "plan_review" => {
            for field in ["planId", "planRevision", "operationId", "planActionId"] {
                public_string(payload, field, true)?;
            }
            for field in ["status", "decision", "summary"] {
                public_string(payload, field, false)?;
            }
            public_optional_string(payload, "guidance", false)?;
            if public_boolean(payload, "confirmable")? {
                return Err(public_projection_shape_invalid(
                    "Rejected scope preview cannot be confirmable",
                ));
            }
        }
        "scope.previewed" => {
            for field in ["planRevision", "planActionId", "operationId", "toolId"] {
                public_string(payload, field, true)?;
            }
            for field in ["status", "summary"] {
                public_string(payload, field, false)?;
            }
        }
        "capability.awaiting" => {
            for field in [
                "id",
                "permissionId",
                "operationId",
                "invocationId",
                "toolId",
                "toolName",
            ] {
                public_string(payload, field, true)?;
            }
            for field in ["requestKind", "riskLevel", "summary", "status"] {
                public_string(payload, field, false)?;
            }
            validate_public_identity_array(
                payload
                    .get("affectedOperationIds")
                    .expect("required affected operation ids"),
                "affectedOperationIds",
            )?;
            let arguments_preview = public_object(payload, "argumentsPreview")?;
            let preview_value = payload.get("preview").expect("required preview");
            let preview = decode_private_scope_preview(preview_value, "public.permission.preview")
                .map_err(|_| {
                    public_projection_shape_invalid("Public permission preview is invalid")
                })?;
            if Value::Object(arguments_preview.clone()) != *preview_value {
                return Err(public_projection_shape_invalid(
                    "Permission argumentsPreview differs from its canonical preview",
                ));
            }
            let operation_id = public_string(payload, "operationId", true)?;
            let preview_id = preview.preview_id.as_str();
            let tool_id = preview.tool_id.as_str();
            let expected_affected_operations = vec![Value::String(operation_id.to_string())];
            if public_string(payload, "id", true)? != preview_id
                || public_string(payload, "permissionId", true)? != preview_id
                || operation_id != preview.operation_id.as_str()
                || public_string(payload, "toolId", true)? != tool_id
                || public_string(payload, "toolName", true)? != tool_id
                || payload.get("riskLevel") != preview_value.get("risk")
                || payload.get("affectedOperationIds")
                    != Some(&Value::Array(expected_affected_operations))
            {
                return Err(public_projection_shape_invalid(
                    "Permission request fields do not match their canonical scope preview",
                ));
            }
        }
        "toolIntent.submitted" => {
            for field in ["operationId", "requestId", "toolId"] {
                public_string(payload, field, true)?;
            }
            for field in ["status", "authorityKind", "summary"] {
                public_string(payload, field, false)?;
            }
            for field in [
                "invocationId",
                "replyReason",
                "planRevision",
                "planActionId",
            ] {
                public_optional_string(payload, field, true)?;
            }
            public_integer(payload, "controlEpoch", true)?;
        }
        "kernelFacts.reconciled" => {
            for field in ["status", "summary"] {
                public_string(payload, field, false)?;
            }
            validate_public_identity_array(
                payload.get("factIds").expect("required fact ids"),
                "factIds",
            )?;
            validate_public_operation_facts(
                payload
                    .get("operationFacts")
                    .expect("required operation facts"),
            )?;
            public_integer(payload, "snapshotHighWater", false)?;
        }
        "authorization.decided" => {
            for field in ["id", "permissionId", "previewId", "factId", "operationId"] {
                public_string(payload, field, true)?;
            }
            for field in ["status", "decision", "factKind", "summary"] {
                public_string(payload, field, false)?;
            }
            for field in ["toolId", "leaseId", "scopeDigest"] {
                public_optional_string(payload, field, true)?;
            }
            public_optional_string(payload, "guidance", false)?;
            if payload.contains_key("leaseVersion") {
                public_integer(payload, "leaseVersion", true)?;
            }
            validate_public_identity_array(
                payload
                    .get("planActionIds")
                    .expect("required PlanAction ids"),
                "planActionIds",
            )?;
            public_object(payload, "details")?;
            if payload.contains_key("scopeDelta") {
                public_object(payload, "scopeDelta")?;
            }
        }
        "review.revised" => {
            public_string(payload, "reviewId", true)?;
            for field in ["status", "summary"] {
                public_string(payload, field, false)?;
            }
            public_integer(payload, "revision", true)?;
            public_integer(payload, "snapshotHighWater", false)?;
            validate_public_review(payload.get("review").expect("required review"))?;
        }
        "planAction.completed" => {
            for field in ["planRevision", "planActionId", "providerTurnId"] {
                public_string(payload, field, true)?;
            }
            for field in ["status", "outcome", "summary"] {
                public_string(payload, field, false)?;
            }
            public_integer(payload, "controlEpoch", true)?;
            public_integer(payload, "snapshotHighWater", false)?;
        }
        "userIntervention.changed" => {
            for field in [
                "interactionId",
                "interactionRevision",
                "candidateSetDigest",
                "targetId",
                "blockId",
            ] {
                public_string(payload, field, true)?;
            }
            for field in ["status", "decisionKind", "title", "summary"] {
                public_string(payload, field, false)?;
            }
            for field in ["decision", "guidance"] {
                public_optional_string(payload, field, false)?;
            }
            for field in ["selectedOptionId", "acceptedPlanRevision"] {
                public_optional_string(payload, field, true)?;
            }
            validate_public_user_intervention(
                payload
                    .get("intervention")
                    .expect("required user intervention"),
            )?;
        }
        "provider.composing" => {
            public_string(payload, "providerTurnId", true)?;
            public_integer(payload, "controlEpoch", true)?;
            public_integer(payload, "streamSequence", true)?;
            public_integer(payload, "textOrdinal", true)?;
            public_optional_string(payload, "providerPhase", false)?;
            if let Some(provider_phase) = payload.get("providerPhase").and_then(Value::as_str) {
                if !matches!(provider_phase, "commentary" | "final_answer") {
                    return Err(public_projection_shape_invalid(
                        "providerPhase is not a current public Provider phase",
                    ));
                }
            }
            for field in ["status", "content"] {
                public_string(payload, field, false)?;
            }
        }
        "provider.completed" => {
            public_string(payload, "providerTurnId", true)?;
            for field in ["status", "terminalScope", "outputKind"] {
                public_string(payload, field, false)?;
            }
            public_integer(payload, "controlEpoch", true)?;
            if payload.contains_key("orderedItems") {
                if matches!(
                    payload.get("outputKind").and_then(Value::as_str),
                    Some("plan" | "planEvidenceRefresh")
                ) {
                    return Err(public_projection_shape_invalid(
                        "Planning completion cannot publish Provider text before confirmation settlement",
                    ));
                }
                validate_public_ordered_items(
                    payload.get("orderedItems").expect("present ordered items"),
                )?;
            }
            validate_public_provider_outcome(
                payload
                    .get("providerOutcome")
                    .expect("required provider outcome"),
            )?;
            let has_review_revision = payload.contains_key("reviewRevision");
            let has_snapshot_high_water = payload.contains_key("snapshotHighWater");
            if has_review_revision != has_snapshot_high_water
                || (has_review_revision
                    && (payload.get("outputKind").and_then(Value::as_str) != Some("answer")
                        || payload.get("terminalScope").and_then(Value::as_str) != Some("turn")))
            {
                return Err(public_projection_shape_invalid(
                    "Final Review binding does not match a terminal Provider answer",
                ));
            }
            if has_review_revision {
                public_integer(payload, "reviewRevision", true)?;
                public_integer(payload, "snapshotHighWater", false)?;
            }
            if let Some(answer_state) = payload.get("answerState").and_then(Value::as_str) {
                if !matches!(answer_state, "provisional" | "committed")
                    || payload.get("outputKind").and_then(Value::as_str) != Some("answer")
                    || (answer_state == "provisional"
                        && payload.get("terminalScope").and_then(Value::as_str)
                            != Some("providerTurn"))
                    || (answer_state == "committed"
                        && payload.get("terminalScope").and_then(Value::as_str) != Some("turn"))
                {
                    return Err(public_projection_shape_invalid(
                        "answerState does not match Provider answer settlement",
                    ));
                }
            }
        }
        "provider.answerState" => {
            public_string(payload, "providerTurnId", true)?;
            public_integer(payload, "controlEpoch", true)?;
            for field in ["status", "answerState", "reasonCode"] {
                public_string(payload, field, false)?;
            }
            if !matches!(
                payload.get("answerState").and_then(Value::as_str),
                Some("stale" | "rejected")
            ) {
                return Err(public_projection_shape_invalid(
                    "provider answer settlement state is invalid",
                ));
            }
        }
        "provider.started" => {
            public_string(payload, "providerTurnId", true)?;
            public_string(payload, "status", false)?;
            public_integer(payload, "controlEpoch", true)?;
            if payload.contains_key("currentActivityCode") {
                public_string(payload, "currentActivityCode", false)?;
                public_integer(payload, "activitySequence", true)?;
            } else {
                public_object(payload, "contextAssembly")?;
                public_string(payload, "summary", false)?;
            }
        }
        "provider.stale" => {
            public_string(payload, "providerTurnId", true)?;
            for field in ["status", "summary"] {
                public_string(payload, field, false)?;
            }
            if payload.contains_key("controlEpoch") {
                public_integer(payload, "controlEpoch", true)?;
            }
        }
        "run.cancelled" => {
            for field in ["callerRequestId", "cancelOperationId"] {
                public_string(payload, field, true)?;
            }
            for field in ["status", "reason", "summary"] {
                public_string(payload, field, false)?;
            }
            public_integer(payload, "controlEpoch", true)?;
            validate_public_cancellation_facts(payload.get("facts").expect("required facts"))?;
        }
        "wait.changed" => {
            for field in ["status", "reason", "summary"] {
                public_string(payload, field, false)?;
            }
            public_optional_string(payload, "targetId", true)?;
            public_optional_string(payload, "decisionKind", false)?;
        }
        "diagnostic"
            if event_kind == "workflow_stage"
                && payload.get("status").and_then(Value::as_str) == Some("recovering") =>
        {
            for field in ["providerTurnId", "code"] {
                public_string(payload, field, true)?;
            }
            for field in ["status", "currentActivityCode", "summary"] {
                public_string(payload, field, false)?;
            }
        }
        "diagnostic" if event_kind == "workflow_stage" => {
            public_string(payload, "providerTurnId", true)?;
            for field in ["status", "code"] {
                public_string(payload, field, false)?;
            }
            public_optional_string(payload, "reason", false)?;
            validate_public_ordered_items(
                payload.get("orderedItems").expect("required ordered items"),
            )?;
        }
        "diagnostic" => {
            for field in ["status", "code", "message"] {
                public_string(payload, field, false)?;
            }
            public_optional_string(payload, "providerTurnId", true)?;
            public_optional_string(payload, "terminalScope", false)?;
            if payload.contains_key("providerOutcome") {
                validate_public_provider_outcome(
                    payload
                        .get("providerOutcome")
                        .expect("present provider outcome"),
                )?;
            }
        }
        _ => {
            return Err(public_projection_shape_invalid(
                "Public projection kind is not current",
            ))
        }
    }
    Ok(())
}

fn validate_public_user_intervention(value: &Value) -> Result<(), HostV2StorageError> {
    let intervention = public_exact_object(
        value,
        &[
            "schemaVersion",
            "interactionId",
            "interactionRevision",
            "candidateSetDigest",
            "problemSummary",
            "relevantFacts",
            "affectedPlanActionIds",
            "options",
            "allowsFreeform",
        ],
        &["recommendation"],
        "User intervention",
    )?;
    if public_string(intervention, "schemaVersion", false)?
        != "deepcode.session.user-intervention.v1"
        || !public_boolean(intervention, "allowsFreeform")?
    {
        return Err(public_projection_shape_invalid(
            "User intervention schema or freeform contract is invalid",
        ));
    }
    for field in ["interactionId", "interactionRevision", "candidateSetDigest"] {
        public_string(intervention, field, true)?;
    }
    public_string(intervention, "problemSummary", false)?;
    public_optional_string(intervention, "recommendation", false)?;
    validate_public_identity_array(
        intervention
            .get("relevantFacts")
            .expect("required intervention fact refs"),
        "userIntervention.relevantFacts",
    )?;
    validate_public_identity_array(
        intervention
            .get("affectedPlanActionIds")
            .expect("required affected PlanActions"),
        "userIntervention.affectedPlanActionIds",
    )?;
    let options = public_array(intervention, "options")?;
    if options.is_empty() || options.len() > 16 {
        return Err(public_projection_shape_invalid(
            "User intervention must contain 1..=16 options",
        ));
    }
    let mut option_ids = HashSet::new();
    for value in options {
        let option = public_exact_object(
            value,
            &["id", "label", "kind", "tradeoffs", "actions"],
            &[
                "description",
                "recommended",
                "candidatePlanRevision",
                "candidatePlanDigest",
            ],
            "User intervention option",
        )?;
        let option_id = public_string(option, "id", true)?;
        if !option_ids.insert(option_id) {
            return Err(public_projection_shape_invalid(
                "User intervention option ids must be unique",
            ));
        }
        public_string(option, "label", false)?;
        public_optional_string(option, "description", false)?;
        if option.contains_key("recommended") {
            public_boolean(option, "recommended")?;
        }
        let kind = public_string(option, "kind", false)?;
        if !matches!(kind, "executable" | "guidanceOnly") {
            return Err(public_projection_shape_invalid(
                "User intervention option kind is invalid",
            ));
        }
        validate_public_string_array(
            option.get("tradeoffs").expect("required tradeoffs"),
            "userIntervention.option.tradeoffs",
        )?;
        let actions = public_array(option, "actions")?;
        let executable = kind == "executable";
        if executable
            != (option.contains_key("candidatePlanRevision")
                && option.contains_key("candidatePlanDigest")
                && !actions.is_empty())
            || (!executable
                && (option.contains_key("candidatePlanRevision")
                    || option.contains_key("candidatePlanDigest")
                    || !actions.is_empty()))
        {
            return Err(public_projection_shape_invalid(
                "User intervention option authority shape is invalid",
            ));
        }
        public_optional_string(option, "candidatePlanRevision", true)?;
        public_optional_string(option, "candidatePlanDigest", true)?;
        for action in actions {
            let action = public_exact_object(
                action,
                &[
                    "planActionId",
                    "operationId",
                    "toolId",
                    "summary",
                    "riskLevel",
                    "canonicalTargets",
                    "scopeDelta",
                    "previewId",
                    "previewDigest",
                ],
                &[],
                "User intervention candidate action",
            )?;
            for field in [
                "planActionId",
                "operationId",
                "toolId",
                "previewId",
                "previewDigest",
            ] {
                public_string(action, field, true)?;
            }
            public_string(action, "summary", false)?;
            if !matches!(
                public_string(action, "riskLevel", false)?,
                "low" | "medium" | "high" | "critical"
            ) {
                return Err(public_projection_shape_invalid(
                    "User intervention action risk is invalid",
                ));
            }
            for field in ["canonicalTargets", "scopeDelta"] {
                validate_public_string_array(
                    action
                        .get(field)
                        .expect("required intervention action list"),
                    field,
                )?;
            }
        }
    }
    Ok(())
}

fn validate_public_string_array(value: &Value, field: &str) -> Result<(), HostV2StorageError> {
    let values = value
        .as_array()
        .ok_or_else(|| public_projection_shape_invalid(format!("{field} must be an array")))?;
    for value in values {
        if value.as_str().is_none() {
            return Err(public_projection_shape_invalid(format!(
                "{field} must contain strings"
            )));
        }
    }
    Ok(())
}

fn public_projection_shape_invalid(message: impl Into<String>) -> HostV2StorageError {
    HostV2StorageError::conflict("UnsupportedHistorySchema", message)
}

fn public_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
    identity: bool,
) -> Result<&'a str, HostV2StorageError> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| public_projection_shape_invalid(format!("{field} must be a string")))?;
    if identity {
        validate_bounded_identity(value, "publicProjectionIdentity", 64 * 1024)
            .map_err(|_| public_projection_shape_invalid(format!("{field} is not an identity")))?;
    }
    Ok(value)
}

fn public_optional_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
    identity: bool,
) -> Result<(), HostV2StorageError> {
    if object.contains_key(field) {
        public_string(object, field, identity)?;
    }
    Ok(())
}

fn public_boolean(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<bool, HostV2StorageError> {
    object
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| public_projection_shape_invalid(format!("{field} must be boolean")))
}

fn public_integer(
    object: &serde_json::Map<String, Value>,
    field: &str,
    positive: bool,
) -> Result<u64, HostV2StorageError> {
    const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
    let value = object
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_JSON_INTEGER)
        .ok_or_else(|| {
            public_projection_shape_invalid(format!("{field} must be a safe integer"))
        })?;
    if positive && value == 0 {
        return Err(public_projection_shape_invalid(format!(
            "{field} must be positive"
        )));
    }
    Ok(value)
}

fn public_array<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a Vec<Value>, HostV2StorageError> {
    object
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| public_projection_shape_invalid(format!("{field} must be an array")))
}

fn public_object<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a serde_json::Map<String, Value>, HostV2StorageError> {
    object
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| public_projection_shape_invalid(format!("{field} must be an object")))
}

fn public_exact_object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
    field: &str,
) -> Result<&'a serde_json::Map<String, Value>, HostV2StorageError> {
    let object = value
        .as_object()
        .ok_or_else(|| public_projection_shape_invalid(format!("{field} must be an object")))?;
    public_exact_map(object, required, optional, field)
}

fn public_exact_map<'a>(
    object: &'a serde_json::Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    field: &str,
) -> Result<&'a serde_json::Map<String, Value>, HostV2StorageError> {
    if object
        .keys()
        .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
        || required
            .iter()
            .any(|key| !object.contains_key(*key) || object.get(*key) == Some(&Value::Null))
        || optional
            .iter()
            .any(|key| object.get(*key) == Some(&Value::Null))
    {
        return Err(public_projection_shape_invalid(format!(
            "{field} is not an exact current object"
        )));
    }
    Ok(object)
}

fn validate_public_identity_array(value: &Value, field: &str) -> Result<(), HostV2StorageError> {
    let values = value
        .as_array()
        .ok_or_else(|| public_projection_shape_invalid(format!("{field} must be an array")))?;
    for item in values {
        let identity = item.as_str().ok_or_else(|| {
            public_projection_shape_invalid(format!("{field} must contain identities"))
        })?;
        validate_bounded_identity(identity, "publicProjectionIdentity", 64 * 1024).map_err(
            |_| public_projection_shape_invalid(format!("{field} contains an invalid identity")),
        )?;
    }
    Ok(())
}

fn public_plan_fields(
    payload: &serde_json::Map<String, Value>,
    scoped: bool,
) -> Result<(), HostV2StorageError> {
    for field in ["planId", "planRevision"] {
        public_string(payload, field, true)?;
    }
    for field in ["title", "summary", "userPlan", "status"] {
        public_string(payload, field, false)?;
    }
    public_boolean(payload, "confirmable")?;
    validate_public_plan_tasks(payload.get("tasks").expect("required tasks"), scoped)
}

fn validate_public_plan_tasks(value: &Value, scoped: bool) -> Result<(), HostV2StorageError> {
    let tasks = value
        .as_array()
        .ok_or_else(|| public_projection_shape_invalid("Plan tasks must be an array"))?;
    if tasks.is_empty() || tasks.len() > 128 {
        return Err(public_projection_shape_invalid(
            "Plan tasks must contain 1..=128 current PlanActions",
        ));
    }
    for task in tasks {
        let optional = if scoped {
            &["scopePreview", "approvalView"][..]
        } else {
            &[][..]
        };
        let task = public_exact_object(
            task,
            &["taskId", "manifest", "idempotencyKey", "deadline"],
            optional,
            "Plan task",
        )?;
        for field in ["taskId", "idempotencyKey"] {
            public_string(task, field, true)?;
        }
        validate_public_scope_manifest(task.get("manifest").expect("required manifest"))?;
        validate_public_deadline(task.get("deadline").expect("required deadline"))?;
        if task.contains_key("scopePreview") {
            let preview = task.get("scopePreview").expect("present scope preview");
            validate_private_scope_preview(preview, "public.task.scopePreview")
                .map_err(|_| public_projection_shape_invalid("Task scope preview is invalid"))?;
            let approval = task
                .get("approvalView")
                .ok_or_else(|| public_projection_shape_invalid("Task approvalView is missing"))?;
            if preview.get("approvalView") != Some(approval) {
                return Err(public_projection_shape_invalid(
                    "Task approvalView differs from its scope preview",
                ));
            }
        } else if task.contains_key("approvalView") {
            return Err(public_projection_shape_invalid(
                "Task approvalView has no scope preview",
            ));
        }
    }
    Ok(())
}

fn validate_public_scope_manifest(value: &Value) -> Result<(), HostV2StorageError> {
    let manifest = public_exact_object(
        value,
        &[
            "planRevision",
            "planActionId",
            "operationId",
            "toolId",
            "scopeIntent",
        ],
        &[],
        "Scope manifest",
    )?;
    for field in ["planRevision", "planActionId", "operationId", "toolId"] {
        public_string(manifest, field, true)?;
    }
    validate_public_scope_intent(manifest.get("scopeIntent").expect("required scopeIntent"))
}

fn validate_public_scope_intent(value: &Value) -> Result<(), HostV2StorageError> {
    let intent = public_exact_object(value, &["kind", "data"], &[], "Scope intent")?;
    let kind = public_string(intent, "kind", false)?;
    let data = public_object(intent, "data")?;
    match kind {
        "resourceScope" => {
            let data = public_exact_map(
                data,
                &["requestedResources"],
                &[],
                "Resource-scope intent data",
            )?;
            let resources = public_array(data, "requestedResources")?;
            if resources.is_empty() || resources.len() > 256 {
                return Err(public_projection_shape_invalid(
                    "Resource-scope intent must contain 1..=256 requested resources",
                ));
            }
            validate_public_requested_resources(resources)
        }
        "exactInvocation" => {
            public_exact_map(data, &[], &[], "Exact-invocation public intent data")?;
            Ok(())
        }
        _ => Err(public_projection_shape_invalid(
            "Scope intent kind is not current",
        )),
    }
}

fn validate_public_requested_resources(resources: &[Value]) -> Result<(), HostV2StorageError> {
    for resource in resources {
        let resource: RequestedResourceV2 =
            serde_json::from_value(resource.clone()).map_err(|_| {
                public_projection_shape_invalid(
                    "Requested resource must use the exact current resource-scope shape",
                )
            })?;
        resource.validate().map_err(|_| {
            public_projection_shape_invalid("Requested resource violates current ABI invariants")
        })?;
    }
    Ok(())
}

fn validate_public_deadline(value: &Value) -> Result<(), HostV2StorageError> {
    let deadline = public_exact_object(value, &["kind", "data"], &[], "Deadline")?;
    let kind = public_string(deadline, "kind", false)?;
    let data = public_object(deadline, "data")?;
    match kind {
        "contractDefault" if data.is_empty() => Ok(()),
        "exactMilliseconds" => {
            let data = public_exact_map(data, &["value"], &[], "Exact deadline")?;
            public_integer(data, "value", true)?;
            Ok(())
        }
        _ => Err(public_projection_shape_invalid(
            "Deadline kind or data is not current",
        )),
    }
}

fn validate_public_scope_preview_bindings(
    payload: &serde_json::Map<String, Value>,
    previews: &[Value],
) -> Result<(), HostV2StorageError> {
    let plan_id = public_string(payload, "planId", true)?;
    let plan_revision = public_string(payload, "planRevision", true)?;
    if plan_id != plan_revision {
        return Err(public_projection_shape_invalid(
            "Public Plan identity differs from its current Plan revision",
        ));
    }
    let tasks = public_array(payload, "tasks")?;
    let mut preview_ids = HashSet::new();
    let mut preview_operations = HashSet::new();
    for preview_value in previews {
        let preview = decode_private_scope_preview(preview_value, "public.scopePreviews")
            .map_err(|_| public_projection_shape_invalid("Public scope preview is invalid"))?;
        if preview.plan_revision.as_str() != plan_revision
            || !preview_ids.insert(preview.preview_id.as_str().to_string())
            || !preview_operations.insert(preview.operation_id.as_str().to_string())
        {
            return Err(public_projection_shape_invalid(
                "Public scope previews are not uniquely bound to the current Plan revision",
            ));
        }
        let mut matching_tasks = tasks.iter().filter(|task| {
            task.get("manifest")
                .and_then(|manifest| manifest.get("operationId"))
                .and_then(Value::as_str)
                == Some(preview.operation_id.as_str())
        });
        let task = matching_tasks.next().ok_or_else(|| {
            public_projection_shape_invalid("Public scope preview has no matching PlanAction task")
        })?;
        if matching_tasks.next().is_some() {
            return Err(public_projection_shape_invalid(
                "Public scope preview matches more than one PlanAction task",
            ));
        }
        let manifest = task
            .get("manifest")
            .and_then(Value::as_object)
            .expect("validated Plan task manifest");
        if manifest.get("planRevision").and_then(Value::as_str) != Some(plan_revision)
            || manifest.get("planActionId").and_then(Value::as_str)
                != Some(preview.plan_action_id.as_str())
            || manifest.get("toolId").and_then(Value::as_str) != Some(preview.tool_id.as_str())
            || task.get("scopePreview") != Some(preview_value)
        {
            return Err(public_projection_shape_invalid(
                "Public scope preview differs from its PlanAction manifest binding",
            ));
        }
    }
    let scoped_task_count = tasks
        .iter()
        .filter(|task| task.get("scopePreview").is_some())
        .count();
    if scoped_task_count != previews.len() {
        return Err(public_projection_shape_invalid(
            "PlanAction scope previews differ from the canonical preview list",
        ));
    }
    Ok(())
}

fn validate_public_scope_approval_view(
    value: &Value,
    plan_revision: &str,
    previews: &[Value],
) -> Result<(), HostV2StorageError> {
    let expected_previews = previews
        .iter()
        .map(|preview| {
            let preview = preview.as_object().expect("validated scope preview");
            json!({
                "previewId": preview.get("previewId").expect("validated previewId"),
                "planActionId": preview.get("planActionId").expect("validated planActionId"),
                "operationId": preview.get("operationId").expect("validated operationId"),
                "toolId": preview.get("toolId").expect("validated toolId"),
                "authorizationDigest": preview
                    .get("authorizationDigest")
                    .expect("validated authorizationDigest"),
                "approvalView": preview.get("approvalView").expect("validated approvalView"),
            })
        })
        .collect::<Vec<_>>();
    let expected = json!({
        "planRevision": plan_revision,
        "previews": expected_previews,
    });
    if *value != expected {
        return Err(public_projection_shape_invalid(
            "Scope approval view differs from its canonical scope previews",
        ));
    }
    Ok(())
}

fn validate_public_readable_plan(
    value: &Value,
    payload: &serde_json::Map<String, Value>,
    previews: &[Value],
) -> Result<(), HostV2StorageError> {
    let plan_id = public_string(payload, "planId", true)?;
    let title = public_string(payload, "title", false)?;
    let summary = public_string(payload, "summary", false)?;
    let user_plan = public_string(payload, "userPlan", false)?;
    let mut readable_tasks = Vec::new();
    let mut task_items = Vec::new();
    for task in public_array(payload, "tasks")? {
        let task = task.as_object().expect("validated Plan task");
        let task_id = task
            .get("taskId")
            .and_then(Value::as_str)
            .expect("validated taskId");
        let manifest = task
            .get("manifest")
            .and_then(Value::as_object)
            .expect("validated Plan task manifest");
        let operation_id = manifest
            .get("operationId")
            .and_then(Value::as_str)
            .expect("validated operationId");
        let tool_id = manifest
            .get("toolId")
            .and_then(Value::as_str)
            .expect("validated toolId");
        let objective = format!("operationId={operation_id}");
        let resource_presentation = previews
            .iter()
            .find(|preview| {
                preview.get("operationId").and_then(Value::as_str) == Some(operation_id)
            })
            .and_then(|preview| preview.get("approvalView"))
            .and_then(|approval| approval.get("resourcePresentation"))
            .and_then(Value::as_array)
            .expect("validated PlanAction resourcePresentation");
        readable_tasks.push(json!({
            "taskId": task_id,
            "title": tool_id,
            "objective": objective,
            "resourcePresentation": resource_presentation,
            "acceptance": [],
            "failure": [],
            "intentKind": tool_id,
        }));
        task_items.push(json!({
            "itemId": task_id,
            "kind": "task",
            "text": tool_id,
            "resourcePresentation": resource_presentation,
            "metadata": {
                "objective": objective,
                "acceptance": [],
                "failure": [],
            },
        }));
    }
    let scope_items = previews
        .iter()
        .map(|preview| {
            let preview = preview.as_object().expect("validated scope preview");
            let approval = preview
                .get("approvalView")
                .and_then(Value::as_object)
                .expect("validated approval view");
            let preview_id = preview
                .get("previewId")
                .and_then(Value::as_str)
                .expect("validated previewId");
            let tool_id = preview
                .get("toolId")
                .and_then(Value::as_str)
                .expect("validated toolId");
            let risk = approval
                .get("risk")
                .and_then(Value::as_str)
                .expect("validated risk");
            let effect_class = approval
                .get("effectClass")
                .and_then(Value::as_str)
                .expect("validated effectClass");
            let effect_scope = approval
                .get("effectScope")
                .and_then(Value::as_str)
                .expect("validated effectScope");
            let scope_digest = approval
                .get("scopeDigest")
                .and_then(Value::as_str)
                .expect("validated scopeDigest");
            let authorization_digest = preview
                .get("authorizationDigest")
                .and_then(Value::as_str)
                .expect("validated authorizationDigest");
            let approval_summary = approval
                .get("summary")
                .and_then(Value::as_str)
                .expect("validated approval summary");
            let resource_presentation = approval
                .get("resourcePresentation")
                .and_then(Value::as_array)
                .expect("validated resourcePresentation");
            let target_refs = resource_presentation
                .iter()
                .filter_map(|resource| {
                    resource
                        .get("canonicalResourceRef")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect::<Vec<_>>();
            json!({
                "itemId": preview_id,
                "kind": "permission",
                "messageKey": "session.projection.plan.item.scopeApproval",
                "messageArgs": {
                    "toolId": tool_id,
                    "summary": approval_summary,
                    "risk": risk,
                    "effectClass": effect_class,
                    "effectScope": effect_scope,
                },
                "status": preview.get("disposition").expect("validated disposition"),
                "targetRefs": target_refs,
                "resourcePresentation": resource_presentation,
                "auditRefs": [preview_id, scope_digest, authorization_digest],
                "metadata": {
                    "acceptance": approval.get("scopeDelta").expect("validated scopeDelta"),
                    "failure": [],
                },
            })
        })
        .collect::<Vec<_>>();
    let expected = json!({
        "schemaVersion": "deepcode.session.readable-plan.v2",
        "titleKey": "session.projection.plan.title",
        "title": title,
        "summary": summary,
        "sourceRefs": {
            "planRevision": plan_id,
        },
        "tasks": readable_tasks,
        "sections": [
            {
                "sectionId": "summary",
                "titleKey": "session.projection.plan.section.summary",
                "items": [{
                    "itemId": "summary",
                    "kind": "text",
                    "text": user_plan,
                }],
            },
            {
                "sectionId": "tasks",
                "titleKey": "session.projection.plan.section.tasks",
                "emptyMessageKey": "session.projection.plan.empty.tasks",
                "items": task_items,
            },
            {
                "sectionId": "scopeApproval",
                "titleKey": "session.projection.plan.section.permissionBundles",
                "emptyMessageKey": "session.projection.plan.empty.permissionBundles",
                "items": scope_items,
            },
        ],
    });
    if *value != expected {
        return Err(public_projection_shape_invalid(
            "Readable Plan differs from the exact canonical v2 projection",
        ));
    }
    Ok(())
}

fn validate_public_operation_facts(value: &Value) -> Result<(), HostV2StorageError> {
    let facts = value
        .as_array()
        .ok_or_else(|| public_projection_shape_invalid("operationFacts must be an array"))?;
    for fact in facts {
        let fact = public_exact_object(
            fact,
            &["factId", "domain", "factKind", "recordedAt", "resourceIds"],
            &[
                "operationId",
                "invocationId",
                "attemptId",
                "effectId",
                "toolId",
                "canonicalAction",
                "targets",
                "effectSummary",
                "readEvidence",
            ],
            "Operation fact",
        )?;
        for field in ["factId", "factKind", "recordedAt"] {
            public_string(fact, field, true)?;
        }
        if !matches!(
            public_string(fact, "domain", false)?,
            "control" | "authorization" | "invocation" | "effect" | "resource" | "cleanup"
        ) {
            return Err(public_projection_shape_invalid(
                "Operation fact domain is not current",
            ));
        }
        for field in [
            "operationId",
            "invocationId",
            "attemptId",
            "effectId",
            "toolId",
            "canonicalAction",
        ] {
            public_optional_string(fact, field, true)?;
        }
        public_optional_string(fact, "effectSummary", false)?;
        validate_public_identity_array(
            fact.get("resourceIds").expect("required resource ids"),
            "operationFact.resourceIds",
        )?;
        if let Some(targets) = fact.get("targets") {
            validate_public_identity_array(targets, "operationFact.targets")?;
        }
        if let Some(read_evidence) = fact.get("readEvidence") {
            validate_public_read_evidence(fact, read_evidence)?;
        }
        if fact.contains_key("toolId") != fact.contains_key("canonicalAction")
            || (fact.contains_key("toolId")
                && fact.get("toolId").and_then(Value::as_str)
                    != fact.get("canonicalAction").and_then(Value::as_str))
        {
            return Err(public_projection_shape_invalid(
                "Operation fact canonicalAction differs from toolId",
            ));
        }
    }
    Ok(())
}

fn validate_public_read_evidence(
    operation_fact: &serde_json::Map<String, Value>,
    value: &Value,
) -> Result<(), HostV2StorageError> {
    let evidence = public_exact_object(
        value,
        &[
            "authorityKind",
            "controlEpoch",
            "evidenceDigest",
            "resourceRefs",
            "subjectDigest",
            "toolId",
        ],
        &[],
        "Operation read evidence",
    )?;
    if public_string(evidence, "authorityKind", false)? != "read"
        || operation_fact.get("domain").and_then(Value::as_str) != Some("effect")
        || !matches!(
            operation_fact.get("factKind").and_then(Value::as_str),
            Some(
                "toolObserved"
                    | "toolObservedAfterCancel"
                    | "toolObservedAfterDeadline"
                    | "toolObservedAfterCancelAndDeadline"
            )
        )
        || operation_fact
            .get("operationId")
            .and_then(Value::as_str)
            .is_none()
        || operation_fact.get("toolId") != evidence.get("toolId")
    {
        return Err(public_projection_shape_invalid(
            "Operation read evidence is not bound to an observed read effect",
        ));
    }
    public_integer(evidence, "controlEpoch", true)?;
    public_string(evidence, "toolId", true)?;
    let digest = public_string(evidence, "evidenceDigest", true)?;
    validate_sha256_digest(digest, "operationFact.readEvidence.evidenceDigest").map_err(|_| {
        public_projection_shape_invalid("Operation read evidence digest is not canonical")
    })?;
    let subject_digest = public_string(evidence, "subjectDigest", true)?;
    validate_sha256_digest(subject_digest, "operationFact.readEvidence.subjectDigest").map_err(
        |_| public_projection_shape_invalid("Operation read subject digest is not canonical"),
    )?;
    let resource_refs = public_array(evidence, "resourceRefs")?;
    if resource_refs.is_empty() {
        return Err(public_projection_shape_invalid(
            "Operation read evidence requires at least one resource reference",
        ));
    }
    validate_public_identity_array(
        evidence
            .get("resourceRefs")
            .expect("required read evidence resource refs"),
        "operationFact.readEvidence.resourceRefs",
    )?;
    let mut previous: Option<&str> = None;
    for resource_ref in resource_refs {
        let resource_ref = resource_ref
            .as_str()
            .expect("validated read evidence resource ref");
        if previous.is_some_and(|candidate| candidate >= resource_ref) {
            return Err(public_projection_shape_invalid(
                "Operation read evidence resource references are not canonical",
            ));
        }
        previous = Some(resource_ref);
    }
    Ok(())
}

fn validate_public_ordered_items(value: &Value) -> Result<(), HostV2StorageError> {
    let items = value
        .as_array()
        .filter(|items| items.len() <= 96)
        .ok_or_else(|| public_projection_shape_invalid("orderedItems is invalid"))?;
    let mut previous_text_ordinal = 0;
    let mut previous_tool_ordinal = 0;
    for item in items {
        let kind = item.get("kind").and_then(Value::as_str);
        match kind {
            Some("text") => {
                let item = public_exact_object(
                    item,
                    &["kind", "phase", "text", "textOrdinal"],
                    &[],
                    "Provider text item",
                )?;
                if !matches!(
                    public_string(item, "phase", false)?,
                    "commentary" | "final_answer" | "unknown"
                ) {
                    return Err(public_projection_shape_invalid(
                        "Provider text phase is not current",
                    ));
                }
                public_string(item, "text", false)?;
                let ordinal = public_integer(item, "textOrdinal", true)?;
                if ordinal <= previous_text_ordinal {
                    return Err(public_projection_shape_invalid(
                        "Provider text ordinal is not strictly ordered",
                    ));
                }
                previous_text_ordinal = ordinal;
            }
            Some("toolCall") => {
                let item = public_exact_object(
                    item,
                    &["kind", "ordinal", "callId", "toolName", "toolId"],
                    &[
                        "operationId",
                        "previewId",
                        "status",
                        "invocationId",
                        "terminalFactId",
                        "terminalFactKind",
                        "settlementReason",
                        "retry",
                    ],
                    "Provider tool item",
                )?;
                let ordinal = public_integer(item, "ordinal", true)?;
                if ordinal <= previous_tool_ordinal {
                    return Err(public_projection_shape_invalid(
                        "Provider tool ordinal is not strictly ordered",
                    ));
                }
                previous_tool_ordinal = ordinal;
                for field in ["callId", "toolName", "toolId"] {
                    public_string(item, field, true)?;
                }
                for field in [
                    "operationId",
                    "previewId",
                    "invocationId",
                    "terminalFactId",
                    "terminalFactKind",
                    "settlementReason",
                ] {
                    public_optional_string(item, field, true)?;
                }
                if item.contains_key("status")
                    && !matches!(
                        public_string(item, "status", false)?,
                        "pending"
                            | "submitting"
                            | "awaitingCapability"
                            | "awaitingInvocation"
                            | "completed"
                            | "aborted"
                            | "unexecuted"
                    )
                {
                    return Err(public_projection_shape_invalid(
                        "Provider tool status is not current",
                    ));
                }
                if let Some(retry) = item.get("retry") {
                    let retry = public_exact_object(
                        retry,
                        &["retryGroupId", "predecessorOperationId", "retryOrdinal"],
                        &[],
                        "Provider tool retry",
                    )?;
                    public_string(retry, "retryGroupId", true)?;
                    let predecessor = public_string(retry, "predecessorOperationId", true)?;
                    let retry_ordinal = public_integer(retry, "retryOrdinal", true)?;
                    if retry_ordinal < 2
                        || item.get("operationId").and_then(Value::as_str) == Some(predecessor)
                    {
                        return Err(public_projection_shape_invalid(
                            "Provider tool retry identity is invalid",
                        ));
                    }
                }
            }
            _ => {
                return Err(public_projection_shape_invalid(
                    "Provider ordered item kind is not current",
                ))
            }
        }
    }
    Ok(())
}

fn validate_public_provider_outcome(value: &Value) -> Result<(), HostV2StorageError> {
    let outcome = public_exact_object(
        value,
        &["providerProfileId", "provider", "model"],
        &["usage"],
        "Provider outcome",
    )?;
    for field in ["providerProfileId", "provider", "model"] {
        public_string(outcome, field, true)?;
    }
    if outcome.contains_key("usage") {
        let usage = public_object(outcome, "usage")?;
        let mut visited = 0usize;
        validate_public_provider_usage(usage, 0, &mut visited)?;
    }
    Ok(())
}

fn validate_public_provider_usage(
    usage: &serde_json::Map<String, Value>,
    depth: usize,
    visited: &mut usize,
) -> Result<(), HostV2StorageError> {
    if depth > 5 || (depth == 5 && !usage.is_empty()) {
        return Err(public_projection_shape_invalid(
            "Provider usage nesting is invalid",
        ));
    }
    for (key, value) in usage {
        *visited += 1;
        let key_is_current = key.len() <= 128
            && key
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic())
            && key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        if *visited > 256 || !key_is_current {
            return Err(public_projection_shape_invalid(
                "Provider usage key is invalid",
            ));
        }
        if let Some(counter) = value.as_u64() {
            if counter > 1_000_000_000_000 {
                return Err(public_projection_shape_invalid(
                    "Provider usage counter is invalid",
                ));
            }
            continue;
        }
        let nested = value
            .as_object()
            .ok_or_else(|| public_projection_shape_invalid("Provider usage value is invalid"))?;
        validate_public_provider_usage(nested, depth + 1, visited)?;
    }
    Ok(())
}

fn validate_public_cancellation_facts(value: &Value) -> Result<(), HostV2StorageError> {
    let facts = public_exact_object(
        value,
        &[
            "afterLedgerSequence",
            "snapshotHighWater",
            "runSequenceHighWater",
            "caughtUp",
            "pendingFactBarrierCount",
        ],
        &[],
        "Run cancellation facts",
    )?;
    for field in [
        "afterLedgerSequence",
        "snapshotHighWater",
        "runSequenceHighWater",
        "pendingFactBarrierCount",
    ] {
        public_integer(facts, field, false)?;
    }
    if facts.get("caughtUp").and_then(Value::as_bool) != Some(true)
        || facts.get("pendingFactBarrierCount").and_then(Value::as_u64) != Some(0)
    {
        return Err(public_projection_shape_invalid(
            "Run cancellation facts are not caught up",
        ));
    }
    Ok(())
}

fn validate_public_review(value: &Value) -> Result<(), HostV2StorageError> {
    let review = public_exact_object(
        value,
        &[
            "projectionVersion",
            "revision",
            "status",
            "planActionSettlementDigest",
            "snapshotHighWater",
            "planned",
            "scopeExpansions",
            "actualEffects",
            "unexecuted",
            "denied",
            "rejections",
            "completions",
            "cleanup",
            "indeterminate",
            "priorEpochLateFacts",
            "factCoverage",
            "factsQuery",
            "pendingCleanupCount",
            "createdAt",
        ],
        &[
            "workAuthority",
            "planRevision",
            "planDecision",
            "plan",
            "finalizedAt",
        ],
        "Review",
    )?;
    if public_string(review, "projectionVersion", false)?
        != "deepcode.session.kernel-review-projection.v2"
        || !matches!(public_string(review, "status", false)?, "draft" | "final")
    {
        return Err(public_projection_shape_invalid(
            "Review version or status is invalid",
        ));
    }
    for field in ["planActionSettlementDigest", "createdAt"] {
        public_string(review, field, true)?;
    }
    for field in ["planRevision", "finalizedAt"] {
        public_optional_string(review, field, true)?;
    }
    public_integer(review, "revision", true)?;
    public_integer(review, "snapshotHighWater", false)?;
    public_integer(review, "pendingCleanupCount", false)?;
    for field in ["planned", "unexecuted"] {
        validate_public_planned_actions(review.get(field).expect("required planned actions"))?;
    }
    for field in [
        "scopeExpansions",
        "actualEffects",
        "denied",
        "rejections",
        "cleanup",
        "indeterminate",
        "priorEpochLateFacts",
    ] {
        validate_public_review_fact_refs(review.get(field).expect("required review facts"))?;
    }
    validate_public_review_completions(review.get("completions").expect("required completions"))?;
    validate_public_review_coverage(review.get("factCoverage").expect("required coverage"))?;
    validate_public_review_query(review.get("factsQuery").expect("required facts query"))?;
    if let Some(plan) = review.get("plan") {
        let plan = public_exact_object(
            plan,
            &["title", "objective", "narrative", "recordedAt"],
            &[],
            "Review Plan",
        )?;
        for field in ["title", "objective", "narrative"] {
            public_string(plan, field, false)?;
        }
        public_string(plan, "recordedAt", true)?;
    }
    if let Some(decision) = review.get("planDecision") {
        let decision = public_exact_object(
            decision,
            &["planRevision", "decision", "recordedAt"],
            &["guidance"],
            "Review Plan decision",
        )?;
        for field in ["planRevision", "recordedAt"] {
            public_string(decision, field, true)?;
        }
        if !matches!(
            public_string(decision, "decision", false)?,
            "accept" | "reject" | "revise"
        ) {
            return Err(public_projection_shape_invalid(
                "Review Plan decision is invalid",
            ));
        }
        public_optional_string(decision, "guidance", false)?;
    }
    if let Some(authority) = review.get("workAuthority") {
        validate_public_work_authority(authority)?;
    }
    Ok(())
}

fn validate_public_planned_actions(value: &Value) -> Result<(), HostV2StorageError> {
    let actions = value
        .as_array()
        .ok_or_else(|| public_projection_shape_invalid("Review actions must be an array"))?;
    for action in actions {
        let action = public_exact_object(
            action,
            &["taskId", "planActionId", "operationId", "toolId"],
            &[],
            "Review action",
        )?;
        for field in ["taskId", "planActionId", "operationId", "toolId"] {
            public_string(action, field, true)?;
        }
    }
    Ok(())
}

fn validate_public_review_fact_refs(value: &Value) -> Result<(), HostV2StorageError> {
    let facts = value
        .as_array()
        .ok_or_else(|| public_projection_shape_invalid("Review facts must be an array"))?;
    for fact in facts {
        let fact = public_exact_object(
            fact,
            &[
                "factId",
                "ledgerSequence",
                "domain",
                "factKind",
                "planActionIds",
                "resourceIds",
                "details",
            ],
            &[
                "controlEpoch",
                "sessionPlanActionId",
                "operationId",
                "invocationId",
                "effectId",
            ],
            "Review fact",
        )?;
        for field in ["factId", "factKind"] {
            public_string(fact, field, true)?;
        }
        if !matches!(
            public_string(fact, "domain", false)?,
            "control" | "authorization" | "invocation" | "effect" | "resource" | "cleanup"
        ) {
            return Err(public_projection_shape_invalid(
                "Review fact domain is invalid",
            ));
        }
        public_integer(fact, "ledgerSequence", true)?;
        if fact.contains_key("controlEpoch") {
            public_integer(fact, "controlEpoch", true)?;
        }
        for field in [
            "sessionPlanActionId",
            "operationId",
            "invocationId",
            "effectId",
        ] {
            public_optional_string(fact, field, true)?;
        }
        validate_public_identity_array(
            fact.get("planActionIds").expect("required PlanAction ids"),
            "reviewFact.planActionIds",
        )?;
        validate_public_identity_array(
            fact.get("resourceIds").expect("required resource ids"),
            "reviewFact.resourceIds",
        )?;
        public_object(fact, "details")?;
    }
    Ok(())
}

fn validate_public_review_completions(value: &Value) -> Result<(), HostV2StorageError> {
    let completions = value
        .as_array()
        .ok_or_else(|| public_projection_shape_invalid("Review completions must be an array"))?;
    for completion in completions {
        let completion = public_exact_object(
            completion,
            &[
                "kind",
                "planRevision",
                "planActionId",
                "controlEpoch",
                "outcome",
                "providerTurnId",
                "controlCallId",
                "controlArgumentsDigest",
                "snapshotHighWater",
                "recordedAt",
            ],
            &[],
            "Review completion",
        )?;
        if public_string(completion, "kind", false)? != "planActionComplete"
            || !matches!(
                public_string(completion, "outcome", false)?,
                "completed" | "no_op" | "blocked" | "skipped" | "unexecuted"
            )
        {
            return Err(public_projection_shape_invalid(
                "Review completion kind is invalid",
            ));
        }
        for field in [
            "planRevision",
            "planActionId",
            "providerTurnId",
            "controlCallId",
            "controlArgumentsDigest",
            "recordedAt",
        ] {
            public_string(completion, field, true)?;
        }
        public_integer(completion, "controlEpoch", true)?;
        public_integer(completion, "snapshotHighWater", false)?;
    }
    Ok(())
}

fn validate_public_review_coverage(value: &Value) -> Result<(), HostV2StorageError> {
    const CATEGORIES: &[&str] = &[
        "scopeExpansions",
        "actualEffects",
        "denied",
        "rejections",
        "cleanup",
        "indeterminate",
        "priorEpochLateFacts",
    ];
    let coverage = public_exact_object(value, CATEGORIES, &[], "Review fact coverage")?;
    for category in CATEGORIES {
        let counts = public_exact_object(
            coverage.get(*category).expect("required coverage category"),
            &["totalCount", "retainedCount", "omittedCount"],
            &[],
            "Review coverage category",
        )?;
        let total = public_integer(counts, "totalCount", false)?;
        let retained = public_integer(counts, "retainedCount", false)?;
        let omitted = public_integer(counts, "omittedCount", false)?;
        if retained.saturating_add(omitted) != total {
            return Err(public_projection_shape_invalid(
                "Review fact coverage counts are inconsistent",
            ));
        }
    }
    Ok(())
}

fn validate_public_review_query(value: &Value) -> Result<(), HostV2StorageError> {
    let query = public_exact_object(
        value,
        &[
            "runId",
            "controlEpoch",
            "afterLedgerSequence",
            "snapshotHighWater",
        ],
        &[],
        "Review facts query",
    )?;
    public_string(query, "runId", true)?;
    public_integer(query, "controlEpoch", true)?;
    public_integer(query, "afterLedgerSequence", false)?;
    public_integer(query, "snapshotHighWater", false)?;
    Ok(())
}

fn validate_public_work_authority(value: &Value) -> Result<(), HostV2StorageError> {
    decode_session_work_authority_v3(value)
        .map(|_| ())
        .map_err(|_| public_projection_shape_invalid("Review authority is not current"))
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

pub(crate) async fn session_run_store_get(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session persistence accepts only trusted local clients",
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

pub(crate) async fn session_run_store_append(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<SessionKernelPersistenceAppendRequestV2>, JsonRejection>,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session persistence accepts only trusted local clients",
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

pub(crate) async fn session_run_store_record_get(
    State(state): State<AppState>,
    Path((session_id, run_id, record_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    if !crate::session_metadata_v2::trusted_private_storage_origin(&headers) {
        return v2_error_response(
            StatusCode::FORBIDDEN,
            "session_kernel_persistence_origin_forbidden",
            "Session persistence accepts only trusted local clients",
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
