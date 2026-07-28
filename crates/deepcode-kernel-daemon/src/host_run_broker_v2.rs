use crate::host_v2_storage::{
    atomic_write_private_json, canonical_sha256, create_private_directory, read_json,
    reject_transport_capabilities, sha256_path_component, validate_bounded_identity,
    validate_safe_session_identity, value_without_field, with_storage_path_lock,
    HostV2StorageError,
};
use crate::host_workspace_registry_v2::HostWorkspaceRehydrateRecordV2;
use deepcode_kernel_abi::{RunCapabilityV2, WorkspaceBindingRefV2};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

const ACTIVE_RUN_SCHEMA_V2: &str = "deepcode.host.active-kernel-run.v2";
const MAX_ACTIVE_RUN_RECORDS: usize = 16_384;
static HOST_BRIDGE_GENERATION_V2: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostRunWorkspaceKindV2 {
    Bound,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostRunSettingsCeilingV2 {
    pub(crate) workspace_read: bool,
    pub(crate) workspace_write: bool,
    pub(crate) git_write: bool,
    pub(crate) web_read: bool,
    pub(crate) private_web_read: bool,
    pub(crate) auto_approve_plans: bool,
}

impl HostRunSettingsCeilingV2 {
    pub(crate) fn empty_workspace() -> Self {
        Self {
            workspace_read: false,
            workspace_write: false,
            git_write: false,
            web_read: false,
            private_web_read: false,
            auto_approve_plans: false,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HostActiveRunRegistrationV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) workspace_binding_ref: String,
    pub(crate) workspace_binding_digest: String,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) initial_input_id: String,
    pub(crate) initial_opaque_input_ref: String,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostActiveRunRecordV2 {
    pub(crate) schema_version: String,
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) workspace_binding_ref: String,
    pub(crate) workspace_binding_digest: String,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) initial_input_id: String,
    pub(crate) initial_opaque_input_ref: String,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
    pub(crate) recorded_at: String,
    pub(crate) record_digest: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostEmptyWorkspaceRootV2 {
    pub(crate) key: String,
    pub(crate) root: PathBuf,
    pub(crate) settings: HostRunSettingsCeilingV2,
}

#[derive(Debug, Clone)]
pub(crate) struct HostActiveRunRegistrationReceiptV2 {
    pub(crate) record: HostActiveRunRecordV2,
    pub(crate) replayed: bool,
}

#[derive(Clone)]
pub(crate) struct HostActiveRunBrokerV2 {
    sessions_dir: Arc<PathBuf>,
    startup_errors: Arc<Mutex<Vec<String>>>,
    session_turn_locks: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    bridge_slots: Arc<Mutex<HashMap<String, Weak<Mutex<Option<OwnedHostBridgeChildV2>>>>>>,
    run_transport_capabilities: Arc<Mutex<HashMap<HostRunTransportBindingV2, [u8; 32]>>>,
}

impl HostActiveRunBrokerV2 {
    pub(crate) fn new(sessions_dir: PathBuf) -> Self {
        Self {
            sessions_dir: Arc::new(sessions_dir),
            startup_errors: Arc::new(Mutex::new(Vec::new())),
            session_turn_locks: Arc::new(Mutex::new(HashMap::new())),
            bridge_slots: Arc::new(Mutex::new(HashMap::new())),
            run_transport_capabilities: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Binds the process-private Kernel Run capability to the Host's
    /// session/hostRun/run tuple. Only its SHA-256 digest is retained in
    /// memory; no capability material enters durable active-run state.
    pub(crate) fn bind_run_transport_capability(
        &self,
        turn: &HostSessionTurnGuardV2,
        host_run_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<(), HostV2StorageError> {
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        let active = self.resolve(&turn.session_id, host_run_id)?;
        if active.run_id != run_id {
            return Err(HostV2StorageError::conflict(
                "host_run_transport_binding_mismatch",
                "Host Run transport capability does not match the durable active Run",
            ));
        }
        let binding = HostRunTransportBindingV2 {
            session_id: turn.session_id.clone(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
        };
        let digest = Sha256::digest(capability.expose_to_transport().as_bytes()).into();
        self.run_transport_capabilities
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_run_transport_authority_unavailable",
                    "Host Run transport authority is unavailable",
                )
            })?
            .insert(binding, digest);
        Ok(())
    }

    pub(crate) fn authorize_session_run_transport(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<(), HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        let submitted: [u8; 32] =
            Sha256::digest(capability.expose_to_transport().as_bytes()).into();
        let capabilities = self.run_transport_capabilities.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_run_transport_authority_unavailable",
                "Host Run transport authority is unavailable",
            )
        })?;
        let accepted = capabilities.iter().any(|(binding, expected)| {
            binding.session_id == session_id
                && binding.run_id == run_id
                && constant_time_digest_eq(expected, &submitted)
        });
        if accepted {
            Ok(())
        } else {
            Err(invalid_run_transport_capability())
        }
    }

    pub(crate) fn authorize_host_run_transport(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<(), HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        let binding = HostRunTransportBindingV2 {
            session_id: session_id.to_string(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
        };
        let submitted: [u8; 32] =
            Sha256::digest(capability.expose_to_transport().as_bytes()).into();
        let capabilities = self.run_transport_capabilities.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_run_transport_authority_unavailable",
                "Host Run transport authority is unavailable",
            )
        })?;
        if capabilities
            .get(&binding)
            .is_some_and(|expected| constant_time_digest_eq(expected, &submitted))
        {
            Ok(())
        } else {
            Err(invalid_run_transport_capability())
        }
    }

    /// Serializes the Host-owned lifecycle for one Session. A caller must
    /// durably persist the new input, advance the Kernel control epoch, request
    /// cancellation, and reconcile facts before it supersedes the old bridge
    /// child through this guard.
    pub(crate) async fn begin_session_turn(
        &self,
        session_id: &str,
    ) -> Result<HostSessionTurnGuardV2, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        let lock = {
            let mut locks = self.session_turn_locks.lock().map_err(|_| {
                HostV2StorageError::io(
                    "host_active_run_turn_lock_unavailable",
                    "Host active-run Session lock registry is unavailable",
                )
            })?;
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(session_id).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(session_id.to_string(), Arc::downgrade(&lock));
                lock
            }
        };
        let turn_guard = lock.lock_owned().await;
        Ok(HostSessionTurnGuardV2 {
            session_id: session_id.to_string(),
            _turn_guard: turn_guard,
        })
    }

    /// Spawns and installs the one Host-owned bridge child for this Session.
    /// Any prior child is terminated by its exact retained handle and reaped
    /// before the replacement becomes visible.
    pub(crate) fn spawn_bridge_child(
        &self,
        turn: &HostSessionTurnGuardV2,
        host_run_id: &str,
        command: &mut Command,
    ) -> Result<HostBridgeChildLeaseV2, HostV2StorageError> {
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        let child = command.spawn().map_err(|error| {
            HostV2StorageError::io(
                "host_bridge_v2_spawn_failed",
                format!("spawn Host-owned Session bridge: {error}"),
            )
        })?;
        self.install_bridge_child(turn, host_run_id, child)
    }

    pub(crate) fn supersede_bridge_child(
        &self,
        turn: &HostSessionTurnGuardV2,
    ) -> Result<bool, HostV2StorageError> {
        let slot = self.bridge_slot(&turn.session_id)?;
        let previous = {
            let mut child = slot.lock().map_err(|_| {
                HostV2StorageError::io(
                    "host_bridge_v2_owner_unavailable",
                    "Host bridge child owner is unavailable",
                )
            })?;
            child.take()
        };
        match previous {
            Some(previous) => {
                terminate_owned_bridge_child(previous.child)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    fn install_bridge_child(
        &self,
        turn: &HostSessionTurnGuardV2,
        host_run_id: &str,
        child: Child,
    ) -> Result<HostBridgeChildLeaseV2, HostV2StorageError> {
        let mut pending_child = PendingHostBridgeChildV2::new(child);
        let slot = self.bridge_slot(&turn.session_id)?;
        let previous = {
            let mut current = slot.lock().map_err(|_| {
                HostV2StorageError::io(
                    "host_bridge_v2_owner_unavailable",
                    "Host bridge child owner is unavailable",
                )
            })?;
            current.take()
        };
        if let Some(previous) = previous {
            terminate_owned_bridge_child(previous.child)?;
        }
        let generation = match HOST_BRIDGE_GENERATION_V2.fetch_update(
            Ordering::Relaxed,
            Ordering::Relaxed,
            |value| value.checked_add(1),
        ) {
            Ok(generation) => generation,
            Err(_) => {
                return Err(HostV2StorageError::conflict(
                    "host_bridge_v2_generation_exhausted",
                    "Host bridge child generation is exhausted",
                ));
            }
        };
        {
            let mut current = slot.lock().map_err(|_| {
                HostV2StorageError::io(
                    "host_bridge_v2_owner_unavailable",
                    "Host bridge child owner is unavailable",
                )
            })?;
            *current = Some(OwnedHostBridgeChildV2 {
                host_run_id: host_run_id.to_string(),
                generation,
                child: pending_child.take(),
            });
        }
        Ok(HostBridgeChildLeaseV2 {
            session_id: turn.session_id.clone(),
            host_run_id: host_run_id.to_string(),
            generation,
            slot,
        })
    }

    fn bridge_slot(
        &self,
        session_id: &str,
    ) -> Result<Arc<Mutex<Option<OwnedHostBridgeChildV2>>>, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        let mut slots = self.bridge_slots.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_bridge_v2_owner_unavailable",
                "Host bridge child registry is unavailable",
            )
        })?;
        slots.retain(|_, slot| slot.strong_count() > 0);
        if let Some(slot) = slots.get(session_id).and_then(Weak::upgrade) {
            return Ok(slot);
        }
        let slot = Arc::new(Mutex::new(None));
        slots.insert(session_id.to_string(), Arc::downgrade(&slot));
        Ok(slot)
    }

    pub(crate) fn register(
        &self,
        input: HostActiveRunRegistrationV2,
    ) -> Result<HostActiveRunRegistrationReceiptV2, HostV2StorageError> {
        validate_registration(&input)?;
        let record = active_run_record(input)?;
        let path = self.active_run_path(&record.session_id, &record.host_run_id)?;
        with_storage_path_lock(&path, || {
            if let Some(existing) = read_json(&path)? {
                let existing = decode_active_run_record(existing)?;
                if existing.record_digest == record.record_digest {
                    return Ok(HostActiveRunRegistrationReceiptV2 {
                        record: existing,
                        replayed: true,
                    });
                }
                return Err(HostV2StorageError::conflict(
                    "host_active_run_identity_conflict",
                    "Host active-run identity already has different durable content",
                ));
            }
            atomic_write_private_json(
                &path,
                &serde_json::to_value(&record).map_err(|error| {
                    HostV2StorageError::invalid(
                        "host_active_run_encode_failed",
                        format!("encode Host active-run record: {error}"),
                    )
                })?,
            )?;
            Ok(HostActiveRunRegistrationReceiptV2 {
                record,
                replayed: false,
            })
        })
    }

    pub(crate) fn resolve(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
        let path = self.active_run_path(session_id, host_run_id)?;
        with_storage_path_lock(&path, || {
            let value = read_json(&path)?.ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_active_run_not_found",
                    "Host active-run record was not found",
                )
            })?;
            let record = decode_active_run_record(value)?;
            if record.session_id != session_id || record.host_run_id != host_run_id {
                return Err(HostV2StorageError::conflict(
                    "host_active_run_identity_conflict",
                    "Host active-run record does not match its durable location",
                ));
            }
            Ok(record)
        })
    }

    pub(crate) fn prepare_empty_workspace_root(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<HostEmptyWorkspaceRootV2, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        let key = sha256_path_component(&format!(
            "deepcode.host.empty-workspace.v2\0{session_id}\0{host_run_id}"
        ));
        let root = self.empty_workspace_root(&key)?;
        with_storage_path_lock(&root, || {
            create_private_directory(&root)?;
            let mut entries = fs::read_dir(&root).map_err(|error| {
                HostV2StorageError::io(
                    "host_empty_workspace_unavailable",
                    format!("inspect Host-managed empty workspace: {error}"),
                )
            })?;
            if entries.next().is_some() {
                return Err(HostV2StorageError::conflict(
                    "host_empty_workspace_not_empty",
                    "Host-managed empty workspace contains unexpected content",
                ));
            }
            Ok(())
        })?;
        Ok(HostEmptyWorkspaceRootV2 {
            key,
            root,
            settings: HostRunSettingsCeilingV2::empty_workspace(),
        })
    }

    pub(crate) fn workspace_rehydrate_records(&self) -> Vec<HostWorkspaceRehydrateRecordV2> {
        match self.scan_active_run_records() {
            Ok(records) => {
                self.replace_startup_errors(Vec::new());
                records
                    .into_iter()
                    .filter(|record| record.workspace_kind == HostRunWorkspaceKindV2::Empty)
                    .filter_map(|record| {
                        let key = record.empty_workspace_key.as_deref()?;
                        let root = self.empty_workspace_root(key).ok()?;
                        let reference =
                            WorkspaceBindingRefV2::new(record.workspace_binding_ref).ok()?;
                        Some(HostWorkspaceRehydrateRecordV2::new(
                            reference,
                            root,
                            Some(record.workspace_binding_identity),
                        ))
                    })
                    .collect()
            }
            Err(error) => {
                self.replace_startup_errors(vec![error.code.to_string()]);
                Vec::new()
            }
        }
    }

    pub(crate) fn status(&self) -> Value {
        let errors = self
            .startup_errors
            .lock()
            .map(|errors| errors.clone())
            .unwrap_or_else(|_| vec!["host_active_run_status_unavailable".to_string()]);
        json!({
            "status": if errors.is_empty() { "ready" } else { "degraded" },
            "schemaVersion": ACTIVE_RUN_SCHEMA_V2,
            "startupErrorCodes": errors,
            "ownedBridgeChildCount": self.owned_bridge_child_count(),
            "authorizedRunTransportCount": self.run_transport_capability_count()
        })
    }

    fn owned_bridge_child_count(&self) -> usize {
        self.bridge_slots
            .lock()
            .map(|slots| {
                slots
                    .values()
                    .filter_map(Weak::upgrade)
                    .filter(|slot| slot.lock().map(|child| child.is_some()).unwrap_or_default())
                    .count()
            })
            .unwrap_or_default()
    }

    fn run_transport_capability_count(&self) -> usize {
        self.run_transport_capabilities
            .lock()
            .map(|capabilities| capabilities.len())
            .unwrap_or_default()
    }

    fn scan_active_run_records(&self) -> Result<Vec<HostActiveRunRecordV2>, HostV2StorageError> {
        let sessions = match fs::read_dir(self.sessions_dir.as_ref()) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(HostV2StorageError::io(
                    "host_active_run_scan_failed",
                    format!("scan Host Session storage: {error}"),
                ))
            }
        };
        let mut records = Vec::new();
        for session in sessions {
            let session = session.map_err(|error| {
                HostV2StorageError::io(
                    "host_active_run_scan_failed",
                    format!("scan Host Session directory: {error}"),
                )
            })?;
            if !session
                .file_type()
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            let active_dir = session.path().join("kernel-v2").join("active-runs");
            let entries = match fs::read_dir(active_dir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(HostV2StorageError::io(
                        "host_active_run_scan_failed",
                        format!("scan Host active-run directory: {error}"),
                    ))
                }
            };
            for entry in entries {
                if records.len() >= MAX_ACTIVE_RUN_RECORDS {
                    return Err(HostV2StorageError::conflict(
                        "host_active_run_scan_limit",
                        "Host active-run recovery exceeds the bounded record limit",
                    ));
                }
                let entry = entry.map_err(|error| {
                    HostV2StorageError::io(
                        "host_active_run_scan_failed",
                        format!("scan Host active-run record: {error}"),
                    )
                })?;
                if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }
                let value = read_json(&entry.path())?.ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_active_run_record_missing",
                        "Host active-run record disappeared during recovery",
                    )
                })?;
                records.push(decode_active_run_record(value)?);
            }
        }
        Ok(records)
    }

    fn active_run_path(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<PathBuf, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        Ok(self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join("active-runs")
            .join(format!("{}.json", sha256_path_component(host_run_id))))
    }

    fn empty_workspace_root(&self, key: &str) -> Result<PathBuf, HostV2StorageError> {
        validate_empty_workspace_key(key)?;
        Ok(self
            .sessions_dir
            .join(".host-v2")
            .join("empty-workspaces")
            .join(key))
    }

    fn replace_startup_errors(&self, errors: Vec<String>) {
        if let Ok(mut current) = self.startup_errors.lock() {
            *current = errors;
        }
    }
}

