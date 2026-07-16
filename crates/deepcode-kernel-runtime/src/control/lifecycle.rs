use super::*;

impl DeepCodeKernelRuntime {
    pub fn config_modified_audit(
        &mut self,
        config_kind: &str,
        changed_keys: Vec<String>,
        store_path: Option<String>,
        old_hash: Option<String>,
        new_hash: Option<String>,
        source: &str,
    ) -> KernelResult<Value> {
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        let payload = serde_json::json!({
            "summary": "Protected configuration modified.",
            "configKind": config_kind,
            "changedKeys": changed_keys,
            "storePath": store_path,
            "oldHash": old_hash,
            "newHash": new_hash,
            "source": source,
            "message": "配置文件已修改，并已写入 Kernel 审计记录。"
        });
        self.ledger.append(LedgerEvent {
            id: format!("evt-config-modified-{sequence}"),
            run_id: None,
            session_id: None,
            kind: "config.modified".to_string(),
            sequence: Some(sequence),
            payload: payload.clone(),
            created_at: None,
        })?;
        Ok(payload)
    }

    pub(crate) fn run_create(
        &mut self,
        request_id: RequestId,
        session_id: Option<SessionId>,
        input: UserInput,
        workspace_binding: Option<WorkspaceBinding>,
        profile_ref: Option<ProfileRef>,
        run_overrides: Option<Value>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let workspace_binding = normalize_run_workspace_binding(
            workspace_binding.unwrap_or_else(empty_workspace_binding),
        )?;
        let attachments = input
            .attachments
            .iter()
            .map(|attachment| {
                let normalized =
                    normalized_explicit_attachment_grant(attachment).ok_or_else(|| {
                        KernelError::InvalidCommand(
                            "run attachment must be an existing explicit file or directory"
                                .to_string(),
                        )
                    })?;
                let resource_id = normalized
                    .get("resourceId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        KernelError::InvalidCommand(
                            "run attachment requires a Session-assigned resourceId".to_string(),
                        )
                    })?;
                if !resource_id.starts_with("external-resource-") {
                    return Err(KernelError::InvalidCommand(
                        "run attachment resourceId is not an external resource identifier"
                            .to_string(),
                    ));
                }
                Ok(normalized)
            })
            .collect::<KernelResult<Vec<_>>>()?;
        self.state.next_run_index += 1;
        let run_id = format!("run-{}", self.state.next_run_index);
        let session_id = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| format!("session-{}", self.state.next_run_index));
        let config_snapshot = self.resolve_minimal_config(
            &run_id,
            profile_ref.as_ref().map(|value| value.id.clone()),
            run_overrides,
        )?;
        let config_ref = ConfigSnapshotRef {
            snapshot_id: config_snapshot.snapshot_id.clone(),
            hash: config_snapshot.hash.clone(),
        };
        let mut sequence = 0_u64;

        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "run.started",
            sequence,
            serde_json::json!({
                "summary": "Kernel driver run created.",
                "inputText": &input.text,
                "attachmentCount": attachments.len(),
                "workspaceBinding": &workspace_binding,
                "configRef": &config_ref,
                "profileRef": &profile_ref,
                "policyProfile": &self.policy_profile.id,
                "driverLoop": "session"
            }),
        )?;

        if let Some(open_path) = workspace_binding.open_path.as_deref() {
            let resource_id =
                resource_instance_id("workspace-read-lease", &[run_id.as_str(), open_path]);
            let resource = KernelResource::active(
                KernelResourceIdentity::new(
                    resource_id.clone(),
                    format!("workspace-read:{run_id}"),
                    format!("workspace-read:{run_id}:{open_path}"),
                ),
                KernelResourceKind::WorkspaceReadLease,
                KernelResourceOwner::agent_run(Some(session_id.clone()), run_id.clone()),
                KernelResourceScope::Run,
                KernelResourceCleanupPolicy::OnRunEnd,
                serde_json::json!({
                    "workspaceId": workspace_binding.workspace_id,
                    "workspaceHash": workspace_binding.workspace_hash,
                    "openPath": open_path,
                    "access": "read",
                    "managedBy": "kernel.resourceManager"
                }),
            );
            sequence += 1;
            self.state
                .resource_manager
                .acquire_batch(vec![resource], |acquired| {
                    self.append_ledger(
                        &run_id,
                        &session_id,
                        "resource.acquired_batch",
                        sequence,
                        serde_json::json!({
                            "summary": "Kernel registered the run-bound workspace read lease.",
                            "resources": acquired,
                        }),
                    )
                })?;
        }

        for attachment in &attachments {
            let resource_id = attachment
                .get("resourceId")
                .and_then(Value::as_str)
                .expect("validated attachment resourceId");
            let canonical_path = attachment
                .get("absolutePath")
                .and_then(Value::as_str)
                .expect("validated attachment absolutePath");
            let target_kind = match attachment.get("kind").and_then(Value::as_str) {
                Some("directory") => ExternalResourceKind::Directory,
                _ => ExternalResourceKind::File,
            };
            let lease = ExternalResourceLease {
                resource_id: resource_id.to_string(),
                root_id: resource_id.to_string(),
                canonical_path: canonical_path.to_string(),
                target_kind,
            };
            let internal_resource_id = resource_instance_id(
                "external-resource-lease",
                &[run_id.as_str(), lease.resource_id.as_str()],
            );
            let resource = KernelResource::active(
                KernelResourceIdentity::new(
                    internal_resource_id,
                    format!("external-resource:{run_id}:{}", lease.resource_id),
                    format!("external-resource:{run_id}:{}", lease.resource_id),
                ),
                KernelResourceKind::ExternalResourceLease,
                KernelResourceOwner::agent_run(Some(session_id.clone()), run_id.clone()),
                KernelResourceScope::Run,
                KernelResourceCleanupPolicy::OnRunEnd,
                serde_json::to_value(&lease).map_err(|error| {
                    KernelError::Other(format!("serialize external resource lease: {error}"))
                })?,
            );
            sequence += 1;
            self.state
                .resource_manager
                .acquire_batch(vec![resource], |acquired| {
                    self.append_ledger(
                        &run_id,
                        &session_id,
                        "resource.acquired_batch",
                        sequence,
                        serde_json::json!({
                            "summary": "Kernel registered an external resource read lease.",
                            "resources": acquired,
                            "externalResourceId": resource_id,
                            "targetKind": lease.target_kind
                        }),
                    )
                })?;
        }

        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "config.snapshot.attached",
            sequence,
            serde_json::json!({
                "summary": "Config snapshot attached.",
                "snapshotRef": &config_ref,
                "sources": &config_snapshot.source_refs
            }),
        )?;

        sequence += 1;
        self.state.records_by_session.insert(
            session_id.clone(),
            RuntimeRunRecord {
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                attachments,
                workspace_binding,
                config_ref,
                lifecycle_state: RuntimeLifecycleState::Ready,
            },
        );

        self.append_ledger(
            &run_id,
            &session_id,
            "runtime.lifecycle_changed",
            sequence,
            serde_json::json!({
                "summary": "Kernel runtime initialized and is ready for Session input.",
                "previousState": RuntimeLifecycleState::Created,
                "currentState": RuntimeLifecycleState::Ready,
                "reason": "runInitialized"
            }),
        )?;
        let lifecycle_event = KernelEvent::RuntimeLifecycleChanged {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.clone()),
            session_id: Some(SessionId(session_id.clone())),
            previous_state: Some(RuntimeLifecycleState::Created),
            current_state: RuntimeLifecycleState::Ready,
            reason: Some("runInitialized".to_string()),
            sequence: Some(sequence),
        };

        let record = self.record_by_run(&run_id)?;
        let contract = self.state_contract_for_record(&record);
        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "state.entered",
            sequence,
            serde_json::json!({
                "summary": "Kernel state contract produced.",
                "stateContract": &contract
            }),
        )?;
        let state_event = KernelEvent::StateEntered {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.clone()),
            session_id: Some(SessionId(session_id.clone())),
            state_contract: contract.clone(),
            sequence: Some(sequence),
        };

        let driver_request = self.driver_request_for_contract(
            &contract,
            Some(SessionId(session_id.clone())),
            DriverRequestKind::NeedProposal,
            "Session should assemble context and submit a Protocol v4 proposal.",
        );
        sequence += 1;
        self.append_ledger(
            &run_id,
            &session_id,
            "driver.request_produced",
            sequence,
            serde_json::json!({
                "summary": "DriverRequest produced for Session DriverLoop.",
                "driverRequest": &driver_request
            }),
        )?;
        let driver_event = KernelEvent::DriverRequestProduced {
            request_id: Some(request_id),
            run_id: RunId(run_id),
            session_id: Some(SessionId(session_id)),
            driver_request,
            sequence: Some(sequence),
        };

        Ok(vec![lifecycle_event, state_event, driver_event])
    }

    pub(crate) fn state_contract_get(
        &mut self,
        request_id: RequestId,
        run_id: Option<RunId>,
        session_id: Option<SessionId>,
    ) -> KernelResult<Vec<KernelEvent>> {
        let (run_id, session_id) = self.resolve_run_session(run_id, session_id)?;
        let record = self.record_by_run(&run_id)?;
        let contract = self.state_contract_for_record(&record);
        let sequence = self.ledger.next_sequence(&run_id)?;
        self.append_ledger(
            &run_id,
            &session_id,
            "state.entered",
            sequence,
            serde_json::json!({
                "summary": "Kernel state contract read.",
                "stateContract": &contract
            }),
        )?;
        Ok(vec![KernelEvent::StateEntered {
            request_id: Some(request_id),
            run_id: RunId(run_id),
            session_id: Some(SessionId(session_id)),
            state_contract: contract,
            sequence: Some(sequence),
        }])
    }
}

fn normalize_run_workspace_binding(binding: WorkspaceBinding) -> KernelResult<WorkspaceBinding> {
    let Some(open_path) = binding
        .open_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return Ok(binding);
    };
    let resolved = resolve_workspace_root(open_path)
        .map_err(|error| KernelError::WorkspaceRootUnreadable(format!("{open_path}: {error}")))?;
    preflight_workspace_root_readable(&resolved.root)?;
    Ok(workspace_binding_from_root(&resolved.root))
}
