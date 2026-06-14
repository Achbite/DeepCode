#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionScopeQuery {
    pub(crate) workspace_id: Option<String>,
    pub(crate) workspace_hash: Option<String>,
    pub(crate) include_archived: Option<bool>,
}

pub(crate) async fn agent_sessions_list(
    State(state): State<AppState>,
    Query(query): Query<AgentSessionScopeQuery>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
    let scope_key = scope_key_from_query(&query);
    let include_archived = query.include_archived.unwrap_or(false);
    let sessions = scoped_sessions(&gui, &scope_key, include_archived);
    let current_session_id = current_agent_session_id_for_scope(&mut gui, &scope_key);
    ApiResponse::ok(json!({
        "sessions": sessions,
        "currentSessionId": current_session_id,
        "workspaceScopeKey": scope_key
    }))
}

pub(crate) async fn agent_session_create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let id = format!("session-{}", now_millis());
    let now = now_text();
    let mode = body
        .get("mode")
        .or_else(|| body.get("initialMode"))
        .and_then(Value::as_str)
        .unwrap_or("plan");
    let workspace_id = body.get("workspaceId").and_then(Value::as_str);
    let workspace_hash = body.get("workspaceHash").and_then(Value::as_str);
    let session = create_agent_session_value(
        &id,
        &now,
        body.get("title")
            .and_then(Value::as_str)
            .unwrap_or("New Agent Session"),
        mode,
        body.get("profileId").and_then(Value::as_str),
        workspace_id,
        workspace_hash,
    );
    let scope_key = session_scope_key(&session);
    gui.current_session_id = Some(id.clone());
    gui.current_session_ids_by_scope
        .insert(scope_key, id.clone());
    gui.session_projection_cache.insert(id.clone(), Vec::new());
    gui.trace_events.insert(id.clone(), Vec::new());
    gui.sessions.insert(0, session.clone());
    ApiResponse::ok(json!({ "session": session, "events": [] }))
}

