use crate::prelude::*;
use crate::*;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionScopeQuery {
    pub(crate) project_id: Option<String>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) workspace_hash: Option<String>,
    pub(crate) include_archived: Option<bool>,
    pub(crate) include_all_scopes: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionRunRequest {
    pub(crate) op: Option<String>,
    pub(crate) content: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) attachments: Option<Vec<Value>>,
    pub(crate) workspace_path: Option<String>,
    pub(crate) no_workspace: Option<bool>,
    pub(crate) workflow: Option<String>,
    pub(crate) requirement_confirmation_mode: Option<String>,
    pub(crate) review_continuation_mode: Option<String>,
    pub(crate) intervention_level: Option<String>,
    pub(crate) autonomy_mode: Option<String>,
    pub(crate) project_memory_mode: Option<Value>,
    pub(crate) title: Option<String>,
    pub(crate) decision_kind: Option<String>,
    pub(crate) decision: Option<String>,
    pub(crate) guidance: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) target_id: Option<String>,
    pub(crate) interaction_id: Option<String>,
    pub(crate) interaction_revision: Option<String>,
    pub(crate) decision_request_id: Option<String>,
    pub(crate) review_id: Option<String>,
    pub(crate) host_language: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRunStreamQuery {
    pub(crate) since_event_count: Option<usize>,
    pub(crate) since_delta_seq: Option<u64>,
}

enum InteractionAdmission {
    NotRequired,
    Claimed,
    AlreadyClaimed(String),
}

fn interaction_admission_lock() -> &'static std::sync::Mutex<()> {
    static ADMISSION_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    ADMISSION_LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn session_run_start_admission_lock(session_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::sync::{Arc, Mutex, OnceLock, Weak};

    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().expect("Session run start lock registry");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(session_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(session_id.to_string(), Arc::downgrade(&lock));
    lock
}

fn new_session_host_run_id() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let sequence = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("session-run-{}-{sequence}", now_millis())
}

fn active_session_run_id(state: &AppState, session_id: &str) -> Option<String> {
    let runs = state.session_runs.lock().expect("session run state lock");
    runs.values()
        .find(|run| run.session_id == session_id && run_status_active(&run.status))
        .map(|run| run.run_id.clone())
}

fn claimed_run_for_decision_request(
    state: &AppState,
    session_id: &str,
    decision_request_id: &str,
) -> Result<Option<String>, InteractionAdmissionError> {
    let mut matching_run_id = None;
    for event in session_projection(state, session_id) {
        if event.get("kind").and_then(Value::as_str) != Some("session_interaction_claim")
            || event
                .pointer("/payload/decisionRequestId")
                .and_then(Value::as_str)
                != Some(decision_request_id)
        {
            continue;
        }
        let run_id = event
            .pointer("/payload/admittedRunId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| InteractionAdmissionError {
                code: "session_append_recovery_required",
                message: "the original decision claim has no durable admittedRunId".to_string(),
            })?;
        if matching_run_id
            .as_deref()
            .is_some_and(|existing| existing != run_id)
        {
            return Err(InteractionAdmissionError {
                code: "session_append_recovery_required",
                message: "one decisionRequestId is bound to multiple durable claimant runs"
                    .to_string(),
            });
        }
        matching_run_id = Some(run_id.to_string());
    }
    Ok(matching_run_id)
}

struct InteractionAdmissionError {
    code: &'static str,
    message: String,
}

fn required_interaction_field<'a>(
    value: Option<&'a String>,
    field: &'static str,
) -> Result<&'a str, InteractionAdmissionError> {
    value
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| InteractionAdmissionError {
            code: "session_interaction_identity_required",
            message: format!("decision admission requires {field}"),
        })
}

