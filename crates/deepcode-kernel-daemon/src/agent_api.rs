#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolExecuteRequest {
    pub(crate) workspace_binding: Option<WorkspaceBinding>,
    pub(crate) tool_call: ToolCallRequest,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCallRequest {
    pub(crate) id: Option<String>,
    pub(crate) name: String,
    pub(crate) arguments: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentResourceResolveRequest {
    pub(crate) workspace_binding: Option<WorkspaceBinding>,
    pub(crate) manifest: AgentResourceManifest,
    pub(crate) request: AgentResourceRequest,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentResourceManifest {
    pub(crate) id: String,
    pub(crate) workspace_scope_key: String,
    pub(crate) workspace_id: Option<String>,
    pub(crate) entries: Vec<AgentResourceManifestEntry>,
    pub(crate) budget: AgentResourceManifestBudget,
    pub(crate) default_deny_patterns: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentResourceManifestBudget {
    pub(crate) max_entries: usize,
    pub(crate) max_bytes: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentResourceManifestEntry {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) resource_ref: String,
    pub(crate) read_policy: String,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentResourceRequest {
    pub(crate) id: String,
    pub(crate) items: Vec<AgentResourceRequestItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentResourceRequestItem {
    pub(crate) id: String,
    pub(crate) manifest_entry_id: String,
    pub(crate) reason: String,
}

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
    let request = build_agent_run_request(&body);
    {
        let mut gui = state.gui.lock().expect("gui state lock");
        if !has_session(&gui, &session_id) {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        }
        maybe_auto_title_session(&mut gui, &session_id, &request.content);
    }

    let user_event = agent_event(
        &session_id,
        "user_msg",
        json!({
            "content": request.content,
            "attachments": body.get("attachments").cloned().unwrap_or_else(|| json!([])),
            "channel": "user",
            "visibility": "conversation"
        }),
        &now_text(),
    );
    append_session_projection(&state, &session_id, vec![user_event]);

    if let Err(error) = start_kernel_agent_run(&state, &session_id, request).await {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "error",
                json!({
                    "message": error,
                    "channel": "error",
                    "visibility": "conversation"
                }),
                &now_text(),
            )],
        );
    }

    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
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
    if let Err(error) = drive_kernel_agent_loop(&state, &session_id, kernel_events).await {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "error",
                json!({
                    "message": error,
                    "channel": "error",
                    "visibility": "conversation"
                }),
                &now_text(),
            )],
        );
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

