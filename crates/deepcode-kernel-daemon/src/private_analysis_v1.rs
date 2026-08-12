use crate::host_v2_storage::{
    append_json_line_durable, validate_bounded_identity, validate_safe_session_identity,
    with_storage_path_lock,
};
use crate::prelude::*;
use crate::*;
use axum::http::HeaderMap;
use std::collections::HashSet;

pub(crate) const PRIVATE_ANALYSIS_PROJECTION_SCHEMA_V1: &str =
    "deepcode.session.private-analysis-projection.v1";
pub(crate) const PRIVATE_ANALYSIS_LEASE_SCHEMA_V1: &str =
    "deepcode.session.private-analysis-lease.v1";
pub(crate) const PRIVATE_ANALYSIS_LEASE_HEADER_V1: &str = "x-deepcode-private-analysis-lease";
const PRIVATE_ANALYSIS_AUDIT_SCHEMA_V1: &str = "deepcode.session.private-analysis-audit.v1";
const PRIVATE_ANALYSIS_LEASE_IDLE_TTL_V1: Duration = Duration::from_secs(15 * 60);
const PRIVATE_ANALYSIS_LEASE_CAPACITY_V1: usize = 128;
const PRIVATE_ANALYSIS_PAGE_DEFAULT_V1: usize = 25;
const PRIVATE_ANALYSIS_PAGE_MAX_V1: usize = 50;
const PRIVATE_ANALYSIS_TRACE_SCAN_MAX_V1: usize = 4096;
const PRIVATE_ANALYSIS_PAGE_TEXT_BYTES_MAX_V1: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
struct PrivateAnalysisLeaseV1 {
    capability: String,
    session_id: String,
    caller_request_id: String,
    host_instance_id: String,
    expires_at: Instant,
}

#[derive(Clone)]
pub(crate) struct PrivateAnalysisLeaseStoreV1 {
    sessions_dir: Arc<PathBuf>,
    leases: Arc<Mutex<HashMap<String, PrivateAnalysisLeaseV1>>>,
}