pub(crate) async fn agent_session_current(
    State(state): State<AppState>,
    Query(query): Query<AgentSessionScopeQuery>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
    let scope_key = scope_key_from_query(&query);
    let Some(session_id) = current_agent_session_id_for_scope(&mut gui, &scope_key) else {
        return ApiResponse::ok(Value::Null);
    };
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_activate(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if has_session(&gui, &session_id) {
        if let Some(scope_key) = session_by_id(&gui, &session_id).map(session_scope_key) {
            gui.current_session_ids_by_scope
                .insert(scope_key, session_id.clone());
        }
        gui.current_session_id = Some(session_id.clone());
        refresh_pending_session_titles(&mut gui);
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

pub(crate) async fn agent_session_rename(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if let Some(title) = body.get("title").and_then(Value::as_str) {
            session["title"] = json!(title);
            session["titleSource"] = json!("user");
        }
        session["updatedAt"] = json!(now_text());
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

pub(crate) async fn agent_session_delete(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let safe_session_id = safe_path_segment(&session_id);
    let (sessions_dir, archive_root, response_scope_key, response_current_id, response_sessions) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let Some(position) = gui.sessions.iter().position(|session| {
            session.get("id").and_then(Value::as_str) == Some(session_id.as_str())
        }) else {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        };

        let scope_key = session_scope_key(&gui.sessions[position]);
        gui.sessions.remove(position);
        gui.session_projection_cache.remove(&session_id);
        gui.pending_plans
            .retain(|_, plan| plan.session_id != session_id);
        gui.pending_reviews
            .retain(|_, review| review.session_id != session_id);
        gui.trace_events.remove(&session_id);
        gui.current_session_ids_by_scope
            .retain(|_, current_id| current_id != &session_id);
        if gui.current_session_id.as_deref() == Some(session_id.as_str()) {
            gui.current_session_id = gui
                .sessions
                .iter()
                .find(|session| !is_archived_session(session))
                .and_then(|session| session.get("id").and_then(Value::as_str))
                .map(ToOwned::to_owned);
        }
        let response_current_id = current_agent_session_id_for_scope(&mut gui, &scope_key);
        let response_sessions = scoped_sessions(&gui, &scope_key, false);
        (
            gui.paths.sessions_dir.clone(),
            gui.paths.conversation_archives_dir.clone(),
            scope_key,
            response_current_id,
            response_sessions,
        )
    };

    remove_session_storage_dir(&sessions_dir, &safe_session_id);
    remove_conversation_archive_dirs(&archive_root, &safe_session_id);

    ApiResponse::ok(json!({
        "sessions": response_sessions,
        "currentSessionId": response_current_id,
        "workspaceScopeKey": response_scope_key
    }))
}

pub(crate) async fn agent_session_archive(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let should_archive = body
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let archived_scope_key = session_by_id(&gui, &session_id).map(session_scope_key);
    let was_global_current = gui.current_session_id.as_deref() == Some(session_id.as_str());
    let was_scoped_current = archived_scope_key
        .as_ref()
        .and_then(|scope| gui.current_session_ids_by_scope.get(scope))
        .map(|current| current == &session_id)
        .unwrap_or(false);
    let mut replacement_scope: Option<(Option<String>, Option<String>, Option<String>)> = None;
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if should_archive {
            if was_global_current || was_scoped_current {
                replacement_scope = Some((
                    session
                        .get("profileId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    session
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    session
                        .get("workspaceHash")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                ));
            }
            session["archivedAt"] = json!(now_text());
        } else {
            session
                .as_object_mut()
                .map(|object| object.remove("archivedAt"));
        }
    }
    if should_archive {
        if let Some(scope_key) = archived_scope_key.as_ref() {
            gui.current_session_ids_by_scope.remove(scope_key);
        }
        if was_global_current || was_scoped_current {
            ensure_current_agent_session_for_scope(
                &mut gui,
                archived_scope_key.as_deref().unwrap_or("unbound-workspace"),
                replacement_scope,
            );
        }
    }
    let response_scope_key = archived_scope_key.unwrap_or_else(|| scope_key_from_parts(None, None));
    let response_current_id = current_agent_session_id_for_scope(&mut gui, &response_scope_key);
    let response_sessions = scoped_sessions(&gui, &response_scope_key, false);
    ApiResponse::ok(json!({
        "sessions": response_sessions,
        "currentSessionId": response_current_id,
        "workspaceScopeKey": response_scope_key
    }))
}

pub(crate) async fn agent_session_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_append_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let incoming = body
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    append_session_projection(&state, &session_id, incoming);
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_send_message(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let _ = (state, session_id, body);
    ApiResponse::error(
        "agent_messages_endpoint_removed",
        "Agent message sending is owned by userspace SessionDriverLoop. Use /api/kernel/commands, /api/llm/chat, and /api/agent/sessions/:id/events.",
    )
}

pub(crate) async fn agent_session_cancel(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
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
    append_session_projection(&state, &session_id, projection);
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

pub(crate) async fn agent_plan_resolve(
    State(state): State<AppState>,
    Path((run_id, plan_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    return ApiResponse::error(
        "session_decision_owned_by_session",
        "Plan decisions are owned by userspace Session DecisionResolver. Daemon no longer resolves or executes plans.",
    );
    let decision = body
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("reject");
    let guidance = body
        .get("guidance")
        .and_then(Value::as_str)
        .map(str::to_string);
    let pending_plan = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let mut pending = find_pending_plan_by_alias(&gui, &plan_id);
        if pending.is_none() {
            if let Some(session_id) = gui.current_session_id.clone() {
                let events = gui
                    .session_projection_cache
                    .get(&session_id)
                    .cloned()
                    .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, &session_id));
                for event in events.iter().rev() {
                    let Some(plan) = pending_plan_from_plan_card_event(&session_id, event) else {
                        continue;
                    };
                    if pending_plan_aliases(&plan).contains(&plan_id) {
                        insert_pending_plan_aliases(&mut gui, plan.clone());
                        pending = Some(plan);
                        break;
                    }
                }
            }
        }
        if let Some(plan) = pending.as_ref() {
            remove_pending_plan_aliases(&mut gui, plan);
        }
        pending
    };
    if pending_plan.is_none() {
        let session_id = state
            .gui
            .lock()
            .expect("gui state lock")
            .current_session_id
            .clone()
            .unwrap_or_else(|| "session-unknown".to_string());
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "trace/plan_accept_noop",
                json!({
                    "title": "Plan accept no-op",
                    "summary": "该计划已处理或已过期，没有再次提交执行。",
                    "runId": run_id.clone(),
                    "planId": plan_id.clone(),
                    "decision": decision,
                    "channel": "progress",
                    "visibility": "conversation",
                    "presentation": "body"
                }),
                &now_text(),
            )],
        );
        let gui = state.gui.lock().expect("gui state lock");
        return session_result(&gui, &session_id);
    }
    let command = match decision {
        "accept" => KernelCommand::PlanAccept {
            request_id: rid("agent-plan-resolve"),
            run_id: deepcode_kernel_abi::RunId(run_id.clone()),
            plan_id: plan_id.clone(),
        },
        "revise" => KernelCommand::PlanRevise {
            request_id: rid("agent-plan-resolve"),
            run_id: deepcode_kernel_abi::RunId(run_id.clone()),
            plan_id: plan_id.clone(),
            guidance: guidance.unwrap_or_else(|| "用户要求修改计划。".to_string()),
        },
        _ => KernelCommand::PlanReject {
            request_id: rid("agent-plan-resolve"),
            run_id: deepcode_kernel_abi::RunId(run_id.clone()),
            plan_id: plan_id.clone(),
            reason: guidance,
        },
    };
    let pending_review = if decision == "accept" {
        pending_plan.as_ref().map(pending_review_for_plan)
    } else {
        None
    };
    let mut post_projection = Vec::new();
    let kernel_events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        let mut events = Vec::new();
        let mut grant_failed = false;
        if decision == "accept" {
            let plan_run_id = pending_plan
                .as_ref()
                .map(|plan| plan.run_id.clone())
                .unwrap_or_else(|| run_id.clone());
            let grants = pending_plan
                .as_ref()
                .map(temporary_grants_for_pending_plan)
                .unwrap_or_default();
            for grant in grants {
                match runtime.dispatch(KernelCommand::PermissionGrantTemporary {
                    request_id: rid("agent-plan-temp-grant"),
                    run_id: deepcode_kernel_abi::RunId(plan_run_id.clone()),
                    grant,
                }) {
                    Ok(mut grant_events) => events.append(&mut grant_events),
                    Err(error) => {
                        events.push(KernelEvent::Error {
                            request_id: Some(rid("agent-plan-temp-grant")),
                            run_id: Some(deepcode_kernel_abi::RunId(run_id.clone())),
                            session_id: None,
                            error: KernelErrorEnvelope::from(&error),
                            message_key: None,
                            args: None,
                        });
                        grant_failed = true;
                        break;
                    }
                }
            }
        }
        if grant_failed {
            events
        } else {
            match runtime.dispatch(command) {
                Ok(mut command_events) => {
                    events.append(&mut command_events);
                    if decision == "accept" {
                        if let Some(plan) = pending_plan.as_ref() {
                            match runtime.dispatch(KernelCommand::ActionBatchSubmit {
                                request_id: rid("agent-action-batch-submit"),
                                run_id: deepcode_kernel_abi::RunId(plan.run_id.clone()),
                                session_id: Some(deepcode_kernel_abi::SessionId(
                                    plan.session_id.clone(),
                                )),
                                batch: json!({
                                    "planId": plan.plan_id,
                                    "actionBundle": plan.action_bundle,
                                    "codeBlocks": plan.code_blocks
                                }),
                            }) {
                                Ok(mut batch_events) => events.append(&mut batch_events),
                                Err(error) => events.push(KernelEvent::Error {
                                    request_id: Some(rid("agent-action-batch-submit")),
                                    run_id: Some(deepcode_kernel_abi::RunId(plan.run_id.clone())),
                                    session_id: Some(deepcode_kernel_abi::SessionId(
                                        plan.session_id.clone(),
                                    )),
                                    error: KernelErrorEnvelope::from(&error),
                                    message_key: None,
                                    args: None,
                                }),
                            }
                        }
                    }
                    events
                }
                Err(error) => vec![KernelEvent::Error {
                    request_id: Some(rid("agent-plan-resolve")),
                    run_id: Some(deepcode_kernel_abi::RunId(run_id.clone())),
                    session_id: None,
                    error: KernelErrorEnvelope::from(&error),
                    message_key: None,
                    args: None,
                }],
            }
        }
    };
    let session_id = pending_plan
        .as_ref()
        .map(|plan| plan.session_id.clone())
        .or_else(|| kernel_events.iter().find_map(kernel_event_session_id))
        .or_else(|| {
            state
                .gui
                .lock()
                .expect("gui state lock")
                .pending_plans
                .get(&plan_id)
                .map(|plan| plan.session_id.clone())
        })
        .or_else(|| {
            state
                .gui
                .lock()
                .expect("gui state lock")
                .current_session_id
                .clone()
        })
        .unwrap_or_else(|| "session-unknown".to_string());
    if let Some(review) =
        pending_review.filter(|_| kernel_events_have_action_progress(&kernel_events))
    {
        state
            .gui
            .lock()
            .expect("gui state lock")
            .pending_reviews
            .insert(review.run_id.clone(), review.clone());
        post_projection.push(review_summary_waiting_event(
            &session_id,
            &review,
            &kernel_events,
        ));
    }
    record_kernel_events(&state, &kernel_events);
    let mut projection = kernel_events_to_agent_events(&session_id, &kernel_events);
    projection.append(&mut post_projection);
    append_session_projection(&state, &session_id, projection);
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

