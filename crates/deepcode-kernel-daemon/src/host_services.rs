use crate::host_inspection::HostInspectionExecutor;
use crate::host_kernel_operation_store_v2::HostKernelOperationStoreV2;
use crate::host_run_broker_v2::{
    HostActiveRunBrokerV2, HostKernelRunRetirementProofV2, HostRunRetirementReceiptV2,
    HostRunSettingsCeilingV2, HostSessionTurnGuardV2,
};
use crate::host_v2_storage::{
    append_json_line_durable, canonical_sha256, reject_transport_capabilities,
    validate_bounded_identity, validate_sha256_digest, with_storage_path_lock, HostV2StorageError,
};
use crate::host_workspace_registry_v2::{
    HostWorkspaceBindingRegisteredV2, HostWorkspaceBindingResolverV2, HostWorkspaceRegistryAdminV2,
    HostWorkspaceRegistryErrorV2, HostWorkspaceRegistryReadinessV2, HostWorkspaceRegistryV2,
    HostWorkspaceRehydrateRecordV2, HostWorkspaceResolveErrorV2,
};
use crate::prelude::*;
use crate::session_kernel_v2_store::{SessionKernelProjectionSinkV2, SessionKernelV2Store};
use deepcode_kernel_abi::v2::{RunId, RunRetirementReasonCodeV2};
use deepcode_kernel_abi::{
    HostInspectionResult, HostResultSource, HostSkillActivationStatus, HostSkillAdapterKind,
    HostSkillCatalogResult, HostSkillDescriptor, HostSkillEffect, HostSkillRiskLevel,
    HostSkillSource, HostUnsupportedWorkspaceField, HostWorkspaceBindingResolved,
    HostWorkspaceFolder, HostWorkspaceOpened, HostWorkspaceRootStatus, HostWorkspaceSaved,
    HostWorkspaceSourceKind, HostWorkspaceSpec, WorkspaceBinding, WorkspaceBindingRefV2,
};
use deepcode_kernel_ledger::v2::CanonicalFactReader;
use deepcode_kernel_runtime::v2::KernelSessionServiceV2;
use deepcode_kernel_skills::{scan_skill_mount, SkillActivationStatus, SkillMountEntry};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
struct HostWorkspaceRecord {
    id: String,
    name: String,
    source: HostWorkspaceSourceKind,
    source_path: Option<PathBuf>,
    root: PathBuf,
    original_folder_path: String,
    folder_is_absolute: bool,
    settings: Value,
    unsupported_fields: Vec<HostUnsupportedWorkspaceField>,
    opened_at: String,
}

#[derive(Debug, Default)]
struct HostWorkspaceState {
    next_workspace_index: u64,
    current: Option<HostWorkspaceRecord>,
}

#[derive(Clone)]
pub(crate) struct HostWorkspaceService {
    state: Arc<Mutex<HostWorkspaceState>>,
    registry_admin: HostWorkspaceRegistryAdminV2,
    registry_resolver: Arc<HostWorkspaceRegistryV2>,
}

impl HostWorkspaceService {
    fn from_projects(
        projects: &[Value],
        mut additional_bindings: Vec<HostWorkspaceRehydrateRecordV2>,
    ) -> Self {
        let (registry_admin, registry_resolver) = HostWorkspaceRegistryV2::new_pair();
        let mut bindings = trusted_project_binding_records(projects);
        bindings.append(&mut additional_bindings);
        let _ = registry_admin.rehydrate(bindings);
        Self {
            state: Arc::new(Mutex::new(HostWorkspaceState::default())),
            registry_admin,
            registry_resolver: Arc::new(registry_resolver),
        }
    }

    pub(crate) fn resolver_v2(&self) -> Arc<dyn HostWorkspaceBindingResolverV2> {
        self.registry_resolver.clone()
    }

    pub(crate) fn readiness(&self) -> HostWorkspaceRegistryReadinessV2 {
        self.registry_admin.readiness()
    }

    pub(crate) fn register_managed_root(
        &self,
        root: &Path,
    ) -> Result<HostWorkspaceBindingRegisteredV2, KernelErrorEnvelope> {
        self.registry_admin.register(root).map_err(registry_error)
    }

    pub(crate) fn resolve_exact_run_binding(
        &self,
        workspace_binding_ref: &WorkspaceBindingRefV2,
        expected_workspace_identity: &str,
    ) -> Result<WorkspaceBinding, KernelErrorEnvelope> {
        let root = self
            .registry_resolver
            .resolve_exact(workspace_binding_ref, expected_workspace_identity)
            .map_err(registry_error)?;
        Ok(workspace_binding_from_root(&root))
    }