fn claim_interaction_decision(
    state: &AppState,
    session_id: &str,
    admitted_run_id: &str,
    body: &AgentSessionRunRequest,
    host_language: &str,
    mut admission_events: Vec<Value>,
) -> Result<InteractionAdmission, InteractionAdmissionError> {
    let Some(decision_kind) = body.decision_kind.as_deref() else {
        return Ok(InteractionAdmission::NotRequired);
    };
    if decision_kind == "boundary" {
        return Ok(InteractionAdmission::NotRequired);
    }
    if !matches!(
        decision_kind,
        "requirement" | "plan" | "review" | "permission"
    ) {
        return Err(InteractionAdmissionError {
            code: "session_interaction_kind_invalid",
            message: "unsupported Session interaction kind".to_string(),
        });
    }
    if !matches!(
        body.decision.as_deref(),
        Some("accept" | "reject" | "revise")
    ) {
        return Err(InteractionAdmissionError {
            code: "session_interaction_decision_invalid",
            message: "unsupported Session interaction decision".to_string(),
        });
    }
    if decision_kind == "permission" && body.decision.as_deref() == Some("revise") {
        return Err(InteractionAdmissionError {
            code: "session_permission_revision_unsupported",
            message:
                "Permission requests only support accept or reject; revise is rejected before claim admission"
                    .to_string(),
        });
    }
    let interaction_id = required_interaction_field(body.interaction_id.as_ref(), "interactionId")?;
    let interaction_revision =
        required_interaction_field(body.interaction_revision.as_ref(), "interactionRevision")?;
    let target_id = required_interaction_field(body.target_id.as_ref(), "targetId")?;
    let decision_request_id =
        required_interaction_field(body.decision_request_id.as_ref(), "decisionRequestId")?;
    let review_id = if decision_kind == "review" {
        Some(required_interaction_field(
            body.review_id.as_ref(),
            "reviewId",
        )?)
    } else {
        None
    };

    let mut events = session_projection(state, session_id);
    let mut recoverable_claimant_run_id = None;
    for event in events.iter().rev() {
        if event.get("kind").and_then(Value::as_str) != Some("session_interaction_claim") {
            continue;
        }
        let payload = event.get("payload").unwrap_or(&Value::Null);
        if payload.get("decisionRequestId").and_then(Value::as_str) == Some(decision_request_id) {
            let original_run_id = payload
                .get("admittedRunId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| InteractionAdmissionError {
                    code: "session_append_recovery_required",
                    message: "the original decision claim has no durable admittedRunId".to_string(),
                })?
                .to_string();
            return Ok(InteractionAdmission::AlreadyClaimed(original_run_id));
        }
        if payload.get("interactionRevision").and_then(Value::as_str) == Some(interaction_revision)
        {
            let claimed_run_id = payload
                .get("admittedRunId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let claimed_run_status = {
                let runs = state.session_runs.lock().expect("session run state lock");
                runs.get(claimed_run_id)
                    .map(|run| run.status.as_str().to_string())
            };
            if !matches!(
                claimed_run_status.as_deref(),
                None | Some("failed" | "cancelled")
            ) {
                return Err(InteractionAdmissionError {
                    code: "session_interaction_already_claimed",
                    message: "the pending interaction was already admitted by another decision"
                        .to_string(),
                });
            }
            recoverable_claimant_run_id = Some(claimed_run_id.to_string());
            break;
        }
    }
    if let Some(recoverable_run_id) = recoverable_claimant_run_id {
        admit_session_release_interaction_claim(state, session_id, &recoverable_run_id).map_err(
            |error| InteractionAdmissionError {
                code: error.code,
                message: error.message,
            },
        )?;
        admit_session_terminal_close(
            state,
            session_id,
            &recoverable_run_id,
            "failed",
            Some("session_interaction_claim_abandoned"),
            Some("The prior interaction claimant stopped before durable settlement."),
        )
        .map_err(|error| InteractionAdmissionError {
            code: error.code,
            message: error.message,
        })?;
        events = session_projection(state, session_id);
    }

    let timeline =
        session_timeline(state, session_id).ok_or_else(|| InteractionAdmissionError {
            code: "session_interaction_projection_unavailable",
            message: "the canonical Session projection is unavailable".to_string(),
        })?;
    validate_shared_projection_commit(&timeline, session_id, &events).map_err(|message| {
        InteractionAdmissionError {
            code: if timeline.get("schemaVersion").and_then(Value::as_str)
                == Some("deepcode.shared-conversation-projection.v2")
            {
                "session_interaction_projection_stale"
            } else {
                "session_interaction_legacy_read_only"
            },
            message,
        }
    })?;
    let pending = timeline
        .pointer("/interactionProjection/pending")
        .filter(|value| value.is_object())
        .ok_or_else(|| InteractionAdmissionError {
            code: "session_interaction_stale",
            message: "there is no pending interaction to resolve".to_string(),
        })?;
    let identity_matches = pending.get("kind").and_then(Value::as_str) == Some(decision_kind)
        && pending.get("interactionId").and_then(Value::as_str) == Some(interaction_id)
        && pending.get("interactionRevision").and_then(Value::as_str) == Some(interaction_revision)
        && pending.get("targetId").and_then(Value::as_str) == Some(target_id)
        && review_id.map_or(true, |review_id| {
            pending.get("reviewId").and_then(Value::as_str) == Some(review_id)
        });
    if !identity_matches {
        return Err(InteractionAdmissionError {
            code: "session_interaction_stale",
            message: "the submitted interaction identity is no longer pending".to_string(),
        });
    }
    let turn_authority_ref =
        pending_interaction_turn_authority_ref(&timeline, pending, &events, session_id)?;
    let guidance = body
        .guidance
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    admission_events.push(agent_event(
        session_id,
        "session_interaction_claim",
        json!({
            "interactionId": interaction_id,
            "interactionRevision": interaction_revision,
            "targetId": target_id,
            "reviewId": review_id,
            "decisionKind": decision_kind,
            "decision": body.decision,
            "guidance": guidance,
            "hasFreeText": guidance.is_some(),
            "hostLanguage": host_language,
            "turnAuthorityRef": turn_authority_ref,
            "decisionRequestId": decision_request_id,
            "admittedRunId": admitted_run_id,
            "status": "claimed",
            "channel": "task",
            "visibility": "hidden",
            "presentation": "traceOnly"
        }),
        &now_text(),
    ));
    admit_session_interaction_claim(
        state,
        session_id,
        admitted_run_id,
        decision_request_id,
        interaction_id,
        interaction_revision,
        target_id,
        admission_events,
    )
    .map_err(|error| InteractionAdmissionError {
        code: error.code,
        message: error.message,
    })?;
    Ok(InteractionAdmission::Claimed)
}