fn kernel_events_have_action_progress(events: &[KernelEvent]) -> bool {
    events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ActionBatchAccepted { .. }
                | KernelEvent::WorkUnitQueued { .. }
                | KernelEvent::WorkUnitStarted { .. }
                | KernelEvent::WorkUnitCompleted { .. }
                | KernelEvent::WorkUnitFailed { .. }
                | KernelEvent::WorkUnitBlocked { .. }
                | KernelEvent::ToolCompleted { .. }
        )
    })
}

pub(crate) fn latest_user_attachments_for_session(
    state: &AppState,
    session_id: &str,
) -> Vec<Value> {
    session_projection(state, session_id)
        .into_iter()
        .rev()
        .find_map(|event| {
            if event.get("kind").and_then(Value::as_str) != Some("user_msg") {
                return None;
            }
            let attachments = event
                .get("payload")
                .and_then(|payload| payload.get("attachments"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if attachments.is_empty() {
                None
            } else {
                Some(attachments)
            }
        })
        .unwrap_or_default()
}

pub(crate) async fn agent_review_resolve(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    return ApiResponse::error(
        "session_decision_owned_by_session",
        "Review decisions are owned by userspace Session DecisionResolver. Daemon no longer resolves reviews or generates continuation plans.",
    );
    let decision = body
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("revise");
    let guidance = body
        .get("guidance")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let pending = {
        let mut gui = state.gui.lock().expect("gui state lock");
        if !has_session(&gui, &session_id) {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        }
        gui.pending_reviews.remove(&run_id)
    };
    let Some(review) = pending else {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "trace/review_accept_noop",
                json!({
                    "title": "Review",
                    "summary": "该 Review 已处理或已过期，没有重复推进任务。",
                    "status": "noop",
                    "runId": run_id.clone(),
                    "decision": decision,
                    "channel": "progress",
                    "visibility": "conversation",
                    "presentation": "collapsible"
                }),
                &now_text(),
            )],
        );
        let gui = state.gui.lock().expect("gui state lock");
        return session_result(&gui, &session_id);
    };

    if decision != "accept" {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "review_summary",
                json!({
                    "title": "Review",
                    "summary": guidance.clone().unwrap_or_else(|| "用户要求补充或修改。".to_string()),
                    "content": guidance.clone().unwrap_or_else(|| "用户要求补充或修改。".to_string()),
                    "status": "needsRevision",
                    "runId": run_id.clone(),
                    "reviewId": run_id.clone(),
                    "sourcePlanId": review.source_plan_id,
                    "confirmable": false,
                    "guidance": guidance,
                    "continuationRequested": false,
                    "channel": "final",
                    "visibility": "conversation",
                    "presentation": "body"
                }),
                &now_text(),
            )],
        );
        let gui = state.gui.lock().expect("gui state lock");
        return session_result(&gui, &session_id);
    }

    append_session_projection(
        &state,
        &session_id,
        vec![agent_event(
            &session_id,
            "review_summary",
            json!({
                "title": "Review",
                "summary": "用户已通过 Review，准备继续后续任务。",
                "content": accepted_review_content(&review),
                "status": "accepted",
                "runId": run_id.clone(),
                "reviewId": run_id.clone(),
                "sourcePlanId": review.source_plan_id.clone(),
                "confirmable": false,
                "continuationRequested": !review.continuations.is_empty(),
                "continuationCount": review.continuations.len(),
                "continuations": review.continuations.clone(),
                "channel": "progress",
                "visibility": "conversation",
                "presentation": "body"
            }),
            &now_text(),
        )],
    );

    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

fn plan_card_event(session_id: &str, plan: &PendingAgentPlan) -> Value {
    agent_event(
        session_id,
        "plan_card",
        json!({
            "title": "Plan",
            "summary": plan.user_plan,
            "content": plan.user_plan,
            "runId": plan.run_id,
            "planId": plan.plan_id,
            "actionBundle": plan.action_bundle,
            "codeBlocks": plan.code_blocks,
            "expectedValidation": plan.expected_validation,
            "reviewGuide": plan.review_guide,
            "planReviewReport": plan.plan_review_report,
            "channel": "action",
            "visibility": "conversation",
            "presentation": "body"
        }),
        &now_text(),
    )
}

