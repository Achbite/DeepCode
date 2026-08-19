use crate::prelude::*;
use crate::*;
use deepcode_kernel_abi::RunCapabilityV2;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentTimelineStreamQueryV2 {
    after_revision: Option<u64>,
}

#[derive(Clone)]
enum TimelineTransportAuthorityV2 {
    HostViewer,
    Run {
        run_id: String,
        capability: RunCapabilityV2,
    },
}

struct RunPinnedTimelineStreamV2 {
    run_id: String,
    delivered_revision: Option<u64>,
    base_snapshot: Option<Value>,
    closed: bool,
}

enum RunPinnedTimelineStreamActionV2 {
    Event {
        name: String,
        payload: Value,
        terminal: bool,
    },
    Wait,
    Close,
}

impl RunPinnedTimelineStreamV2 {
    fn new(run_id: String, after_revision: Option<u64>) -> Self {
        Self {
            run_id,
            delivered_revision: after_revision,
            base_snapshot: None,
            closed: false,
        }
    }

    fn observe(
        &mut self,
        session_id: &str,
        snapshot: Option<Value>,
    ) -> RunPinnedTimelineStreamActionV2 {
        if self.closed {
            return RunPinnedTimelineStreamActionV2::Close;
        }
        let Some(snapshot) = snapshot else {
            return RunPinnedTimelineStreamActionV2::Wait;
        };
        if timeline_run_id(&snapshot) != Some(self.run_id.as_str()) {
            self.closed = true;
            return RunPinnedTimelineStreamActionV2::Close;
        }
        let revision = match timeline_u64_field(&snapshot, "revision") {
            Ok(revision) => revision,
            Err(_) => {
                self.closed = true;
                return RunPinnedTimelineStreamActionV2::Close;
            }
        };
        if self
            .delivered_revision
            .is_some_and(|delivered| revision < delivered)
        {
            self.closed = true;
            return RunPinnedTimelineStreamActionV2::Close;
        }
        if self
            .delivered_revision
            .map(|delivered| revision > delivered)
            .unwrap_or(true)
        {
            let event = match self.base_snapshot.as_ref() {
                Some(base)
                    if timeline_u64_field(base, "revision").ok() == self.delivered_revision =>
                {
                    match create_timeline_delta(base, &snapshot) {
                        Ok(delta) => json!({
                            "type": "delta",
                            "sessionId": session_id,
                            "revision": revision,
                            "delta": delta
                        }),
                        Err(_) => timeline_snapshot_event(session_id, revision, &snapshot),
                    }
                }
                _ => timeline_snapshot_event(session_id, revision, &snapshot),
            };
            let name = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("snapshot")
                .to_string();
            let terminal = timeline_is_terminal(&snapshot);
            self.delivered_revision = Some(revision);
            self.base_snapshot = Some(snapshot);
            self.closed = terminal;
            return RunPinnedTimelineStreamActionV2::Event {
                name,
                payload: event,
                terminal,
            };
        }
        if self.base_snapshot.is_none() {
            let terminal = timeline_is_terminal(&snapshot);
            self.base_snapshot = Some(snapshot);
            if terminal {
                self.closed = true;
                return RunPinnedTimelineStreamActionV2::Close;
            }
        }
        RunPinnedTimelineStreamActionV2::Wait
    }
}