    pub(crate) fn validate_requested_run_workspace(
        &self,
        path: &str,
        workspace_binding_ref: &WorkspaceBindingRefV2,
        expected_workspace_identity: &str,
    ) -> Result<(), KernelErrorEnvelope> {
        let requested = resolve_workspace_root(path)?;
        preflight_workspace_root_readable(&requested.root)?;
        let active =
            self.resolve_exact_run_binding(workspace_binding_ref, expected_workspace_identity)?;
        let active_root = active
            .open_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| {
                host_service_error(
                    "host_run_workspace_unverifiable",
                    "The immutable Run workspace has no canonical root.",
                )
            })?;
        if active_root != requested.root {
            return Err(host_service_error(
                "host_run_workspace_mismatch",
                "The requested workspace does not match the immutable active Run workspace.",
            ));
        }
        Ok(())
    }

    fn unregister_exact_managed_root_if_present_v2(
        &self,
        workspace_binding_ref: &WorkspaceBindingRefV2,
        expected_workspace_identity: &str,
    ) -> Result<(), HostV2StorageError> {
        match self
            .registry_admin
            .unregister_exact(workspace_binding_ref, expected_workspace_identity)
        {
            Ok(()) | Err(HostWorkspaceRegistryErrorV2::BindingNotFound) => Ok(()),
            Err(HostWorkspaceRegistryErrorV2::BindingIdentityMismatch) => {
                Err(HostV2StorageError::conflict(
                    "host_run_workspace_identity_mismatch",
                    "Host Run workspace binding no longer matches its durable owned identity",
                ))
            }
            Err(error) => Err(HostV2StorageError::io(
                "host_run_workspace_unregister_failed",
                format!("unregister exact Host Run workspace binding: {error}"),
            )),
        }
    }

    pub(crate) fn resolve_binding(
        &self,
        path: String,
    ) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
        let requested = PathBuf::from(path.trim());
        if !requested.is_dir() {
            return Err(host_service_error(
                "host_workspace_invalid_root",
                format!(
                    "workspace binding path is not a directory: {}",
                    requested.display()
                ),
            ));
        }
        let resolved = resolve_workspace_root(&path)?;
        preflight_workspace_root_readable(&resolved.root)?;
        Ok(workspace_result(HostWorkspaceOutput::BindingResolved(
            HostWorkspaceBindingResolved {
                workspace_binding: workspace_binding_from_root(&resolved.root),
                root_status: HostWorkspaceRootStatus::Ready,
            },
        )))
    }

    pub(crate) fn open(&self, path: String) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
        let resolved = resolve_workspace_root(&path)?;
        preflight_workspace_root_readable(&resolved.root)?;
        let mut state = self.lock_state()?;
        let workspace = opened_workspace(&mut state, resolved);
        let output = workspace_spec(&workspace);
        state.current = Some(workspace);
        Ok(workspace_result(HostWorkspaceOutput::Opened(
            HostWorkspaceOpened { workspace: output },
        )))
    }

    pub(crate) fn current(&self) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
        let state = self.lock_state()?;
        Ok(workspace_result(HostWorkspaceOutput::Current(
            HostWorkspaceCurrent {
                current: state.current.as_ref().map(workspace_spec),
                fallback_used: false,
                last_error: None,
            },
        )))
    }

    pub(crate) fn save(
        &self,
        file_name: Option<String>,
    ) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
        let current = self.lock_state()?.current.clone().ok_or_else(|| {
            host_service_error(
                "host_workspace_missing",
                "Host workspace save requires an open workspace",
            )
        })?;
        let file_name =
            normalize_workspace_file_name(file_name.as_deref().unwrap_or(current.name.as_str()))?;
        let workspace_file_path = current.root.join(file_name);
        let overwritten = workspace_file_path.exists();
        atomic_write_workspace_json(
            &workspace_file_path,
            &json!({
                "folders": [{ "path": "." }],
                "settings": current.settings
            }),
        )?;
        let resolved = resolve_workspace_root(&workspace_file_path.to_string_lossy())?;
        preflight_workspace_root_readable(&resolved.root)?;
        let mut state = self.lock_state()?;
        let reopened = opened_workspace(&mut state, resolved);
        let reopened_spec = workspace_spec(&reopened);
        state.current = Some(reopened);
        Ok(workspace_result(HostWorkspaceOutput::Saved(
            HostWorkspaceSaved {
                workspace_file_path: workspace_file_path.to_string_lossy().to_string(),
                workspace: reopened_spec,
                created: !overwritten,
                overwritten,
            },
        )))
    }

    pub(crate) fn current_root(&self) -> Result<Option<PathBuf>, KernelErrorEnvelope> {
        Ok(self
            .lock_state()?
            .current
            .as_ref()
            .map(|workspace| workspace.root.clone()))
    }

    pub(crate) fn patch_settings(&self, patches: Value) -> Result<Value, KernelErrorEnvelope> {
        let patches = patches.as_object().ok_or_else(|| {
            host_service_error(
                "host_workspace_settings_invalid",
                "Workspace settings patches must be a JSON object",
            )
        })?;
        if let Some(key) = patches.keys().find(|key| !key.starts_with("deepcode.")) {
            return Err(host_service_error(
                "host_workspace_settings_key_invalid",
                format!("Workspace setting is outside the deepcode namespace: {key}"),
            ));
        }
        let mut state = self.lock_state()?;
        let current = state.current.as_mut().ok_or_else(|| {
            host_service_error(
                "host_workspace_missing",
                "Workspace settings require an open workspace",
            )
        })?;
        let settings = current.settings.as_object_mut().ok_or_else(|| {
            host_service_error(
                "host_workspace_settings_invalid",
                "Open workspace settings must be a JSON object",
            )
        })?;
        for (key, value) in patches {
            if value.is_null() {
                settings.remove(key);
            } else {
                settings.insert(key.clone(), value.clone());
            }
        }
        Ok(current.settings.clone())
    }

    pub(crate) fn begin_project_binding(
        &self,
        existing_binding: Option<&Value>,
        root_path: &str,
    ) -> Result<HostProjectBindingChange, KernelErrorEnvelope> {
        let binding_result = self
            .resolve_binding(root_path.to_string())
            .map_err(|error| {
                host_service_error(
                    "project_root_unavailable",
                    format!("project workspace root is unavailable: {}", error.message),
                )
            })?;
        let HostWorkspaceOutput::BindingResolved(binding_result) = binding_result.output else {
            return Err(host_service_error(
                "project_root_unavailable",
                "Host workspace service did not resolve the project root",
            ));
        };
        let root = binding_result
            .workspace_binding
            .open_path
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| {
                host_service_error(
                    "project_root_unavailable",
                    "Resolved project binding has no canonical root",
                )
            })?;
        let mut value =
            serde_json::to_value(binding_result.workspace_binding).map_err(|error| {
                host_service_error(
                    "project_workspace_binding_encoding_failed",
                    error.to_string(),
                )
            })?;

        let existing_ref = existing_binding
            .and_then(project_binding_ref)
            .and_then(|value| WorkspaceBindingRefV2::new(value).ok());
        let (registered, rollback) = match existing_ref {
            Some(workspace_binding_ref) => match self
                .registry_resolver
                .resolve_workspace_binding(&workspace_binding_ref)
            {
                Ok(previous_root) => (
                    self.registry_admin
                        .rebind(&workspace_binding_ref, &root)
                        .map_err(registry_error)?,
                    HostProjectBindingRollback::Rebind {
                        workspace_binding_ref,
                        previous_root,
                    },
                ),
                Err(HostWorkspaceResolveErrorV2::Stale) => (
                    self.registry_admin
                        .rebind(&workspace_binding_ref, &root)
                        .map_err(registry_error)?,
                    HostProjectBindingRollback::Unregister(workspace_binding_ref),
                ),
                Err(_) => {
                    let registered = self
                        .registry_admin
                        .register(&root)
                        .map_err(registry_error)?;
                    (
                        registered.clone(),
                        HostProjectBindingRollback::Unregister(registered.workspace_binding_ref),
                    )
                }
            },
            None => {
                let registered = self
                    .registry_admin
                    .register(&root)
                    .map_err(registry_error)?;
                (
                    registered.clone(),
                    HostProjectBindingRollback::Unregister(registered.workspace_binding_ref),
                )
            }
        };

        value["workspaceBindingRef"] = json!(registered.workspace_binding_ref);
        value["workspaceBindingIdentity"] = json!(registered.workspace_identity);
        Ok(HostProjectBindingChange { value, rollback })
    }

    pub(crate) fn rollback_project_binding(
        &self,
        change: HostProjectBindingChange,
    ) -> Result<(), KernelErrorEnvelope> {
        match change.rollback {
            HostProjectBindingRollback::Unregister(workspace_binding_ref) => self
                .registry_admin
                .unregister(&workspace_binding_ref)
                .map_err(registry_error),
            HostProjectBindingRollback::Rebind {
                workspace_binding_ref,
                previous_root,
            } => self
                .registry_admin
                .rebind(&workspace_binding_ref, &previous_root)
                .map(|_| ())
                .map_err(registry_error),
        }
    }

    pub(crate) fn validate_project_binding(
        &self,
        stored_binding: &Value,
    ) -> Result<Value, KernelErrorEnvelope> {
        let raw_ref = project_binding_ref(stored_binding).ok_or_else(|| {
            host_service_error(
                "project_workspace_binding_unsupported",
                "Project workspace binding has no v2 workspaceBindingRef; rebind the project",
            )
        })?;
        let workspace_binding_ref = WorkspaceBindingRefV2::new(raw_ref).map_err(|_| {
            host_service_error(
                "project_workspace_binding_unsupported",
                "Project workspace binding reference is invalid; rebind the project",
            )
        })?;
        let workspace_identity = stored_binding
            .get("workspaceBindingIdentity")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                host_service_error(
                    "project_workspace_binding_stale",
                    "Project workspace binding has no persisted root identity; rebind the project",
                )
            })?;
        let root = self
            .registry_resolver
            .resolve_workspace_binding(&workspace_binding_ref)
            .map_err(resolve_error)?;
        let resolved = workspace_binding_from_root(&root);
        let stored_hash = stored_binding.get("workspaceHash").and_then(Value::as_str);
        let stored_root = stored_binding.get("openPath").and_then(Value::as_str);
        if stored_hash != resolved.workspace_hash.as_deref()
            || stored_root != resolved.open_path.as_deref()
        {
            return Err(host_service_error(
                "project_workspace_binding_mismatch",
                "Project workspace binding no longer matches its canonical root; rebind the project",
            ));
        }
        let mut value = serde_json::to_value(resolved).map_err(|error| {
            host_service_error(
                "project_workspace_binding_encoding_failed",
                error.to_string(),
            )
        })?;
        value["workspaceBindingRef"] = json!(workspace_binding_ref);
        value["workspaceBindingIdentity"] = json!(workspace_identity);
        Ok(value)
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HostWorkspaceState>, KernelErrorEnvelope> {
        self.state.lock().map_err(|_| {
            host_service_error(
                "host_workspace_unavailable",
                "Host workspace state is unavailable",
            )
        })
    }
}