fn review_summary_waiting_event(
    session_id: &str,
    review: &PendingAgentReview,
    kernel_events: &[KernelEvent],
) -> Value {
    let completed = kernel_events
        .iter()
        .filter(|event| matches!(event, KernelEvent::WorkUnitCompleted { .. }))
        .count();
    let failed = kernel_events
        .iter()
        .filter(|event| matches!(event, KernelEvent::WorkUnitFailed { .. }))
        .count();
    let blocked = kernel_events
        .iter()
        .filter(|event| matches!(event, KernelEvent::WorkUnitBlocked { .. }))
        .count();
    let tool_results = kernel_events
        .iter()
        .filter(|event| matches!(event, KernelEvent::ToolCompleted { .. }))
        .count();
    let summary = if failed > 0 || blocked > 0 {
        "当前批次已推进，但存在失败或阻塞项，请审查 Kernel facts 后决定是否修订。"
    } else {
        "当前批次已执行，请审查 Kernel tool facts 与验证结果。"
    };
    let facts = review_fact_lines(kernel_events)
        .into_iter()
        .map(|line| line.trim_start_matches("- ").to_string())
        .collect::<Vec<_>>();
    let content = waiting_review_content(review, kernel_events, summary, completed, failed, blocked, tool_results);
    agent_event(
        session_id,
        "review_summary",
        json!({
            "title": "Review",
            "summary": summary,
            "content": content,
            "status": "waitingUserReview",
            "runId": review.run_id.clone(),
            "reviewId": review.run_id.clone(),
            "sourcePlanId": review.source_plan_id.clone(),
            "confirmable": true,
            "continuationCount": review.continuations.len(),
            "continuationRequested": false,
            "continuations": review.continuations.clone(),
            "reviewExpectations": review.review_expectations.clone(),
            "facts": facts,
            "factCounts": {
                "workUnitsCompleted": completed,
                "workUnitsFailed": failed,
                "workUnitsBlocked": blocked,
                "toolResults": tool_results
            },
            "channel": "review",
            "visibility": "conversation",
            "presentation": "body"
        }),
        &now_text(),
    )
}

fn accepted_review_content(review: &PendingAgentReview) -> String {
    let mut lines = vec![
        "## Review 已通过".to_string(),
        String::new(),
        "用户已通过当前批次 Review；Kernel facts 已作为本批次事实源保留。".to_string(),
        String::new(),
        "### 后续任务".to_string(),
    ];
    if review.continuations.is_empty() {
        lines.push("- 当前计划没有登记后续批次。".to_string());
    } else {
        lines.push(format!(
            "- 当前计划登记了 {} 个后续意图。后续批次必须由 Session 重新组装上下文并调用模型生成新的详细 Plan；这些意图不会由 daemon 直接执行。",
            review.continuations.len()
        ));
        for continuation in review.continuations.iter().take(6) {
            lines.push(format!("- {}", continuation_summary(continuation)));
        }
    }
    lines.push(String::new());
    lines.push("### 决策边界".to_string());
    lines.push("- Review 通过只关闭当前批次。".to_string());
    lines.push("- 后续批次仍需生成新的 Plan，并等待用户确认后才能执行。".to_string());
    lines.join("\n")
}

fn waiting_review_content(
    review: &PendingAgentReview,
    kernel_events: &[KernelEvent],
    summary: &str,
    completed: usize,
    failed: usize,
    blocked: usize,
    tool_results: usize,
) -> String {
    let mut lines = vec![
        "## Review".to_string(),
        String::new(),
        summary.to_string(),
        String::new(),
        "### 执行结果".to_string(),
        format!("- WorkUnit 完成：{completed}"),
        format!("- WorkUnit 失败：{failed}"),
        format!("- WorkUnit 阻塞：{blocked}"),
        format!("- Tool facts：{tool_results}"),
        String::new(),
    ];

    let completed_units = work_unit_completed_lines(kernel_events);
    lines.push("### 完成项".to_string());
    if completed_units.is_empty() {
        lines.push("- 暂无已完成 WorkUnit。".to_string());
    } else {
        lines.extend(completed_units);
    }
    lines.push(String::new());

    let failed_units = work_unit_failed_lines(kernel_events);
    let blocked_units = work_unit_blocked_lines(kernel_events);
    lines.push("### 失败 / 阻塞项".to_string());
    if failed_units.is_empty() && blocked_units.is_empty() {
        lines.push("- 暂无失败或阻塞项。".to_string());
    } else {
        lines.extend(failed_units);
        lines.extend(blocked_units);
    }
    lines.push(String::new());

    let tool_lines = tool_fact_lines(kernel_events);
    lines.push("### 文件与工具事实".to_string());
    if tool_lines.is_empty() {
        lines.push("- 当前批次没有可展示的 ToolCompleted 事实。".to_string());
    } else {
        lines.extend(tool_lines);
    }
    lines.push(String::new());

    if !review.user_plan.trim().is_empty() {
        lines.push("### 原计划摘要".to_string());
        lines.push(clip_chars(review.user_plan.trim(), 1200));
        lines.push(String::new());
    }

    lines.push("### 验证与启动建议".to_string());
    let review_expectations = review_expectation_lines(review);
    if review_expectations.is_empty() {
        lines.push("- 当前计划未提供可执行验证命令，需要下一轮补充。".to_string());
    } else {
        lines.extend(review_expectations);
    }
    lines.push(String::new());

    lines.push("### 后续决策".to_string());
    if failed > 0 || blocked > 0 {
        lines.push("- 如需修复，请在输入框输入 Review 修改意见；空输入通过会关闭当前 Review，但不会自动执行失败项。".to_string());
    } else {
        lines.push("- 空输入通过 Review；输入文字会作为 Review 修订意见。".to_string());
    }
    if review.continuations.is_empty() {
        lines.push("- 当前计划没有登记后续批次。".to_string());
    } else {
        lines.push(format!(
            "- 当前计划登记了 {} 个后续意图；Review 通过后由 Session 重新生成下一批详细 Plan，再等待用户确认。",
            review.continuations.len()
        ));
    }

    lines.join("\n")
}