pub(crate) struct HostSessionTurnGuardV2 {
    session_id: String,
    _turn_guard: OwnedMutexGuard<()>,
}

struct OwnedHostBridgeChildV2 {
    host_run_id: String,
    generation: u64,
    child: Child,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct HostRunTransportBindingV2 {
    session_id: String,
    host_run_id: String,
    run_id: String,
}

struct PendingHostBridgeChildV2 {
    child: Option<Child>,
}

impl PendingHostBridgeChildV2 {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn take(&mut self) -> Child {
        self.child
            .take()
            .expect("pending Host bridge child is present")
    }
}

impl Drop for PendingHostBridgeChildV2 {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            let _ = terminate_owned_bridge_child(child);
        }
    }
}

pub(crate) struct HostBridgeChildLeaseV2 {
    session_id: String,
    host_run_id: String,
    generation: u64,
    slot: Arc<Mutex<Option<OwnedHostBridgeChildV2>>>,
}

impl HostBridgeChildLeaseV2 {
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(crate) fn host_run_id(&self) -> &str {
        &self.host_run_id
    }

    pub(crate) fn take_stdin(&self) -> Result<Option<ChildStdin>, HostV2StorageError> {
        self.with_child(|child| Ok(child.stdin.take()))
    }

    pub(crate) fn take_stdout(&self) -> Result<Option<ChildStdout>, HostV2StorageError> {
        self.with_child(|child| Ok(child.stdout.take()))
    }