pub(crate) struct HostProjectBindingChange {
    pub(crate) value: Value,
    rollback: HostProjectBindingRollback,
}

enum HostProjectBindingRollback {
    Unregister(WorkspaceBindingRefV2),
    Rebind {
        workspace_binding_ref: WorkspaceBindingRefV2,
        previous_root: PathBuf,
    },
}

#[derive(Clone)]
pub(crate) struct HostInspectionService {
    workspace: HostWorkspaceService,
    executor: HostInspectionExecutor,
}

impl HostInspectionService {
    fn new(workspace: HostWorkspaceService) -> Self {
        Self {
            workspace,
            executor: HostInspectionExecutor,
        }
    }

    pub(crate) fn query(
        &self,
        query: HostInspectionQuery,
    ) -> Result<HostInspectionResult, KernelErrorEnvelope> {
        let workspace_root = self.workspace.current_root()?;
        let output = self.executor.execute(query, workspace_root.as_deref())?;
        Ok(HostInspectionResult {
            source: HostResultSource::HostProjection,
            output,
        })
    }
}

#[derive(Default)]
struct HostSkillAdminState {
    catalog: BTreeMap<String, HostSkillDescriptor>,
}

#[derive(Clone, Default)]
pub(crate) struct HostSkillAdminService {
    state: Arc<Mutex<HostSkillAdminState>>,
}