fn review_fact_lines(kernel_events: &[KernelEvent]) -> Vec<String> {
    let mut facts = Vec::new();
    facts.extend(work_unit_completed_lines(kernel_events));
    facts.extend(work_unit_failed_lines(kernel_events));
    facts.extend(work_unit_blocked_lines(kernel_events));
    facts.extend(tool_fact_lines(kernel_events));
    facts
}

fn work_unit_completed_lines(kernel_events: &[KernelEvent]) -> Vec<String> {
    kernel_events
        .iter()
        .filter_map(|event| match event {
            KernelEvent::WorkUnitCompleted {
                work_unit_id,
                output,
                ..
            } => Some(format!(
                "- `{}` completed{}",
                work_unit_id,
                output
                    .as_ref()
                    .map(|value| format!("：{}", clipped_json(value, 180)))
                    .unwrap_or_default()
            )),
            _ => None,
        })
        .collect()
}

fn work_unit_failed_lines(kernel_events: &[KernelEvent]) -> Vec<String> {
    kernel_events
        .iter()
        .filter_map(|event| match event {
            KernelEvent::WorkUnitFailed {
                work_unit_id,
                error,
                ..
            } => Some(format!("- `{}` failed：{}", work_unit_id, error.message)),
            _ => None,
        })
        .collect()
}

fn work_unit_blocked_lines(kernel_events: &[KernelEvent]) -> Vec<String> {
    kernel_events
        .iter()
        .filter_map(|event| match event {
            KernelEvent::WorkUnitBlocked {
                work_unit_id,
                reason,
                ..
            } => Some(format!("- `{}` blocked：{}", work_unit_id, reason)),
            _ => None,
        })
        .collect()
}

fn tool_fact_lines(kernel_events: &[KernelEvent]) -> Vec<String> {
    kernel_events
        .iter()
        .filter_map(|event| match event {
            KernelEvent::ToolCompleted {
                tool_name,
                ok,
                output,
                error,
                ..
            } => {
                let status = if *ok { "ok" } else { "error" };
                let detail = error
                    .as_ref()
                    .map(|error| error.message.clone())
                    .or_else(|| output.as_ref().map(|value| clipped_json(value, 180)))
                    .unwrap_or_else(|| "no output".to_string());
                Some(format!("- `{}` {}：{}", tool_name, status, detail))
            }
            _ => None,
        })
        .collect()
}

fn review_expectation_lines(review: &PendingAgentReview) -> Vec<String> {
    let mut lines = Vec::new();
    if !review.expected_validation.trim().is_empty() {
        lines.push(format!(
            "- 验证要求：{}",
            review.expected_validation.trim()
        ));
    }
    if !review.review_guide.trim().is_empty() {
        lines.push(format!("- Review 指引：{}", review.review_guide.trim()));
    }
    lines.extend(review
        .review_expectations
        .iter()
        .filter_map(|expectation| {
            expectation
                .get("description")
                .and_then(Value::as_str)
                .or_else(|| expectation.get("summary").and_then(Value::as_str))
                .or_else(|| expectation.get("command").and_then(Value::as_str))
        })
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("- {}", value.trim()))
        .collect::<Vec<_>>());
    lines
}

fn continuation_summary(value: &Value) -> String {
    value
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| value.get("description").and_then(Value::as_str))
        .or_else(|| value.get("id").and_then(Value::as_str))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| clipped_json(value, 160))
}

fn clipped_json(value: &Value, max_chars: usize) -> String {
    let text = if let Some(value) = value.as_str() {
        value.to_string()
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| "<unserializable>".to_string())
    };
    clip_chars(&text, max_chars)
}

fn clip_chars(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index >= max_chars {
            output.push('…');
            return output;
        }
        output.push(ch);
    }
    output
}