#[derive(Debug)]
pub(crate) struct PrivateAnalysisErrorV1 {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl PrivateAnalysisErrorV1 {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrivateAnalysisLeaseRequestV1 {
    caller_request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateAnalysisLeaseReceiptV1 {
    schema_version: &'static str,
    session_id: String,
    capability: String,
    expires_in_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrivateAnalysisPageQueryV1 {
    #[serde(default)]
    after_cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateAnalysisToolV1 {
    name: String,
    stage: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateAnalysisItemV1 {
    analysis_id: String,
    request_id: String,
    provider_turn_id: String,
    run_id: String,
    user_turn_id: String,
    boundary: ProviderTracePurposeV1,
    started_at_unix_ms: String,
    completed_at_unix_ms: String,
    status: ProviderTraceTerminalKindV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason_code: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    reasoning: String,
    tools: Vec<PrivateAnalysisToolV1>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateAnalysisProjectionV1 {
    schema_version: &'static str,
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    after_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
    has_more: bool,
    items: Vec<PrivateAnalysisItemV1>,
}

impl PrivateAnalysisLeaseStoreV1 {
    pub(crate) fn new(sessions_dir: PathBuf) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            leases: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn mint(
        &self,
        session_id: &str,
        caller_request_id: &str,
        host_instance_id: &str,
    ) -> Result<PrivateAnalysisLeaseReceiptV1, PrivateAnalysisErrorV1> {
        validate_safe_session_identity(session_id).map_err(private_analysis_storage_error)?;
        validate_bounded_identity(caller_request_id, "callerRequestId", 512)
            .map_err(private_analysis_storage_error)?;
        validate_bounded_identity(host_instance_id, "hostInstanceId", 512)
            .map_err(private_analysis_storage_error)?;
        let mut leases = self.leases.lock().map_err(|_| {
            PrivateAnalysisErrorV1::new(
                "private_analysis_lease_store_unavailable",
                "Private analysis lease state is unavailable",
            )
        })?;
        let now = Instant::now();
        leases.retain(|_, lease| lease.expires_at > now);
        if let Some(existing) = leases.values_mut().find(|lease| {
            lease.caller_request_id == caller_request_id
                && lease.host_instance_id == host_instance_id
        }) {
            if existing.session_id != session_id {
                return Err(PrivateAnalysisErrorV1::new(
                    "private_analysis_caller_request_conflict",
                    "callerRequestId is already bound to a different Session analysis lease",
                ));
            }
            existing.expires_at = now + PRIVATE_ANALYSIS_LEASE_IDLE_TTL_V1;
            let receipt = PrivateAnalysisLeaseReceiptV1 {
                schema_version: PRIVATE_ANALYSIS_LEASE_SCHEMA_V1,
                session_id: session_id.to_string(),
                capability: existing.capability.clone(),
                expires_in_seconds: PRIVATE_ANALYSIS_LEASE_IDLE_TTL_V1.as_secs(),
            };
            self.record_audit("grant", session_id, caller_request_id, None, "idempotent")?;
            return Ok(receipt);
        }
        if leases.len() >= PRIVATE_ANALYSIS_LEASE_CAPACITY_V1 {
            return Err(PrivateAnalysisErrorV1::new(
                "private_analysis_lease_capacity_exceeded",
                "Private analysis lease capacity is exhausted",
            ));
        }
        let mut entropy = [0u8; 32];
        getrandom::fill(&mut entropy).map_err(|error| {
            PrivateAnalysisErrorV1::new(
                "private_analysis_lease_entropy_failed",
                format!("Generate private analysis capability: {error}"),
            )
        })?;
        let capability = format!("private-analysis-v1.{}", lower_hex_v1(&entropy));
        let replaced = leases
            .iter()
            .find(|(_, lease)| {
                lease.session_id == session_id && lease.host_instance_id == host_instance_id
            })
            .map(|(key, lease)| (key.clone(), lease.clone()));
        if let Some((key, _)) = &replaced {
            leases.remove(key);
        }
        let lease = PrivateAnalysisLeaseV1 {
            capability: capability.clone(),
            session_id: session_id.to_string(),
            caller_request_id: caller_request_id.to_string(),
            host_instance_id: host_instance_id.to_string(),
            expires_at: now + PRIVATE_ANALYSIS_LEASE_IDLE_TTL_V1,
        };
        leases.insert(capability.clone(), lease);
        if let Err(error) =
            self.record_audit("grant", session_id, caller_request_id, None, "granted")
        {
            leases.remove(&capability);
            if let Some((key, lease)) = replaced {
                leases.insert(key, lease);
            }
            return Err(error);
        }
        Ok(PrivateAnalysisLeaseReceiptV1 {
            schema_version: PRIVATE_ANALYSIS_LEASE_SCHEMA_V1,
            session_id: session_id.to_string(),
            capability,
            expires_in_seconds: PRIVATE_ANALYSIS_LEASE_IDLE_TTL_V1.as_secs(),
        })
    }

    fn authorize(
        &self,
        capability: &str,
        session_id: &str,
        host_instance_id: &str,
    ) -> Result<String, PrivateAnalysisErrorV1> {
        let caller_request_id = {
            let mut leases = self.leases.lock().map_err(|_| {
                PrivateAnalysisErrorV1::new(
                    "private_analysis_lease_store_unavailable",
                    "Private analysis lease state is unavailable",
                )
            })?;
            let now = Instant::now();
            leases.retain(|_, lease| lease.expires_at > now);
            let lease = leases.get_mut(capability).ok_or_else(|| {
                PrivateAnalysisErrorV1::new(
                    "private_analysis_lease_required",
                    "Private analysis lease is missing, invalid, or expired",
                )
            })?;
            if lease.session_id != session_id || lease.host_instance_id != host_instance_id {
                return Err(PrivateAnalysisErrorV1::new(
                    "private_analysis_lease_conflict",
                    "Private analysis lease is bound to a different Session or Host",
                ));
            }
            lease.expires_at = now + PRIVATE_ANALYSIS_LEASE_IDLE_TTL_V1;
            lease.caller_request_id.clone()
        };
        Ok(caller_request_id)
    }

    fn record_read_outcome(
        &self,
        session_id: &str,
        caller_request_id: &str,
        cursor: Option<&str>,
        result_code: &'static str,
    ) -> Result<(), PrivateAnalysisErrorV1> {
        self.record_audit("read", session_id, caller_request_id, cursor, result_code)
    }

    fn revoke(
        &self,
        capability: &str,
        session_id: &str,
        host_instance_id: &str,
    ) -> Result<(), PrivateAnalysisErrorV1> {
        let lease = {
            let mut leases = self.leases.lock().map_err(|_| {
                PrivateAnalysisErrorV1::new(
                    "private_analysis_lease_store_unavailable",
                    "Private analysis lease state is unavailable",
                )
            })?;
            let lease = leases.remove(capability).ok_or_else(|| {
                PrivateAnalysisErrorV1::new(
                    "private_analysis_lease_required",
                    "Private analysis lease is missing, invalid, or expired",
                )
            })?;
            if lease.session_id != session_id || lease.host_instance_id != host_instance_id {
                leases.insert(capability.to_string(), lease);
                return Err(PrivateAnalysisErrorV1::new(
                    "private_analysis_lease_conflict",
                    "Private analysis lease is bound to a different Session or Host",
                ));
            }
            lease
        };
        self.record_audit(
            "revoke",
            session_id,
            &lease.caller_request_id,
            None,
            "revoked",
        )
    }

    fn record_audit(
        &self,
        action: &'static str,
        session_id: &str,
        caller_request_id: &str,
        cursor: Option<&str>,
        result_code: &'static str,
    ) -> Result<(), PrivateAnalysisErrorV1> {
        let path = self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join("private-analysis-audit.jsonl");
        let record = json!({
            "schemaVersion": PRIVATE_ANALYSIS_AUDIT_SCHEMA_V1,
            "action": action,
            "sessionId": session_id,
            "callerRequestId": caller_request_id,
            "cursor": cursor,
            "recordedAtUnixMs": now_millis().to_string(),
            "resultCode": result_code,
        });
        with_storage_path_lock(&path, || append_json_line_durable(&path, &record))
            .map_err(private_analysis_storage_error)
    }
}

pub(crate) async fn private_analysis_lease_mint_v1(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    body: Result<Json<PrivateAnalysisLeaseRequestV1>, JsonRejection>,
) -> Response {
    if let Err(response) = ensure_private_analysis_session_v1(&state, &session_id) {
        return response;
    }
    let Json(request) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return private_analysis_error_response_v1(
                StatusCode::BAD_REQUEST,
                "private_analysis_lease_body_invalid",
                rejection.body_text(),
            )
        }
    };
    let host_instance_id = state.host_services.active_runs_v2.owner_instance_id();
    match state
        .private_analysis_v1
        .mint(&session_id, &request.caller_request_id, &host_instance_id)
    {
        Ok(receipt) => (
            StatusCode::OK,
            ApiResponse::ok(serde_json::to_value(receipt).expect("lease receipt serializes")),
        )
            .into_response(),
        Err(error) => private_analysis_error_response_v1(
            private_analysis_error_status_v1(error.code),
            error.code,
            error.message,
        ),
    }
}

pub(crate) async fn private_analysis_page_v1(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<PrivateAnalysisPageQueryV1>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = ensure_private_analysis_session_v1(&state, &session_id) {
        return response;
    }
    let capability = match private_analysis_capability_header_v1(&headers) {
        Ok(capability) => capability,
        Err(error) => {
            return private_analysis_error_response_v1(
                StatusCode::UNAUTHORIZED,
                error.code,
                error.message,
            )
        }
    };
    let host_instance_id = state.host_services.active_runs_v2.owner_instance_id();
    let caller_request_id =
        match state
            .private_analysis_v1
            .authorize(capability, &session_id, &host_instance_id)
        {
            Ok(caller_request_id) => caller_request_id,
            Err(error) => {
                return private_analysis_error_response_v1(
                    private_analysis_error_status_v1(error.code),
                    error.code,
                    error.message,
                )
            }
        };
    let limit = query
        .limit
        .unwrap_or(PRIVATE_ANALYSIS_PAGE_DEFAULT_V1)
        .clamp(1, PRIVATE_ANALYSIS_PAGE_MAX_V1);
    let store = state.provider_trace_v1.clone();
    let read_session_id = session_id.clone();
    let after_cursor = query.after_cursor.clone();
    let result = tokio::task::spawn_blocking(move || {
        build_private_analysis_projection_v1(
            &store,
            &read_session_id,
            after_cursor.as_deref(),
            limit,
        )
    })
    .await;
    let audit_result_code = match &result {
        Ok(Ok(_)) => "succeeded",
        Ok(Err(error)) => error.code,
        Err(_) => "private_analysis_task_failed",
    };
    if let Err(error) = state.private_analysis_v1.record_read_outcome(
        &session_id,
        &caller_request_id,
        query.after_cursor.as_deref(),
        audit_result_code,
    ) {
        return private_analysis_error_response_v1(
            StatusCode::INTERNAL_SERVER_ERROR,
            error.code,
            error.message,
        );
    }
    match result {
        Ok(Ok(projection)) => (
            StatusCode::OK,
            ApiResponse::ok(
                serde_json::to_value(projection).expect("private analysis projection serializes"),
            ),
        )
            .into_response(),
        Ok(Err(error)) => private_analysis_error_response_v1(
            private_analysis_error_status_v1(error.code),
            error.code,
            error.message,
        ),
        Err(_) => private_analysis_error_response_v1(
            StatusCode::INTERNAL_SERVER_ERROR,
            "private_analysis_task_failed",
            "Private analysis projection task failed",
        ),
    }
}

pub(crate) async fn private_analysis_lease_revoke_v1(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let capability = match private_analysis_capability_header_v1(&headers) {
        Ok(capability) => capability,
        Err(error) => {
            return private_analysis_error_response_v1(
                StatusCode::UNAUTHORIZED,
                error.code,
                error.message,
            )
        }
    };
    let host_instance_id = state.host_services.active_runs_v2.owner_instance_id();
    match state
        .private_analysis_v1
        .revoke(capability, &session_id, &host_instance_id)
    {
        Ok(()) => (
            StatusCode::OK,
            ApiResponse::ok(json!({
                "schemaVersion": PRIVATE_ANALYSIS_LEASE_SCHEMA_V1,
                "sessionId": session_id,
                "revoked": true,
            })),
        )
            .into_response(),
        Err(error) => private_analysis_error_response_v1(
            private_analysis_error_status_v1(error.code),
            error.code,
            error.message,
        ),
    }
}

fn build_private_analysis_projection_v1(
    store: &ProviderTraceStoreV1,
    session_id: &str,
    after_cursor: Option<&str>,
    limit: usize,
) -> Result<PrivateAnalysisProjectionV1, PrivateAnalysisErrorV1> {
    let metadata = store
        .list_verified_metadata(session_id)
        .map_err(private_analysis_trace_error)?;
    if metadata.len() > PRIVATE_ANALYSIS_TRACE_SCAN_MAX_V1 {
        return Err(PrivateAnalysisErrorV1::new(
            "private_analysis_trace_scan_limit_exceeded",
            "Private analysis trace count exceeds the bounded scan limit",
        ));
    }
    let mut recoveries = metadata
        .into_iter()
        .map(|metadata| {
            store
                .verified_terminal_recovery(session_id, &metadata.provider_turn_id)
                .map_err(private_analysis_trace_error)
        })
        .collect::<Result<Vec<_>, _>>()?;
    recoveries.sort_by(|left, right| {
        private_analysis_sort_key_v1(left).cmp(&private_analysis_sort_key_v1(right))
    });
    let cursor_key = after_cursor
        .map(parse_private_analysis_cursor_v1)
        .transpose()?;
    let mut items = Vec::new();
    let mut text_bytes = 0usize;
    let mut has_more = false;
    for recovery in recoveries {
        let key = private_analysis_sort_key_v1(&recovery);
        if cursor_key.as_ref().is_some_and(|cursor| key <= *cursor) {
            continue;
        }
        if items.len() >= limit
            || (text_bytes > 0
                && text_bytes.saturating_add(recovery.reasoning.len())
                    > PRIVATE_ANALYSIS_PAGE_TEXT_BYTES_MAX_V1)
        {
            has_more = true;
            break;
        }
        text_bytes = text_bytes.saturating_add(recovery.reasoning.len());
        items.push(private_analysis_item_v1(recovery));
    }
    let next_cursor = items
        .last()
        .map(|item| format!("{}:{}", item.started_at_unix_ms, item.provider_turn_id));
    Ok(PrivateAnalysisProjectionV1 {
        schema_version: PRIVATE_ANALYSIS_PROJECTION_SCHEMA_V1,
        session_id: session_id.to_string(),
        after_cursor: after_cursor.map(str::to_string),
        next_cursor,
        has_more,
        items,
    })
}

fn private_analysis_item_v1(recovery: ProviderTraceTerminalRecoveryV1) -> PrivateAnalysisItemV1 {
    let mut names = HashSet::new();
    let tools = recovery
        .completed
        .as_ref()
        .into_iter()
        .flat_map(|completed| completed.ordered_items.iter())
        .filter_map(|item| {
            if item.get("kind").and_then(Value::as_str) != Some("toolCall") {
                return None;
            }
            let name = item.get("name").and_then(Value::as_str)?.to_string();
            if !names.insert(name.clone()) {
                return None;
            }
            Some(PrivateAnalysisToolV1 {
                name,
                stage: "requested",
            })
        })
        .collect::<Vec<_>>();
    let provider_turn_id = recovery.metadata.provider_turn_id.clone();
    PrivateAnalysisItemV1 {
        analysis_id: format!("analysis:{provider_turn_id}"),
        request_id: provider_turn_id.clone(),
        provider_turn_id,
        run_id: recovery.metadata.run_id,
        user_turn_id: recovery.metadata.user_turn_id,
        boundary: recovery.metadata.purpose,
        started_at_unix_ms: recovery.started_at_unix_ms,
        completed_at_unix_ms: recovery.completed_at_unix_ms,
        status: recovery.metadata.terminal_kind,
        reason_code: recovery.reason_code,
        reasoning: recovery.reasoning,
        tools,
    }
}

fn private_analysis_sort_key_v1(recovery: &ProviderTraceTerminalRecoveryV1) -> (u128, String) {
    (
        recovery
            .started_at_unix_ms
            .parse::<u128>()
            .unwrap_or_default(),
        recovery.metadata.provider_turn_id.clone(),
    )
}

fn parse_private_analysis_cursor_v1(
    cursor: &str,
) -> Result<(u128, String), PrivateAnalysisErrorV1> {
    validate_bounded_identity(cursor, "afterCursor", 1024)
        .map_err(private_analysis_storage_error)?;
    let (started_at, provider_turn_id) = cursor.split_once(':').ok_or_else(|| {
        PrivateAnalysisErrorV1::new(
            "private_analysis_cursor_invalid",
            "Private analysis cursor is malformed",
        )
    })?;
    let started_at = started_at.parse::<u128>().map_err(|_| {
        PrivateAnalysisErrorV1::new(
            "private_analysis_cursor_invalid",
            "Private analysis cursor timestamp is malformed",
        )
    })?;
    validate_bounded_identity(provider_turn_id, "providerTurnId", 512)
        .map_err(private_analysis_storage_error)?;
    Ok((started_at, provider_turn_id.to_string()))
}

fn private_analysis_capability_header_v1(
    headers: &HeaderMap,
) -> Result<&str, PrivateAnalysisErrorV1> {
    let capability = headers
        .get(PRIVATE_ANALYSIS_LEASE_HEADER_V1)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            PrivateAnalysisErrorV1::new(
                "private_analysis_lease_required",
                "Private analysis lease header is required",
            )
        })?;
    if !capability.starts_with("private-analysis-v1.") || capability.len() != 84 {
        return Err(PrivateAnalysisErrorV1::new(
            "private_analysis_lease_required",
            "Private analysis lease header is malformed",
        ));
    }
    Ok(capability)
}

fn ensure_private_analysis_session_v1(state: &AppState, session_id: &str) -> Result<(), Response> {
    if validate_safe_session_identity(session_id).is_err() {
        return Err(private_analysis_error_response_v1(
            StatusCode::BAD_REQUEST,
            "private_analysis_session_invalid",
            "Private analysis requires a valid Session identity",
        ));
    }
    let gui = state.gui.lock().map_err(|_| {
        private_analysis_error_response_v1(
            StatusCode::INTERNAL_SERVER_ERROR,
            "private_analysis_session_state_unavailable",
            "Session metadata is unavailable",
        )
    })?;
    let exists = gui.session_metadata_error.is_none()
        && gui.sessions.iter().any(|session| {
            session.get("id").and_then(Value::as_str) == Some(session_id)
                && !session_is_deletion_tombstone(session)
        });
    if !exists {
        return Err(private_analysis_error_response_v1(
            StatusCode::NOT_FOUND,
            "private_analysis_session_not_found",
            "Private analysis Session does not exist or is unavailable",
        ));
    }
    Ok(())
}

fn private_analysis_trace_error(error: ProviderTraceErrorV1) -> PrivateAnalysisErrorV1 {
    PrivateAnalysisErrorV1::new(error.code, error.message)
}

fn private_analysis_storage_error(
    error: crate::host_v2_storage::HostV2StorageError,
) -> PrivateAnalysisErrorV1 {
    PrivateAnalysisErrorV1::new(error.code, error.message)
}

fn private_analysis_error_status_v1(code: &str) -> StatusCode {
    match code {
        "private_analysis_lease_required" => StatusCode::UNAUTHORIZED,
        "private_analysis_lease_conflict" | "private_analysis_caller_request_conflict" => {
            StatusCode::CONFLICT
        }
        "private_analysis_lease_capacity_exceeded"
        | "private_analysis_trace_scan_limit_exceeded" => StatusCode::TOO_MANY_REQUESTS,
        _ if code.ends_with("_invalid") => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn private_analysis_error_response_v1(
    status: StatusCode,
    code: impl Into<String>,
    message: impl Into<String>,
) -> Response {
    (status, ApiResponse::error(code, message)).into_response()
}

fn lower_hex_v1(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}