impl HostSkillAdminService {
    pub(crate) fn discover(&self) -> Result<HostSkillCatalogResult, KernelErrorEnvelope> {
        let skills = self
            .state
            .lock()
            .map_err(|_| {
                host_service_error(
                    "host_skill_catalog_unavailable",
                    "Host skill catalog is unavailable",
                )
            })?
            .catalog
            .values()
            .cloned()
            .collect();
        Ok(HostSkillCatalogResult {
            source: HostResultSource::HostManagement,
            skills,
        })
    }

    pub(crate) fn scan_mount(
        &self,
        path: &Path,
    ) -> Result<deepcode_kernel_skills::SkillMountScanResult, KernelErrorEnvelope> {
        let result = scan_skill_mount(path)
            .map_err(|error| host_service_error(error.code, error.message))?;
        let mut state = self.state.lock().map_err(|_| {
            host_service_error(
                "host_skill_catalog_unavailable",
                "Host skill catalog is unavailable",
            )
        })?;
        for entry in &result.skills {
            let descriptor = host_skill_descriptor(entry);
            state.catalog.insert(descriptor.id.clone(), descriptor);
        }
        Ok(result)
    }
}

#[derive(Clone)]
pub(crate) struct AuditService {
    reader: Option<CanonicalFactReader>,
    host_management_audit_path: Arc<PathBuf>,
}

impl AuditService {
    fn new(reader: Option<CanonicalFactReader>, sessions_dir: &Path) -> Self {
        Self {
            reader,
            host_management_audit_path: Arc::new(
                sessions_dir
                    .join(".host-management-v2")
                    .join("config-audit.jsonl"),
            ),
        }
    }

    pub(crate) fn record_config_change(
        &self,
        config_kind: &str,
        changed_keys: &[String],
        store_path: &Path,
        old_hash: &str,
        new_hash: &str,
        source: &str,
        transition: Value,
    ) -> Result<Value, HostV2StorageError> {
        validate_bounded_identity(config_kind, "configKind", 128)?;
        validate_bounded_identity(source, "source", 256)?;
        validate_sha256_digest(old_hash, "oldHash")?;
        validate_sha256_digest(new_hash, "newHash")?;
        reject_transport_capabilities(&transition)?;

        let store_path = store_path.to_string_lossy().to_string();
        validate_bounded_identity(&store_path, "storePath", 4096)?;

        let mut changed_keys = changed_keys.to_vec();
        changed_keys.sort();
        changed_keys.dedup();
        if changed_keys.is_empty() {
            return Err(HostV2StorageError::invalid(
                "host_config_audit_changed_keys_missing",
                "Host config audit requires at least one changed key",
            ));
        }
        for changed_key in &changed_keys {
            validate_bounded_identity(changed_key, "changedKey", 256)?;
        }

        let record_body = json!({
            "schemaVersion": "deepcode.host.config-audit.v2",
            "recordedAt": crate::utils::now_text(),
            "configKind": config_kind,
            "changedKeys": changed_keys,
            "storePath": store_path,
            "oldHash": old_hash,
            "newHash": new_hash,
            "source": source,
            "transition": transition
        });
        let record_digest = canonical_sha256(&record_body)?;
        let digest_identity = record_digest.strip_prefix("sha256:").ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_config_audit_digest_invalid",
                "Host config audit canonical digest is invalid",
            )
        })?;
        let record_id = format!("host-config-change-v2:{}", digest_identity);
        let mut record = record_body;
        let record_object = record.as_object_mut().ok_or_else(|| {
            HostV2StorageError::invalid(
                "host_config_audit_record_invalid",
                "Host config audit record must be a JSON object",
            )
        })?;
        record_object.insert("recordId".to_string(), json!(record_id));
        record_object.insert("recordDigest".to_string(), json!(record_digest));
        reject_transport_capabilities(&record)?;

        with_storage_path_lock(&self.host_management_audit_path, || {
            append_json_line_durable(&self.host_management_audit_path, &record)
        })?;
        Ok(record)
    }

    pub(crate) fn status(&self) -> Value {
        let Some(reader) = &self.reader else {
            return json!({
                "status": "awaitingLiveComposition",
                "factSource": "CanonicalFactStoreV2"
            });
        };
        match reader.ledger_sequence_high_water() {
            Ok(high_water) => json!({
                "status": "ready",
                "factSource": "CanonicalFactStoreV2",
                "ledgerSequenceHighWater": high_water
            }),
            Err(_) => json!({
                "status": "unavailable",
                "factSource": "CanonicalFactStoreV2"
            }),
        }
    }
}