fn pending_interaction_turn_authority_ref(
    timeline: &Value,
    pending: &Value,
    events: &[Value],
    session_id: &str,
) -> Result<String, InteractionAdmissionError> {
    let block_id = pending
        .get("blockId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| InteractionAdmissionError {
            code: "session_interaction_projection_stale",
            message: "pending interaction has no canonical block identity".to_string(),
        })?;
    let matching_blocks = timeline
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|turn| {
            turn.get("blocks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|block| block.get("id").and_then(Value::as_str) == Some(block_id))
        .collect::<Vec<_>>();
    if matching_blocks.len() != 1 {
        return Err(InteractionAdmissionError {
            code: "session_interaction_projection_stale",
            message: "pending interaction does not resolve one canonical projection block"
                .to_string(),
        });
    }
    let source_refs = matching_blocks[0]
        .pointer("/provenance/sourceEventRefs")
        .and_then(Value::as_array)
        .ok_or_else(|| InteractionAdmissionError {
            code: "session_interaction_projection_stale",
            message: "pending interaction block has no provenance source events".to_string(),
        })?;
    let events_by_id = events
        .iter()
        .filter_map(|event| {
            event
                .get("id")
                .and_then(Value::as_str)
                .map(|event_id| (event_id, event))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut authority_refs = std::collections::HashSet::new();
    for source_ref in source_refs.iter().filter_map(Value::as_str) {
        let event_id = source_ref.strip_prefix("event:").unwrap_or(source_ref);
        let Some(event) = events_by_id.get(event_id) else {
            continue;
        };
        if event.get("kind").and_then(Value::as_str) == Some("session_turn_authority") {
            authority_refs.insert(event_id.to_string());
        }
        if let Some(authority_ref) = event
            .pointer("/payload/lineage/turnAuthorityRef")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            authority_refs.insert(authority_ref.to_string());
        }
    }
    if authority_refs.len() != 1 {
        return Err(InteractionAdmissionError {
            code: "session_interaction_projection_stale",
            message: "pending interaction provenance does not resolve one exact turn authority"
                .to_string(),
        });
    }
    let authority_ref = authority_refs
        .into_iter()
        .next()
        .expect("one authority ref");
    let authority_event =
        events_by_id
            .get(authority_ref.as_str())
            .ok_or_else(|| InteractionAdmissionError {
                code: "session_interaction_projection_stale",
                message: "pending interaction authority event is not durable".to_string(),
            })?;
    let expected_run_id = pending
        .get("runId")
        .or_else(|| pending.pointer("/request/runId"))
        .and_then(Value::as_str);
    let authority_matches = authority_event.get("kind").and_then(Value::as_str)
        == Some("session_turn_authority")
        && authority_event.get("sessionId").and_then(Value::as_str) == Some(session_id)
        && authority_event
            .pointer("/payload/schemaVersion")
            .and_then(Value::as_str)
            == Some("deepcode.session.turn-authority.v2")
        && authority_event
            .pointer("/payload/sessionId")
            .and_then(Value::as_str)
            == Some(session_id)
        && expected_run_id.is_none_or(|run_id| {
            authority_event
                .pointer("/payload/runId")
                .and_then(Value::as_str)
                == Some(run_id)
        });
    if !authority_matches {
        return Err(InteractionAdmissionError {
            code: "session_interaction_projection_stale",
            message: "pending interaction authority does not match its canonical identity"
                .to_string(),
        });
    }
    Ok(authority_ref)
}

async fn await_session_run_bootstrap(
    state: &AppState,
    session_id: &str,
    run_id: &str,
    grant: &SessionRunBootstrapGrant,
) -> Result<(), InteractionAdmissionError> {
    let timeout_ms = std::env::var("DEEPCODE_SESSION_BOOTSTRAP_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(10_000)
        .clamp(100, 60_000);
    let started = Instant::now();
    loop {
        match observe_session_run_bootstrap(state, session_id, run_id, &grant.token) {
            SessionRunBootstrapObservation::Committed { .. } => {
                clear_session_run_bootstrap(state, session_id, run_id, &grant.token);
                return Ok(());
            }
            SessionRunBootstrapObservation::Revoked { reason } => {
                clear_session_run_bootstrap(state, session_id, run_id, &grant.token);
                return Err(InteractionAdmissionError {
                    code: "session_run_bootstrap_failed",
                    message: reason,
                });
            }
            SessionRunBootstrapObservation::Missing => {
                return Err(InteractionAdmissionError {
                    code: "session_append_recovery_required",
                    message:
                        "Run bootstrap admission disappeared before its durable acknowledgement"
                            .to_string(),
                })
            }
            SessionRunBootstrapObservation::Pending => {}
        }

        let terminal = {
            let runs = state.session_runs.lock().expect("session run state lock");
            runs.get(run_id)
                .filter(|run| run.session_id == session_id)
                .filter(|run| run_status_terminal(&run.status))
                .map(|run| {
                    run.message
                        .clone()
                        .unwrap_or_else(|| format!("Run stopped with status {}", run.status))
                })
        };
        if let Some(message) = terminal {
            let outcome =
                revoke_session_run_bootstrap(state, session_id, run_id, &grant.token, &message)
                    .map_err(|error| InteractionAdmissionError {
                        code: error.code,
                        message: error.message,
                    })?;
            if matches!(outcome, SessionRunBootstrapObservation::Committed { .. }) {
                clear_session_run_bootstrap(state, session_id, run_id, &grant.token);
                return Ok(());
            }
            clear_session_run_bootstrap(state, session_id, run_id, &grant.token);
            return Err(InteractionAdmissionError {
                code: "session_run_bootstrap_failed",
                message,
            });
        }
        if started.elapsed() >= Duration::from_millis(timeout_ms) {
            let message = format!("Run did not durably bootstrap within {timeout_ms} ms");
            let outcome =
                revoke_session_run_bootstrap(state, session_id, run_id, &grant.token, &message)
                    .map_err(|error| InteractionAdmissionError {
                        code: error.code,
                        message: error.message,
                    })?;
            if matches!(outcome, SessionRunBootstrapObservation::Committed { .. }) {
                clear_session_run_bootstrap(state, session_id, run_id, &grant.token);
                return Ok(());
            }
            {
                let mut runs = state.session_runs.lock().expect("session run state lock");
                if let Some(run) = runs
                    .get_mut(run_id)
                    .filter(|run| run.session_id == session_id)
                    .filter(|run| !run_status_terminal(&run.status))
                {
                    run.status = "cancelling".to_string();
                    run.updated_at = now_text();
                    run.message = Some(message.clone());
                }
            }
            clear_session_run_bootstrap(state, session_id, run_id, &grant.token);
            return Err(InteractionAdmissionError {
                code: "session_run_bootstrap_failed",
                message,
            });
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn durable_session_run_response(
    state: &AppState,
    session_id: &str,
    run_id: &str,
) -> Json<ApiResponse> {
    let outcome = match durable_session_run_outcome(state, session_id, run_id) {
        Ok(outcome) => outcome,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let Some((session, events)) = session_payload(state, session_id) else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    let run = AgentRunState {
        run_id: run_id.to_string(),
        session_id: session_id.to_string(),
        profile_id: None,
        status: outcome.status,
        start_event_count: 0,
        started_at: outcome.started_at,
        updated_at: outcome.completed_at.clone(),
        completed_at: Some(outcome.completed_at),
        message: outcome.message,
        final_text: outcome.final_text,
    };
    ApiResponse::ok(json!({
        "run": run,
        "session": session,
        "events": events
    }))
}

pub(crate) async fn agent_session_run_start(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<AgentSessionRunRequest>,
) -> Json<ApiResponse> {
    let Some((session, _events)) = session_payload(&state, &session_id) else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    if !session_schema_is_compatible(&session) {
        return incompatible_session_response();
    }
    if body.decision_kind.as_deref() == Some("boundary") {
        return ApiResponse::error(
            "session_interaction_kind_invalid",
            "boundary decision runs have no canonical caller and cannot open a new run",
        );
    }
    if body.run_id.is_some() && body.decision_kind.is_none() {
        return ApiResponse::error(
            "session_interaction_identity_required",
            "runId is only accepted as part of a canonical interaction decision",
        );
    }
    let run_start_lock = session_run_start_admission_lock(&session_id);
    let run_start_guard = run_start_lock.lock_owned().await;
    if let Err(error) = reconcile_session_run_recovery(&state, &session_id) {
        return ApiResponse::error(error.code, error.message);
    }
    if let Some(decision_request_id) = body
        .decision_request_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        match claimed_run_for_decision_request(&state, &session_id, decision_request_id) {
            Ok(Some(original_run_id)) => {
                if run_belongs_to_session(&state, &session_id, &original_run_id) {
                    return run_response(&state, &session_id, &original_run_id);
                }
                return durable_session_run_response(&state, &session_id, &original_run_id);
            }
            Ok(None) => {}
            Err(error) => return ApiResponse::error(error.code, error.message),
        }
    }
    if let Some(active_run_id) = active_session_run_id(&state, &session_id) {
        return ApiResponse::error(
            "session_run_already_active",
            format!(
                "Session already has active run {active_run_id}; send guidance to that run or wait for its canonical terminal state"
            ),
        );
    }
    let continuing_run = body.run_id.is_some() || body.decision_kind.is_some();
    let project_context = match authoritative_project_run_context(&state, &session, continuing_run)
    {
        Ok(context) => context,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    if !continuing_run {
        if let Some(context) = project_context.as_ref() {
            if let Some(binding) = context
                .get("workspaceBinding")
                .filter(|value| value.is_object())
            {
                let mut gui = state.gui.lock().expect("gui state lock");
                if let Some(stored_session) = session_mut(&mut gui, &session_id) {
                    stored_session["workspaceBinding"] = binding.clone();
                    apply_workspace_binding_to_session(stored_session, binding);
                    stored_session["updatedAt"] = json!(now_text());
                }
                if let Err(error) = persist_session_index(&gui) {
                    return ApiResponse::error("agent_session_persist_failed", error);
                }
            }
        }
    }
    let run_id = new_session_host_run_id();
    let profile_id = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let llm_profiles = gui.llm_profiles.clone();
        let Some(stored_session) = session_mut(&mut gui, &session_id) else {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        };
        let stored_profile_id = stored_session
            .get("profileId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let profile_id = stored_profile_id
            .as_deref()
            .filter(|profile_id| llm_profile_is_enabled(&llm_profiles, profile_id))
            .map(str::to_string)
            .or_else(|| preferred_enabled_llm_profile_id(&llm_profiles));
        let Some(profile_id) = profile_id else {
            return ApiResponse::error(
                "llm_profile_unavailable",
                "no enabled LLM Profile is available for this session",
            );
        };
        if stored_profile_id.as_deref() != Some(profile_id.as_str()) {
            stored_session["profileId"] = json!(profile_id.clone());
            stored_session["updatedAt"] = json!(now_text());
            if let Err(error) = persist_session_index(&gui) {
                return ApiResponse::error("agent_session_persist_failed", error);
            }
        }
        profile_id
    };
    let interaction_admission_guard = body
        .decision_kind
        .as_deref()
        .filter(|kind| *kind != "boundary")
        .map(|_| {
            interaction_admission_lock()
                .lock()
                .expect("interaction admission lock")
        });
    let (host_language, host_language_source) = normalize_host_language(
        body.host_language.as_deref(),
        user_setting_string(&state, "workbench.language"),
    );
    let host_fallback_events = if host_language_source == "request" {
        Vec::new()
    } else {
        vec![agent_event(
            &session_id,
            "workflow_stage",
            json!({
                "stage": "session.language.host_fallback",
                "status": "completed",
                "hostLanguage": host_language.clone(),
                "source": host_language_source,
                "channel": "progress",
                "visibility": "hidden",
                "presentation": "traceOnly"
            }),
            &now_text(),
        )]
    };
    let interaction_admission = match claim_interaction_decision(
        &state,
        &session_id,
        &run_id,
        &body,
        &host_language,
        host_fallback_events.clone(),
    ) {
        Ok(InteractionAdmission::AlreadyClaimed(original_run_id)) => {
            if !original_run_id.is_empty()
                && run_belongs_to_session(&state, &session_id, &original_run_id)
            {
                return run_response(&state, &session_id, &original_run_id);
            }
            return durable_session_run_response(&state, &session_id, &original_run_id);
        }
        Ok(admission) => admission,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let bootstrap_grant = if matches!(interaction_admission, InteractionAdmission::NotRequired) {
        match register_session_run_bootstrap(&state, &session_id, &run_id) {
            Ok(grant) => Some(grant),
            Err(error) => return ApiResponse::error(error.code, error.message),
        }
    } else {
        None
    };
    let events = session_projection(&state, &session_id);
    let start_event_count = events.len();
    let run = AgentRunState::running(
        run_id.clone(),
        session_id.clone(),
        profile_id.clone(),
        start_event_count,
    );
    {
        let mut runs = state.session_runs.lock().expect("session run state lock");
        runs.insert(run_id.clone(), run.clone());
    }
    let intervention_level = body
        .intervention_level
        .clone()
        .or_else(|| user_setting_string(&state, "agent.interventionLevel"))
        .or_else(|| Some("medium".to_string()));
    let project_memory_mode = normalize_project_memory_mode(
        body.project_memory_mode.clone(),
        user_setting_string(&state, "agent.memory.projectMode"),
    );
    let autonomy_mode = body
        .autonomy_mode
        .clone()
        .or_else(|| user_setting_string(&state, "agent.permissions.autonomyMode"))
        .unwrap_or_else(|| "strict".to_string());
    let request = host_bridge_request(
        &session_id,
        &run_id,
        &body,
        &profile_id,
        intervention_level,
        project_memory_mode,
        autonomy_mode,
        host_language,
        project_context.as_ref(),
        bootstrap_grant.as_ref(),
        if bootstrap_grant.is_some() {
            host_fallback_events
        } else {
            Vec::new()
        },
    );
    let worker_state = state.clone();
    let worker_session_id = session_id.clone();
    let worker_run_id = run_id.clone();
    thread::spawn(move || {
        run_session_bridge_worker(
            worker_state,
            worker_session_id,
            worker_run_id,
            request,
            start_event_count,
        );
    });
    drop(interaction_admission_guard);

    if let Some(grant) = bootstrap_grant.as_ref() {
        if let Err(error) = await_session_run_bootstrap(&state, &session_id, &run_id, grant).await {
            return ApiResponse::error(error.code, error.message);
        }
    }
    drop(run_start_guard);
    run_response(&state, &session_id, &run_id)
}

pub(crate) async fn agent_session_run_get(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    run_response(&state, &session_id, &run_id)
}

pub(crate) async fn agent_session_run_cancel(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
) -> Json<ApiResponse> {
    if !run_belongs_to_session(&state, &session_id, &run_id) {
        return ApiResponse::error("agent_run_not_found", "agent run not found");
    }
    if let Err(error) = request_run_cancellation(&state, &run_id) {
        return ApiResponse::error(error.code, error.message);
    }
    run_response(&state, &session_id, &run_id)
}

pub(crate) async fn agent_session_run_delta(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(mut body): Json<Value>,
) -> Json<ApiResponse> {
    if !run_belongs_to_session(&state, &session_id, &run_id) {
        return ApiResponse::error("agent_run_not_found", "agent run not found");
    }
    canonicalize_projection_safe_integers(&mut body);
    if let Err(message) = validate_agent_timeline_delta(&state, &session_id, &body) {
        record_daemon_projection_delivery(
            &state,
            &session_id,
            &run_id,
            "daemon.timeline_delta_received",
            Some(&body),
            "rejected",
            true,
        );
        return ApiResponse::error("agent_timeline_delta_invalid", message);
    }
    record_daemon_projection_delivery(
        &state,
        &session_id,
        &run_id,
        "daemon.timeline_delta_received",
        Some(&body),
        "accepted",
        false,
    );
    let normalized_delta = {
        let mut deltas = state
            .session_run_deltas
            .lock()
            .expect("session run delta state lock");
        let queue = deltas.entry(run_id.clone()).or_default();
        let delta_seq = queue
            .last()
            .and_then(|delta| delta.get("deltaSeq").and_then(Value::as_u64))
            .unwrap_or(0)
            + 1;
        let delta = normalize_run_delta(&session_id, &run_id, delta_seq, body);
        queue.push(delta);
        const MAX_RUN_DELTAS: usize = 2_000;
        if queue.len() > MAX_RUN_DELTAS {
            let overflow = queue.len() - MAX_RUN_DELTAS;
            queue.drain(0..overflow);
        }
        queue.last().cloned().unwrap_or(Value::Null)
    };
    record_daemon_projection_delivery(
        &state,
        &session_id,
        &run_id,
        "daemon.timeline_delta_enqueued",
        Some(&normalized_delta),
        "accepted",
        false,
    );
    touch_run(&state, &run_id, None);
    run_response(&state, &session_id, &run_id)
}

pub(crate) async fn agent_session_run_guidance(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let run = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.get(&run_id)
            .filter(|run| run.session_id == session_id)
            .cloned()
    };
    let Some(run) = run else {
        return ApiResponse::error("agent_run_not_found", "agent run not found");
    };
    if run_status_terminal(&run.status) {
        return ApiResponse::error(
            "agent_run_not_active",
            "run is not active; start a new run or resolve the pending decision",
        );
    }
    let events = session_projection(&state, &session_id);
    if pending_permission_message(&events).is_some() {
        return ApiResponse::error(
            "permission_pending",
            "permission confirmation is pending; resolve it before sending guidance",
        );
    }
    let guidance = body
        .get("guidance")
        .or_else(|| body.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if guidance.is_empty() {
        return ApiResponse::error("empty_guidance", "guidance must not be empty");
    }
    let observed_base_head = match body
        .get("baseHead")
        .cloned()
        .ok_or_else(|| "guidance requires caller-observed baseHead")
        .and_then(|value| {
            serde_json::from_value::<SessionDomainHeadV1>(value)
                .map_err(|_| "guidance has an invalid caller-observed baseHead")
        }) {
        Ok(head) => head,
        Err(message) => return ApiResponse::error("session_append_transition_invalid", message),
    };
    let observed_turn_authority_ref = match body
        .get("turnAuthorityRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(authority_ref) => authority_ref.to_string(),
        None => {
            return ApiResponse::error(
                "session_append_transition_invalid",
                "guidance requires caller-observed turnAuthorityRef",
            )
        }
    };
    let attachments = body
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let (host_language, host_language_source) = normalize_host_language(
        body.get("hostLanguage").and_then(Value::as_str),
        user_setting_string(&state, "workbench.language"),
    );
    let guidance_id = format!("guidance-{}", now_millis());
    let guidance_event = agent_event(
        &session_id,
        "user_guidance",
        json!({
            "guidanceId": guidance_id,
            "content": guidance.clone(),
            "guidance": guidance.clone(),
            "attachments": attachments,
            "source": "user",
            "targetRunId": run_id.clone(),
            "targetInteractionKind": "runningRunGuidance",
            "effectiveCheckpoint": "nextProviderCall",
            "checkpointKind": "nextProviderCall",
            "hostLanguage": host_language,
            "hostLanguageSource": host_language_source,
            "status": "queued",
            "summary": "用户补充引导已记录，将在下一次 provider checkpoint 生效。",
            "channel": "user",
            "visibility": "conversation",
            "presentation": "body"
        }),
        &now_text(),
    );
    if let Err(error) = admit_session_guidance(
        &state,
        &session_id,
        &run_id,
        observed_base_head,
        observed_turn_authority_ref,
        guidance_event,
    ) {
        let sessions_dir = state
            .gui
            .lock()
            .expect("gui state lock")
            .paths
            .sessions_dir
            .clone();
        return ApiResponse::error_with_data(
            error.code,
            error.message.clone(),
            error.api_details(&sessions_dir, &session_id),
        );
    }
    touch_run(&state, &run_id, Some("guidance queued".to_string()));
    run_response(&state, &session_id, &run_id)
}

pub(crate) async fn agent_session_run_stream(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Query(query): Query<AgentRunStreamQuery>,
) -> Response {
    let stream_state = state.clone();
    let stream = async_stream::stream! {
        let mut sent_delta_seq = query.since_delta_seq.unwrap_or(0);
        let mut sent_event_count = query.since_event_count.unwrap_or_else(|| {
            let runs = stream_state.session_runs.lock().expect("session run state lock");
            runs.get(&run_id).map(|run| run.start_event_count).unwrap_or(0)
        });
        let mut last_run_status = String::new();
        let mut heartbeat_at = Instant::now();
        loop {
            let run = {
                let runs = stream_state.session_runs.lock().expect("session run state lock");
                runs.get(&run_id)
                    .filter(|run| run.session_id == session_id)
                    .cloned()
            };
            let Some(run) = run else {
                yield sse_bytes("error", json!({
                    "code": "agent_run_not_found",
                    "message": "agent run not found",
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone()
                }));
                break;
            };

            if run.status != last_run_status {
                last_run_status = run.status.clone();
                yield sse_bytes("run", json!({
                    "run": run.clone(),
                    "sessionId": session_id.clone()
                }));
            }

            let deltas = {
                let deltas = stream_state
                    .session_run_deltas
                    .lock()
                    .expect("session run delta state lock");
                deltas.get(&run_id).cloned().unwrap_or_default()
            };
            for delta in deltas.iter() {
                let Some(seq) = delta.get("deltaSeq").and_then(Value::as_u64) else {
                    continue;
                };
                if seq <= sent_delta_seq {
                    continue;
                }
                record_daemon_projection_delivery(
                    &stream_state,
                    &session_id,
                    &run_id,
                    "daemon.sse_delta_sent",
                    Some(delta),
                    "sent",
                    false,
                );
                yield sse_bytes("delta", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "delta": delta
                }));
                sent_delta_seq = seq;
            }

            let events = session_projection(&stream_state, &session_id);
            if events.len() != sent_event_count {
                let new_events = events.iter().skip(sent_event_count).cloned().collect::<Vec<_>>();
                sent_event_count = events.len();
                yield sse_bytes("events", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "events": new_events,
                    "eventCount": sent_event_count
                }));
            }

            if run_status_terminal(&run.status) {
                let (terminal_events, terminal_event_count) =
                    terminal_stream_event_tail(&events, sent_event_count);
                sent_event_count = terminal_event_count;
                record_daemon_projection_delivery(
                    &stream_state,
                    &session_id,
                    &run_id,
                    "daemon.sse_terminal_sent",
                    None,
                    "sent",
                    true,
                );
                flush_daemon_projection_delivery_terminal(&stream_state, &run_id).await;
                yield sse_bytes("terminal", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "run": run.clone(),
                    "events": terminal_events,
                    "eventCount": sent_event_count
                }));
                break;
            }

            if heartbeat_at.elapsed() >= Duration::from_secs(10) {
                heartbeat_at = Instant::now();
                yield sse_bytes("heartbeat", json!({
                    "sessionId": session_id.clone(),
                    "runId": run_id.clone(),
                    "at": now_text()
                }));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

pub(crate) async fn agent_session_cancel(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let active_runs = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.values()
            .filter(|run| run.session_id == session_id && run_status_active(&run.status))
            .map(|run| run.run_id.clone())
            .collect::<Vec<_>>()
    };
    for run_id in active_runs {
        if let Err(error) = request_run_cancellation(&state, &run_id) {
            return ApiResponse::error(error.code, error.message);
        }
    }
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_trace(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    let events = gui
        .trace_events
        .get(&session_id)
        .cloned()
        .unwrap_or_default();
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "trace": {
            "sessionId": session_id,
            "events": events,
            "eventCount": events.len(),
            "updatedAt": now_text()
        }
    }))
}

pub(crate) async fn agent_permission_resolve(
    State(state): State<AppState>,
    Path(permission_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let candidate_session_ids = {
        let gui = state.gui.lock().expect("gui state lock");
        let mut session_ids = gui
            .sessions
            .iter()
            .filter_map(|session| {
                session
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();
        if let Some(current_session_id) = gui.current_session_id.as_ref() {
            session_ids.retain(|session_id| session_id != current_session_id);
            session_ids.insert(0, current_session_id.clone());
        }
        session_ids
    };
    let permission_session_id = candidate_session_ids
        .iter()
        .find(|session_id| {
            session_projection(&state, session_id)
                .iter()
                .rev()
                .any(|event| {
                    event.get("kind").and_then(Value::as_str) == Some("permission_request")
                        && event
                            .get("payload")
                            .and_then(|payload| {
                                payload.get("id").or_else(|| payload.get("permissionId"))
                            })
                            .and_then(Value::as_str)
                            == Some(permission_id.as_str())
                })
        })
        .cloned()
        .or_else(|| candidate_session_ids.first().cloned());
    if let Some(session_id) = permission_session_id.as_deref() {
        let sessions_dir = state
            .gui
            .lock()
            .expect("gui state lock")
            .paths
            .sessions_dir
            .clone();
        match read_session_domain_snapshot(&sessions_dir, session_id) {
            Ok(snapshot) if snapshot.writeability == SessionDomainWriteability::Current => {
                return ApiResponse::error(
                    "session_permission_resolution_requires_session_run",
                    "Canonical Session permission decisions must be resolved through a Session run",
                )
            }
            Ok(snapshot) if snapshot.writeability == SessionDomainWriteability::LegacyReadOnly => {
                return ApiResponse::error(
                    "session_append_legacy_read_only",
                    "Legacy raw-event Session is read-only and cannot resolve permission decisions",
                )
            }
            Ok(_) => {}
            Err(error) => {
                return ApiResponse::error_with_data(
                    error.code,
                    error.message.clone(),
                    error.api_details(&sessions_dir, session_id),
                )
            }
        }
    }
    let decision = body
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("reject")
        .to_string();
    let kernel_decision = if decision == "accept" {
        deepcode_kernel_abi::PermissionDecisionKind::Accept
    } else {
        deepcode_kernel_abi::PermissionDecisionKind::Reject
    };
    let kernel_events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::PermissionResolve {
                request_id: rid("agent-permission-resolve"),
                permission_id: permission_id.clone(),
                decision: kernel_decision,
            })
            .unwrap_or_else(|error| {
                vec![KernelEvent::Error {
                    request_id: Some(rid("agent-permission-resolve")),
                    run_id: None,
                    session_id: None,
                    error: KernelErrorEnvelope::from(&error),
                    message_key: None,
                    args: None,
                }]
            })
    };
    let session_id = kernel_events
        .iter()
        .find_map(kernel_event_session_id)
        .or_else(|| {
            state
                .gui
                .lock()
                .expect("gui state lock")
                .current_session_id
                .clone()
        })
        .unwrap_or_else(|| "session-unknown".to_string());
    record_kernel_events(&state, &kernel_events);
    let projection = kernel_events_to_agent_events(&session_id, &kernel_events);
    if let Err(error) = append_session_projection(&state, &session_id, projection) {
        return ApiResponse::error(error.code, error.message);
    }
    let gui = state.gui.lock().expect("gui state lock");
    if gui
        .sessions
        .iter()
        .any(|session| session.get("id").and_then(Value::as_str) == Some(session_id.as_str()))
    {
        session_result(&gui, &session_id)
    } else {
        ApiResponse::ok(json!({
            "sessionId": session_id,
            "events": gui
                .session_projection_cache
                .get(&session_id)
                .cloned()
                .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, &session_id))
        }))
    }
}

#[cfg(test)]
#[path = "agent_api_tests.rs"]
mod tests;