pub(crate) async fn agent_plan_resolve(
    State(state): State<AppState>,
    Path((run_id, plan_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let decision = body
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("reject");
    let guidance = body
        .get("guidance")
        .and_then(Value::as_str)
        .map(str::to_string);
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
    let kernel_events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        let mut events = Vec::new();
        let mut grant_failed = false;
        if decision == "accept" {
            let (grants, approved_tools, pending_review) = {
                let gui = state.gui.lock().expect("gui state lock");
                gui.pending_plans.get(&plan_id).map_or_else(
                    || (Vec::new(), Vec::new(), None),
                    |plan| {
                        (
                            temporary_grants_for_pending_plan(plan),
                            approved_tool_calls_for_pending_plan(plan),
                            pending_review_for_plan(plan),
                        )
                    },
                )
            };
            if let Some(review) = pending_review {
                state
                    .gui
                    .lock()
                    .expect("gui state lock")
                    .pending_reviews
                    .insert(run_id.clone(), review);
            }
            for grant in grants {
                match runtime.dispatch(KernelCommand::PermissionGrantTemporary {
                    request_id: rid("agent-plan-temp-grant"),
                    run_id: deepcode_kernel_abi::RunId(run_id.clone()),
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
            if !grant_failed {
                if let Err(error) = runtime.enqueue_approved_tool_calls(&run_id, approved_tools) {
                    events.push(KernelEvent::Error {
                        request_id: Some(rid("agent-plan-approved-tools")),
                        run_id: Some(deepcode_kernel_abi::RunId(run_id.clone())),
                        session_id: None,
                        error: KernelErrorEnvelope::from(&error),
                        message_key: None,
                        args: None,
                    });
                    grant_failed = true;
                }
            }
        }
        if grant_failed {
            events
        } else {
            match runtime.dispatch(command) {
                Ok(mut command_events) => {
                    events.append(&mut command_events);
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
    let session_id = kernel_events
        .iter()
        .find_map(kernel_event_session_id)
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
    state
        .gui
        .lock()
        .expect("gui state lock")
        .pending_plans
        .remove(&plan_id);
    if let Err(error) = drive_kernel_agent_loop(&state, &session_id, kernel_events).await {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "error",
                json!({
                    "message": error,
                    "channel": "error",
                    "visibility": "conversation"
                }),
                &now_text(),
            )],
        );
    }
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_review_resolve(
    State(state): State<AppState>,
    Path((session_id, run_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
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
        return ApiResponse::error("agent_review_not_found", "agent review not found");
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
                    "status": "needsRevision",
                    "runId": run_id.clone(),
                    "reviewId": run_id.clone(),
                    "confirmable": false,
                    "guidance": guidance,
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
                "status": "accepted",
                "runId": run_id.clone(),
                "reviewId": run_id.clone(),
                "confirmable": false,
                "continuationCount": review.continuations.len(),
                "channel": "progress",
                "visibility": "conversation",
                "presentation": "body"
            }),
            &now_text(),
        )],
    );

    if review.continuations.is_empty() {
        let gui = state.gui.lock().expect("gui state lock");
        return session_result(&gui, &session_id);
    }

    let plan = continuation_plan_from_review(&review);
    let mut review_events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        match runtime.dispatch(KernelCommand::PlanContractSubmit {
            request_id: rid("agent-review-continuation-plan"),
            run_id: Some(deepcode_kernel_abi::RunId(plan.run_id.clone())),
            session_id: Some(deepcode_kernel_abi::SessionId(session_id.clone())),
            contract: plan.action_bundle.clone(),
        }) {
            Ok(events) => events,
            Err(error) => vec![KernelEvent::Error {
                request_id: Some(rid("agent-review-continuation-plan")),
                run_id: Some(deepcode_kernel_abi::RunId(plan.run_id.clone())),
                session_id: Some(deepcode_kernel_abi::SessionId(session_id.clone())),
                error: KernelErrorEnvelope::from(&error),
                message_key: None,
                args: None,
            }],
        }
    };
    let mut plan = plan;
    plan.plan_review_report = review_events.iter().find_map(|event| {
        if let KernelEvent::PlanReviewReportProduced { report, .. } = event {
            Some(report.clone())
        } else {
            None
        }
    });
    {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.pending_plans.insert(plan.plan_id.clone(), plan.clone());
    }
    record_kernel_events(&state, &review_events);
    let mut projection = vec![plan_card_event(&session_id, &plan)];
    projection.extend(kernel_events_to_agent_events(&session_id, &review_events));
    append_session_projection(&state, &session_id, projection);
    review_events.clear();
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

fn continuation_plan_from_review(review: &PendingAgentReview) -> PendingAgentPlan {
    let plan_id = format!(
        "{}-continuation-{}",
        safe_path_segment(&review.source_plan_id),
        now_millis()
    );
    let actions = review.continuations.clone();
    let action_bundle = json!({
        "version": "1",
        "id": plan_id,
        "goal": format!("Continue after user review for {}", review.source_plan_id),
        "actions": actions,
        "validationExpectations": [
            {
                "id": "continuation-tool-validation",
                "description": "Kernel tool facts and post-tool validation must confirm the continuation."
            }
        ],
        "reviewExpectations": []
    });
    let summary = actions
        .first()
        .and_then(|action| action.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Continue after user review.")
        .to_string();
    PendingAgentPlan {
        session_id: review.session_id.clone(),
        run_id: review.run_id.clone(),
        plan_id: action_bundle
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("review-continuation")
            .to_string(),
        user_plan: summary,
        action_bundle,
        code_blocks: review.code_blocks.clone(),
        expected_validation:
            "Kernel executes the scoped continuation and records tool validation facts.".to_string(),
        review_guide: "Review the continuation plan before execution.".to_string(),
        plan_review_report: None,
        created_at: now_text(),
    }
}

pub(crate) fn approved_tool_calls_for_pending_plan(
    plan: &PendingAgentPlan,
) -> Vec<(String, String, Value)> {
    let code_blocks = plan
        .code_blocks
        .iter()
        .filter_map(|block| {
            let id = block.get("id")?.as_str()?.to_string();
            Some((id, block.clone()))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let actions = plan
        .action_bundle
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    actions
        .iter()
        .filter_map(|action| approved_tool_call_for_action(plan, action, &code_blocks))
        .collect()
}

fn approved_tool_call_for_action(
    plan: &PendingAgentPlan,
    action: &Value,
    code_blocks: &std::collections::BTreeMap<String, Value>,
) -> Option<(String, String, Value)> {
    let action_id = action.get("id")?.as_str()?.trim();
    let capability = action.get("capability")?.as_str()?.trim();
    let kind = action
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let resource_scope = action
        .get("resourceScope")
        .and_then(Value::as_array)
        .and_then(|items| items.iter().find_map(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let tool_call_id = format!(
        "approved-{}-{}",
        safe_path_segment(&plan.plan_id),
        safe_path_segment(action_id)
    );
    match capability {
        "workspace.write" if kind == "write" => {
            let source_block_id = action.get("sourceBlockId")?.as_str()?.trim();
            let block = code_blocks.get(source_block_id)?;
            let path = block.get("path")?.as_str()?.trim();
            let content = block.get("content")?.as_str()?;
            Some((
                tool_call_id,
                "fs.write".to_string(),
                json!({
                    "path": path,
                    "content": content
                }),
            ))
        }
        "workspace.delete" => Some((
            tool_call_id,
            "fs.delete".to_string(),
            json!({
                "path": resource_scope,
                "reason": format!("Approved plan {} action {}", plan.plan_id, action_id)
            }),
        )),
        "workspace.read" if kind == "list" => Some((
            tool_call_id,
            "fs.list".to_string(),
            json!({ "path": resource_scope }),
        )),
        "workspace.read" if kind == "read" => Some((
            tool_call_id,
            "fs.read".to_string(),
            json!({ "path": resource_scope }),
        )),
        "workspace.search" if kind == "search" => Some((
            tool_call_id,
            "code.search".to_string(),
            json!({ "query": search_query_from_scope(resource_scope) }),
        )),
        _ => None,
    }
}

fn search_query_from_scope(scope: &str) -> String {
    scope
        .strip_prefix("search:")
        .or_else(|| scope.strip_prefix("symbol:"))
        .unwrap_or(scope)
        .trim()
        .to_string()
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

fn pending_review_for_plan(plan: &PendingAgentPlan) -> Option<PendingAgentReview> {
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
    if continuations.is_empty() && review_expectations.is_empty() {
        return None;
    }
    Some(PendingAgentReview {
        session_id: plan.session_id.clone(),
        run_id: plan.run_id.clone(),
        source_plan_id: plan.plan_id.clone(),
        continuations,
        code_blocks: plan.code_blocks.clone(),
        review_expectations,
        created_at: now_text(),
    })
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

pub(crate) async fn agent_parse_actions() -> Json<ApiResponse> {
    ApiResponse::ok(json!({ "actions": [], "errors": [] }))
}

pub(crate) async fn agent_fixture_run() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "parse": { "actions": [], "errors": [] },
        "observations": []
    }))
}

pub(crate) async fn agent_resources_resolve(
    State(state): State<AppState>,
    Json(body): Json<AgentResourceResolveRequest>,
) -> Json<ApiResponse> {
    let mut items = Vec::new();
    let entries = body
        .manifest
        .entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let max_entries = body.manifest.budget.max_entries.max(1);
    let max_bytes = body.manifest.budget.max_bytes.max(256);

    for request_item in body.request.items.iter().take(max_entries) {
        let Some(entry) = entries.get(request_item.manifest_entry_id.as_str()) else {
            items.push(json!({
                "requestItemId": request_item.id,
                "manifestEntryId": request_item.manifest_entry_id,
                "readPolicy": "denyRead",
                "status": "denied",
                "denialReason": "resource is not listed in ResourceManifest",
                "sourceKind": "manifestOnly"
            }));
            continue;
        };
        match entry.read_policy.as_str() {
            "denyRead" => items.push(json!({
                "requestItemId": request_item.id,
                "manifestEntryId": entry.id,
                "readPolicy": entry.read_policy,
                "status": "denied",
                "denialReason": "resource is denied by manifest policy",
                "sourceKind": "manifestOnly"
            })),
            "askRead" => items.push(json!({
                "requestItemId": request_item.id,
                "manifestEntryId": entry.id,
                "readPolicy": entry.read_policy,
                "status": "needsUserApproval",
                "denialReason": "resource requires user approval before read",
                "sourceKind": "manifestOnly"
            })),
            _ => {
                let resource = resolve_auto_read_resource(
                    &state,
                    body.workspace_binding.as_ref(),
                    entry,
                    max_bytes,
                );
                match resource {
                    Ok((content, refs)) => items.push(json!({
                        "requestItemId": request_item.id,
                        "manifestEntryId": entry.id,
                        "readPolicy": "autoRead",
                        "status": "provided",
                        "contentSummary": content.content_summary,
                        "promptContent": content.prompt_content,
                        "contentKind": content.content_kind,
                        "truncated": content.truncated,
                        "originalBytes": content.original_bytes,
                        "evidenceRefs": refs,
                        "sourceKind": "kernelResource"
                    })),
                    Err(error) => items.push(json!({
                        "requestItemId": request_item.id,
                        "manifestEntryId": entry.id,
                        "readPolicy": "autoRead",
                        "status": "denied",
                        "denialReason": error,
                        "sourceKind": "kernelResource"
                    })),
                }
            }
        }
    }

    ApiResponse::ok(json!({
        "id": format!("resource-packet-{}", now_millis()),
        "workspaceScopeKey": body.manifest.workspace_scope_key,
        "requestId": body.request.id,
        "items": items
    }))
}

fn resolve_auto_read_resource(
    state: &AppState,
    binding: Option<&WorkspaceBinding>,
    entry: &AgentResourceManifestEntry,
    max_bytes: usize,
) -> Result<(ResolvedResourceContent, Vec<String>), String> {
    ensure_workspace_binding(&state.runtime, binding).map_err(|error| error.message)?;
    let output = match entry.kind.as_str() {
        "file" | "ruler" => crate::workspace_api::dispatch_workspace(
            &state.runtime,
            KernelCommand::WorkspaceRead {
                request_id: rid("agent-resource-read"),
                folder_id: None,
                path: entry.resource_ref.clone(),
            },
        )
        .map_err(|error| error.message)?,
        "search" | "symbol" => crate::workspace_api::dispatch_workspace(
            &state.runtime,
            KernelCommand::WorkspaceSearch {
                request_id: rid("agent-resource-search"),
                folder_id: None,
                query: entry.resource_ref.clone(),
                include: None,
                is_regex: false,
            },
        )
        .map_err(|error| error.message)?,
        "index" | "checkpoint" => json!({
            "summary": entry.resource_ref,
            "reason": entry.reason
        }),
        other => {
            return Err(format!(
                "resource kind {other} is not supported by Kernel resource resolver"
            ));
        }
    };
    Ok((
        summarize_resource_output(&output, max_bytes),
        vec![format!("kernel-resource:{}:{}", entry.kind, entry.id)],
    ))
}

struct ResolvedResourceContent {
    content_summary: String,
    prompt_content: String,
    content_kind: &'static str,
    truncated: bool,
    original_bytes: usize,
}

fn summarize_resource_output(output: &Value, max_bytes: usize) -> ResolvedResourceContent {
    let (content_kind, candidate) =
        if let Some(content) = output.get("content").and_then(Value::as_str) {
            ("fileText", content.to_string())
        } else if let Some(text) = output.get("text").and_then(Value::as_str) {
            ("text", text.to_string())
        } else if let Some(nodes) = output.get("nodes") {
            (
                "directoryTree",
                serde_json::to_string_pretty(nodes).unwrap_or_else(|_| nodes.to_string()),
            )
        } else if let Some(matches) = output.get("matches") {
            (
                "searchResults",
                serde_json::to_string_pretty(matches).unwrap_or_else(|_| matches.to_string()),
            )
        } else if let Some(summary) = output.get("summary").and_then(Value::as_str) {
            ("summary", summary.to_string())
        } else {
            (
                "json",
                serde_json::to_string_pretty(output).unwrap_or_else(|_| "{}".to_string()),
            )
        };
    let original_bytes = candidate.len();
    let max_chars = max_bytes.max(256);
    let prompt_content = candidate.chars().take(max_chars).collect::<String>();
    let truncated = prompt_content.len() < candidate.len();
    let content_summary = prompt_content.chars().take(1200).collect::<String>();
    ResolvedResourceContent {
        content_summary,
        prompt_content,
        content_kind,
        truncated,
        original_bytes,
    }
}

pub(crate) async fn agent_prompt_layers() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "layers": [
            {
                "id": "protocol-contract-v1",
                "kind": "builtin",
                "priority": 0,
                "contentHash": "protocol-contract:v1",
                "title": "Protocol Contract"
            },
            {
                "id": "builtin-system-prompt-v1",
                "kind": "builtin",
                "priority": 10,
                "contentHash": "builtin-system-prompt:v1",
                "title": "Builtin System Prompt"
            },
            {
                "id": "ruler-context",
                "kind": "workspace",
                "priority": 30,
                "contentHash": "ruler:settings",
                "title": "Ruler Context"
            }
        ]
    }))
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