#[derive(Clone)]
pub(crate) struct HostServices {
    pub(crate) workspace: HostWorkspaceService,
    pub(crate) inspection: HostInspectionService,
    pub(crate) skill_admin: HostSkillAdminService,
    pub(crate) audit: AuditService,
    pub(crate) active_runs_v2: HostActiveRunBrokerV2,
    pub(crate) kernel_operations_v2: HostKernelOperationStoreV2,
    pub(crate) session_kernel_v2: SessionKernelV2Store,
    pub(crate) projection_v2: SessionKernelProjectionSinkV2,
    kernel_v2_service: KernelSessionServiceV2,
}

impl HostServices {
    pub(crate) fn from_projects(
        projects: &[Value],
        sessions_dir: PathBuf,
        kernel_v2_service: KernelSessionServiceV2,
        audit_reader: Option<CanonicalFactReader>,
        recoverable_session_ids: &HashSet<String>,
        deletion_tombstone_ids: &HashSet<String>,
    ) -> Result<Self, HostV2StorageError> {
        let active_runs_v2 = HostActiveRunBrokerV2::new(sessions_dir.clone())?;
        let kernel_operations_v2 = HostKernelOperationStoreV2::new(sessions_dir.clone());
        let mut workspace_rehydrate_records =
            active_runs_v2.workspace_rehydrate_records(recoverable_session_ids);
        match kernel_operations_v2.workspace_rehydrate_records(recoverable_session_ids) {
            Ok(mut records) => workspace_rehydrate_records.append(&mut records),
            Err(error) => active_runs_v2.record_startup_error(error.code),
        }
        let workspace = HostWorkspaceService::from_projects(projects, workspace_rehydrate_records);
        let mut retirement_session_ids = recoverable_session_ids.clone();
        retirement_session_ids.extend(deletion_tombstone_ids.iter().cloned());
        let recovery_kernel_v2_service = kernel_v2_service.clone();
        if let Err(error) = active_runs_v2.recover_retiring_runs(
            &retirement_session_ids,
            |run_id, reason_code, reason| {
                retire_kernel_authority_v2(&recovery_kernel_v2_service, run_id, reason_code, reason)
            },
            |workspace_binding_ref, workspace_identity| {
                workspace.unregister_exact_managed_root_if_present_v2(
                    workspace_binding_ref,
                    workspace_identity,
                )
            },
        ) {
            active_runs_v2.record_startup_error(error.code);
        }
        Ok(Self {
            inspection: HostInspectionService::new(workspace.clone()),
            workspace,
            skill_admin: HostSkillAdminService::default(),
            audit: AuditService::new(audit_reader, &sessions_dir),
            session_kernel_v2: SessionKernelV2Store::new(
                sessions_dir.clone(),
                active_runs_v2.clone(),
            ),
            projection_v2: SessionKernelProjectionSinkV2::new(
                sessions_dir.clone(),
                active_runs_v2.clone(),
            ),
            kernel_operations_v2,
            active_runs_v2,
            kernel_v2_service,
        })
    }

    pub(crate) fn retire_kernel_run_with_turn_v2(
        &self,
        turn: &HostSessionTurnGuardV2,
        host_run_id: &str,
        run_id: &str,
        reason_code: RunRetirementReasonCodeV2,
        reason: Option<&str>,
    ) -> Result<HostRunRetirementReceiptV2, HostV2StorageError> {
        self.active_runs_v2.retire_run(
            turn,
            host_run_id,
            run_id,
            &crate::utils::now_text(),
            reason_code,
            reason,
            |run_id, reason_code, reason| {
                retire_kernel_authority_v2(&self.kernel_v2_service, run_id, reason_code, reason)
            },
            |workspace_binding_ref, workspace_identity| {
                self.workspace.unregister_exact_managed_root_if_present_v2(
                    workspace_binding_ref,
                    workspace_identity,
                )
            },
        )
    }