    pub(crate) fn take_stderr(&self) -> Result<Option<ChildStderr>, HostV2StorageError> {
        self.with_child(|child| Ok(child.stderr.take()))
    }

    pub(crate) fn try_wait(&self) -> Result<Option<ExitStatus>, HostV2StorageError> {
        self.with_child(Child::try_wait)
    }

    pub(crate) fn terminate_and_wait(&self) -> Result<(), HostV2StorageError> {
        let child = self.take_owned_child()?;
        match child {
            Some(child) => terminate_owned_bridge_child(child.child),
            None => Ok(()),
        }
    }

    fn with_child<T>(
        &self,
        operation: impl FnOnce(&mut Child) -> io::Result<T>,
    ) -> Result<T, HostV2StorageError> {
        let mut slot = self.slot.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_bridge_v2_owner_unavailable",
                "Host bridge child owner is unavailable",
            )
        })?;
        let child = slot.as_mut().ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_bridge_v2_superseded",
                "Host bridge child was superseded or already reaped",
            )
        })?;
        if child.host_run_id != self.host_run_id || child.generation != self.generation {
            return Err(HostV2StorageError::conflict(
                "host_bridge_v2_superseded",
                "Host bridge child was superseded by a newer Session turn",
            ));
        }
        operation(&mut child.child).map_err(|error| {
            HostV2StorageError::io(
                "host_bridge_v2_child_operation_failed",
                format!("operate Host-owned Session bridge: {error}"),
            )
        })
    }

    fn take_owned_child(&self) -> Result<Option<OwnedHostBridgeChildV2>, HostV2StorageError> {
        let mut slot = self.slot.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_bridge_v2_owner_unavailable",
                "Host bridge child owner is unavailable",
            )
        })?;
        if slot.as_ref().is_some_and(|child| {
            child.host_run_id == self.host_run_id && child.generation == self.generation
        }) {
            Ok(slot.take())
        } else {
            Ok(None)
        }
    }
}