pub(crate) async fn agent_session_timeline(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<ApiResponse> {
    let authority = match timeline_transport_authority(&state, &session_id, &headers) {
        Ok(authority) => authority,
        Err(response) => return response,
    };
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let _io_guard = session_private_io_lock(&session_id).read_owned().await;
    let empty_host_timeline = {
        let gui = state.gui.lock().expect("gui state lock");
        let session = match verified_selectable_session(&gui, &session_id) {
            Ok(session) => session,
            Err(response) => return response,
        };
        matches!(&authority, TimelineTransportAuthorityV2::HostViewer)
            .then(|| empty_timeline_for_verified_session(session, &session_id))
            .flatten()
    };
    match timeline_for_transport_authority(&state, &session_id, &authority) {
        Ok(Some(timeline)) => ApiResponse::ok(timeline),
        Ok(None) => match empty_host_timeline {
            Some(timeline) => ApiResponse::ok(timeline),
            None => ApiResponse::error(
                "agent_timeline_unavailable",
                "Session v3 public timeline is not available",
            ),
        },
        Err(error) => ApiResponse::error(
            error.code,
            format!(
                "Session v3 public timeline is unavailable: {}",
                error.message
            ),
        ),
    }
}

fn empty_timeline_for_verified_session(session: &Value, session_id: &str) -> Option<Value> {
    if session.get("eventCount").and_then(Value::as_u64) != Some(0) {
        return None;
    }
    let timeline = json!({
        "schemaVersion": "deepcode.shared-conversation-projection.v4",
        "shapeVersion": "deepcode.shared-conversation.work-segments.v4",
        "sessionId": session_id,
        "revision": 0,
        "sourceEventVersion": 0,
        "generatedAt": "1970-01-01T00:00:00.000Z",
        "turns": [],
        "eventCount": 0
    });
    crate::session_public_projection_v2::validate_work_segments_shared_projection_timeline(
        &timeline,
    )
    .ok()?;
    Some(timeline)
}

fn timeline_for_transport_authority(
    state: &AppState,
    session_id: &str,
    authority: &TimelineTransportAuthorityV2,
) -> Result<Option<Value>, crate::host_v2_storage::HostV2StorageError> {
    match authority {
        TimelineTransportAuthorityV2::HostViewer => state
            .host_services
            .projection_v2
            .latest_timeline(session_id),
        TimelineTransportAuthorityV2::Run { run_id, capability } => {
            let active = state
                .host_services
                .active_runs_v2
                .resolve_session_active_run(session_id)?
                .ok_or_else(|| {
                    crate::host_v2_storage::HostV2StorageError::not_found(
                        "host_session_prior_timeline_run_missing",
                        "Run-bound prior Session timeline has no active Host Run",
                    )
                })?;
            if active.run_id != *run_id {
                return Err(crate::host_v2_storage::HostV2StorageError::conflict(
                    "host_session_prior_timeline_run_mismatch",
                    "Run-bound prior Session timeline does not match the active Host Run",
                ));
            }
            let bootstrap = state
                .host_services
                .kernel_operations_v2
                .get_bootstrap(session_id, &active.host_run_id)?;
            if bootstrap.run_id != *run_id || bootstrap.bootstrap_digest != active.bootstrap_digest
            {
                return Err(crate::host_v2_storage::HostV2StorageError::conflict(
                    "host_session_prior_timeline_bootstrap_mismatch",
                    "Run-bound prior Session timeline does not match the durable bootstrap",
                ));
            }
            bootstrap.prior_session_events.validate(session_id)?;
            state.host_services.projection_v2.frozen_prior_timeline(
                session_id,
                &active.host_run_id,
                run_id,
                capability,
                &bootstrap.prior_session_events,
            )
        }
    }
}

pub(crate) async fn agent_session_timeline_stream(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<AgentTimelineStreamQueryV2>,
    headers: axum::http::HeaderMap,
) -> Response {
    let authority = match timeline_transport_authority(&state, &session_id, &headers) {
        Ok(authority) => authority,
        Err(response) => return response.into_response(),
    };
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response.into_response();
    }
    {
        let gui = state.gui.lock().expect("gui state lock");
        if let Err(response) = verified_selectable_session(&gui, &session_id) {
            return response.into_response();
        }
    }

    let pinned_run_id = match resolve_timeline_stream_run_id(&state, &session_id, &authority).await
    {
        Ok(Some(run_id)) => run_id,
        Ok(None) => {
            return ApiResponse::error(
                "agent_timeline_unavailable",
                "Session v2 public timeline is not available",
            )
            .into_response()
        }
        Err(error) => return ApiResponse::error(error.code, error.message).into_response(),
    };
    {
        let _io_guard = session_private_io_lock(&session_id).read_owned().await;
        if let Err(error) = state
            .host_services
            .projection_v2
            .latest_timeline_for_run(&session_id, &pinned_run_id)
        {
            return ApiResponse::error(error.code, error.message).into_response();
        }
    }

    let stream_state = state.clone();
    let stream = async_stream::stream! {
        let mut cursor = RunPinnedTimelineStreamV2::new(pinned_run_id.clone(), query.after_revision);
        let mut heartbeat_at = Instant::now();
        loop {
            if !authority.is_authorized(
                &stream_state.host_services.active_runs_v2,
                &session_id,
            ) {
                if matches!(&authority, TimelineTransportAuthorityV2::Run { .. }) {
                    let terminal = {
                        let _io_guard = session_private_io_lock(&session_id).read_owned().await;
                        stream_state
                            .host_services
                            .projection_v2
                            .latest_timeline_for_run(&session_id, &pinned_run_id)
                    };
                    let terminal = match terminal {
                        Ok(terminal) => terminal,
                        Err(error) => {
                            yield Err::<bytes::Bytes, std::io::Error>(
                                std::io::Error::other(format!("{}: {}", error.code, error.message))
                            );
                            break;
                        }
                    };
                    if terminal.as_ref().is_some_and(timeline_is_terminal) {
                        if let RunPinnedTimelineStreamActionV2::Event {
                            name, payload, ..
                        } = cursor.observe(&session_id, terminal)
                        {
                            yield Ok::<bytes::Bytes, std::io::Error>(
                                timeline_sse_bytes(&name, payload)
                                    .expect("timeline SSE serialization is infallible")
                            );
                        }
                    }
                }
                break;
            }
            if crate::session_metadata_v2::session_metadata_unavailable_response(
                &stream_state,
            )
            .is_some()
            {
                break;
            }
            let session_selectable = {
                let gui = stream_state.gui.lock().expect("gui state lock");
                verified_selectable_session(&gui, &session_id).is_ok()
            };
            if !session_selectable {
                break;
            }
            let latest = {
                let _io_guard = session_private_io_lock(&session_id).read_owned().await;
                stream_state
                    .host_services
                    .projection_v2
                    .latest_timeline_for_run(&session_id, &pinned_run_id)
            };
            let latest = match latest {
                Ok(latest) => latest,
                Err(error) => {
                    yield Err::<bytes::Bytes, std::io::Error>(
                        std::io::Error::other(format!("{}: {}", error.code, error.message))
                    );
                    break;
                }
            };

            match cursor.observe(&session_id, latest) {
                RunPinnedTimelineStreamActionV2::Event {
                    name,
                    payload,
                    terminal,
                } => {
                    yield Ok::<bytes::Bytes, std::io::Error>(
                        timeline_sse_bytes(&name, payload)
                            .expect("timeline SSE serialization is infallible")
                    );
                    if terminal {
                        break;
                    }
                }
                RunPinnedTimelineStreamActionV2::Wait => {}
                RunPinnedTimelineStreamActionV2::Close => break,
            }

            if heartbeat_at.elapsed() >= Duration::from_secs(10) {
                heartbeat_at = Instant::now();
                yield Ok::<bytes::Bytes, std::io::Error>(
                    bytes::Bytes::from_static(b": heartbeat\n\n")
                );
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
            (
                header::HeaderName::from_static("x-content-type-options"),
                "nosniff",
            ),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

async fn resolve_timeline_stream_run_id(
    state: &AppState,
    session_id: &str,
    authority: &TimelineTransportAuthorityV2,
) -> Result<Option<String>, crate::host_v2_storage::HostV2StorageError> {
    match authority {
        TimelineTransportAuthorityV2::Run { run_id, .. } => Ok(Some(run_id.clone())),
        TimelineTransportAuthorityV2::HostViewer => {
            let _io_guard = session_private_io_lock(session_id).read_owned().await;
            match state
                .host_services
                .active_runs_v2
                .resolve_session_active_run(session_id)
            {
                Ok(Some(active)) => Ok(Some(active.run_id)),
                Ok(None) => state
                    .host_services
                    .projection_v2
                    .latest_timeline(session_id)
                    .map(|timeline| {
                        timeline
                            .and_then(|timeline| timeline_run_id(&timeline).map(ToOwned::to_owned))
                    }),
                Err(error) => Err(error),
            }
        }
    }
}

fn timeline_transport_authority(
    state: &AppState,
    session_id: &str,
    headers: &axum::http::HeaderMap,
) -> Result<TimelineTransportAuthorityV2, Json<ApiResponse>> {
    if state.host_shell_authority.authorize(headers) {
        return Ok(TimelineTransportAuthorityV2::HostViewer);
    }
    let run_id = headers
        .get("x-deepcode-run-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiResponse::error(
                "host_run_transport_capability_required",
                "Session timeline requires Host authority or an active Run transport binding",
            )
        })?;
    let capability = headers
        .get(crate::kernel_v2_transport::RUN_TRANSPORT_CAPABILITY_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| RunCapabilityV2::new(value.to_string()).ok())
        .ok_or_else(|| {
            ApiResponse::error(
                "host_run_transport_capability_required",
                "Session timeline requires Host authority or an active Run transport binding",
            )
        })?;
    state
        .host_services
        .active_runs_v2
        .authorize_session_run_transport(session_id, run_id, &capability)
        .map_err(|error| ApiResponse::error(error.code, error.message))?;
    Ok(TimelineTransportAuthorityV2::Run {
        run_id: run_id.to_string(),
        capability,
    })
}

impl TimelineTransportAuthorityV2 {
    fn is_authorized(
        &self,
        active_runs: &crate::host_run_broker_v2::HostActiveRunBrokerV2,
        session_id: &str,
    ) -> bool {
        match self {
            // Host authority is daemon-scoped and cannot be retired without
            // terminating this stream's owning process.
            Self::HostViewer => true,
            Self::Run { run_id, capability } => active_runs
                .authorize_session_run_transport(session_id, run_id, capability)
                .is_ok(),
        }
    }
}

fn timeline_snapshot_event(session_id: &str, revision: u64, snapshot: &Value) -> Value {
    json!({
        "type": "snapshot",
        "sessionId": session_id,
        "revision": revision,
        "snapshot": snapshot
    })
}

fn create_timeline_delta(base: &Value, next: &Value) -> Result<Value, String> {
    let base_revision = timeline_u64_field(base, "revision")?;
    let revision = timeline_u64_field(next, "revision")?;
    let base_source_version = timeline_u64_field(base, "sourceEventVersion")?;
    let source_event_version = timeline_u64_field(next, "sourceEventVersion")?;
    let base_event_count = timeline_u64_field(base, "eventCount")?;
    let event_count = timeline_u64_field(next, "eventCount")?;
    if revision <= base_revision
        || source_event_version <= base_source_version
        || event_count <= base_event_count
    {
        return Err("timeline delta versions must advance".to_string());
    }
    let session_id = next
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "timeline sessionId is missing".to_string())?;
    if base.get("sessionId").and_then(Value::as_str) != Some(session_id) {
        return Err("timeline delta belongs to another Session".to_string());
    }
    let next_turns = next
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| "timeline turns are missing".to_string())?;
    let base_turns = base
        .get("turns")
        .and_then(Value::as_array)
        .ok_or_else(|| "timeline turns are missing".to_string())?;
    let mut base_by_id = HashMap::new();
    for turn in base_turns {
        let id = turn
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "timeline turn id is missing".to_string())?;
        if base_by_id.insert(id, turn).is_some() {
            return Err("timeline repeats a turn id".to_string());
        }
    }
    let mut next_ids = std::collections::HashSet::new();
    let mut replacements = Vec::new();
    let mut operations = Vec::new();
    for turn in next_turns {
        let id = turn
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "timeline turn id is missing".to_string())?;
        if !next_ids.insert(id) {
            return Err("timeline repeats a turn id".to_string());
        }
        if let Some(before) = base_by_id.get(id).copied() {
            if before != turn {
                if let Some(append) = exact_timeline_text_append_v3(before, turn) {
                    operations.push(json!({
                        "kind": "text.append",
                        "append": append,
                    }));
                } else {
                    replacements.push(turn.clone());
                }
            }
        } else {
            replacements.push(turn.clone());
        }
    }
    let removed = base_by_id
        .keys()
        .filter(|id| !next_ids.contains(**id))
        .map(|id| Value::String((*id).to_string()))
        .collect::<Vec<_>>();
    let mut root_replacements = serde_json::Map::new();
    for key in [
        "taskProjection",
        "interactionProjection",
        "tokenUsageProjection",
        "workspaceProjection",
    ] {
        if base.get(key) != next.get(key) {
            root_replacements.insert(
                key.to_string(),
                next.get(key).cloned().unwrap_or(Value::Null),
            );
        }
    }
    if base.get("runProjection") != next.get("runProjection") {
        operations.push(json!({
            "kind": "run.updated",
            "runProjection": next.get("runProjection").cloned().unwrap_or(Value::Null),
        }));
    }
    Ok(json!({
        "schemaVersion": next.get("schemaVersion").cloned().unwrap_or(Value::Null),
        "shapeVersion": next.get("shapeVersion").cloned().unwrap_or(Value::Null),
        "sessionId": session_id,
        "baseRevision": base_revision,
        "revision": revision,
        "sourceEventVersion": source_event_version,
        "generatedAt": next.get("generatedAt").cloned().unwrap_or(Value::Null),
        "eventCount": event_count,
        "turnReplacements": replacements,
        "removedTurnIds": removed,
        "operations": operations,
        "rootReplacements": root_replacements,
    }))
}