    pub(crate) fn prepare_empty_run_workspace(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<HostPreparedEmptyWorkspaceV2, KernelErrorEnvelope> {
        let empty = self
            .active_runs_v2
            .prepare_empty_workspace_root(session_id, host_run_id)
            .map_err(host_v2_service_error)?;
        let registered = match self.workspace.register_managed_root(&empty.root) {
            Ok(registered) => registered,
            Err(register_error) => {
                return match self
                    .active_runs_v2
                    .discard_prepared_empty_workspace_root(&empty.key)
                {
                    Ok(()) => Err(register_error),
                    Err(cleanup_error) => Err(host_service_error(
                        "host_empty_workspace_prepare_cleanup_failed",
                        format!(
                            "register prepared workspace failed with {}; remove prepared root failed with {}",
                            register_error.code, cleanup_error.code
                        ),
                    )),
                };
            }
        };
        Ok(HostPreparedEmptyWorkspaceV2 {
            workspace_binding_ref: registered.workspace_binding_ref,
            workspace_binding_identity: registered.workspace_identity,
            workspace_canonical_root: empty.root,
            empty_workspace_key: empty.key,
            run_settings: empty.settings,
        })
    }

    pub(crate) fn prepare_bound_run_workspace(
        &self,
        path: &str,
    ) -> Result<HostPreparedBoundWorkspaceV2, KernelErrorEnvelope> {
        let resolved = resolve_workspace_root(path)?;
        preflight_workspace_root_readable(&resolved.root)?;
        let registered = self.workspace.register_managed_root(&resolved.root)?;
        Ok(HostPreparedBoundWorkspaceV2 {
            workspace_binding_ref: registered.workspace_binding_ref,
            workspace_binding_identity: registered.workspace_identity,
            workspace_canonical_root: resolved.root,
        })
    }

    pub(crate) fn discard_prepared_bound_run_workspace(
        &self,
        prepared: &HostPreparedBoundWorkspaceV2,
    ) -> Result<(), KernelErrorEnvelope> {
        self.workspace
            .unregister_exact_managed_root_if_present_v2(
                &prepared.workspace_binding_ref,
                &prepared.workspace_binding_identity,
            )
            .map_err(host_v2_service_error)
    }

    pub(crate) fn discard_prepared_empty_run_workspace(
        &self,
        prepared: &HostPreparedEmptyWorkspaceV2,
    ) -> Result<(), KernelErrorEnvelope> {
        let unregister = self
            .workspace
            .unregister_exact_managed_root_if_present_v2(
                &prepared.workspace_binding_ref,
                &prepared.workspace_binding_identity,
            )
            .map_err(host_v2_service_error);
        let remove = self
            .active_runs_v2
            .discard_prepared_empty_workspace_root(&prepared.empty_workspace_key)
            .map_err(host_v2_service_error);
        match (unregister, remove) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(unregister_error), Err(remove_error)) => Err(host_service_error(
                "host_empty_workspace_cleanup_failed",
                format!(
                    "unregister prepared workspace failed with {}; remove prepared root failed with {}",
                    unregister_error.code, remove_error.code
                ),
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HostPreparedEmptyWorkspaceV2 {
    pub(crate) workspace_binding_ref: WorkspaceBindingRefV2,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_canonical_root: PathBuf,
    pub(crate) empty_workspace_key: String,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
}

#[derive(Debug, Clone)]
pub(crate) struct HostPreparedBoundWorkspaceV2 {
    pub(crate) workspace_binding_ref: WorkspaceBindingRefV2,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_canonical_root: PathBuf,
}

struct ResolvedWorkspaceRoot {
    source: HostWorkspaceSourceKind,
    source_path: Option<PathBuf>,
    root: PathBuf,
    original_folder_path: String,
    folder_is_absolute: bool,
    settings: Value,
    unsupported_fields: Vec<HostUnsupportedWorkspaceField>,
}

fn resolve_workspace_root(path: &str) -> Result<ResolvedWorkspaceRoot, KernelErrorEnvelope> {
    let source = PathBuf::from(path.trim());
    if source.is_dir() {
        let root = source.canonicalize().map_err(|error| {
            host_service_error(
                "host_workspace_unavailable",
                format!("canonicalize workspace {path}: {error}"),
            )
        })?;
        return Ok(ResolvedWorkspaceRoot {
            source: HostWorkspaceSourceKind::Directory,
            source_path: None,
            original_folder_path: root.to_string_lossy().to_string(),
            folder_is_absolute: true,
            root,
            settings: json!({}),
            unsupported_fields: Vec::new(),
        });
    }
    if source.is_file() && source.extension().and_then(OsStr::to_str) == Some("code-workspace") {
        let text = fs::read_to_string(&source).map_err(|error| {
            host_service_error(
                "host_workspace_unavailable",
                format!("read workspace file {path}: {error}"),
            )
        })?;
        let value: Value = serde_json::from_str(&text).map_err(|error| {
            host_service_error(
                "host_workspace_invalid_file",
                format!("parse workspace file: {error}"),
            )
        })?;
        let folder_path = value
            .get("folders")
            .and_then(Value::as_array)
            .and_then(|folders| folders.first())
            .and_then(|folder| folder.get("path"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                host_service_error(
                    "host_workspace_invalid_file",
                    "workspace file has no folders[0].path",
                )
            })?;
        let source_path = source.canonicalize().map_err(|error| {
            host_service_error(
                "host_workspace_unavailable",
                format!("canonicalize workspace file {path}: {error}"),
            )
        })?;
        let base = source.parent().unwrap_or_else(|| Path::new("."));
        let root = base.join(folder_path).canonicalize().map_err(|error| {
            host_service_error(
                "host_workspace_unavailable",
                format!("canonicalize workspace folder {folder_path}: {error}"),
            )
        })?;
        return Ok(ResolvedWorkspaceRoot {
            source: HostWorkspaceSourceKind::CodeWorkspace,
            source_path: Some(source_path),
            root,
            original_folder_path: folder_path.to_string(),
            folder_is_absolute: Path::new(folder_path).is_absolute(),
            settings: value.get("settings").cloned().unwrap_or_else(|| json!({})),
            unsupported_fields: unsupported_workspace_fields(&value),
        });
    }
    Err(host_service_error(
        "host_workspace_invalid_path",
        format!("{path} is not a directory or .code-workspace file"),
    ))
}

fn opened_workspace(
    state: &mut HostWorkspaceState,
    resolved: ResolvedWorkspaceRoot,
) -> HostWorkspaceRecord {
    state.next_workspace_index += 1;
    let name = resolved
        .source_path
        .as_ref()
        .or(Some(&resolved.root))
        .and_then(|path| path.file_stem().or_else(|| path.file_name()))
        .and_then(OsStr::to_str)
        .unwrap_or("workspace")
        .to_string();
    HostWorkspaceRecord {
        id: format!("ws-{}", state.next_workspace_index),
        name,
        source: resolved.source,
        source_path: resolved.source_path,
        root: resolved.root,
        original_folder_path: resolved.original_folder_path,
        folder_is_absolute: resolved.folder_is_absolute,
        settings: resolved.settings,
        unsupported_fields: resolved.unsupported_fields,
        opened_at: crate::now_millis().to_string(),
    }
}

fn workspace_spec(workspace: &HostWorkspaceRecord) -> HostWorkspaceSpec {
    let root_path = workspace.root.to_string_lossy().to_string();
    HostWorkspaceSpec {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        source: workspace.source,
        source_path: workspace
            .source_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        root_path: root_path.clone(),
        folders: vec![HostWorkspaceFolder {
            id: "wf-0".to_string(),
            name: workspace.name.clone(),
            path: root_path.clone(),
            absolute_path: root_path,
            original_path: workspace.original_folder_path.clone(),
            is_absolute: workspace.folder_is_absolute,
        }],
        settings: workspace.settings.clone(),
        unsupported_fields: workspace.unsupported_fields.clone(),
        opened_at: workspace.opened_at.clone(),
    }
}

fn workspace_binding_from_root(root: &Path) -> WorkspaceBinding {
    let canonical = root.to_string_lossy().to_string();
    let digest = deepcode_kernel_tools::hash_bytes(canonical.as_bytes());
    WorkspaceBinding {
        workspace_id: Some(format!("workspace-{}", &digest[..16])),
        workspace_hash: Some(digest.clone()),
        open_path: Some(canonical),
        active_folder_id: Some("wf-0".to_string()),
        folder_hash: Some(digest),
    }
}

fn workspace_result(output: HostWorkspaceOutput) -> HostWorkspaceResult {
    HostWorkspaceResult {
        source: HostResultSource::HostManagement,
        output,
    }
}

fn preflight_workspace_root_readable(root: &Path) -> Result<(), KernelErrorEnvelope> {
    fs::read_dir(root).map(|_| ()).map_err(|error| {
        host_service_error(
            "host_workspace_root_unreadable",
            format!(
                "{} cannot be listed for read-only workspace access: {error}",
                root.display()
            ),
        )
    })
}

fn normalize_workspace_file_name(name: &str) -> Result<String, KernelErrorEnvelope> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(host_service_error(
            "host_workspace_invalid_file_name",
            "workspace file name is required",
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || matches!(trimmed, "." | "..") {
        return Err(host_service_error(
            "host_workspace_invalid_file_name",
            "workspace file name must not contain path separators",
        ));
    }
    let sanitized = trimmed
        .chars()
        .map(|character| {
            if matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    if sanitized.ends_with(".code-workspace") {
        Ok(sanitized)
    } else {
        Ok(format!("{sanitized}.code-workspace"))
    }
}

fn atomic_write_workspace_json(path: &Path, value: &Value) -> Result<(), KernelErrorEnvelope> {
    let parent = path.parent().ok_or_else(|| {
        host_service_error(
            "host_workspace_invalid_path",
            "workspace file path has no parent",
        )
    })?;
    let content = serde_json::to_vec_pretty(value).map_err(|error| {
        host_service_error(
            "host_workspace_save_failed",
            format!("encode workspace file: {error}"),
        )
    })?;
    let temp_path = parent.join(format!(
        ".deepcode-workspace-{}-{}.tmp",
        std::process::id(),
        crate::now_millis()
    ));
    let cleanup = HostTemporaryPath::new(temp_path.clone());
    let mut temp_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| {
            host_service_error(
                "host_workspace_save_failed",
                format!("create {}: {error}", temp_path.display()),
            )
        })?;
    std::io::Write::write_all(&mut temp_file, &content).map_err(|error| {
        host_service_error(
            "host_workspace_save_failed",
            format!("write {}: {error}", temp_path.display()),
        )
    })?;
    temp_file.sync_all().map_err(|error| {
        host_service_error(
            "host_workspace_save_failed",
            format!("sync {}: {error}", temp_path.display()),
        )
    })?;
    drop(temp_file);
    fs::rename(&temp_path, path).map_err(|error| {
        host_service_error(
            "host_workspace_save_failed",
            format!("rename {}: {error}", path.display()),
        )
    })?;
    cleanup.disarm();
    Ok(())
}

struct HostTemporaryPath {
    path: PathBuf,
    armed: bool,
}

impl HostTemporaryPath {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for HostTemporaryPath {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn unsupported_workspace_fields(value: &Value) -> Vec<HostUnsupportedWorkspaceField> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .filter(|(key, _)| key.as_str() != "folders" && key.as_str() != "settings")
        .map(|(key, value)| HostUnsupportedWorkspaceField {
            key: key.clone(),
            kind: value_kind(value).to_string(),
        })
        .collect()
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn trusted_project_binding_records(projects: &[Value]) -> Vec<HostWorkspaceRehydrateRecordV2> {
    projects
        .iter()
        .filter(|project| project.get("kind").and_then(Value::as_str) == Some("folder"))
        .filter_map(|project| project.get("workspaceBinding"))
        .filter_map(|binding| {
            let raw_ref = project_binding_ref(binding)?;
            if !valid_persisted_binding_ref(&raw_ref) {
                return None;
            }
            let root = binding
                .get("openPath")
                .and_then(Value::as_str)
                .map(PathBuf::from)?;
            if !root.is_absolute() {
                return None;
            }
            Some(HostWorkspaceRehydrateRecordV2::new(
                WorkspaceBindingRefV2::new(raw_ref).ok()?,
                root,
                binding
                    .get("workspaceBindingIdentity")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            ))
        })
        .collect()
}

fn project_binding_ref(binding: &Value) -> Option<String> {
    binding
        .get("workspaceBindingRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn valid_persisted_binding_ref(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("wsb_v2_") else {
        return false;
    };
    encoded.len() == 64
        && encoded
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn host_skill_descriptor(entry: &SkillMountEntry) -> HostSkillDescriptor {
    HostSkillDescriptor {
        id: entry.skill_id.clone(),
        version: entry.version.clone(),
        title_key: nonempty(&entry.title),
        description_key: nonempty(&entry.description),
        input_schema: json!({ "type": "object" }),
        output_schema: json!({ "type": "object" }),
        required_capabilities: entry.requested_capabilities.clone(),
        allowed_phases: Vec::new(),
        risk_level: host_skill_risk_level(&entry.risk_level),
        effects: entry
            .effects
            .iter()
            .filter_map(|effect| host_skill_effect(effect))
            .collect(),
        source: HostSkillSource::LocalPack {
            pack_id: entry.relative_path.clone(),
        },
        adapter_kind: host_skill_adapter_kind(&entry.entrypoint_kind),
        activation_status: match entry.activation_status {
            SkillActivationStatus::Dormant => HostSkillActivationStatus::Dormant,
            SkillActivationStatus::Registered => HostSkillActivationStatus::Registered,
        },
        requested_model_visible: entry.model_visible,
    }
}

fn nonempty(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.to_string())
}

fn host_skill_risk_level(value: &str) -> HostSkillRiskLevel {
    match normalized_enum_name(value).as_str() {
        "medium" => HostSkillRiskLevel::Medium,
        "high" => HostSkillRiskLevel::High,
        "critical" => HostSkillRiskLevel::Critical,
        _ => HostSkillRiskLevel::Low,
    }
}

fn host_skill_effect(value: &str) -> Option<HostSkillEffect> {
    Some(match normalized_enum_name(value).as_str() {
        "readsworkspace" => HostSkillEffect::ReadsWorkspace,
        "writesworkspace" => HostSkillEffect::WritesWorkspace,
        "createsworkspace" => HostSkillEffect::CreatesWorkspace,
        "deletesworkspace" => HostSkillEffect::DeletesWorkspace,
        "readsgit" => HostSkillEffect::ReadsGit,
        "runsprocess" => HostSkillEffect::RunsProcess,
        "usesnetwork" => HostSkillEffect::UsesNetwork,
        "readssecret" => HostSkillEffect::ReadsSecret,
        "modifiesgit" => HostSkillEffect::ModifiesGit,
        "pushesgit" => HostSkillEffect::PushesGit,
        "controlsbrowser" => HostSkillEffect::ControlsBrowser,
        "modifieskernel" => HostSkillEffect::ModifiesKernel,
        "modifiesconfig" => HostSkillEffect::ModifiesConfig,
        _ => return None,
    })
}

fn host_skill_adapter_kind(value: &str) -> HostSkillAdapterKind {
    match normalized_enum_name(value).as_str() {
        "externalprocess" | "script" => HostSkillAdapterKind::ExternalProcess,
        "mcp" => HostSkillAdapterKind::Mcp,
        _ => HostSkillAdapterKind::Declarative,
    }
}

fn normalized_enum_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn registry_error(error: HostWorkspaceRegistryErrorV2) -> KernelErrorEnvelope {
    host_service_error("host_workspace_registry_error", error.to_string())
}

fn host_v2_service_error(error: crate::host_v2_storage::HostV2StorageError) -> KernelErrorEnvelope {
    host_service_error(error.code, error.message)
}

fn retire_kernel_authority_v2(
    service: &KernelSessionServiceV2,
    run_id: &str,
    reason_code: RunRetirementReasonCodeV2,
    reason: Option<&str>,
) -> Result<HostKernelRunRetirementProofV2, HostV2StorageError> {
    let run_id = RunId::new(run_id.to_string()).map_err(|_| {
        HostV2StorageError::conflict(
            "host_kernel_run_id_invalid",
            "Host Run contains an invalid Kernel Run identity",
        )
    })?;
    let receipt = service
        .retire_run_host(run_id, reason_code, reason.map(ToOwned::to_owned))
        .map_err(|_| {
            HostV2StorageError::io(
                "host_kernel_run_retirement_failed",
                "Kernel Run retirement did not reach its durable terminal fact",
            )
        })?;
    Ok(HostKernelRunRetirementProofV2 {
        fact_id: receipt.retirement_fact_id.as_str().to_string(),
        ledger_sequence: receipt.retirement_ledger_sequence,
    })
}

fn resolve_error(error: HostWorkspaceResolveErrorV2) -> KernelErrorEnvelope {
    let (code, message) = match error {
        HostWorkspaceResolveErrorV2::NotFound => (
            "project_workspace_binding_not_found",
            "Project workspace binding was not found; rebind the project",
        ),
        HostWorkspaceResolveErrorV2::Stale => (
            "project_workspace_binding_stale",
            "Project workspace binding is stale; rebind the project",
        ),
        HostWorkspaceResolveErrorV2::Unavailable => (
            "project_workspace_binding_unavailable",
            "Project workspace binding registry is unavailable",
        ),
    };
    host_service_error(code, message)
}

fn host_service_error(code: impl Into<String>, message: impl Into<String>) -> KernelErrorEnvelope {
    KernelErrorEnvelope {
        code: code.into(),
        message: message.into(),
        message_key: None,
        args: None,
    }
}