impl Drop for HostBridgeChildLeaseV2 {
    fn drop(&mut self) {
        if let Ok(Some(child)) = self.take_owned_child() {
            let _ = terminate_owned_bridge_child(child.child);
        }
    }
}

fn terminate_owned_bridge_child(mut child: Child) -> Result<(), HostV2StorageError> {
    let kill_error = match child.try_wait() {
        Ok(Some(_)) => None,
        Ok(None) => {
            if let Err(error) = child.kill() {
                Some(error)
            } else {
                None
            }
        }
        Err(error) => {
            return Err(HostV2StorageError::io(
                "host_bridge_v2_wait_failed",
                format!("inspect Host-owned Session bridge: {error}"),
            ))
        }
    };
    child.wait().map_err(|error| {
        HostV2StorageError::io(
            "host_bridge_v2_wait_failed",
            format!("reap Host-owned Session bridge: {error}"),
        )
    })?;
    if let Some(error) = kill_error {
        return Err(HostV2StorageError::io(
            "host_bridge_v2_terminate_failed",
            format!("terminate Host-owned Session bridge: {error}"),
        ));
    }
    Ok(())
}

fn constant_time_digest_eq(expected: &[u8; 32], submitted: &[u8; 32]) -> bool {
    expected
        .iter()
        .zip(submitted)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn invalid_run_transport_capability() -> HostV2StorageError {
    HostV2StorageError::unauthorized(
        "host_run_transport_capability_invalid",
        "Host Run transport capability is invalid for this Session and Run",
    )
}

fn validate_registration(input: &HostActiveRunRegistrationV2) -> Result<(), HostV2StorageError> {
    validate_safe_session_identity(&input.session_id)?;
    for (field, value) in [
        ("hostRunId", input.host_run_id.as_str()),
        ("runId", input.run_id.as_str()),
        ("workspaceBindingRef", input.workspace_binding_ref.as_str()),
        (
            "workspaceBindingDigest",
            input.workspace_binding_digest.as_str(),
        ),
        (
            "workspaceBindingIdentity",
            input.workspace_binding_identity.as_str(),
        ),
        ("initialInputId", input.initial_input_id.as_str()),
        (
            "initialOpaqueInputRef",
            input.initial_opaque_input_ref.as_str(),
        ),
        ("recordedAt", input.recorded_at.as_str()),
    ] {
        validate_bounded_identity(value, field, 128 * 1024)?;
    }
    match input.workspace_kind {
        HostRunWorkspaceKindV2::Bound if input.empty_workspace_key.is_some() => {
            return Err(HostV2StorageError::invalid(
                "host_active_run_workspace_invalid",
                "Bound Host run cannot carry an empty workspace key",
            ))
        }
        HostRunWorkspaceKindV2::Empty => {
            let key = input.empty_workspace_key.as_deref().ok_or_else(|| {
                HostV2StorageError::invalid(
                    "host_active_run_workspace_invalid",
                    "Empty Host run requires its managed workspace key",
                )
            })?;
            validate_empty_workspace_key(key)?;
            if input.run_settings != HostRunSettingsCeilingV2::empty_workspace() {
                return Err(HostV2StorageError::invalid(
                    "host_empty_workspace_settings_invalid",
                    "Empty Host runs must disable all workspace and network capabilities",
                ));
            }
        }
        _ => {}
    }
    let value = serde_json::to_value(input.run_settings.clone()).map_err(|error| {
        HostV2StorageError::invalid(
            "host_active_run_settings_invalid",
            format!("encode Host active-run settings: {error}"),
        )
    })?;
    reject_transport_capabilities(&value)
}

fn validate_empty_workspace_key(key: &str) -> Result<(), HostV2StorageError> {
    if key.len() != 64
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(HostV2StorageError::invalid(
            "host_empty_workspace_key_invalid",
            "Host-managed empty workspace key is invalid",
        ));
    }
    Ok(())
}