fn exact_timeline_text_append_v3(before: &Value, after: &Value) -> Option<Value> {
    let mut before_without_blocks = before.as_object()?.clone();
    let mut after_without_blocks = after.as_object()?.clone();
    let before_blocks = before_without_blocks.remove("blocks")?.as_array()?.clone();
    let after_blocks = after_without_blocks.remove("blocks")?.as_array()?.clone();
    if before_without_blocks != after_without_blocks || before_blocks.len() != after_blocks.len() {
        return None;
    }
    let turn_id = before.get("id")?.as_str()?;
    let mut append = None;
    for (previous, next) in before_blocks.iter().zip(after_blocks.iter()) {
        if previous == next {
            continue;
        }
        if append.is_some() {
            return None;
        }
        append = exact_timeline_block_text_append_v3(turn_id, previous, next);
        append.as_ref()?;
    }
    append
}

fn exact_timeline_block_text_append_v3(
    turn_id: &str,
    before: &Value,
    after: &Value,
) -> Option<Value> {
    let before_object = before.as_object()?;
    let after_object = after.as_object()?;
    let block_id = before_object.get("id")?.as_str()?;
    if after_object.get("id")?.as_str()? != block_id
        || before_object.get("kind")?.as_str()? != "assistant"
        || after_object.get("kind")?.as_str()? != "assistant"
        || before_object.get("narrativeKind")?.as_str()? != "assistantText"
        || after_object.get("narrativeKind")?.as_str()? != "assistantText"
    {
        return None;
    }
    let base_revision = before_object.get("revision")?.as_u64()?;
    let block_revision = after_object.get("revision")?.as_u64()?;
    if base_revision == 0 || base_revision.checked_add(1)? != block_revision {
        return None;
    }
    let before_summary = before_object.get("summary")?.as_str()?;
    let after_summary = after_object.get("summary")?.as_str()?;
    let before_body = before_object
        .get("bodyMarkdown")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let after_body = after_object
        .get("bodyMarkdown")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !after_summary.starts_with(before_summary)
        || !after_body.starts_with(before_body)
        || after_body.len() == before_body.len()
        || after_summary[before_summary.len()..] != after_body[before_body.len()..]
    {
        return None;
    }
    let before_refs = before_object
        .get("provenance")?
        .get("sourceEventRefs")?
        .as_array()?;
    let after_refs = after_object
        .get("provenance")?
        .get("sourceEventRefs")?
        .as_array()?;
    if after_refs.len() <= before_refs.len()
        || before_refs
            .iter()
            .zip(after_refs.iter())
            .any(|(left, right)| left != right)
    {
        return None;
    }
    let new_refs = after_refs[before_refs.len()..].to_vec();
    let mut unique = std::collections::HashSet::new();
    if after_refs.iter().any(|value| {
        value
            .as_str()
            .filter(|value| !value.is_empty())
            .is_none_or(|value| !unique.insert(value))
    }) {
        return None;
    }
    let mut normalized = after_object.clone();
    normalized.insert("revision".to_string(), json!(base_revision));
    normalized.insert("summary".to_string(), json!(before_summary));
    if before_object.contains_key("bodyMarkdown") {
        normalized.insert("bodyMarkdown".to_string(), json!(before_body));
    } else {
        normalized.remove("bodyMarkdown");
    }
    let mut provenance = normalized.get("provenance")?.as_object()?.clone();
    provenance.insert(
        "sourceEventRefs".to_string(),
        Value::Array(before_refs.clone()),
    );
    normalized.insert("provenance".to_string(), Value::Object(provenance));
    if Value::Object(normalized) != *before {
        return None;
    }
    Some(json!({
        "turnId": turn_id,
        "blockId": block_id,
        "baseBlockRevision": base_revision,
        "blockRevision": block_revision,
        "textDelta": &after_body[before_body.len()..],
        "sourceEventRefs": new_refs,
    }))
}

