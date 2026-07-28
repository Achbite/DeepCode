use crate::host_inspection::HostInspectionExecutor;
use crate::host_run_broker_v2::{HostActiveRunBrokerV2, HostRunSettingsCeilingV2};
use crate::host_workspace_registry_v2::{
    HostWorkspaceBindingRegisteredV2, HostWorkspaceBindingResolverV2, HostWorkspaceRegistryAdminV2,
    HostWorkspaceRegistryErrorV2, HostWorkspaceRegistryReadinessV2, HostWorkspaceRegistryV2,
    HostWorkspaceRehydrateRecordV2, HostWorkspaceResolveErrorV2,
};
use crate::prelude::*;
use crate::session_kernel_v2_store::{SessionKernelProjectionSinkV2, SessionKernelV2Store};
use deepcode_kernel_abi::{
    HostInspectionResult, HostMcpRiskDecisionRecord, HostMcpRiskDecisionSubmit, HostResultSource,
    HostSkillActivationStatus, HostSkillAdapterKind, HostSkillCatalogResult, HostSkillDescriptor,
    HostSkillEffect, HostSkillRiskLevel, HostSkillSource, HostSkillTrustDecisionRecord,
    HostSkillTrustDecisionSubmit, HostUnsupportedWorkspaceField, HostWorkspaceBindingResolved,
    HostWorkspaceFolder, HostWorkspaceOpened, HostWorkspaceRootStatus, HostWorkspaceSaved,
    HostWorkspaceSourceKind, HostWorkspaceSpec, WorkspaceBinding, WorkspaceBindingRefV2,
};
use deepcode_kernel_ledger::v2::CanonicalFactReader;
use deepcode_kernel_skills::{scan_skill_mount, SkillActivationStatus, SkillMountEntry};
use std::collections::BTreeMap;
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

    pub(crate) fn unregister_managed_root(
        &self,
        workspace_binding_ref: &WorkspaceBindingRefV2,
    ) -> Result<(), KernelErrorEnvelope> {
        self.registry_admin
            .unregister(workspace_binding_ref)
            .map_err(registry_error)
    }

    pub(crate) fn resolve_binding(
        &self,
        _request_id: RequestId,
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

    pub(crate) fn open(
        &self,
        _request_id: RequestId,
        path: String,
    ) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
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

    pub(crate) fn current(
        &self,
        _request_id: RequestId,
    ) -> Result<HostWorkspaceResult, KernelErrorEnvelope> {
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
        _request_id: RequestId,
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

    pub(crate) fn begin_project_binding(
        &self,
        existing_binding: Option<&Value>,
        root_path: &str,
    ) -> Result<HostProjectBindingChange, KernelErrorEnvelope> {
        let binding_result = self
            .resolve_binding(
                RequestId("host-project-binding".to_string()),
                root_path.to_string(),
            )
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
        _request_id: RequestId,
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
    trust_decisions: BTreeMap<String, HostSkillTrustDecisionRecord>,
    mcp_decisions: BTreeMap<String, HostMcpRiskDecisionRecord>,
    next_sequence: u64,
}

#[derive(Clone, Default)]
pub(crate) struct HostSkillAdminService {
    state: Arc<Mutex<HostSkillAdminState>>,
}

impl HostSkillAdminService {
    pub(crate) fn discover(
        &self,
        _request_id: RequestId,
    ) -> Result<HostSkillCatalogResult, KernelErrorEnvelope> {
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

    pub(crate) fn record_skill_trust(
        &self,
        request_id: RequestId,
        skill_id: String,
        decision: HostSkillTrustDecisionSubmit,
    ) -> Result<Vec<KernelEvent>, KernelErrorEnvelope> {
        if skill_id.trim().is_empty() {
            return Err(host_service_error(
                "host_skill_id_invalid",
                "Host skill trust decision requires a non-empty skill id",
            ));
        }
        let record = HostSkillTrustDecisionRecord {
            skill_id: skill_id.clone(),
            decision: decision.decision,
            trust_mode: decision.trust_mode,
            revision_hash: decision.revision_hash,
            approved_capabilities: decision.approved_capabilities,
            approved_at: decision.approved_at,
            approved_by: decision.approved_by,
            expires_at: decision.expires_at,
        };
        let mut state = self.lock_state()?;
        let sequence = next_host_admin_sequence(&mut state)?;
        state.trust_decisions.insert(skill_id, record.clone());
        Ok(vec![KernelEvent::HostSkillTrustDecisionRecorded {
            request_id,
            record,
            sequence: Some(sequence),
        }])
    }

    pub(crate) fn record_mcp_risk(
        &self,
        request_id: RequestId,
        connector_id: String,
        binding_id: Option<String>,
        decision: HostMcpRiskDecisionSubmit,
    ) -> Result<Vec<KernelEvent>, KernelErrorEnvelope> {
        if connector_id.trim().is_empty() {
            return Err(host_service_error(
                "host_mcp_connector_id_invalid",
                "Host MCP risk decision requires a non-empty connector id",
            ));
        }
        let record = HostMcpRiskDecisionRecord {
            connector_id,
            binding_id,
            decision: decision.decision,
            revision_hash: decision.revision_hash,
            acknowledged_by: decision.acknowledged_by,
            acknowledged_at: decision.acknowledged_at,
            risk_level: decision.risk_level,
            permission_granted: false,
        };
        let key = format!(
            "{}\u{0}{}",
            record.connector_id,
            record.binding_id.as_deref().unwrap_or_default()
        );
        let mut state = self.lock_state()?;
        let sequence = next_host_admin_sequence(&mut state)?;
        state.mcp_decisions.insert(key, record.clone());
        Ok(vec![KernelEvent::HostMcpRiskDecisionRecorded {
            request_id,
            record,
            sequence: Some(sequence),
        }])
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HostSkillAdminState>, KernelErrorEnvelope> {
        self.state.lock().map_err(|_| {
            host_service_error(
                "host_skill_admin_unavailable",
                "Host skill administration state is unavailable",
            )
        })
    }
}

fn next_host_admin_sequence(state: &mut HostSkillAdminState) -> Result<u64, KernelErrorEnvelope> {
    let sequence = state.next_sequence.checked_add(1).ok_or_else(|| {
        host_service_error(
            "host_skill_admin_sequence_exhausted",
            "Host skill administration sequence is exhausted",
        )
    })?;
    state.next_sequence = sequence;
    Ok(sequence)
}

#[derive(Clone, Default)]
pub(crate) struct AuditService {
    reader: Option<CanonicalFactReader>,
}

impl AuditService {
    fn new(reader: Option<CanonicalFactReader>) -> Self {
        Self { reader }
    }

    pub(crate) fn status(&self) -> Value {
        let Some(reader) = &self.reader else {
            return json!({
                "status": "awaitingLiveComposition",
                "factSource": "CanonicalFactStoreV2",
                "legacySignedVerification": false
            });
        };
        match reader.ledger_sequence_high_water() {
            Ok(high_water) => json!({
                "status": "ready",
                "factSource": "CanonicalFactStoreV2",
                "ledgerSequenceHighWater": high_water,
                "legacySignedVerification": false
            }),
            Err(_) => json!({
                "status": "unavailable",
                "factSource": "CanonicalFactStoreV2",
                "legacySignedVerification": false
            }),
        }
    }

    fn reject_legacy_query(&self) -> Result<Vec<KernelEvent>, KernelErrorEnvelope> {
        Err(host_service_error(
            "legacy_audit_query_unsupported",
            "Legacy audit query is removed; use run-scoped KernelFactsQuery v2",
        ))
    }

    fn reject_legacy_verify(&self) -> Result<Vec<KernelEvent>, KernelErrorEnvelope> {
        Err(host_service_error(
            "legacy_audit_verify_unsupported",
            "Legacy signed audit verification is removed; CanonicalFactStore v2 facts are the audit source",
        ))
    }
}

#[derive(Clone)]
pub(crate) struct HostServices {
    pub(crate) workspace: HostWorkspaceService,
    pub(crate) inspection: HostInspectionService,
    pub(crate) skill_admin: HostSkillAdminService,
    pub(crate) audit: AuditService,
    pub(crate) active_runs_v2: HostActiveRunBrokerV2,
    pub(crate) session_kernel_v2: SessionKernelV2Store,
    pub(crate) projection_v2: SessionKernelProjectionSinkV2,
}

impl HostServices {
    pub(crate) fn from_projects(
        projects: &[Value],
        sessions_dir: PathBuf,
        audit_reader: Option<CanonicalFactReader>,
    ) -> Self {
        let active_runs_v2 = HostActiveRunBrokerV2::new(sessions_dir.clone());
        let workspace = HostWorkspaceService::from_projects(
            projects,
            active_runs_v2.workspace_rehydrate_records(),
        );
        Self {
            inspection: HostInspectionService::new(workspace.clone()),
            workspace,
            skill_admin: HostSkillAdminService::default(),
            audit: AuditService::new(audit_reader),
            session_kernel_v2: SessionKernelV2Store::new(
                sessions_dir.clone(),
                active_runs_v2.clone(),
            ),
            projection_v2: SessionKernelProjectionSinkV2::new(sessions_dir, active_runs_v2.clone()),
            active_runs_v2,
        }
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
        let registered = self.workspace.register_managed_root(&empty.root)?;
        Ok(HostPreparedEmptyWorkspaceV2 {
            workspace_binding_ref: registered.workspace_binding_ref,
            workspace_binding_identity: registered.workspace_identity,
            empty_workspace_key: empty.key,
            run_settings: empty.settings,
        })
    }

    pub(crate) fn discard_prepared_empty_run_workspace(
        &self,
        prepared: &HostPreparedEmptyWorkspaceV2,
    ) -> Result<(), KernelErrorEnvelope> {
        self.workspace
            .unregister_managed_root(&prepared.workspace_binding_ref)
    }

    /// Routes Host-owned read and administration commands without consulting
    /// the legacy Runtime. Legacy audit commands fail closed instead of
    /// projecting the old ledger as canonical facts.
    pub(crate) fn dispatch_host_command(
        &self,
        command: KernelCommand,
    ) -> Option<Result<Vec<KernelEvent>, KernelErrorEnvelope>> {
        match command {
            KernelCommand::HostWorkspaceBindingResolve { request_id, path } => Some(
                self.workspace
                    .resolve_binding(request_id.clone(), path)
                    .map(|result| vec![KernelEvent::HostWorkspaceCompleted { request_id, result }]),
            ),
            KernelCommand::HostWorkspaceOpen { request_id, path } => Some(
                self.workspace
                    .open(request_id.clone(), path)
                    .map(|result| vec![KernelEvent::HostWorkspaceCompleted { request_id, result }]),
            ),
            KernelCommand::HostWorkspaceCurrent { request_id } => Some(
                self.workspace
                    .current(request_id.clone())
                    .map(|result| vec![KernelEvent::HostWorkspaceCompleted { request_id, result }]),
            ),
            KernelCommand::HostWorkspaceSave {
                request_id,
                file_name,
            } => Some(
                self.workspace
                    .save(request_id.clone(), file_name)
                    .map(|result| vec![KernelEvent::HostWorkspaceCompleted { request_id, result }]),
            ),
            KernelCommand::HostResourceQuery { request_id, query } => Some(
                self.inspection
                    .query(request_id.clone(), query)
                    .map(|result| {
                        vec![KernelEvent::HostInspectionCompleted { request_id, result }]
                    }),
            ),
            KernelCommand::HostSkillDiscover { request_id } => Some(
                self.skill_admin
                    .discover(request_id.clone())
                    .map(|result| vec![KernelEvent::HostSkillsDiscovered { request_id, result }]),
            ),
            KernelCommand::HostSkillTrustDecisionSubmit {
                request_id,
                skill_id,
                decision,
            } => Some(
                self.skill_admin
                    .record_skill_trust(request_id, skill_id, decision),
            ),
            KernelCommand::HostMcpRiskDecisionSubmit {
                request_id,
                connector_id,
                binding_id,
                decision,
            } => Some(self.skill_admin.record_mcp_risk(
                request_id,
                connector_id,
                binding_id,
                decision,
            )),
            KernelCommand::AuditQuery { .. } => Some(self.audit.reject_legacy_query()),
            KernelCommand::AuditVerify { .. } => Some(self.audit.reject_legacy_verify()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HostPreparedEmptyWorkspaceV2 {
    pub(crate) workspace_binding_ref: WorkspaceBindingRefV2,
    pub(crate) workspace_binding_identity: String,
    pub(crate) empty_workspace_key: String,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
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
