use crate::api_response::ApiResponse;
use crate::prelude::*;
use crate::AppState;
use axum::extract::Request;
use axum::middleware::Next;

pub(crate) const HOST_STARTUP_READINESS_SCHEMA_V2: &str = "deepcode.host.startup-readiness.v2";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostStartupReadinessStatusV2 {
    schema_version: &'static str,
    pub(crate) phase: HostStartupReadinessPhaseV2,
    pub(crate) ready: bool,
    started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostStartupReadinessPhaseV2 {
    Recovering,
    Ready,
    Failed,
}

#[derive(Clone)]
pub(crate) struct HostStartupReadinessV2 {
    status: Arc<Mutex<HostStartupReadinessStatusV2>>,
}

impl HostStartupReadinessV2 {
    pub(crate) fn recovering() -> Self {
        Self {
            status: Arc::new(Mutex::new(HostStartupReadinessStatusV2 {
                schema_version: HOST_STARTUP_READINESS_SCHEMA_V2,
                phase: HostStartupReadinessPhaseV2::Recovering,
                ready: false,
                started_at: crate::now_text(),
                completed_at: None,
                failure_code: None,
            })),
        }
    }

    pub(crate) fn status(&self) -> HostStartupReadinessStatusV2 {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| HostStartupReadinessStatusV2 {
                schema_version: HOST_STARTUP_READINESS_SCHEMA_V2,
                phase: HostStartupReadinessPhaseV2::Failed,
                ready: false,
                started_at: crate::now_text(),
                completed_at: Some(crate::now_text()),
                failure_code: Some("host_startup_readiness_unavailable".to_string()),
            })
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.status
            .lock()
            .map(|status| status.ready)
            .unwrap_or(false)
    }

    pub(crate) fn mark_ready(&self) -> Result<(), &'static str> {
        let mut status = self
            .status
            .lock()
            .map_err(|_| "Host startup readiness owner is unavailable")?;
        if status.phase != HostStartupReadinessPhaseV2::Recovering {
            return Err("Host startup readiness can become ready only after recovery");
        }
        status.phase = HostStartupReadinessPhaseV2::Ready;
        status.ready = true;
        status.completed_at = Some(crate::now_text());
        status.failure_code = None;
        Ok(())
    }

    pub(crate) fn mark_failed(&self, failure_code: impl Into<String>) {
        if let Ok(mut status) = self.status.lock() {
            status.phase = HostStartupReadinessPhaseV2::Failed;
            status.ready = false;
            status.completed_at = Some(crate::now_text());
            status.failure_code = Some(failure_code.into());
        }
    }
}

pub(crate) async fn host_startup_readiness_gate(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if state.startup_readiness_v2.is_ready()
        || startup_route_is_available(request.method(), request.uri().path(), request.headers())
    {
        return next.run(request).await;
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        ApiResponse::error_with_data(
            "startup_recovery_in_progress",
            "DeepCode Host startup recovery has not completed",
            serde_json::to_value(state.startup_readiness_v2.status())
                .unwrap_or_else(|_| json!({ "ready": false })),
        ),
    )
        .into_response()
}

fn startup_route_is_available(
    method: &Method,
    path: &str,
    headers: &axum::http::HeaderMap,
) -> bool {
    if method == Method::OPTIONS {
        return true;
    }
    if matches!(
        (method, path),
        (&Method::GET, "/api/host/identity")
            | (&Method::GET, "/api/health")
            | (&Method::POST, "/api/host/shutdown")
            | (&Method::POST, "/api/kernel/v2/commands")
            | (&Method::POST, "/api/llm/chat/stream")
    ) {
        return true;
    }
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if segments.len() == 5
        && segments[0] == "api"
        && segments[1] == "session-store"
        && !segments[2].is_empty()
        && segments[3] == "kernel-v3"
        && !segments[4].is_empty()
        && matches!(method, &Method::GET | &Method::POST)
    {
        return true;
    }
    if segments.len() == 7
        && segments[0] == "api"
        && segments[1] == "session-store"
        && !segments[2].is_empty()
        && segments[3] == "kernel-v3"
        && !segments[4].is_empty()
        && segments[5] == "records"
        && !segments[6].is_empty()
        && method == Method::GET
    {
        return true;
    }
    if segments.len() == 8
        && segments[0] == "api"
        && segments[1] == "agent"
        && segments[2] == "sessions"
        && !segments[3].is_empty()
        && segments[4] == "runs"
        && !segments[5].is_empty()
        && segments[6] == "kernel-v2"
        && ((segments[7] == "projections" && method == Method::POST)
            || (segments[7] == "prior-events" && method == Method::GET))
    {
        return true;
    }
    // Projection recovery reads the frozen prior timeline through its exact
    // Run transport binding. The handler still validates both identities.
    segments.len() == 5
        && segments[0] == "api"
        && segments[1] == "agent"
        && segments[2] == "sessions"
        && !segments[3].is_empty()
        && segments[4] == "timeline"
        && method == Method::GET
        && headers.contains_key("x-deepcode-run-id")
        && headers.contains_key(crate::kernel_v2_transport::RUN_TRANSPORT_CAPABILITY_HEADER)
}
