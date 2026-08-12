use crate::prelude::*;
use crate::*;

pub(crate) const HOST_CONVERSATION_DRAFT_TARGET_SCHEMA_V1: &str =
    "deepcode.host.conversation-draft-target.v1";
pub(crate) const HOST_COMPOSER_PROJECTION_SCHEMA_V1: &str = "deepcode.host.composer-projection.v1";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentComposerQueryV1 {
    pub(crate) project_id: Option<String>,
    pub(crate) session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AgentConversationDraftTargetV1 {
    Public {
        schema_version: String,
        target_id: String,
        target_revision: String,
        workspace_scope_key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_hash: Option<String>,
    },
    Project {
        schema_version: String,
        target_id: String,
        target_revision: String,
        project_id: String,
        workspace_scope_key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_binding_ref: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_binding_identity: Option<String>,
    },
}

impl AgentConversationDraftTargetV1 {
    pub(crate) fn target_id(&self) -> &str {
        match self {
            Self::Public { target_id, .. } | Self::Project { target_id, .. } => target_id,
        }
    }

    pub(crate) fn project_id(&self) -> Option<&str> {
        match self {
            Self::Project { project_id, .. } => Some(project_id),
            Self::Public { .. } => None,
        }
    }

    pub(crate) fn workspace_identity(&self) -> (Option<&str>, Option<&str>) {
        match self {
            Self::Public {
                workspace_id,
                workspace_hash,
                ..
            } => (workspace_id.as_deref(), workspace_hash.as_deref()),
            Self::Project { .. } => (None, None),
        }
    }
}

fn public_conversation_draft_target_v1(
    state: &AppState,
) -> Result<AgentConversationDraftTargetV1, crate::host_v2_storage::HostV2StorageError> {
    let workspace = current_workspace(&state.host_services.workspace).map_err(|error| {
        crate::host_v2_storage::HostV2StorageError::invalid(
            "composer_workspace_projection_unavailable",
            format!(
                "Current workspace is unavailable for Composer projection: {}",
                error.message
            ),
        )
    })?;
    let (workspace_id, workspace_hash) = match workspace.current {
        Some(workspace) => {
            let material = json!({
                "workspaceId": workspace.id,
                "source": workspace.source,
                "sourcePath": workspace.source_path,
                "folders": workspace.folders.iter().map(|folder| json!({
                    "id": folder.id,
                    "absolutePath": folder.absolute_path,
                })).collect::<Vec<_>>(),
            });
            let workspace_hash = crate::host_v2_storage::canonical_sha256(&material)?;
            (Some(workspace.id), Some(workspace_hash))
        }
        None => (None, None),
    };
    let workspace_scope_key =
        scope_key_from_parts(workspace_id.as_deref(), workspace_hash.as_deref());
    let target_id = format!("public-draft-{workspace_scope_key}");
    let revision_material = json!({
        "schemaVersion": HOST_CONVERSATION_DRAFT_TARGET_SCHEMA_V1,
        "kind": "public",
        "targetId": target_id,
        "workspaceScopeKey": workspace_scope_key,
        "workspaceId": workspace_id,
        "workspaceHash": workspace_hash,
    });
    let target_revision = crate::host_v2_storage::canonical_sha256(&revision_material)?;
    Ok(AgentConversationDraftTargetV1::Public {
        schema_version: HOST_CONVERSATION_DRAFT_TARGET_SCHEMA_V1.to_string(),
        target_id,
        target_revision,
        workspace_scope_key,
        workspace_id,
        workspace_hash,
    })
}

fn project_conversation_draft_target_v1(
    project: &Value,
) -> Result<AgentConversationDraftTargetV1, crate::host_v2_storage::HostV2StorageError> {
    let project_target = agent_project_conversation_target_v1(project)?;
    let target_id = format!("draft-{}", project_target.target_id);
    let revision_material = json!({
        "schemaVersion": HOST_CONVERSATION_DRAFT_TARGET_SCHEMA_V1,
        "kind": "project",
        "targetId": target_id,
        "projectId": project_target.project_id,
        "workspaceScopeKey": project_target.workspace_scope_key,
        "workspaceBindingRef": project_target.workspace_binding_ref,
        "workspaceBindingIdentity": project_target.workspace_binding_identity,
        "projectTargetRevision": project_target.target_revision,
    });
    let target_revision = crate::host_v2_storage::canonical_sha256(&revision_material)?;
    Ok(AgentConversationDraftTargetV1::Project {
        schema_version: HOST_CONVERSATION_DRAFT_TARGET_SCHEMA_V1.to_string(),
        target_id,
        target_revision,
        project_id: project_target.project_id,
        workspace_scope_key: project_target.workspace_scope_key,
        workspace_binding_ref: project_target.workspace_binding_ref,
        workspace_binding_identity: project_target.workspace_binding_identity,
    })
}

pub(crate) fn require_conversation_draft_target_v1(
    state: &AppState,
    supplied: &AgentConversationDraftTargetV1,
) -> Result<AgentConversationDraftTargetV1, crate::host_v2_storage::HostV2StorageError> {
    let expected = match supplied {
        AgentConversationDraftTargetV1::Public { .. } => {
            public_conversation_draft_target_v1(state)?
        }
        AgentConversationDraftTargetV1::Project { project_id, .. } => {
            let gui = state.gui.lock().expect("gui state lock");
            let project = project_by_id(&gui, project_id).ok_or_else(|| {
                crate::host_v2_storage::HostV2StorageError::not_found(
                    "agent_project_not_found",
                    "Composer Project target no longer exists",
                )
            })?;
            project_conversation_draft_target_v1(project)?
        }
    };
    if &expected != supplied {
        return Err(crate::host_v2_storage::HostV2StorageError::conflict(
            "agent_conversation_draft_target_stale",
            "The submitted conversationDraftTarget no longer identifies the exact navigation and workspace facts",
        ));
    }
    Ok(expected)
}

fn effective_composer_profiles(
    state: &AppState,
    config: &Value,
) -> Result<(Vec<Value>, Option<String>), ProviderTraceErrorV1> {
    if !llm_profile_store_is_current(config) {
        return Ok((Vec::new(), None));
    }
    let default_profile_id = preferred_effective_llm_profile_id(state, config)?;
    let mut profiles = Vec::new();
    for profile in config
        .get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(profile_id) = profile.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !effective_llm_profile_is_enabled(state, config, profile_id)? {
            continue;
        }
        profiles.push(json!({
            "profileId": profile_id,
            "name": profile.get("name").and_then(Value::as_str).unwrap_or(profile_id),
            "model": profile.get("model").and_then(Value::as_str).unwrap_or_default(),
            "providerFlavor": profile.get("providerFlavor").and_then(Value::as_str).unwrap_or("openai"),
            "isDefault": default_profile_id.as_deref() == Some(profile_id),
        }));
    }
    Ok((profiles, default_profile_id))
}