fn temporary_grants_for_pending_plan(
    plan: &PendingAgentPlan,
) -> Vec<deepcode_kernel_abi::TemporaryGrantEnvelope> {
    let gaps = plan
        .plan_review_report
        .as_ref()
        .and_then(|report| report.get("permissionGaps"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let actions = plan
        .action_bundle
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut grants = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for gap in gaps {
        let Some(capability) = gap.as_str().filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        let scopes = resource_scopes_for_capability(&actions, capability);
        if scopes.is_empty() {
            let key = format!("{capability}:*");
            if seen.insert(key) {
                grants.push(temporary_grant(plan, capability, None));
            }
            continue;
        }
        for scope in scopes {
            let key = format!("{capability}:{scope}");
            if seen.insert(key) {
                grants.push(temporary_grant(plan, capability, Some(scope)));
            }
        }
    }
    grants
}

fn pending_review_for_plan(plan: &PendingAgentPlan) -> PendingAgentReview {
    let continuations = plan
        .action_bundle
        .get("continuationExpectations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let review_expectations = plan
        .action_bundle
        .get("reviewExpectations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    PendingAgentReview {
        session_id: plan.session_id.clone(),
        run_id: plan.run_id.clone(),
        source_plan_id: plan.plan_id.clone(),
        user_plan: plan.user_plan.clone(),
        continuations,
        code_blocks: plan.code_blocks.clone(),
        review_expectations,
        expected_validation: plan.expected_validation.clone(),
        review_guide: plan.review_guide.clone(),
        created_at: now_text(),
    }
}

fn resource_scopes_for_capability(actions: &[Value], capability: &str) -> Vec<String> {
    actions
        .iter()
        .filter(|action| action.get("capability").and_then(Value::as_str) == Some(capability))
        .flat_map(|action| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|scope| scope.as_str().map(str::to_string))
        .filter(|scope| {
            !scope.trim().is_empty()
                && scope != "workspace"
                && !scope.contains('*')
                && !scope.starts_with("search:")
                && !scope.starts_with("symbol:")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review_fixture() -> PendingAgentReview {
        PendingAgentReview {
            session_id: "session-generic".to_string(),
            run_id: "run-generic".to_string(),
            source_plan_id: "plan-generic".to_string(),
            user_plan: "# Plan\n\n## Test Plan\n- Run the validation command from the plan.".to_string(),
            continuations: vec![json!({
                "id": "next-batch",
                "title": "Generate the next reviewable implementation batch"
            })],
            code_blocks: Vec::new(),
            review_expectations: vec![json!({
                "id": "manual-review",
                "description": "Inspect written files and run the project validation commands from the plan."
            })],
            expected_validation: "Kernel records concrete write facts for every planned file.".to_string(),
            review_guide: "Review generated files before accepting the batch.".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn review_summary_waiting_event_contains_detailed_failure_content() {
        let review = review_fixture();
        let events = vec![
            KernelEvent::WorkUnitFailed {
                request_id: None,
                run_id: deepcode_kernel_abi::RunId("run-generic".to_string()),
                session_id: Some(deepcode_kernel_abi::SessionId("session-generic".to_string())),
                work_unit_id: "work-unit-generic".to_string(),
                error: KernelErrorEnvelope {
                    code: "invalid_command".to_string(),
                    message: "invalid command: workspace.write action requires sourceBlockId".to_string(),
                    message_key: None,
                    args: None,
                },
                sequence: Some(1),
            },
            KernelEvent::ToolCompleted {
                run_id: Some(deepcode_kernel_abi::RunId("run-generic".to_string())),
                session_id: Some(deepcode_kernel_abi::SessionId("session-generic".to_string())),
                turn_id: None,
                tool_call_id: "tool-generic".to_string(),
                tool_name: "fs.write".to_string(),
                ok: false,
                output: None,
                error: Some(KernelErrorEnvelope {
                    code: "invalid_command".to_string(),
                    message: "invalid command: workspace.write action requires sourceBlockId".to_string(),
                    message_key: None,
                    args: None,
                }),
                sequence: Some(2),
            },
        ];

        let event = review_summary_waiting_event("session-generic", &review, &events);
        let payload = event.get("payload").and_then(Value::as_object).unwrap();
        let content = payload.get("content").and_then(Value::as_str).unwrap();

        assert!(content.contains("失败 / 阻塞项"));
        assert!(content.contains("workspace.write action requires sourceBlockId"));
        assert_eq!(
            payload
                .get("continuationRequested")
                .and_then(Value::as_bool),
            Some(false)
        );
        assert!(payload.get("facts").and_then(Value::as_array).unwrap().len() >= 2);
    }

    #[test]
    fn accepted_review_content_marks_continuations_as_session_planning_input() {
        let review = review_fixture();
        let content = accepted_review_content(&review);

        assert!(content.contains("后续批次必须由 Session 重新组装上下文"));
        assert!(content.contains("不会由 daemon 直接执行"));
    }
}

fn temporary_grant(
    plan: &PendingAgentPlan,
    capability: &str,
    resource_path: Option<String>,
) -> deepcode_kernel_abi::TemporaryGrantEnvelope {
    deepcode_kernel_abi::TemporaryGrantEnvelope {
        id: format!(
            "grant-{}-{}-{}",
            safe_path_segment(&plan.plan_id),
            safe_path_segment(capability),
            resource_path
                .as_deref()
                .map(safe_path_segment)
                .unwrap_or_else(|| "run".to_string())
        ),
        capability: capability.to_string(),
        resource_kind: resource_kind_for_capability(capability).to_string(),
        resource_path,
        expires_after_sequence: None,
        reason: Some(format!("Plan {} accepted by user", plan.plan_id)),
    }
}

fn resource_kind_for_capability(capability: &str) -> &'static str {
    match capability {
        "workspace.write" | "workspace.delete" | "workspace.rename" | "workspace.create" => {
            "workspaceFile"
        }
        "git.write" => "git",
        "process.exec" => "process",
        "network.egress" => "network",
        "browser.control" => "browser",
        "secret.read" => "secret",
        _ => "capability",
    }
}

pub(crate) async fn agent_feedback() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "accepted": true,
        "message": "Feedback recorded by host compatibility layer."
    }))
}

pub(crate) async fn agent_workflow_config_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "config": gui.workflow_config,
        "storePath": gui.paths.workflow_config_path.to_string_lossy(),
        "initialized": true
    }))
}

pub(crate) async fn agent_workflow_config_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let config = body.get("config").cloned().unwrap_or_else(|| json!({}));
    let mut gui = state.gui.lock().expect("gui state lock");
    merge_object(&mut gui.workflow_config, &config);
    match atomic_write_json(&gui.paths.workflow_config_path, &gui.workflow_config) {
        Ok(()) => ApiResponse::ok(json!({
            "config": gui.workflow_config,
            "storePath": gui.paths.workflow_config_path.to_string_lossy(),
            "initialized": true
        })),
        Err(error) => ApiResponse::error("write_workflow_config_failed", error),
    }
}

