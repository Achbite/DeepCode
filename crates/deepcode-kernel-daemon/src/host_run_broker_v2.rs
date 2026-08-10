use crate::host_v2_storage::{
    atomic_write_private_json, canonical_sha256, create_private_directory, read_json,
    reject_transport_capabilities, sha256_path_component, sync_directory,
    validate_bounded_identity, validate_safe_session_identity, value_without_field,
    with_storage_path_lock, with_storage_path_locks, HostV2StorageError,
};
use crate::host_workspace_registry_v2::HostWorkspaceRehydrateRecordV2;
use deepcode_kernel_abi::v2::RunRetirementReasonCodeV2;
use deepcode_kernel_abi::{RunCapabilityV2, WorkspaceBindingRefV2};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

const ACTIVE_RUN_SCHEMA_V2: &str = "deepcode.host.kernel-run-lifecycle.v3";
const MAX_ACTIVE_RUN_RECORDS: usize = 16_384;
static HOST_BRIDGE_GENERATION_V2: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostRunWorkspaceKindV2 {
    Bound,
    Empty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostRunLifecycleV2 {
    Active,
    Retiring,
    Retired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum HostBridgeOwnershipV2 {
    NotStarted,
    SpawnPrepared {
        owner_instance_id: String,
        generation: u64,
    },
    Owned {
        owner_instance_id: String,
        generation: u64,
    },
    Reaped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostRunRetirementProgressV2 {
    pub(crate) requested_at: String,
    pub(crate) reason_code: RunRetirementReasonCodeV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    pub(crate) kernel_run_retired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kernel_retirement_fact_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) kernel_retirement_ledger_sequence: Option<u64>,
    pub(crate) transport_capability_unbound: bool,
    pub(crate) bridge_child_reaped: bool,
    pub(crate) workspace_binding_unregistered: bool,
    pub(crate) empty_workspace_removed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostRunSettingsCeilingV2 {
    pub(crate) workspace_read: bool,
    pub(crate) workspace_write: bool,
    pub(crate) web_read: bool,
    pub(crate) auto_approve_plans: bool,
}

impl HostRunSettingsCeilingV2 {
    pub(crate) fn empty_workspace() -> Self {
        Self {
            workspace_read: false,
            workspace_write: false,
            web_read: false,
            auto_approve_plans: false,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HostActiveRunRegistrationV2 {
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) bootstrap_digest: String,
    pub(crate) workspace_binding_ref: String,
    pub(crate) workspace_binding_digest: String,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) active_folder_id: Option<String>,
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
    pub(crate) lifecycle: HostRunLifecycleV2,
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) run_id: String,
    pub(crate) bootstrap_digest: String,
    pub(crate) workspace_binding_ref: String,
    pub(crate) workspace_binding_digest: String,
    pub(crate) workspace_binding_identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_canonical_root: Option<PathBuf>,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) active_folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) initial_input_id: String,
    pub(crate) initial_opaque_input_ref: String,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
    pub(crate) recorded_at: String,
    pub(crate) registration_digest: String,
    pub(crate) bridge_ownership: HostBridgeOwnershipV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) retirement: Option<HostRunRetirementProgressV2>,
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

#[derive(Debug, Clone)]
pub(crate) struct HostRunRetirementReceiptV2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostKernelRunRetirementProofV2 {
    pub(crate) fact_id: String,
    pub(crate) ledger_sequence: u64,
}

#[derive(Clone)]
pub(crate) struct HostActiveRunBrokerV2 {
    sessions_dir: Arc<PathBuf>,
    owner_instance_id: Arc<String>,
    startup_errors: Arc<Mutex<Vec<String>>>,
    session_turn_locks: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    bridge_slots: Arc<Mutex<HashMap<String, Arc<Mutex<Option<OwnedHostBridgeChildV2>>>>>>,
    _bridge_finalizer: Arc<HostBridgeFinalizerV2>,
    run_transport_capabilities:
        Arc<Mutex<HashMap<HostRunTransportBindingV2, HostRunTransportCapabilityV2>>>,
}

impl HostActiveRunBrokerV2 {
    pub(crate) fn new(sessions_dir: PathBuf) -> Result<Self, HostV2StorageError> {
        let sessions_dir = Arc::new(sessions_dir);
        let owner_instance_id = Arc::new(boot_owner_instance_id()?);
        let bridge_slots = Arc::new(Mutex::new(HashMap::new()));
        let bridge_finalizer = Arc::new(HostBridgeFinalizerV2 {
            sessions_dir: Arc::clone(&sessions_dir),
            owner_instance_id: Arc::clone(&owner_instance_id),
            bridge_slots: Arc::clone(&bridge_slots),
        });
        Ok(Self {
            sessions_dir,
            owner_instance_id,
            startup_errors: Arc::new(Mutex::new(Vec::new())),
            session_turn_locks: Arc::new(Mutex::new(HashMap::new())),
            bridge_slots,
            _bridge_finalizer: bridge_finalizer,
            run_transport_capabilities: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(crate) fn owner_instance_id(&self) -> String {
        self.owner_instance_id.as_ref().clone()
    }

    /// Binds the process-private Kernel Run capability to the Host's
    /// session/hostRun/run tuple. The typed capability and its digest remain
    /// process-private; neither is serializable or included in Debug output.
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
        let mut capabilities = self.run_transport_capabilities.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_run_transport_authority_unavailable",
                "Host Run transport authority is unavailable",
            )
        })?;
        if let Some(existing) = capabilities.get(&binding) {
            if constant_time_digest_eq(&existing.digest, &digest) {
                return Ok(());
            }
            return Err(HostV2StorageError::conflict(
                "host_run_transport_capability_conflict",
                "Host Run transport capability is already bound to different private material",
            ));
        }
        capabilities.insert(
            binding,
            HostRunTransportCapabilityV2 {
                capability: capability.clone(),
                digest,
            },
        );
        Ok(())
    }

    /// Returns process-private capability material only to trusted Host code
    /// that supplies the exact durable session/hostRun/run identity.
    pub(crate) fn run_transport_capability(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
    ) -> Result<RunCapabilityV2, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        let active = self.resolve(session_id, host_run_id)?;
        if active.run_id != run_id {
            return Err(HostV2StorageError::conflict(
                "host_run_transport_binding_mismatch",
                "Host Run transport capability does not match the durable active Run",
            ));
        }
        let binding = HostRunTransportBindingV2 {
            session_id: session_id.to_string(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
        };
        self.run_transport_capabilities
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_run_transport_authority_unavailable",
                    "Host Run transport authority is unavailable",
                )
            })?
            .get(&binding)
            .map(|bound| bound.capability.clone())
            .ok_or_else(invalid_run_transport_capability)
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
        let binding = self
            .run_transport_capabilities
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_run_transport_authority_unavailable",
                    "Host Run transport authority is unavailable",
                )
            })?
            .iter()
            .find(|(binding, expected)| {
                binding.session_id == session_id
                    && binding.run_id == run_id
                    && constant_time_digest_eq(&expected.digest, &submitted)
            })
            .map(|(binding, _)| binding.clone())
            .ok_or_else(invalid_run_transport_capability)?;
        let active = self.resolve(&binding.session_id, &binding.host_run_id)?;
        if active.run_id == binding.run_id {
            Ok(())
        } else {
            Err(invalid_run_transport_capability())
        }
    }

    /// Resolves the durable Host binding for a process-private Run capability.
    /// The returned identity is advisory only: callers that perform storage or
    /// effects must re-authorize under their coordinated resource lock.
    pub(crate) fn resolve_session_run_transport(
        &self,
        run_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
        validate_bounded_identity(run_id, "runId", 512)?;
        let submitted: [u8; 32] =
            Sha256::digest(capability.expose_to_transport().as_bytes()).into();
        let binding = self
            .run_transport_capabilities
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_run_transport_authority_unavailable",
                    "Host Run transport authority is unavailable",
                )
            })?
            .iter()
            .find(|(binding, expected)| {
                binding.run_id == run_id && constant_time_digest_eq(&expected.digest, &submitted)
            })
            .map(|(binding, _)| binding.clone())
            .ok_or_else(invalid_run_transport_capability)?;
        let active = self
            .resolve(&binding.session_id, &binding.host_run_id)
            .map_err(|_| invalid_run_transport_capability())?;
        if active.lifecycle == HostRunLifecycleV2::Active && active.run_id == binding.run_id {
            Ok(active)
        } else {
            Err(invalid_run_transport_capability())
        }
    }

    pub(crate) fn with_authorized_session_run_transport_storage<T>(
        &self,
        session_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
        coordinated_path: &Path,
        operation: impl FnOnce() -> Result<T, HostV2StorageError>,
    ) -> Result<T, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        let submitted: [u8; 32] =
            Sha256::digest(capability.expose_to_transport().as_bytes()).into();
        let binding = self
            .run_transport_capabilities
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_run_transport_authority_unavailable",
                    "Host Run transport authority is unavailable",
                )
            })?
            .iter()
            .find(|(binding, expected)| {
                binding.session_id == session_id
                    && binding.run_id == run_id
                    && constant_time_digest_eq(&expected.digest, &submitted)
            })
            .map(|(binding, _)| binding.clone())
            .ok_or_else(invalid_run_transport_capability)?;
        let active_path = self.active_run_path(&binding.session_id, &binding.host_run_id)?;
        with_storage_path_locks(&[&active_path, coordinated_path], || {
            let value = read_json(&active_path)?.ok_or_else(invalid_run_transport_capability)?;
            let active =
                decode_active_run_record(value).map_err(|_| invalid_run_transport_capability())?;
            if active.lifecycle != HostRunLifecycleV2::Active
                || active.session_id != binding.session_id
                || active.host_run_id != binding.host_run_id
                || active.run_id != binding.run_id
            {
                return Err(invalid_run_transport_capability());
            }
            let capability_still_bound = self
                .run_transport_capabilities
                .lock()
                .map_err(|_| {
                    HostV2StorageError::io(
                        "host_run_transport_authority_unavailable",
                        "Host Run transport authority is unavailable",
                    )
                })?
                .get(&binding)
                .is_some_and(|expected| constant_time_digest_eq(&expected.digest, &submitted));
            if !capability_still_bound {
                return Err(invalid_run_transport_capability());
            }
            operation()
        })
    }

    pub(crate) fn authorize_host_run_transport(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<(), HostV2StorageError> {
        let active =
            self.authorize_host_run_transport_binding(session_id, host_run_id, capability)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        if active.run_id == run_id {
            Ok(())
        } else {
            Err(invalid_run_transport_capability())
        }
    }

    pub(crate) fn authorize_host_run_transport_binding(
        &self,
        session_id: &str,
        host_run_id: &str,
        capability: &RunCapabilityV2,
    ) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        let submitted: [u8; 32] =
            Sha256::digest(capability.expose_to_transport().as_bytes()).into();
        let binding = self
            .run_transport_capabilities
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_run_transport_authority_unavailable",
                    "Host Run transport authority is unavailable",
                )
            })?
            .iter()
            .find(|(binding, expected)| {
                binding.session_id == session_id
                    && binding.host_run_id == host_run_id
                    && constant_time_digest_eq(&expected.digest, &submitted)
            })
            .map(|(binding, _)| binding.clone())
            .ok_or_else(invalid_run_transport_capability)?;
        let active = self
            .resolve(&binding.session_id, &binding.host_run_id)
            .map_err(|_| invalid_run_transport_capability())?;
        if active.run_id == binding.run_id {
            Ok(active)
        } else {
            Err(invalid_run_transport_capability())
        }
    }

    fn unbind_run_transport_capability(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
    ) -> Result<bool, HostV2StorageError> {
        let binding = HostRunTransportBindingV2 {
            session_id: session_id.to_string(),
            host_run_id: host_run_id.to_string(),
            run_id: run_id.to_string(),
        };
        Ok(self
            .run_transport_capabilities
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_run_transport_authority_unavailable",
                    "Host Run transport authority is unavailable",
                )
            })?
            .remove(&binding)
            .is_some())
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
        let initial = self.resolve(&turn.session_id, host_run_id)?;
        let slot = self.bridge_slot(&turn.session_id)?;
        let mut current = slot.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_bridge_v2_owner_unavailable",
                "Host bridge child owner is unavailable",
            )
        })?;
        if let Some(previous) = current.as_mut() {
            terminate_owned_bridge_child_ref(&mut previous.child)?;
            self.mark_bridge_reaped_exact(
                &turn.session_id,
                &previous.host_run_id,
                &previous.run_id,
                previous.generation,
            )?;
            current.take();
        }
        let active = self.resolve(&turn.session_id, host_run_id)?;
        if active.run_id != initial.run_id
            || !matches!(
                active.bridge_ownership,
                HostBridgeOwnershipV2::NotStarted | HostBridgeOwnershipV2::Reaped
            )
        {
            return Err(HostV2StorageError::conflict(
                "host_bridge_v2_owner_lost",
                "Host Run cannot spawn a bridge while durable child ownership is unresolved",
            ));
        }
        let generation = next_bridge_generation()?;
        self.mark_bridge_spawn_prepared(&active, generation)?;
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let spawn_error = HostV2StorageError::io(
                    "host_bridge_v2_spawn_failed",
                    format!("spawn Host-owned Session bridge: {error}"),
                );
                if let Err(cleanup_error) = self.mark_bridge_reaped_exact(
                    &turn.session_id,
                    host_run_id,
                    &active.run_id,
                    generation,
                ) {
                    return Err(HostV2StorageError::io(
                        "host_bridge_v2_spawn_state_failed",
                        format!(
                            "{}; failed to persist that no child was installed: {}",
                            spawn_error.code, cleanup_error.code
                        ),
                    ));
                }
                return Err(spawn_error);
            }
        };
        *current = Some(OwnedHostBridgeChildV2 {
            host_run_id: host_run_id.to_string(),
            run_id: active.run_id.clone(),
            generation,
            child,
        });
        if let Err(state_error) =
            self.mark_bridge_owned_exact(&turn.session_id, host_run_id, &active.run_id, generation)
        {
            let cleanup = current.as_mut().ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_bridge_v2_spawn_state_conflict",
                    "Host bridge child disappeared while its durable ownership was recorded",
                )
            });
            match cleanup.and_then(|owned| {
                terminate_owned_bridge_child_ref(&mut owned.child)?;
                self.mark_bridge_reaped_exact(
                    &turn.session_id,
                    host_run_id,
                    &active.run_id,
                    generation,
                )
            }) {
                Ok(()) => {
                    current.take();
                    return Err(state_error);
                }
                Err(cleanup_error) => {
                    return Err(HostV2StorageError::io(
                        "host_bridge_v2_spawn_state_cleanup_pending",
                        format!(
                            "record bridge ownership failed with {}; exact child cleanup remains owned after {}",
                            state_error.code, cleanup_error.code
                        ),
                    ))
                }
            }
        }
        drop(current);
        Ok(HostBridgeChildLeaseV2 {
            broker: self.clone(),
            session_id: turn.session_id.clone(),
            host_run_id: host_run_id.to_string(),
            run_id: active.run_id,
            generation,
            slot,
        })
    }

    fn remove_empty_bridge_slot(&self, session_id: &str) {
        let candidate = self
            .bridge_slots
            .lock()
            .ok()
            .and_then(|slots| slots.get(session_id).cloned());
        let Some(candidate) = candidate else {
            return;
        };
        if candidate
            .lock()
            .map(|child| child.is_some())
            .unwrap_or(true)
        {
            return;
        }
        if let Ok(mut slots) = self.bridge_slots.lock() {
            if slots
                .get(session_id)
                .is_some_and(|current| Arc::ptr_eq(current, &candidate))
            {
                slots.remove(session_id);
            }
        }
    }

    fn terminate_bridge_child_for_run(
        &self,
        turn: &HostSessionTurnGuardV2,
        host_run_id: &str,
        run_id: &str,
        generation: u64,
    ) -> Result<(), HostV2StorageError> {
        let slot = self.bridge_slot(&turn.session_id)?;
        let mut current = slot.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_bridge_v2_owner_unavailable",
                "Host bridge child owner is unavailable",
            )
        })?;
        let Some(owned) = current.as_mut() else {
            if self.bridge_child_durably_reaped(&turn.session_id, host_run_id, run_id)? {
                return Ok(());
            }
            return Err(HostV2StorageError::conflict(
                "host_run_retirement_child_ownership_lost",
                "Host Run durable child ownership has no matching process handle",
            ));
        };
        if owned.host_run_id != host_run_id
            || owned.run_id != run_id
            || owned.generation != generation
        {
            if self.bridge_child_durably_reaped(&turn.session_id, host_run_id, run_id)? {
                return Ok(());
            }
            return Err(HostV2StorageError::conflict(
                "host_run_retirement_child_identity_mismatch",
                "Host Run bridge slot belongs to a different exact child identity",
            ));
        }
        terminate_owned_bridge_child_ref(&mut owned.child)?;
        self.mark_bridge_reaped_exact(&turn.session_id, host_run_id, run_id, generation)?;
        current.take();
        drop(current);
        self.remove_empty_bridge_slot(&turn.session_id);
        Ok(())
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
        if let Some(slot) = slots.get(session_id) {
            return Ok(Arc::clone(slot));
        }
        let slot = Arc::new(Mutex::new(None));
        slots.insert(session_id.to_string(), Arc::clone(&slot));
        Ok(slot)
    }

    fn mark_bridge_spawn_prepared(
        &self,
        expected: &HostActiveRunRecordV2,
        generation: u64,
    ) -> Result<(), HostV2StorageError> {
        let path = self.active_run_path(&expected.session_id, &expected.host_run_id)?;
        with_storage_path_lock(&path, || {
            let value = read_json(&path)?.ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_active_run_not_found",
                    "Host active-run record was not found before bridge spawn",
                )
            })?;
            let mut record = decode_active_run_record(value)?;
            require_run_identity(
                &record,
                &expected.session_id,
                &expected.host_run_id,
                &expected.run_id,
            )?;
            if record.lifecycle != HostRunLifecycleV2::Active
                || !matches!(
                    record.bridge_ownership,
                    HostBridgeOwnershipV2::NotStarted | HostBridgeOwnershipV2::Reaped
                )
            {
                return Err(HostV2StorageError::conflict(
                    "host_bridge_v2_owner_lost",
                    "Host Run bridge ownership is not available for a new child",
                ));
            }
            record.bridge_ownership = HostBridgeOwnershipV2::SpawnPrepared {
                owner_instance_id: self.owner_instance_id.as_ref().clone(),
                generation,
            };
            write_active_run_record(&path, &mut record)
        })
    }

    fn mark_bridge_owned_exact(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        generation: u64,
    ) -> Result<(), HostV2StorageError> {
        let path = self.active_run_path(session_id, host_run_id)?;
        with_storage_path_lock(&path, || {
            let value = read_json(&path)?.ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_active_run_not_found",
                    "Host active-run record was not found after bridge spawn",
                )
            })?;
            let mut record = decode_active_run_record(value)?;
            require_run_identity(&record, session_id, host_run_id, run_id)?;
            if record.lifecycle != HostRunLifecycleV2::Active
                || record.bridge_ownership
                    != (HostBridgeOwnershipV2::SpawnPrepared {
                        owner_instance_id: self.owner_instance_id.as_ref().clone(),
                        generation,
                    })
            {
                return Err(HostV2StorageError::conflict(
                    "host_bridge_v2_spawn_state_conflict",
                    "Host Run bridge spawn ownership changed before child installation",
                ));
            }
            record.bridge_ownership = HostBridgeOwnershipV2::Owned {
                owner_instance_id: self.owner_instance_id.as_ref().clone(),
                generation,
            };
            write_active_run_record(&path, &mut record)
        })
    }

    fn mark_bridge_reaped_exact(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        generation: u64,
    ) -> Result<(), HostV2StorageError> {
        let path = self.active_run_path(session_id, host_run_id)?;
        mark_bridge_reaped_on_disk(
            &path,
            session_id,
            host_run_id,
            run_id,
            self.owner_instance_id.as_ref(),
            generation,
        )
    }

    fn bridge_child_durably_reaped(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
    ) -> Result<bool, HostV2StorageError> {
        let path = self.active_run_path(session_id, host_run_id)?;
        with_storage_path_lock(&path, || {
            let value = read_json(&path)?.ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_active_run_not_found",
                    "Host active-run record was not found while reconciling child cleanup",
                )
            })?;
            let record = decode_active_run_record(value)?;
            require_run_identity(&record, session_id, host_run_id, run_id)?;
            Ok(matches!(
                record.bridge_ownership,
                HostBridgeOwnershipV2::NotStarted | HostBridgeOwnershipV2::Reaped
            ))
        })
    }

    pub(crate) fn register(
        &self,
        turn: &HostSessionTurnGuardV2,
        input: HostActiveRunRegistrationV2,
        workspace_canonical_root: Option<&Path>,
    ) -> Result<HostActiveRunRegistrationReceiptV2, HostV2StorageError> {
        validate_registration(&input)?;
        if turn.session_id != input.session_id {
            return Err(HostV2StorageError::conflict(
                "host_session_turn_identity_mismatch",
                "Host active-run registration does not match its Session lifecycle guard",
            ));
        }
        if let Some(existing) = self.resolve_session_active_run(&input.session_id)? {
            if existing.host_run_id != input.host_run_id {
                return Err(HostV2StorageError::conflict(
                    "host_session_multiple_active_runs",
                    "Session already has a different durable active Kernel Run",
                ));
            }
        }
        let record = active_run_record(input, workspace_canonical_root)?;
        let path = self.active_run_path(&record.session_id, &record.host_run_id)?;
        with_storage_path_lock(&path, || {
            let retired_path = self.retired_run_path(&record.session_id, &record.host_run_id)?;
            if read_json(&retired_path)?.is_some() {
                return Err(HostV2StorageError::conflict(
                    "host_active_run_already_retired",
                    "Host Run identity has already been retired and cannot be reused",
                ));
            }
            if let Some(existing) = read_json(&path)? {
                let existing = decode_active_run_record(existing)?;
                if existing.lifecycle == HostRunLifecycleV2::Active
                    && existing.registration_digest == record.registration_digest
                    && existing.workspace_canonical_root == record.workspace_canonical_root
                {
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
            if record.lifecycle != HostRunLifecycleV2::Active {
                return Err(HostV2StorageError::conflict(
                    "host_active_run_retiring",
                    "Host Run is retiring and cannot accept new Host operations",
                ));
            }
            Ok(record)
        })
    }

    pub(crate) fn resolve_session_active_run(
        &self,
        session_id: &str,
    ) -> Result<Option<HostActiveRunRecordV2>, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        let active_dir = self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join("active-runs");
        let entries = match fs::read_dir(active_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(HostV2StorageError::io(
                    "host_active_run_scan_failed",
                    format!("scan Session active-run directory: {error}"),
                ))
            }
        };
        let mut active = None;
        for entry in entries {
            let entry = entry.map_err(|error| {
                HostV2StorageError::io(
                    "host_active_run_scan_failed",
                    format!("scan Session active-run record: {error}"),
                )
            })?;
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let value = read_json(&entry.path())?.ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_active_run_record_missing",
                    "Host active-run record disappeared during Session resolution",
                )
            })?;
            let record = decode_active_run_record(value)?;
            if record.session_id != session_id || record.lifecycle != HostRunLifecycleV2::Active {
                return Err(HostV2StorageError::conflict(
                    "host_active_run_identity_conflict",
                    "Session active-run record does not match its durable location",
                ));
            }
            if active.replace(record).is_some() {
                return Err(HostV2StorageError::conflict(
                    "host_session_multiple_active_runs",
                    "Session has more than one durable active Kernel Run",
                ));
            }
        }
        Ok(active)
    }

    pub(crate) fn verify_session_has_no_run_residue(
        &self,
        session_id: &str,
    ) -> Result<(), HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        let active_dir = self
            .sessions_dir
            .join(session_id)
            .join("kernel-v2")
            .join("active-runs");
        let entries = match fs::read_dir(active_dir) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(HostV2StorageError::io(
                    "host_active_run_scan_failed",
                    format!("scan Session active-run directory before deletion: {error}"),
                ))
            }
        };
        if let Some(entries) = entries {
            let mut record_count = 0usize;
            for entry in entries {
                let entry = entry.map_err(|error| {
                    HostV2StorageError::io(
                        "host_active_run_scan_failed",
                        format!("scan Session active-run record before deletion: {error}"),
                    )
                })?;
                if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }
                record_count = record_count.saturating_add(1);
                if record_count > MAX_ACTIVE_RUN_RECORDS {
                    return Err(HostV2StorageError::conflict(
                        "host_active_run_scan_limit",
                        "Session active-run records exceed the bounded deletion scan limit",
                    ));
                }
                let value = read_json(&entry.path())?.ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_active_run_record_missing",
                        "Session active-run record disappeared during deletion verification",
                    )
                })?;
                let record = decode_active_run_record(value)?;
                if record.session_id != session_id {
                    return Err(HostV2StorageError::conflict(
                        "host_active_run_identity_conflict",
                        "Session active-run record does not match its deletion scope",
                    ));
                }
                return Err(HostV2StorageError::conflict(
                    "host_session_run_retirement_pending",
                    "Session still has an Active or Retiring Host Run",
                ));
            }
        }

        let bridge_slot = self
            .bridge_slots
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_bridge_v2_owner_unavailable",
                    "Host bridge child registry is unavailable during deletion verification",
                )
            })?
            .get(session_id)
            .cloned();
        if let Some(bridge_slot) = bridge_slot {
            if bridge_slot
                .lock()
                .map_err(|_| {
                    HostV2StorageError::io(
                        "host_bridge_v2_owner_unavailable",
                        "Host bridge child owner is unavailable during deletion verification",
                    )
                })?
                .is_some()
            {
                return Err(HostV2StorageError::conflict(
                    "host_session_bridge_child_retirement_pending",
                    "Session still owns a live bridge child",
                ));
            }
        }

        if self
            .run_transport_capabilities
            .lock()
            .map_err(|_| {
                HostV2StorageError::io(
                    "host_run_transport_capability_registry_unavailable",
                    "Host Run transport capability registry is unavailable during deletion verification",
                )
            })?
            .keys()
            .any(|binding| binding.session_id == session_id)
        {
            return Err(HostV2StorageError::conflict(
                "host_session_transport_capability_retirement_pending",
                "Session still owns a process-private Run transport capability",
            ));
        }
        Ok(())
    }

    pub(crate) fn active_run_records(
        &self,
    ) -> Result<Vec<HostActiveRunRecordV2>, HostV2StorageError> {
        self.scan_active_run_records().map(|records| {
            records
                .into_iter()
                .filter(|record| record.lifecycle == HostRunLifecycleV2::Active)
                .collect()
        })
    }

    pub(crate) fn retire_run(
        &self,
        turn: &HostSessionTurnGuardV2,
        host_run_id: &str,
        run_id: &str,
        requested_at: &str,
        reason_code: RunRetirementReasonCodeV2,
        reason: Option<&str>,
        mut retire_kernel_run: impl FnMut(
            &str,
            RunRetirementReasonCodeV2,
            Option<&str>,
        )
            -> Result<HostKernelRunRetirementProofV2, HostV2StorageError>,
        mut unregister_workspace_binding: impl FnMut(
            &WorkspaceBindingRefV2,
            &str,
        ) -> Result<(), HostV2StorageError>,
    ) -> Result<HostRunRetirementReceiptV2, HostV2StorageError> {
        validate_bounded_identity(requested_at, "retirementRequestedAt", 1024)?;
        if let Some(reason) = reason {
            validate_bounded_identity(reason, "retirementReason", 1024)?;
        }
        let started = self.begin_retirement(
            &turn.session_id,
            host_run_id,
            run_id,
            requested_at,
            reason_code,
            reason,
        )?;
        if started.lifecycle == HostRunLifecycleV2::Retired {
            return Ok(HostRunRetirementReceiptV2);
        }
        self.resume_retirement(
            Some(turn),
            started,
            &mut retire_kernel_run,
            &mut unregister_workspace_binding,
        )
    }

    /// Resumes durable retiring records during Host startup. Process-private
    /// capabilities are absent after restart. A child step that was not
    /// durably completed is never guessed complete because its exact handle
    /// cannot be reconstructed; that record remains retiring and degraded.
    /// Retiring workspaces are excluded from registry rehydration.
    pub(crate) fn recover_retiring_runs(
        &self,
        admitted_session_ids: &HashSet<String>,
        mut retire_kernel_run: impl FnMut(
            &str,
            RunRetirementReasonCodeV2,
            Option<&str>,
        )
            -> Result<HostKernelRunRetirementProofV2, HostV2StorageError>,
        mut unregister_workspace_binding: impl FnMut(
            &WorkspaceBindingRefV2,
            &str,
        ) -> Result<(), HostV2StorageError>,
    ) -> Result<usize, HostV2StorageError> {
        let records = self.scan_active_run_records()?;
        if records.iter().any(|record| {
            record.lifecycle == HostRunLifecycleV2::Retiring
                && !admitted_session_ids.contains(&record.session_id)
        }) {
            self.record_startup_error("host_session_recovery_not_admitted");
        }
        let retiring = records
            .into_iter()
            .filter(|record| record.lifecycle == HostRunLifecycleV2::Retiring)
            .filter(|record| admitted_session_ids.contains(&record.session_id))
            .collect::<Vec<_>>();
        let mut recovered = 0_usize;
        let mut first_error = None;
        for record in retiring {
            match self.resume_retirement(
                None,
                record,
                &mut retire_kernel_run,
                &mut unregister_workspace_binding,
            ) {
                Ok(_) => recovered += 1,
                Err(error) => {
                    self.record_startup_error(error.code);
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = first_error {
            Err(error)
        } else {
            Ok(recovered)
        }
    }

    fn begin_retirement(
        &self,
        session_id: &str,
        host_run_id: &str,
        run_id: &str,
        requested_at: &str,
        reason_code: RunRetirementReasonCodeV2,
        reason: Option<&str>,
    ) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        validate_bounded_identity(run_id, "runId", 512)?;
        let path = self.active_run_path(session_id, host_run_id)?;
        with_storage_path_lock(&path, || {
            if let Some(value) = read_json(&path)? {
                let mut record = decode_active_run_record(value)?;
                require_run_identity(&record, session_id, host_run_id, run_id)?;
                match record.lifecycle {
                    HostRunLifecycleV2::Active => {
                        record.lifecycle = HostRunLifecycleV2::Retiring;
                        record.retirement = Some(HostRunRetirementProgressV2 {
                            requested_at: requested_at.to_string(),
                            reason_code,
                            reason: reason.map(ToOwned::to_owned),
                            kernel_run_retired: false,
                            kernel_retirement_fact_id: None,
                            kernel_retirement_ledger_sequence: None,
                            transport_capability_unbound: false,
                            bridge_child_reaped: matches!(
                                record.bridge_ownership,
                                HostBridgeOwnershipV2::NotStarted | HostBridgeOwnershipV2::Reaped
                            ),
                            workspace_binding_unregistered: false,
                            empty_workspace_removed: record.workspace_kind
                                == HostRunWorkspaceKindV2::Bound,
                            completed_at: None,
                            last_error_code: None,
                        });
                        write_active_run_record(&path, &mut record)?;
                        Ok(record)
                    }
                    HostRunLifecycleV2::Retiring => {
                        require_retirement_reason(&record, reason_code, reason)?;
                        Ok(record)
                    }
                    HostRunLifecycleV2::Retired => Err(HostV2StorageError::conflict(
                        "host_run_retirement_state_invalid",
                        "Retired Host Run cannot remain in active-run storage",
                    )),
                }
            } else {
                let retired_path = self.retired_run_path(session_id, host_run_id)?;
                let value = read_json(&retired_path)?.ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_active_run_not_found",
                        "Host active-run record was not found",
                    )
                })?;
                let record = decode_active_run_record(value)?;
                require_run_identity(&record, session_id, host_run_id, run_id)?;
                if record.lifecycle != HostRunLifecycleV2::Retired {
                    return Err(HostV2StorageError::conflict(
                        "host_run_retirement_archive_invalid",
                        "Host retired-run archive does not contain a retired Run",
                    ));
                }
                require_retirement_reason(&record, reason_code, reason)?;
                Ok(record)
            }
        })
    }

    fn resume_retirement(
        &self,
        turn: Option<&HostSessionTurnGuardV2>,
        mut record: HostActiveRunRecordV2,
        retire_kernel_run: &mut impl FnMut(
            &str,
            RunRetirementReasonCodeV2,
            Option<&str>,
        )
            -> Result<HostKernelRunRetirementProofV2, HostV2StorageError>,
        unregister_workspace_binding: &mut impl FnMut(
            &WorkspaceBindingRefV2,
            &str,
        ) -> Result<(), HostV2StorageError>,
    ) -> Result<HostRunRetirementReceiptV2, HostV2StorageError> {
        if record.lifecycle == HostRunLifecycleV2::Retired {
            return Ok(HostRunRetirementReceiptV2);
        }
        require_retiring(&record)?;

        if !retirement_progress(&record)?.kernel_run_retired {
            let progress = retirement_progress(&record)?;
            let proof = match retire_kernel_run(
                &record.run_id,
                progress.reason_code,
                progress.reason.as_deref(),
            ) {
                Ok(proof) => proof,
                Err(error) => return Err(self.preserve_retirement_failure(&record, error)),
            };
            record = self.mark_kernel_retirement_step(&record, proof)?;
        }

        if !retirement_progress(&record)?.transport_capability_unbound {
            if let Err(error) = self.unbind_run_transport_capability(
                &record.session_id,
                &record.host_run_id,
                &record.run_id,
            ) {
                return Err(self.preserve_retirement_failure(&record, error));
            }
            record = self.mark_retirement_step(&record, HostRetirementStepV2::TransportUnbound)?;
        }

        if !retirement_progress(&record)?.bridge_child_reaped {
            let termination = match &record.bridge_ownership {
                HostBridgeOwnershipV2::NotStarted | HostBridgeOwnershipV2::Reaped => Ok(()),
                HostBridgeOwnershipV2::SpawnPrepared {
                    owner_instance_id,
                    generation,
                }
                | HostBridgeOwnershipV2::Owned {
                    owner_instance_id,
                    generation,
                } => {
                    if owner_instance_id != self.owner_instance_id.as_ref() {
                        Err(HostV2StorageError::conflict(
                            "host_run_retirement_child_ownership_lost",
                            "Host restart cannot prove cleanup of a bridge child owned by a previous process instance",
                        ))
                    } else {
                        match turn {
                            Some(turn) if turn.session_id == record.session_id => self
                                .terminate_bridge_child_for_run(
                                    turn,
                                    &record.host_run_id,
                                    &record.run_id,
                                    *generation,
                                ),
                            Some(_) => Err(HostV2StorageError::conflict(
                                "host_run_retirement_turn_mismatch",
                                "Host Run retirement guard belongs to another Session",
                            )),
                            None => Err(HostV2StorageError::conflict(
                                "host_run_retirement_child_ownership_lost",
                                "Host startup recovery cannot use an unguarded bridge child handle",
                            )),
                        }
                    }
                }
            };
            if let Err(error) = termination {
                return Err(self.preserve_retirement_failure(&record, error));
            }
            record = self.mark_retirement_step(&record, HostRetirementStepV2::BridgeChildReaped)?;
        }

        if !retirement_progress(&record)?.workspace_binding_unregistered {
            let workspace_binding_ref =
                WorkspaceBindingRefV2::new(record.workspace_binding_ref.clone()).map_err(|_| {
                    HostV2StorageError::conflict(
                        "host_run_workspace_binding_invalid",
                        "Durable Host Run workspace binding reference is invalid",
                    )
                });
            let workspace_binding_ref = match workspace_binding_ref {
                Ok(reference) => reference,
                Err(error) => return Err(self.preserve_retirement_failure(&record, error)),
            };
            if let Err(error) = unregister_workspace_binding(
                &workspace_binding_ref,
                &record.workspace_binding_identity,
            ) {
                return Err(self.preserve_retirement_failure(&record, error));
            }
            record =
                self.mark_retirement_step(&record, HostRetirementStepV2::WorkspaceUnregistered)?;
        }

        if !retirement_progress(&record)?.empty_workspace_removed {
            if let Err(error) = self.remove_exact_empty_workspace(&record) {
                return Err(self.preserve_retirement_failure(&record, error));
            }
            record =
                self.mark_retirement_step(&record, HostRetirementStepV2::EmptyWorkspaceRemoved)?;
        }

        record = self.mark_retirement_completed_at(&record, &crate::now_text())?;
        match self.finish_retirement(&record) {
            Ok(receipt) => Ok(receipt),
            Err(error) => Err(self.preserve_retirement_failure(&record, error)),
        }
    }

    fn mark_kernel_retirement_step(
        &self,
        expected: &HostActiveRunRecordV2,
        proof: HostKernelRunRetirementProofV2,
    ) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
        validate_bounded_identity(&proof.fact_id, "kernelRetirementFactId", 512)?;
        if proof.ledger_sequence == 0 {
            return Err(HostV2StorageError::invalid(
                "host_kernel_run_retirement_proof_invalid",
                "Kernel Run retirement proof must contain a positive ledger sequence",
            ));
        }
        let path = self.active_run_path(&expected.session_id, &expected.host_run_id)?;
        with_storage_path_lock(&path, || {
            let value = read_json(&path)?.ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_active_run_not_found",
                    "Host retiring-run record was not found",
                )
            })?;
            let mut record = decode_active_run_record(value)?;
            require_same_retiring_run(&record, expected)?;
            let progress = record.retirement.as_mut().ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_run_retirement_state_invalid",
                    "Host retiring Run is missing retirement progress",
                )
            })?;
            if progress.kernel_run_retired {
                if progress.kernel_retirement_fact_id.as_deref() == Some(proof.fact_id.as_str())
                    && progress.kernel_retirement_ledger_sequence == Some(proof.ledger_sequence)
                {
                    return Ok(record);
                }
                return Err(HostV2StorageError::conflict(
                    "host_kernel_run_retirement_proof_conflict",
                    "Host Run already records a different Kernel retirement proof",
                ));
            }
            progress.kernel_run_retired = true;
            progress.kernel_retirement_fact_id = Some(proof.fact_id);
            progress.kernel_retirement_ledger_sequence = Some(proof.ledger_sequence);
            progress.last_error_code = None;
            write_active_run_record(&path, &mut record)?;
            Ok(record)
        })
    }

    fn mark_retirement_step(
        &self,
        expected: &HostActiveRunRecordV2,
        step: HostRetirementStepV2,
    ) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
        let path = self.active_run_path(&expected.session_id, &expected.host_run_id)?;
        with_storage_path_lock(&path, || {
            let value = read_json(&path)?.ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_active_run_not_found",
                    "Host retiring-run record was not found",
                )
            })?;
            let mut record = decode_active_run_record(value)?;
            require_same_retiring_run(&record, expected)?;
            let progress = record.retirement.as_mut().ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_run_retirement_state_invalid",
                    "Host retiring Run is missing retirement progress",
                )
            })?;
            let clear_workspace_root = matches!(&step, HostRetirementStepV2::WorkspaceUnregistered);
            match step {
                HostRetirementStepV2::TransportUnbound => {
                    progress.transport_capability_unbound = true
                }
                HostRetirementStepV2::BridgeChildReaped => progress.bridge_child_reaped = true,
                HostRetirementStepV2::WorkspaceUnregistered => {
                    progress.workspace_binding_unregistered = true;
                }
                HostRetirementStepV2::EmptyWorkspaceRemoved => {
                    progress.empty_workspace_removed = true
                }
            }
            progress.last_error_code = None;
            if clear_workspace_root {
                record.workspace_canonical_root = None;
            }
            write_active_run_record(&path, &mut record)?;
            Ok(record)
        })
    }

    fn mark_retirement_completed_at(
        &self,
        expected: &HostActiveRunRecordV2,
        completed_at: &str,
    ) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
        validate_bounded_identity(completed_at, "retirementCompletedAt", 1024)?;
        let path = self.active_run_path(&expected.session_id, &expected.host_run_id)?;
        with_storage_path_lock(&path, || {
            let value = read_json(&path)?.ok_or_else(|| {
                HostV2StorageError::not_found(
                    "host_active_run_not_found",
                    "Host retiring-run record was not found",
                )
            })?;
            let mut record = decode_active_run_record(value)?;
            require_same_retiring_run(&record, expected)?;
            let progress = record.retirement.as_mut().ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_run_retirement_state_invalid",
                    "Host retiring Run is missing retirement progress",
                )
            })?;
            if !retirement_resources_released(progress) {
                return Err(HostV2StorageError::conflict(
                    "host_run_retirement_incomplete",
                    "Host Run resources are not fully released",
                ));
            }
            if progress.completed_at.is_none() {
                progress.completed_at = Some(completed_at.to_string());
                progress.last_error_code = None;
                write_active_run_record(&path, &mut record)?;
            }
            Ok(record)
        })
    }

    fn preserve_retirement_failure(
        &self,
        expected: &HostActiveRunRecordV2,
        failure: HostV2StorageError,
    ) -> HostV2StorageError {
        if let Err(persist_error) = self.record_retirement_error(expected, failure.code) {
            return HostV2StorageError::io(
                "host_run_retirement_error_persist_failed",
                format!(
                    "Host Run remains retiring after {} but its error marker could not be updated: {}",
                    failure.code, persist_error.code
                ),
            );
        }
        failure
    }

    fn record_retirement_error(
        &self,
        expected: &HostActiveRunRecordV2,
        error_code: &str,
    ) -> Result<(), HostV2StorageError> {
        validate_bounded_identity(error_code, "retirementErrorCode", 512)?;
        let path = self.active_run_path(&expected.session_id, &expected.host_run_id)?;
        with_storage_path_lock(&path, || {
            let Some(value) = read_json(&path)? else {
                return Ok(());
            };
            let mut record = decode_active_run_record(value)?;
            require_same_retiring_run(&record, expected)?;
            let progress = record.retirement.as_mut().ok_or_else(|| {
                HostV2StorageError::conflict(
                    "host_run_retirement_state_invalid",
                    "Host retiring Run is missing retirement progress",
                )
            })?;
            progress.last_error_code = Some(error_code.to_string());
            write_active_run_record(&path, &mut record)
        })
    }

    fn finish_retirement(
        &self,
        expected: &HostActiveRunRecordV2,
    ) -> Result<HostRunRetirementReceiptV2, HostV2StorageError> {
        let path = self.active_run_path(&expected.session_id, &expected.host_run_id)?;
        with_storage_path_lock(&path, || {
            let retired_path =
                self.retired_run_path(&expected.session_id, &expected.host_run_id)?;
            let Some(value) = read_json(&path)? else {
                let value = read_json(&retired_path)?.ok_or_else(|| {
                    HostV2StorageError::not_found(
                        "host_run_retirement_missing",
                        "Host Run has neither an active record nor a retired archive",
                    )
                })?;
                let record = decode_active_run_record(value)?;
                require_run_identity(
                    &record,
                    &expected.session_id,
                    &expected.host_run_id,
                    &expected.run_id,
                )?;
                if record.lifecycle != HostRunLifecycleV2::Retired {
                    return Err(HostV2StorageError::conflict(
                        "host_run_retirement_archive_invalid",
                        "Host retired-run archive does not contain a retired Run",
                    ));
                }
                return Ok(HostRunRetirementReceiptV2);
            };
            let mut record = decode_active_run_record(value)?;
            require_same_retiring_run(&record, expected)?;
            let progress = retirement_progress(&record)?;
            if !retirement_resources_released(progress) || progress.completed_at.is_none() {
                return Err(HostV2StorageError::conflict(
                    "host_run_retirement_incomplete",
                    "Host Run cannot be archived before all owned resources are released",
                ));
            }
            record
                .retirement
                .as_mut()
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_run_retirement_state_invalid",
                        "Host retiring Run is missing retirement progress",
                    )
                })?
                .last_error_code = None;
            record.lifecycle = HostRunLifecycleV2::Retired;
            refresh_record_digest(&mut record)?;
            if let Some(value) = read_json(&retired_path)? {
                let archived = decode_active_run_record(value)?;
                if archived.record_digest != record.record_digest {
                    return Err(HostV2StorageError::conflict(
                        "host_run_retirement_archive_conflict",
                        "Host retired-run archive has different durable content",
                    ));
                }
            } else {
                atomic_write_private_json(
                    &retired_path,
                    &serde_json::to_value(&record).map_err(|error| {
                        HostV2StorageError::invalid(
                            "host_run_retirement_encode_failed",
                            format!("encode Host retired-run record: {error}"),
                        )
                    })?,
                )?;
            }
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(HostV2StorageError::io(
                        "host_run_retirement_active_remove_failed",
                        format!("remove Host active-run record after archival: {error}"),
                    ))
                }
            }
            if let Some(parent) = path.parent() {
                sync_directory(parent)?;
            }
            Ok(HostRunRetirementReceiptV2)
        })
    }

    fn remove_exact_empty_workspace(
        &self,
        record: &HostActiveRunRecordV2,
    ) -> Result<(), HostV2StorageError> {
        if record.workspace_kind != HostRunWorkspaceKindV2::Empty {
            return Err(HostV2StorageError::conflict(
                "host_run_empty_workspace_ownership_invalid",
                "Only a Host-owned empty Run workspace can be removed",
            ));
        }
        let key = record.empty_workspace_key.as_deref().ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_run_empty_workspace_ownership_invalid",
                "Host-owned empty Run workspace is missing its ownership key",
            )
        })?;
        let expected_key = empty_workspace_key(&record.session_id, &record.host_run_id);
        if key != expected_key {
            return Err(HostV2StorageError::conflict(
                "host_run_empty_workspace_ownership_invalid",
                "Host-owned empty Run workspace key does not match its exact Run identity",
            ));
        }
        let root = self.empty_workspace_root(key)?;
        with_storage_path_lock(&root, || {
            let metadata = match fs::symlink_metadata(&root) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => {
                    return Err(HostV2StorageError::io(
                        "host_empty_workspace_unavailable",
                        format!("inspect exact Host-owned empty workspace: {error}"),
                    ))
                }
            };
            if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                return Err(HostV2StorageError::conflict(
                    "host_run_empty_workspace_ownership_invalid",
                    "Exact Host-owned empty workspace is not a plain directory",
                ));
            }
            let mut entries = fs::read_dir(&root).map_err(|error| {
                HostV2StorageError::io(
                    "host_empty_workspace_unavailable",
                    format!("inspect exact Host-owned empty workspace contents: {error}"),
                )
            })?;
            if entries.next().is_some() {
                return Err(HostV2StorageError::conflict(
                    "host_empty_workspace_not_empty",
                    "Host-owned empty workspace contains content and was not removed",
                ));
            }
            fs::remove_dir(&root).map_err(|error| {
                HostV2StorageError::io(
                    "host_empty_workspace_remove_failed",
                    format!("remove exact Host-owned empty workspace: {error}"),
                )
            })?;
            if let Some(parent) = root.parent() {
                sync_directory(parent)?;
            }
            Ok(())
        })
    }

    pub(crate) fn prepare_empty_workspace_root(
        &self,
        session_id: &str,
        host_run_id: &str,
    ) -> Result<HostEmptyWorkspaceRootV2, HostV2StorageError> {
        validate_safe_session_identity(session_id)?;
        validate_bounded_identity(host_run_id, "hostRunId", 512)?;
        let key = empty_workspace_key(session_id, host_run_id);
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

    pub(crate) fn discard_prepared_empty_workspace_root(
        &self,
        key: &str,
    ) -> Result<(), HostV2StorageError> {
        validate_empty_workspace_key(key)?;
        let root = self.empty_workspace_root(key)?;
        with_storage_path_lock(&root, || {
            let metadata = match fs::symlink_metadata(&root) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => {
                    return Err(HostV2StorageError::io(
                        "host_empty_workspace_unavailable",
                        format!("inspect prepared Host empty workspace: {error}"),
                    ))
                }
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(HostV2StorageError::conflict(
                    "host_empty_workspace_ownership_invalid",
                    "Prepared Host empty workspace is not an owned real directory",
                ));
            }
            if fs::read_dir(&root)
                .map_err(|error| {
                    HostV2StorageError::io(
                        "host_empty_workspace_unavailable",
                        format!("inspect prepared Host empty workspace contents: {error}"),
                    )
                })?
                .next()
                .is_some()
            {
                return Err(HostV2StorageError::conflict(
                    "host_empty_workspace_not_empty",
                    "Prepared Host empty workspace contains unexpected content",
                ));
            }
            fs::remove_dir(&root).map_err(|error| {
                HostV2StorageError::io(
                    "host_empty_workspace_remove_failed",
                    format!("remove prepared Host empty workspace: {error}"),
                )
            })?;
            if let Some(parent) = root.parent() {
                sync_directory(parent)?;
            }
            Ok(())
        })
    }

    pub(crate) fn workspace_rehydrate_records(
        &self,
        recoverable_session_ids: &HashSet<String>,
    ) -> Vec<HostWorkspaceRehydrateRecordV2> {
        match self.scan_active_run_records() {
            Ok(records) => {
                let unadmitted = records.iter().any(|record| {
                    record.lifecycle == HostRunLifecycleV2::Active
                        && !recoverable_session_ids.contains(&record.session_id)
                });
                let owner_lost = records.iter().any(|record| {
                    recoverable_session_ids.contains(&record.session_id)
                        && matches!(
                            &record.bridge_ownership,
                            HostBridgeOwnershipV2::SpawnPrepared {
                                owner_instance_id,
                                ..
                            } | HostBridgeOwnershipV2::Owned {
                                owner_instance_id,
                                ..
                            } if owner_instance_id != self.owner_instance_id.as_ref()
                        )
                });
                let mut errors = Vec::new();
                if owner_lost {
                    errors.push("host_bridge_v2_owner_lost".to_string());
                }
                if unadmitted {
                    errors.push("host_session_recovery_not_admitted".to_string());
                }
                let rehydrate = records
                    .into_iter()
                    .filter(|record| recoverable_session_ids.contains(&record.session_id))
                    .filter(|record| record.lifecycle == HostRunLifecycleV2::Active)
                    .map(|record| {
                        let root = match record.workspace_kind {
                            HostRunWorkspaceKindV2::Bound => record
                                .workspace_canonical_root
                                .clone()
                                .ok_or_else(|| {
                                    HostV2StorageError::conflict(
                                        "host_active_run_workspace_recovery_material_missing",
                                        "UnsupportedHistorySchema: bound active Host Run has no Host-only workspace recovery root",
                                    )
                                })?,
                            HostRunWorkspaceKindV2::Empty => {
                                let key = record.empty_workspace_key.as_deref().ok_or_else(|| {
                                    HostV2StorageError::conflict(
                                        "host_active_run_workspace_invalid",
                                        "Managed empty Host Run has no exact workspace key",
                                    )
                                })?;
                                self.empty_workspace_root(key)?
                            }
                        };
                        let reference = WorkspaceBindingRefV2::new(record.workspace_binding_ref)
                            .map_err(|_| {
                                HostV2StorageError::conflict(
                                    "host_active_run_workspace_binding_invalid",
                                    "Durable Host Run contains an invalid workspace binding reference",
                                )
                            })?;
                        Ok(HostWorkspaceRehydrateRecordV2::new(
                            reference,
                            root,
                            Some(record.workspace_binding_identity),
                        ))
                    })
                    .collect::<Result<Vec<_>, HostV2StorageError>>();
                match rehydrate {
                    Ok(records) => {
                        self.replace_startup_errors(errors);
                        records
                    }
                    Err(error) => {
                        errors.push(error.code.to_string());
                        self.replace_startup_errors(errors);
                        Vec::new()
                    }
                }
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

    fn retired_run_path(
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
            .join("retired-runs")
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

    pub(crate) fn record_startup_error(&self, code: &str) {
        if let Ok(mut current) = self.startup_errors.lock() {
            if !current.iter().any(|existing| existing == code) {
                current.push(code.to_string());
            }
        }
    }
}

fn active_run_path_for_reaper(
    sessions_dir: &std::path::Path,
    session_id: &str,
    host_run_id: &str,
) -> PathBuf {
    sessions_dir
        .join(session_id)
        .join("kernel-v2")
        .join("active-runs")
        .join(format!("{}.json", sha256_path_component(host_run_id)))
}

fn retired_run_path_for_reaper(
    sessions_dir: &std::path::Path,
    session_id: &str,
    host_run_id: &str,
) -> PathBuf {
    sessions_dir
        .join(session_id)
        .join("kernel-v2")
        .join("retired-runs")
        .join(format!("{}.json", sha256_path_component(host_run_id)))
}

struct HostBridgeFinalizerV2 {
    sessions_dir: Arc<PathBuf>,
    owner_instance_id: Arc<String>,
    bridge_slots: Arc<Mutex<HashMap<String, Arc<Mutex<Option<OwnedHostBridgeChildV2>>>>>>,
}

impl Drop for HostBridgeFinalizerV2 {
    fn drop(&mut self) {
        let slots = match self.bridge_slots.lock() {
            Ok(mut slots) => slots.drain().collect::<Vec<_>>(),
            Err(poisoned) => poisoned.into_inner().drain().collect::<Vec<_>>(),
        };
        let mut pending = VecDeque::new();
        for (session_id, slot) in slots {
            let owned = match slot.lock() {
                Ok(mut child) => child.take(),
                Err(poisoned) => poisoned.into_inner().take(),
            };
            let Some(mut owned) = owned else {
                continue;
            };
            let terminated = terminate_owned_bridge_child_ref(&mut owned.child).is_ok();
            let durably_reaped = terminated
                && mark_bridge_reaped_on_disk(
                    &active_run_path_for_reaper(
                        self.sessions_dir.as_ref(),
                        &session_id,
                        &owned.host_run_id,
                    ),
                    &session_id,
                    &owned.host_run_id,
                    &owned.run_id,
                    self.owner_instance_id.as_ref(),
                    owned.generation,
                )
                .is_ok();
            if durably_reaped {
                continue;
            }
            let task = HostBridgeReaperTaskV2 {
                active_run_path: active_run_path_for_reaper(
                    self.sessions_dir.as_ref(),
                    &session_id,
                    &owned.host_run_id,
                ),
                retired_run_path: retired_run_path_for_reaper(
                    self.sessions_dir.as_ref(),
                    &session_id,
                    &owned.host_run_id,
                ),
                session_id,
                host_run_id: owned.host_run_id,
                run_id: owned.run_id,
                owner_instance_id: self.owner_instance_id.as_str().to_string(),
                generation: owned.generation,
                child: owned.child,
            };
            pending.push_back(task);
        }
        while !pending.is_empty() {
            let current_len = pending.len();
            for _ in 0..current_len {
                let mut task = pending
                    .pop_front()
                    .expect("Host bridge finalizer queue length is stable");
                if !try_reap_host_bridge_task(&mut task) {
                    pending.push_back(task);
                }
            }
            if !pending.is_empty() {
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

pub(crate) struct HostSessionTurnGuardV2 {
    session_id: String,
    _turn_guard: OwnedMutexGuard<()>,
}

struct OwnedHostBridgeChildV2 {
    host_run_id: String,
    run_id: String,
    generation: u64,
    child: Child,
}

struct HostBridgeReaperTaskV2 {
    active_run_path: PathBuf,
    retired_run_path: PathBuf,
    session_id: String,
    host_run_id: String,
    run_id: String,
    owner_instance_id: String,
    generation: u64,
    child: Child,
}

fn try_reap_host_bridge_task(task: &mut HostBridgeReaperTaskV2) -> bool {
    if terminate_owned_bridge_child_ref(&mut task.child).is_err() {
        return false;
    }
    match mark_bridge_reaped_on_disk(
        &task.active_run_path,
        &task.session_id,
        &task.host_run_id,
        &task.run_id,
        &task.owner_instance_id,
        task.generation,
    ) {
        Ok(()) => true,
        Err(error) if error.code == "host_active_run_not_found" => {
            retired_bridge_is_durably_reaped(task).unwrap_or(false)
        }
        Err(_) => false,
    }
}

fn retired_bridge_is_durably_reaped(
    task: &HostBridgeReaperTaskV2,
) -> Result<bool, HostV2StorageError> {
    let Some(value) = read_json(&task.retired_run_path)? else {
        return Ok(false);
    };
    let record = decode_active_run_record(value)?;
    require_run_identity(&record, &task.session_id, &task.host_run_id, &task.run_id)?;
    Ok(record.lifecycle == HostRunLifecycleV2::Retired
        && matches!(record.bridge_ownership, HostBridgeOwnershipV2::Reaped))
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct HostRunTransportBindingV2 {
    session_id: String,
    host_run_id: String,
    run_id: String,
}

struct HostRunTransportCapabilityV2 {
    capability: RunCapabilityV2,
    digest: [u8; 32],
}

pub(crate) struct HostBridgeChildLeaseV2 {
    broker: HostActiveRunBrokerV2,
    session_id: String,
    host_run_id: String,
    run_id: String,
    generation: u64,
    slot: Arc<Mutex<Option<OwnedHostBridgeChildV2>>>,
}

impl HostBridgeChildLeaseV2 {
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
        self.terminate_owned_child().map(|_| ())
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
        if child.host_run_id != self.host_run_id
            || child.run_id != self.run_id
            || child.generation != self.generation
        {
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

    fn terminate_owned_child(&self) -> Result<bool, HostV2StorageError> {
        let mut slot = self.slot.lock().map_err(|_| {
            HostV2StorageError::io(
                "host_bridge_v2_owner_unavailable",
                "Host bridge child owner is unavailable",
            )
        })?;
        if !slot.as_ref().is_some_and(|child| {
            child.host_run_id == self.host_run_id
                && child.run_id == self.run_id
                && child.generation == self.generation
        }) {
            return Ok(false);
        }
        let child = slot.as_mut().ok_or_else(|| {
            HostV2StorageError::conflict(
                "host_bridge_v2_superseded",
                "Host bridge child was superseded or already reaped",
            )
        })?;
        terminate_owned_bridge_child_ref(&mut child.child)?;
        self.broker.mark_bridge_reaped_exact(
            &self.session_id,
            &self.host_run_id,
            &self.run_id,
            self.generation,
        )?;
        slot.take();
        Ok(true)
    }
}

impl Drop for HostBridgeChildLeaseV2 {
    fn drop(&mut self) {
        let _ = self.terminate_owned_child();
    }
}

fn terminate_owned_bridge_child_ref(child: &mut Child) -> Result<(), HostV2StorageError> {
    match child.try_wait() {
        Ok(Some(_)) => return Ok(()),
        Ok(None) => {}
        Err(error) => {
            return Err(HostV2StorageError::io(
                "host_bridge_v2_wait_failed",
                format!("inspect Host-owned Session bridge: {error}"),
            ))
        }
    }
    match child.kill() {
        Ok(()) => child
            .wait()
            .map(|_| ())
            .map_err(|error| {
                HostV2StorageError::io(
                    "host_bridge_v2_wait_failed",
                    format!("reap Host-owned Session bridge after termination: {error}"),
                )
            }),
        Err(kill_error) => match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err(HostV2StorageError::io(
                "host_bridge_v2_terminate_failed",
                format!(
                    "terminate Host-owned Session bridge: {kill_error}; child is still running and remains owned for retry"
                ),
            )),
            Err(wait_error) => Err(HostV2StorageError::io(
                "host_bridge_v2_terminate_and_wait_failed",
                format!(
                    "terminate Host-owned Session bridge: {kill_error}; inspect it for reaping: {wait_error}"
                ),
            )),
        },
    }
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
        ("bootstrapDigest", input.bootstrap_digest.as_str()),
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
    crate::host_v2_storage::validate_sha256_digest(&input.bootstrap_digest, "bootstrapDigest")?;
    if let Some(folder_id) = input.active_folder_id.as_deref() {
        validate_bounded_identity(folder_id, "activeFolderId", 512)?;
    }
    match input.workspace_kind {
        HostRunWorkspaceKindV2::Bound if input.empty_workspace_key.is_some() => {
            return Err(HostV2StorageError::invalid(
                "host_active_run_workspace_invalid",
                "Bound Host run cannot carry an empty workspace key",
            ))
        }
        HostRunWorkspaceKindV2::Empty => {
            if input.active_folder_id.is_some() {
                return Err(HostV2StorageError::invalid(
                    "host_active_run_workspace_invalid",
                    "Empty Host run cannot carry an active folder identity",
                ));
            }
            let key = input.empty_workspace_key.as_deref().ok_or_else(|| {
                HostV2StorageError::invalid(
                    "host_active_run_workspace_invalid",
                    "Empty Host run requires its managed workspace key",
                )
            })?;
            validate_empty_workspace_key(key)?;
            if key != empty_workspace_key(&input.session_id, &input.host_run_id) {
                return Err(HostV2StorageError::invalid(
                    "host_active_run_workspace_invalid",
                    "Empty Host run workspace key does not match its exact Run identity",
                ));
            }
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

fn validate_workspace_recovery_root(
    workspace_kind: HostRunWorkspaceKindV2,
    root: Option<&Path>,
) -> Result<Option<String>, HostV2StorageError> {
    match workspace_kind {
        HostRunWorkspaceKindV2::Empty if root.is_some() => {
            return Err(HostV2StorageError::invalid(
                "host_active_run_workspace_root_invalid",
                "Managed empty Host Runs cannot persist a bound-workspace recovery root",
            ))
        }
        HostRunWorkspaceKindV2::Empty => return Ok(None),
        HostRunWorkspaceKindV2::Bound => {}
    }
    let root = root.ok_or_else(|| {
        HostV2StorageError::conflict(
            "host_active_run_workspace_recovery_material_missing",
            "UnsupportedHistorySchema: bound active Host Run has no Host-only workspace recovery root",
        )
    })?;
    if !root.is_absolute() {
        return Err(HostV2StorageError::invalid(
            "host_active_run_workspace_root_invalid",
            "Bound active Host Run recovery root must be absolute",
        ));
    }
    let canonical = fs::canonicalize(root).map_err(|error| {
        HostV2StorageError::io(
            "host_active_run_workspace_root_unavailable",
            format!("validate bound active Host Run recovery root: {error}"),
        )
    })?;
    if canonical != root || !canonical.is_dir() {
        return Err(HostV2StorageError::conflict(
            "host_active_run_workspace_root_stale",
            "Bound active Host Run recovery root is no longer the exact canonical directory",
        ));
    }
    fs::read_dir(&canonical).map_err(|error| {
        HostV2StorageError::io(
            "host_active_run_workspace_root_unavailable",
            format!("read bound active Host Run recovery root: {error}"),
        )
    })?;
    let text = canonical.to_str().ok_or_else(|| {
        HostV2StorageError::invalid(
            "host_active_run_workspace_root_encoding_unsupported",
            "Bound active Host Run recovery root must be valid UTF-8",
        )
    })?;
    if text.is_empty() || text.len() > 64 * 1024 {
        return Err(HostV2StorageError::invalid(
            "host_active_run_workspace_root_invalid",
            "Bound active Host Run recovery root exceeds its bounded storage shape",
        ));
    }
    Ok(Some(text.to_string()))
}

fn active_run_record(
    input: HostActiveRunRegistrationV2,
    workspace_canonical_root: Option<&Path>,
) -> Result<HostActiveRunRecordV2, HostV2StorageError> {
    let workspace_canonical_root =
        validate_workspace_recovery_root(input.workspace_kind, workspace_canonical_root)?;
    let registration_digest = active_run_registration_digest(&input)?;
    let mut value = json!({
        "schemaVersion": ACTIVE_RUN_SCHEMA_V2,
        "lifecycle": HostRunLifecycleV2::Active,
        "sessionId": input.session_id,
        "hostRunId": input.host_run_id,
        "runId": input.run_id,
        "bootstrapDigest": input.bootstrap_digest,
        "workspaceBindingRef": input.workspace_binding_ref,
        "workspaceBindingDigest": input.workspace_binding_digest,
        "workspaceBindingIdentity": input.workspace_binding_identity,
        "workspaceKind": input.workspace_kind,
        "initialInputId": input.initial_input_id,
        "initialOpaqueInputRef": input.initial_opaque_input_ref,
        "runSettings": input.run_settings,
        "recordedAt": input.recorded_at,
        "registrationDigest": registration_digest,
        "bridgeOwnership": HostBridgeOwnershipV2::NotStarted
    });
    if let Some(key) = input.empty_workspace_key {
        value["emptyWorkspaceKey"] = Value::String(key);
    }
    if let Some(folder_id) = input.active_folder_id {
        value["activeFolderId"] = Value::String(folder_id);
    }
    if let Some(root) = workspace_canonical_root {
        value["workspaceCanonicalRoot"] = Value::String(root);
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
    if value.get("schemaVersion").and_then(Value::as_str) != Some(ACTIVE_RUN_SCHEMA_V2) {
        return Err(HostV2StorageError::conflict(
            "host_active_run_schema_unsupported",
            "Host active-run record has an unsupported schema",
        ));
    }
    let record: HostActiveRunRecordV2 = serde_json::from_value(value.clone()).map_err(|error| {
        HostV2StorageError::conflict(
            "host_active_run_record_corrupt",
            format!("decode Host active-run record: {error}"),
        )
    })?;
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
        bootstrap_digest: record.bootstrap_digest.clone(),
        workspace_binding_ref: record.workspace_binding_ref.clone(),
        workspace_binding_digest: record.workspace_binding_digest.clone(),
        workspace_binding_identity: record.workspace_binding_identity.clone(),
        workspace_kind: record.workspace_kind,
        active_folder_id: record.active_folder_id.clone(),
        empty_workspace_key: record.empty_workspace_key.clone(),
        initial_input_id: record.initial_input_id.clone(),
        initial_opaque_input_ref: record.initial_opaque_input_ref.clone(),
        run_settings: record.run_settings.clone(),
        recorded_at: record.recorded_at.clone(),
    })?;
    if active_run_registration_digest(&HostActiveRunRegistrationV2 {
        session_id: record.session_id.clone(),
        host_run_id: record.host_run_id.clone(),
        run_id: record.run_id.clone(),
        bootstrap_digest: record.bootstrap_digest.clone(),
        workspace_binding_ref: record.workspace_binding_ref.clone(),
        workspace_binding_digest: record.workspace_binding_digest.clone(),
        workspace_binding_identity: record.workspace_binding_identity.clone(),
        workspace_kind: record.workspace_kind,
        active_folder_id: record.active_folder_id.clone(),
        empty_workspace_key: record.empty_workspace_key.clone(),
        initial_input_id: record.initial_input_id.clone(),
        initial_opaque_input_ref: record.initial_opaque_input_ref.clone(),
        run_settings: record.run_settings.clone(),
        recorded_at: record.recorded_at.clone(),
    })? != record.registration_digest
    {
        return Err(HostV2StorageError::conflict(
            "host_active_run_registration_digest_mismatch",
            "Host active-run immutable registration failed digest verification",
        ));
    }
    validate_run_lifecycle(&record)?;
    Ok(record)
}

fn active_run_registration_digest(
    input: &HostActiveRunRegistrationV2,
) -> Result<String, HostV2StorageError> {
    let mut value = json!({
        "sessionId": input.session_id,
        "hostRunId": input.host_run_id,
        "runId": input.run_id,
        "bootstrapDigest": input.bootstrap_digest,
        "workspaceBindingRef": input.workspace_binding_ref,
        "workspaceBindingDigest": input.workspace_binding_digest,
        "workspaceBindingIdentity": input.workspace_binding_identity,
        "workspaceKind": input.workspace_kind,
        "emptyWorkspaceKey": input.empty_workspace_key,
        "initialInputId": input.initial_input_id,
        "initialOpaqueInputRef": input.initial_opaque_input_ref,
        "runSettings": input.run_settings,
        "recordedAt": input.recorded_at,
    });
    if let Some(folder_id) = input.active_folder_id.as_deref() {
        value["activeFolderId"] = Value::String(folder_id.to_string());
    }
    reject_transport_capabilities(&value)?;
    canonical_sha256(&value)
}

fn mark_bridge_reaped_on_disk(
    path: &std::path::Path,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
    expected_owner: &str,
    generation: u64,
) -> Result<(), HostV2StorageError> {
    with_storage_path_lock(path, || {
        let value = read_json(path)?.ok_or_else(|| {
            HostV2StorageError::not_found(
                "host_active_run_not_found",
                "Host active-run record was not found while reaping its bridge child",
            )
        })?;
        let mut record = decode_active_run_record(value)?;
        require_run_identity(&record, session_id, host_run_id, run_id)?;
        match &record.bridge_ownership {
            HostBridgeOwnershipV2::SpawnPrepared {
                owner_instance_id,
                generation: owned_generation,
            }
            | HostBridgeOwnershipV2::Owned {
                owner_instance_id,
                generation: owned_generation,
            } if owner_instance_id == expected_owner && *owned_generation == generation => {}
            HostBridgeOwnershipV2::Reaped => return Ok(()),
            HostBridgeOwnershipV2::SpawnPrepared { .. } | HostBridgeOwnershipV2::Owned { .. } => {
                return Err(HostV2StorageError::conflict(
                    "host_bridge_v2_owner_lost",
                    "Host Run bridge child belongs to another process owner or generation",
                ))
            }
            HostBridgeOwnershipV2::NotStarted => {
                return Err(HostV2StorageError::conflict(
                    "host_bridge_v2_spawn_state_conflict",
                    "Host Run records no bridge child to reap",
                ))
            }
        }
        record.bridge_ownership = HostBridgeOwnershipV2::Reaped;
        if record.lifecycle == HostRunLifecycleV2::Retiring {
            record
                .retirement
                .as_mut()
                .ok_or_else(|| {
                    HostV2StorageError::conflict(
                        "host_run_retirement_state_invalid",
                        "Host retiring Run is missing retirement progress",
                    )
                })?
                .bridge_child_reaped = true;
        }
        write_active_run_record(path, &mut record)
    })
}

#[derive(Debug, Clone, Copy)]
enum HostRetirementStepV2 {
    TransportUnbound,
    BridgeChildReaped,
    WorkspaceUnregistered,
    EmptyWorkspaceRemoved,
}

fn next_bridge_generation() -> Result<u64, HostV2StorageError> {
    HOST_BRIDGE_GENERATION_V2
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .map_err(|_| {
            HostV2StorageError::conflict(
                "host_bridge_v2_generation_exhausted",
                "Host bridge child generation is exhausted",
            )
        })
}

fn boot_owner_instance_id() -> Result<String, HostV2StorageError> {
    let mut entropy = [0_u8; 32];
    getrandom::fill(&mut entropy).map_err(|_| {
        HostV2StorageError::io(
            "host_bridge_owner_entropy_unavailable",
            "Operating-system CSPRNG could not create the Host bridge owner identity",
        )
    })?;
    let mut encoded = String::with_capacity(entropy.len() * 2);
    for byte in entropy {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    Ok(format!("host-bridge-owner-v2-{encoded}"))
}

fn empty_workspace_key(session_id: &str, host_run_id: &str) -> String {
    sha256_path_component(&format!(
        "deepcode.host.empty-workspace.v2\0{session_id}\0{host_run_id}"
    ))
}

fn retirement_progress(
    record: &HostActiveRunRecordV2,
) -> Result<&HostRunRetirementProgressV2, HostV2StorageError> {
    record.retirement.as_ref().ok_or_else(|| {
        HostV2StorageError::conflict(
            "host_run_retirement_state_invalid",
            "Host retiring Run is missing retirement progress",
        )
    })
}

fn retirement_resources_released(progress: &HostRunRetirementProgressV2) -> bool {
    progress.kernel_run_retired
        && progress.transport_capability_unbound
        && progress.bridge_child_reaped
        && progress.workspace_binding_unregistered
        && progress.empty_workspace_removed
}

fn require_retirement_reason(
    record: &HostActiveRunRecordV2,
    reason_code: RunRetirementReasonCodeV2,
    reason: Option<&str>,
) -> Result<(), HostV2StorageError> {
    let progress = retirement_progress(record)?;
    if progress.reason_code == reason_code && progress.reason.as_deref() == reason {
        Ok(())
    } else {
        Err(HostV2StorageError::conflict(
            "host_run_retirement_reason_conflict",
            "Host Run retirement was already requested with a different reason",
        ))
    }
}

fn require_retiring(record: &HostActiveRunRecordV2) -> Result<(), HostV2StorageError> {
    if record.lifecycle == HostRunLifecycleV2::Retiring {
        Ok(())
    } else {
        Err(HostV2StorageError::conflict(
            "host_run_retirement_state_invalid",
            "Host Run is not in the durable retiring state",
        ))
    }
}

fn require_run_identity(
    record: &HostActiveRunRecordV2,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
) -> Result<(), HostV2StorageError> {
    if record.session_id == session_id
        && record.host_run_id == host_run_id
        && record.run_id == run_id
    {
        Ok(())
    } else {
        Err(HostV2StorageError::conflict(
            "host_run_retirement_identity_conflict",
            "Host Run retirement identity does not match durable state",
        ))
    }
}

fn require_same_retiring_run(
    record: &HostActiveRunRecordV2,
    expected: &HostActiveRunRecordV2,
) -> Result<(), HostV2StorageError> {
    require_run_identity(
        record,
        &expected.session_id,
        &expected.host_run_id,
        &expected.run_id,
    )?;
    require_retiring(record)?;
    if retirement_progress(record)?.requested_at != retirement_progress(expected)?.requested_at {
        return Err(HostV2StorageError::conflict(
            "host_run_retirement_identity_conflict",
            "Host Run retirement revision changed during cleanup",
        ));
    }
    Ok(())
}

fn validate_run_lifecycle(record: &HostActiveRunRecordV2) -> Result<(), HostV2StorageError> {
    validate_bridge_ownership(&record.bridge_ownership)?;
    match record.workspace_kind {
        HostRunWorkspaceKindV2::Empty => {
            if record.workspace_canonical_root.is_some() {
                return Err(HostV2StorageError::conflict(
                    "host_active_run_workspace_root_invalid",
                    "Managed empty Host Run retained a bound-workspace recovery root",
                ));
            }
        }
        HostRunWorkspaceKindV2::Bound => {
            let must_retain_root = match record.lifecycle {
                HostRunLifecycleV2::Active => true,
                HostRunLifecycleV2::Retiring => record
                    .retirement
                    .as_ref()
                    .map_or(true, |progress| !progress.workspace_binding_unregistered),
                HostRunLifecycleV2::Retired => false,
            };
            if must_retain_root {
                validate_workspace_recovery_root(
                    HostRunWorkspaceKindV2::Bound,
                    record.workspace_canonical_root.as_deref(),
                )?;
            } else if record.workspace_canonical_root.is_some() {
                return Err(HostV2StorageError::conflict(
                    "host_active_run_workspace_root_retained",
                    "Retired or unregistered Host Run retained a recoverable workspace root",
                ));
            }
        }
    }
    match (record.lifecycle, record.retirement.as_ref()) {
        (HostRunLifecycleV2::Active, None) => Ok(()),
        (HostRunLifecycleV2::Active, Some(_)) => Err(HostV2StorageError::conflict(
            "host_run_retirement_state_invalid",
            "Active Host Run cannot contain retirement progress",
        )),
        (HostRunLifecycleV2::Retiring | HostRunLifecycleV2::Retired, Some(progress)) => {
            validate_bounded_identity(&progress.requested_at, "retirementRequestedAt", 1024)?;
            if let Some(reason) = &progress.reason {
                validate_bounded_identity(reason, "retirementReason", 1024)?;
            }
            if let Some(completed_at) = &progress.completed_at {
                validate_bounded_identity(completed_at, "retirementCompletedAt", 1024)?;
            }
            if let Some(error_code) = &progress.last_error_code {
                validate_bounded_identity(error_code, "retirementErrorCode", 512)?;
            }
            if progress.bridge_child_reaped
                != matches!(
                    record.bridge_ownership,
                    HostBridgeOwnershipV2::NotStarted | HostBridgeOwnershipV2::Reaped
                )
            {
                return Err(HostV2StorageError::conflict(
                    "host_run_retirement_state_invalid",
                    "Host Run child cleanup progress does not match durable bridge ownership",
                ));
            }
            match (
                progress.kernel_run_retired,
                progress.kernel_retirement_fact_id.as_deref(),
                progress.kernel_retirement_ledger_sequence,
            ) {
                (true, Some(fact_id), Some(ledger_sequence)) if ledger_sequence > 0 => {
                    validate_bounded_identity(fact_id, "kernelRetirementFactId", 512)?;
                }
                (false, None, None) => {}
                _ => {
                    return Err(HostV2StorageError::conflict(
                        "host_run_retirement_state_invalid",
                        "Host Run Kernel retirement progress is incomplete or contradictory",
                    ))
                }
            }
            if record.workspace_kind == HostRunWorkspaceKindV2::Bound
                && !progress.empty_workspace_removed
            {
                return Err(HostV2StorageError::conflict(
                    "host_run_retirement_state_invalid",
                    "Bound Host Run cannot own an empty-workspace cleanup step",
                ));
            }
            if record.lifecycle == HostRunLifecycleV2::Retired
                && (!retirement_resources_released(progress) || progress.completed_at.is_none())
            {
                return Err(HostV2StorageError::conflict(
                    "host_run_retirement_state_invalid",
                    "Retired Host Run must record complete resource cleanup",
                ));
            }
            Ok(())
        }
        (HostRunLifecycleV2::Retiring | HostRunLifecycleV2::Retired, None) => {
            Err(HostV2StorageError::conflict(
                "host_run_retirement_state_invalid",
                "Retiring or retired Host Run requires retirement progress",
            ))
        }
    }
}

fn validate_bridge_ownership(ownership: &HostBridgeOwnershipV2) -> Result<(), HostV2StorageError> {
    match ownership {
        HostBridgeOwnershipV2::NotStarted | HostBridgeOwnershipV2::Reaped => Ok(()),
        HostBridgeOwnershipV2::SpawnPrepared {
            owner_instance_id,
            generation,
        }
        | HostBridgeOwnershipV2::Owned {
            owner_instance_id,
            generation,
        } => {
            validate_bounded_identity(owner_instance_id, "bridgeOwnerInstanceId", 256)?;
            if *generation == 0 {
                return Err(HostV2StorageError::conflict(
                    "host_bridge_v2_generation_invalid",
                    "Host bridge child generation must be non-zero",
                ));
            }
            Ok(())
        }
    }
}

fn refresh_record_digest(record: &mut HostActiveRunRecordV2) -> Result<(), HostV2StorageError> {
    validate_run_lifecycle(record)?;
    let value = serde_json::to_value(&*record).map_err(|error| {
        HostV2StorageError::invalid(
            "host_active_run_encode_failed",
            format!("encode Host active-run record: {error}"),
        )
    })?;
    let without_digest = value_without_field(&value, "recordDigest")?;
    record.record_digest = canonical_sha256(&without_digest)?;
    Ok(())
}

fn write_active_run_record(
    path: &std::path::Path,
    record: &mut HostActiveRunRecordV2,
) -> Result<(), HostV2StorageError> {
    refresh_record_digest(record)?;
    let value = serde_json::to_value(record).map_err(|error| {
        HostV2StorageError::invalid(
            "host_active_run_encode_failed",
            format!("encode Host active-run record: {error}"),
        )
    })?;
    reject_transport_capabilities(&value)?;
    atomic_write_private_json(path, &value)
}