pub(crate) fn composer_pending_interaction(
    state: &AppState,
    session_id: &str,
) -> Result<Option<Value>, crate::host_v2_storage::HostV2StorageError> {
    Ok(state
        .host_services
        .projection_v2
        .latest_timeline(session_id)?
        .and_then(|timeline| timeline.pointer("/interactionProjection/pending").cloned()))
}

pub(crate) async fn agent_composer_projection_v1(
    State(state): State<AppState>,
    Query(query): Query<AgentComposerQueryV1>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let project_id = query
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let session_id = query
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if query.project_id.is_some() != project_id.is_some()
        || query.session_id.is_some() != session_id.is_some()
        || project_id.is_some_and(|value| value.len() > 512 || value.chars().any(char::is_control))
        || session_id.is_some_and(|value| value.len() > 512 || value.chars().any(char::is_control))
    {
        return ApiResponse::error(
            "agent_composer_query_invalid",
            "Composer projectId and sessionId must be non-empty bounded identities when supplied",
        );
    }

    let public_draft_target = if session_id.is_none() && project_id.is_none() {
        match public_conversation_draft_target_v1(&state) {
            Ok(target) => Some(target),
            Err(error) => return ApiResponse::error(error.code, error.message),
        }
    } else {
        None
    };

    let (config, conversation_target, conversation_draft_target, stored_profile_id) = {
        let gui = state.gui.lock().expect("gui state lock");
        if let Some(session_id) = session_id {
            let session = match verified_selectable_session(&gui, session_id) {
                Ok(session) => session,
                Err(response) => return response,
            };
            if project_id.is_some()
                && session.get("projectId").and_then(Value::as_str) != project_id
            {
                return ApiResponse::error(
                    "agent_composer_target_mismatch",
                    "Composer Session does not belong to the requested Project target",
                );
            }
            let target = match agent_conversation_target_v1(session) {
                Ok(target) => target,
                Err(error) => return ApiResponse::error(error.code, error.message),
            };
            (
                gui.llm_profiles.clone(),
                Some(target),
                None,
                session
                    .get("profileId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )
        } else {
            let target = if let Some(project_id) = project_id {
                let Some(project) = project_by_id(&gui, project_id) else {
                    return ApiResponse::error(
                        "agent_project_not_found",
                        "agent project not found",
                    );
                };
                match project_conversation_draft_target_v1(project) {
                    Ok(target) => target,
                    Err(error) => return ApiResponse::error(error.code, error.message),
                }
            } else {
                public_draft_target.expect("public draft target was resolved before metadata lock")
            };
            (gui.llm_profiles.clone(), None, Some(target), None)
        }
    };
    composer_projection_response(
        &state,
        config,
        conversation_target,
        conversation_draft_target,
        stored_profile_id,
    )
}

fn composer_projection_response(
    state: &AppState,
    config: Value,
    conversation_target: Option<AgentConversationTargetV1>,
    conversation_draft_target: Option<AgentConversationDraftTargetV1>,
    stored_profile_id: Option<String>,
) -> Json<ApiResponse> {
    let (enabled_profiles, default_profile_id) = match effective_composer_profiles(state, &config) {
        Ok(profiles) => profiles,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let enabled_profile_ids = enabled_profiles
        .iter()
        .filter_map(|profile| profile.get("profileId").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    let selected_profile_id = match stored_profile_id.as_deref() {
        Some(profile_id) if enabled_profile_ids.contains(profile_id) => {
            Some(profile_id.to_string())
        }
        Some(_) => None,
        None if conversation_target.is_none() => default_profile_id.clone(),
        None => None,
    };
    let session_id = conversation_target
        .as_ref()
        .map(|target| target.session_id.as_str());
    let active_run = match session_id {
        Some(session_id) => match state
            .host_services
            .active_runs_v2
            .resolve_session_active_run(session_id)
        {
            Ok(Some(active)) => {
                let status = match active.lifecycle {
                    crate::host_run_broker_v2::HostRunLifecycleV2::Active => "active",
                    crate::host_run_broker_v2::HostRunLifecycleV2::Retiring => "retiring",
                    crate::host_run_broker_v2::HostRunLifecycleV2::Retired => {
                        return ApiResponse::error(
                            "agent_composer_active_run_invalid",
                            "Composer active Run lookup returned a retired lifecycle",
                        )
                    }
                };
                Some(json!({
                    "hostRunId": active.host_run_id,
                    "runId": active.run_id,
                    "status": status,
                }))
            }
            Ok(None) => None,
            Err(error) => return ApiResponse::error(error.code, error.message),
        },
        None => None,
    };
    let pending_interaction = match session_id {
        Some(session_id) => match composer_pending_interaction(state, session_id) {
            Ok(pending) => pending,
            Err(error) => return ApiResponse::error(error.code, error.message),
        },
        None => None,
    };
    let block_reason = if active_run.is_some() {
        Some("activeRun")
    } else if pending_interaction.is_some() {
        Some("pendingInteraction")
    } else if enabled_profiles.is_empty() {
        Some("noEnabledProfile")
    } else if selected_profile_id.is_none() {
        Some("selectedProfileUnavailable")
    } else {
        None
    };
    let selection_mutable = active_run.is_none() && pending_interaction.is_none();
    // An active Run or interaction freezes the Profile choice, not the text
    // input lane. Session still admits that input as canonical user guidance.
    let can_submit = selected_profile_id.is_some();
    let mut projection = json!({
        "schemaVersion": HOST_COMPOSER_PROJECTION_SCHEMA_V1,
        "revision": "pending",
        "conversationTarget": conversation_target,
        "conversationDraftTarget": conversation_draft_target,
        "enabledProfiles": enabled_profiles,
        "defaultProfileId": default_profile_id,
        "selectedProfileId": selected_profile_id,
        "selectionMutable": selection_mutable,
        "canSubmit": can_submit,
        "blockReason": block_reason,
        "activeRun": active_run,
        "pendingInteraction": pending_interaction,
    });
    if let Some(object) = projection.as_object_mut() {
        for optional in [
            "conversationTarget",
            "conversationDraftTarget",
            "defaultProfileId",
            "selectedProfileId",
            "blockReason",
            "activeRun",
            "pendingInteraction",
        ] {
            if object.get(optional).is_some_and(Value::is_null) {
                object.remove(optional);
            }
        }
    }
    let revision_material = match projection.as_object_mut() {
        Some(object) => {
            object.remove("revision");
            Value::Object(object.clone())
        }
        None => unreachable!("Composer projection is an object"),
    };
    let revision = match crate::host_v2_storage::canonical_sha256(&revision_material) {
        Ok(revision) => revision,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    projection["revision"] = json!(revision);
    ApiResponse::ok(projection)
}