pub(crate) async fn agent_tools(State(state): State<AppState>) -> Json<ApiResponse> {
    match dispatch_skill(
        &state.runtime,
        KernelCommand::SkillDiscover {
            request_id: rid("skill-discover"),
        },
    ) {
        Ok(output) => {
            let skills = output
                .get("skills")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let tools = skills
                .iter()
                .map(|skill| {
                    json!({
                        "name": skill.get("id").or_else(|| skill.get("name")).cloned().unwrap_or(Value::Null),
                        "description": skill.get("description").cloned().unwrap_or_else(|| json!("Kernel skill")),
                        "inputSchema": skill.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                        "riskLevel": skill.get("riskLevel").cloned().unwrap_or_else(|| json!("low")),
                        "needsApproval": skill.get("requiresApproval").cloned().unwrap_or_else(|| json!(false)),
                        "allowedModes": ["readOnly", "plan", "askBeforeWrite"]
                    })
                })
                .collect::<Vec<_>>();
            ApiResponse::ok(json!({
                "skills": skills,
                "tools": tools
            }))
        }
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) fn create_agent_session_value(
    id: &str,
    now: &str,
    title: &str,
    mode: &str,
    profile_id: Option<&str>,
    workspace_id: Option<&str>,
    workspace_hash: Option<&str>,
) -> Value {
    let workspace_scope_key = scope_key_from_parts(workspace_id, workspace_hash);
    json!({
        "id": id,
        "title": title,
        "mode": mode,
        "profileId": profile_id,
        "workspaceId": workspace_id,
        "workspaceHash": workspace_hash,
        "workspaceScopeKey": workspace_scope_key,
        "titleSource": "pending",
        "eventCount": 0,
        "createdAt": now,
        "updatedAt": now
    })
}

pub(crate) fn is_archived_session(session: &Value) -> bool {
    session.get("archivedAt").and_then(Value::as_str).is_some()
}

pub(crate) fn remove_session_storage_dir(sessions_dir: &FsPath, safe_session_id: &str) {
    let path = sessions_dir.join(safe_session_id);
    if path.starts_with(sessions_dir) {
        let _ = fs::remove_dir_all(path);
    }
}

pub(crate) fn remove_conversation_archive_dirs(archive_root: &FsPath, safe_session_id: &str) {
    let Ok(workspaces) = fs::read_dir(archive_root) else {
        return;
    };
    for workspace in workspaces.filter_map(Result::ok) {
        let session_dir = workspace.path().join(safe_session_id);
        if session_dir.starts_with(archive_root) {
            let _ = fs::remove_dir_all(session_dir);
        }
    }
}

pub(crate) fn scope_key_from_query(query: &AgentSessionScopeQuery) -> String {
    scope_key_from_parts(
        query.workspace_id.as_deref(),
        query.workspace_hash.as_deref(),
    )
}

pub(crate) fn scope_key_from_parts(
    workspace_id: Option<&str>,
    workspace_hash: Option<&str>,
) -> String {
    match (workspace_id, workspace_hash) {
        (Some(id), Some(hash)) if !id.trim().is_empty() && !hash.trim().is_empty() => {
            format!(
                "workspace-{}-{}",
                safe_path_segment(id),
                safe_path_segment(hash)
            )
        }
        (Some(id), _) if !id.trim().is_empty() => {
            format!("workspace-{}", safe_path_segment(id))
        }
        _ => "unbound-workspace".to_string(),
    }
}

pub(crate) fn session_scope_key(session: &Value) -> String {
    if let Some(scope_key) = session.get("workspaceScopeKey").and_then(Value::as_str) {
        if !scope_key.trim().is_empty() {
            return safe_path_segment(scope_key);
        }
    }
    scope_key_from_parts(
        session.get("workspaceId").and_then(Value::as_str),
        session.get("workspaceHash").and_then(Value::as_str),
    )
}

pub(crate) fn scoped_sessions(
    gui: &GuiState,
    scope_key: &str,
    include_archived: bool,
) -> Vec<Value> {
    gui.sessions
        .iter()
        .filter(|session| include_archived || !is_archived_session(session))
        .filter(|session| session_scope_key(session) == scope_key)
        .cloned()
        .collect()
}

pub(crate) fn session_by_id<'a>(gui: &'a GuiState, session_id: &str) -> Option<&'a Value> {
    gui.sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
}

pub(crate) fn current_agent_session_id_for_scope(
    gui: &mut GuiState,
    scope_key: &str,
) -> Option<String> {
    if let Some(current_id) = gui.current_session_ids_by_scope.get(scope_key) {
        if gui.sessions.iter().any(|session| {
            session.get("id").and_then(Value::as_str) == Some(current_id.as_str())
                && !is_archived_session(session)
                && session_scope_key(session) == scope_key
        }) {
            return Some(current_id.clone());
        }
    }

    let next_id = gui
        .sessions
        .iter()
        .find(|session| !is_archived_session(session) && session_scope_key(session) == scope_key)
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned);
    if let Some(next_id) = next_id.as_ref() {
        gui.current_session_ids_by_scope
            .insert(scope_key.to_string(), next_id.clone());
    }
    next_id
}

pub(crate) fn ensure_current_agent_session(
    gui: &mut GuiState,
    fallback_scope: Option<(Option<String>, Option<String>, Option<String>)>,
) {
    if let Some(next_id) = gui
        .sessions
        .iter()
        .find(|session| !is_archived_session(session))
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
    {
        gui.current_session_id = Some(next_id);
        return;
    }

    let id = format!("session-{}", now_millis());
    let now = now_text();
    let (profile_id, workspace_id, workspace_hash) = fallback_scope.unwrap_or_default();
    let session = create_agent_session_value(
        &id,
        &now,
        "New Agent Session",
        "plan",
        profile_id.as_deref(),
        workspace_id.as_deref(),
        workspace_hash.as_deref(),
    );
    gui.current_session_id = Some(id.clone());
    gui.session_projection_cache.insert(id.clone(), Vec::new());
    gui.trace_events.insert(id.clone(), Vec::new());
    gui.sessions.insert(0, session);
}

pub(crate) fn ensure_current_agent_session_for_scope(
    gui: &mut GuiState,
    scope_key: &str,
    fallback_scope: Option<(Option<String>, Option<String>, Option<String>)>,
) {
    if let Some(next_id) = gui
        .sessions
        .iter()
        .find(|session| !is_archived_session(session) && session_scope_key(session) == scope_key)
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
    {
        gui.current_session_ids_by_scope
            .insert(scope_key.to_string(), next_id.clone());
        gui.current_session_id = Some(next_id);
        return;
    }

    let id = format!("session-{}", now_millis());
    let now = now_text();
    let (profile_id, workspace_id, workspace_hash) = fallback_scope.unwrap_or_default();
    let session = create_agent_session_value(
        &id,
        &now,
        "New Agent Session",
        "plan",
        profile_id.as_deref(),
        workspace_id.as_deref(),
        workspace_hash.as_deref(),
    );
    gui.current_session_id = Some(id.clone());
    gui.current_session_ids_by_scope
        .insert(session_scope_key(&session), id.clone());
    gui.session_projection_cache.insert(id.clone(), Vec::new());
    gui.trace_events.insert(id.clone(), Vec::new());
    gui.sessions.insert(0, session);
}