fn timeline_u64_field(value: &Value, field: &str) -> Result<u64, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("Session timeline {field} is invalid"))
}

fn timeline_run_id(value: &Value) -> Option<&str> {
    value
        .get("runProjection")
        .and_then(|run| run.get("runId"))
        .and_then(Value::as_str)
}

fn timeline_is_terminal(value: &Value) -> bool {
    matches!(
        value
            .get("runProjection")
            .and_then(|run| run.get("status"))
            .and_then(Value::as_str),
        Some("succeeded" | "failed" | "cancelled")
    )
}

fn timeline_sse_bytes(
    event: &str,
    payload: Value,
) -> Result<bytes::Bytes, std::convert::Infallible> {
    let data = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    Ok(bytes::Bytes::from(format!(
        "event: {event}\ndata: {data}\n\n"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_run_broker_v2::{
        HostActiveRunBrokerV2, HostActiveRunRegistrationV2, HostRunSettingsCeilingV2,
        HostRunWorkspaceKindV2,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static TIMELINE_TEST_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    struct TimelineTestRoot {
        path: PathBuf,
    }

    impl TimelineTestRoot {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock after Unix epoch")
                .as_nanos();
            let sequence = TIMELINE_TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "deepcode-run-pinned-timeline-{}-{timestamp}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test-owned timeline root");
            let path = fs::canonicalize(path).expect("canonicalize test-owned timeline root");
            Self { path }
        }
    }

    impl Drop for TimelineTestRoot {
        fn drop(&mut self) {
            match fs::remove_dir_all(&self.path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) if std::thread::panicking() => eprintln!(
                    "failed to remove test-owned timeline root {} during panic: {error}",
                    self.path.display()
                ),
                Err(error) => panic!(
                    "remove test-owned timeline root {}: {error}",
                    self.path.display()
                ),
            }
        }
    }

    fn timeline_snapshot(session_id: &str, run_id: &str, revision: u64, status: &str) -> Value {
        let phase = if status == "succeeded" {
            "settled"
        } else {
            "processing"
        };
        json!({
            "schemaVersion": "deepcode.shared-conversation-projection.v2",
            "shapeVersion": "deepcode.shared-conversation.work-segments.v2",
            "sessionId": session_id,
            "revision": revision,
            "sourceEventVersion": revision,
            "generatedAt": "2026-08-05T00:00:00Z",
            "eventCount": revision,
            "turns": [],
            "runProjection": {
                "runId": run_id,
                "revision": revision,
                "status": status,
                "phase": phase,
                "currentActivity": null,
                "wait": null,
                "languageBinding": {
                    "language": "neutral",
                    "status": "unavailable"
                }
            }
        })
    }

    fn sse_bytes_for_action(action: RunPinnedTimelineStreamActionV2) -> Option<(bool, Vec<u8>)> {
        match action {
            RunPinnedTimelineStreamActionV2::Event {
                name,
                payload,
                terminal,
            } => Some((
                terminal,
                timeline_sse_bytes(&name, payload)
                    .expect("timeline SSE serialization is infallible")
                    .to_vec(),
            )),
            RunPinnedTimelineStreamActionV2::Wait | RunPinnedTimelineStreamActionV2::Close => None,
        }
    }

    #[tokio::test]
    async fn run_pinned_timeline_stream_emits_terminal_once_without_following_new_run() {
        let root = TimelineTestRoot::new();
        let session_id = "session-run-pinned-stream";
        let host_run_id = "host-run-pinned-stream";
        let old_run_id = "run-old-pinned-stream";
        let new_run_id = "run-new-must-remain-invisible";
        let correct_capability =
            RunCapabilityV2::new("timeline-correct-capability-0123456789abcdef".to_string())
                .expect("valid correct Run capability");
        let wrong_capability =
            RunCapabilityV2::new("timeline-wrong-capability-0123456789abcdef".to_string())
                .expect("valid wrong Run capability");
        let broker =
            HostActiveRunBrokerV2::new(root.path.clone()).expect("create test active-run broker");
        let turn = broker
            .begin_session_turn(session_id)
            .await
            .expect("begin test Session turn");
        broker
            .register(
                &turn,
                HostActiveRunRegistrationV2 {
                    session_id: session_id.to_string(),
                    host_run_id: host_run_id.to_string(),
                    run_id: old_run_id.to_string(),
                    bootstrap_digest: format!("sha256:{}", "1".repeat(64)),
                    workspace_binding_ref: "workspace-ref-run-pinned-stream".to_string(),
                    workspace_binding_digest: format!("sha256:{}", "2".repeat(64)),
                    workspace_binding_identity: "workspace-identity-run-pinned-stream".to_string(),
                    workspace_kind: HostRunWorkspaceKindV2::Bound,
                    active_folder_id: Some("folder-run-pinned-stream".to_string()),
                    empty_workspace_key: None,
                    initial_input_id: "input-run-pinned-stream".to_string(),
                    initial_opaque_input_ref: "opaque-input-run-pinned-stream".to_string(),
                    run_settings: HostRunSettingsCeilingV2 {
                        workspace_read: true,
                        workspace_write: false,
                        web_read: false,
                        auto_approve_plans: false,
                    },
                    recorded_at: "2026-08-03T00:00:00Z".to_string(),
                },
                Some(&root.path),
            )
            .expect("register test active Run");
        broker
            .bind_run_transport_capability(&turn, host_run_id, old_run_id, &correct_capability)
            .expect("bind exact test Run capability");

        let correct_authority = TimelineTransportAuthorityV2::Run {
            run_id: old_run_id.to_string(),
            capability: correct_capability,
        };
        let wrong_authority = TimelineTransportAuthorityV2::Run {
            run_id: old_run_id.to_string(),
            capability: wrong_capability,
        };
        assert!(correct_authority.is_authorized(&broker, session_id));
        assert!(!wrong_authority.is_authorized(&broker, session_id));

        let mut cursor = RunPinnedTimelineStreamV2::new(old_run_id.to_string(), None);
        let first = sse_bytes_for_action(cursor.observe(
            session_id,
            Some(timeline_snapshot(session_id, old_run_id, 1, "running")),
        ))
        .expect("first pinned snapshot emits SSE bytes");
        let terminal = sse_bytes_for_action(cursor.observe(
            session_id,
            Some(timeline_snapshot(session_id, old_run_id, 2, "succeeded")),
        ))
        .expect("old Run terminal emits SSE bytes");
        assert!(!first.0, "first SSE event must remain non-terminal");
        assert!(terminal.0, "terminal SSE event must close the stream");
        let first_text = std::str::from_utf8(&first.1).expect("first SSE bytes are UTF-8");
        let terminal_text = std::str::from_utf8(&terminal.1).expect("terminal SSE bytes are UTF-8");
        assert!(first_text.starts_with("event: snapshot\ndata: "));
        assert!(first_text.ends_with("\n\n"));
        assert!(first_text.contains(&format!("\"runId\":\"{old_run_id}\"")));
        assert!(first_text.contains("\"status\":\"running\""));
        assert!(terminal_text.starts_with("event: delta\ndata: "));
        assert!(terminal_text.ends_with("\n\n"));
        assert!(terminal_text.contains(&format!("\"runId\":\"{old_run_id}\"")));
        assert!(terminal_text.contains("\"status\":\"succeeded\""));
        assert_eq!(
            [first_text, terminal_text]
                .into_iter()
                .filter(|event| event.contains("\"status\":\"succeeded\""))
                .count(),
            1,
            "old Run terminal must appear in exactly one SSE event"
        );

        assert!(sse_bytes_for_action(cursor.observe(
            session_id,
            Some(timeline_snapshot(session_id, old_run_id, 2, "succeeded")),
        ))
        .is_none());
        assert!(sse_bytes_for_action(cursor.observe(
            session_id,
            Some(timeline_snapshot(session_id, new_run_id, 3, "running")),
        ))
        .is_none());

        let mut mismatch_cursor = RunPinnedTimelineStreamV2::new(old_run_id.to_string(), None);
        assert!(sse_bytes_for_action(mismatch_cursor.observe(
            session_id,
            Some(timeline_snapshot(session_id, new_run_id, 1, "running")),
        ))
        .is_none());
        assert!(!first_text.contains(new_run_id));
        assert!(!terminal_text.contains(new_run_id));

        drop(turn);
        drop(broker);
        let root_path = root.path.clone();
        drop(root);
        assert!(!root_path.exists(), "test-owned timeline root remains");
    }
}