fn active_run_record(
    input: HostActiveRunRegistrationV2,
) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
    let mut value = json!({
        "schemaVersion": ACTIVE_RUN_SCHEMA_V2,
        "sessionId": input.session_id,
        "hostRunId": input.host_run_id,
        "runId": input.run_id,
        "workspaceBindingRef": input.workspace_binding_ref,
        "workspaceBindingDigest": input.workspace_binding_digest,
        "workspaceBindingIdentity": input.workspace_binding_identity,
        "workspaceKind": input.workspace_kind,
        "initialInputId": input.initial_input_id,
        "initialOpaqueInputRef": input.initial_opaque_input_ref,
        "runSettings": input.run_settings,
        "recordedAt": input.recorded_at
    });
    if let Some(key) = input.empty_workspace_key {
        value["emptyWorkspaceKey"] = Value::String(key);
    }
    reject_transport_capabilities(&value)?;
    let digest = canonical_sha256(&value)?;
    value["recordDigest"] = Value::String(digest);
    serde_json::from_value(value).map_err(|error| {
        HostV2StorageError::invalid(
            "host_active_run_record_invalid",
            format!("construct Host active-run record: {error}"),
        )
    })
}

fn decode_active_run_record(value: Value) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
    reject_transport_capabilities(&value)?;
    let record: HostActiveRunRecordV2 = serde_json::from_value(value.clone()).map_err(|error| {
        HostV2StorageError::conflict(
            "host_active_run_record_corrupt",
            format!("decode Host active-run record: {error}"),
        )
    })?;
    if record.schema_version != ACTIVE_RUN_SCHEMA_V2 {
        return Err(HostV2StorageError::conflict(
            "host_active_run_schema_unsupported",
            "Host active-run record has an unsupported schema",
        ));
    }
    let without_digest = value_without_field(&value, "recordDigest")?;
    let expected = canonical_sha256(&without_digest)?;
    if expected != record.record_digest {
        return Err(HostV2StorageError::conflict(
            "host_active_run_digest_mismatch",
            "Host active-run record failed digest verification",
        ));
    }
    validate_registration(&HostActiveRunRegistrationV2 {
        session_id: record.session_id.clone(),
        host_run_id: record.host_run_id.clone(),
        run_id: record.run_id.clone(),
        workspace_binding_ref: record.workspace_binding_ref.clone(),
        workspace_binding_digest: record.workspace_binding_digest.clone(),
        workspace_binding_identity: record.workspace_binding_identity.clone(),
        workspace_kind: record.workspace_kind,
        empty_workspace_key: record.empty_workspace_key.clone(),
        initial_input_id: record.initial_input_id.clone(),
        initial_opaque_input_ref: record.initial_opaque_input_ref.clone(),
        run_settings: record.run_settings.clone(),
        recorded_at: record.recorded_at.clone(),
    })?;
    Ok(record)
}