pub(crate) fn compact_agent_session_title(content: &str) -> Option<String> {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    const TITLE_CHAR_LIMIT: usize = 28;
    let char_count = normalized.chars().count();
    if char_count <= TITLE_CHAR_LIMIT {
        return Some(normalized);
    }
    let title = normalized
        .chars()
        .take(TITLE_CHAR_LIMIT)
        .collect::<String>();
    Some(format!("{title}…"))
}

pub(crate) fn maybe_auto_title_session(gui: &mut GuiState, session_id: &str, content: &str) {
    let Some(title) = compact_agent_session_title(content) else {
        return;
    };
    if let Some(session) = session_mut(gui, session_id) {
        let source = session
            .get("titleSource")
            .and_then(Value::as_str)
            .unwrap_or("pending");
        if source == "pending" {
            session["title"] = json!(title);
            session["titleSource"] = json!("auto");
            session["updatedAt"] = json!(now_text());
        }
    }
}

pub(crate) fn first_user_message_content(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        if event.get("kind").and_then(Value::as_str) != Some("user_msg") {
            return None;
        }
        event
            .get("payload")
            .and_then(|payload| payload.get("content"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}

pub(crate) fn refresh_pending_session_titles(gui: &mut GuiState) {
    let sessions_dir = gui.paths.sessions_dir.clone();
    let pending_ids = gui
        .sessions
        .iter()
        .filter(|session| {
            session
                .get("titleSource")
                .and_then(Value::as_str)
                .unwrap_or("pending")
                == "pending"
        })
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    for session_id in pending_ids {
        let events = gui
            .session_projection_cache
            .get(&session_id)
            .cloned()
            .unwrap_or_else(|| read_session_projection_jsonl(&sessions_dir, &session_id));
        if let Some(content) = first_user_message_content(&events) {
            maybe_auto_title_session(gui, &session_id, &content);
        }
    }
}

pub(crate) fn has_session(gui: &GuiState, session_id: &str) -> bool {
    gui.sessions.iter().any(|session| {
        session.get("id").and_then(Value::as_str) == Some(session_id)
            && !is_archived_session(session)
    })
}

pub(crate) fn session_mut<'a>(gui: &'a mut GuiState, session_id: &str) -> Option<&'a mut Value> {
    gui.sessions
        .iter_mut()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
}

pub(crate) fn update_session_event_count(gui: &mut GuiState, session_id: &str) {
    let count = gui
        .session_projection_cache
        .get(session_id)
        .map(Vec::len)
        .unwrap_or_default();
    if let Some(session) = session_mut(gui, session_id) {
        session["eventCount"] = json!(count);
        session["updatedAt"] = json!(now_text());
    }
}

pub(crate) fn session_result(gui: &GuiState, session_id: &str) -> Json<ApiResponse> {
    let Some(session) = gui
        .sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
    else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    let events = gui
        .session_projection_cache
        .get(session_id)
        .cloned()
        .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, session_id));
    ApiResponse::ok(json!({
        "session": session,
        "events": events
    }))
}

pub(crate) fn agent_event(session_id: &str, kind: &str, payload: Value, ts: &str) -> Value {
    json!({
        "id": format!("evt-{}-{}", kind, now_millis()),
        "sessionId": session_id,
        "ts": ts,
        "kind": kind,
        "payload": payload
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_session_list_and_current_are_workspace_owned() {
        let mut gui = GuiState::new();
        let now = "2026-06-05T00:00:00Z";
        let session_a = create_agent_session_value(
            "session-a",
            now,
            "Workspace A",
            "plan",
            None,
            Some("workspace-a"),
            Some("hash-a"),
        );
        let session_b = create_agent_session_value(
            "session-b",
            now,
            "Workspace B",
            "plan",
            None,
            Some("workspace-b"),
            Some("hash-b"),
        );
        let scope_a = session_scope_key(&session_a);
        let scope_b = session_scope_key(&session_b);
        gui.sessions = vec![session_b, session_a];
        gui.current_session_ids_by_scope
            .insert(scope_a.clone(), "session-a".to_string());
        gui.current_session_ids_by_scope
            .insert(scope_b.clone(), "session-b".to_string());

        assert_eq!(
            scoped_sessions(&gui, &scope_a, false)
                .iter()
                .filter_map(|session| session.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["session-a"]
        );
        assert_eq!(
            scoped_sessions(&gui, &scope_b, false)
                .iter()
                .filter_map(|session| session.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["session-b"]
        );
        assert_eq!(
            current_agent_session_id_for_scope(&mut gui, &scope_a).as_deref(),
            Some("session-a")
        );
        assert_eq!(
            current_agent_session_id_for_scope(&mut gui, &scope_b).as_deref(),
            Some("session-b")
        );

        session_mut(&mut gui, "session-a").unwrap()["archivedAt"] = json!(now);
        gui.current_session_ids_by_scope.remove(&scope_a);
        ensure_current_agent_session_for_scope(
            &mut gui,
            &scope_a,
            Some((
                None,
                Some("workspace-a".to_string()),
                Some("hash-a".to_string()),
            )),
        );

        assert_ne!(
            current_agent_session_id_for_scope(&mut gui, &scope_a).as_deref(),
            Some("session-b")
        );
        assert_eq!(
            current_agent_session_id_for_scope(&mut gui, &scope_b).as_deref(),
            Some("session-b")
        );
    }
}
