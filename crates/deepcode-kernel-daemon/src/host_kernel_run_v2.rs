use crate::host_run_broker_v2::{
    HostActiveRunBrokerV2, HostActiveRunRecordV2, HostActiveRunRegistrationV2,
    HostBridgeChildLeaseV2, HostRunSettingsCeilingV2, HostRunWorkspaceKindV2,
};
use crate::host_v2_storage::{reject_transport_capabilities, HostV2StorageError};
use deepcode_kernel_abi::v2::{InputId, RunId};
use deepcode_kernel_abi::v2_command::{
    KernelCommandResponseEnvelopeV2, KernelReplyV2, RunOpenReplyV2,
};
use deepcode_kernel_abi::{RunCapabilityV2, WorkspaceBindingRefV2};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA: &str =
    "deepcode.session.kernel-production-request.v2";
const SESSION_KERNEL_PERSISTENCE_V2_SCHEMA: &str = "deepcode.session.kernel-persistence.v2";
const SESSION_KERNEL_PREFETCHED_RUN_V2_SCHEMA: &str = "deepcode.session.prefetched-kernel-run.v2";
const SESSION_KERNEL_RUN_CAPABILITY_ENV_V2: &str = "DEEPCODE_SESSION_RUN_CAPABILITY_V2";

#[derive(Debug, Clone)]
pub(crate) struct HostKernelRunWorkspaceV2 {
    pub(crate) workspace_binding_ref: WorkspaceBindingRefV2,
    pub(crate) workspace_binding_identity: String,
    pub(crate) workspace_kind: HostRunWorkspaceKindV2,
    pub(crate) empty_workspace_key: Option<String>,
    pub(crate) run_settings: HostRunSettingsCeilingV2,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostKernelInitialInputV2 {
    pub(crate) input_id: InputId,
    pub(crate) opaque_input_ref: String,
    pub(crate) text: String,
    pub(crate) recorded_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub(crate) enum HostKernelBridgeOperationV2 {
    InitialTurn {
        guidance: Vec<String>,
    },
    ResumePlanAction {
        plan_action_id: String,
        wake_hint: bool,
        provider_call_budget: u16,
        guidance: Vec<String>,
    },
    UserInput {
        input: HostKernelInitialInputV2,
        guidance: Vec<String>,
    },
    Replan {
        expected_plan_revision: String,
        guidance: Vec<String>,
    },
    ResumeAfterBackpressure {
        operation_id: String,
        retry_at: String,
        plan_action_id: String,
        guidance: Vec<String>,
    },
    PreviewPlanAction {
        plan_action_id: String,
    },
    SkipPlanAction {
        plan_action_id: String,
        reason: String,
    },
    ObserveCapabilityDecision {
        decision: HostKernelCapabilityDecisionV2,
        guidance: String,
    },
    ReconcileWake {},
    FinalizeReview {},
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostKernelCapabilityDecisionV2 {
    Allow,
    Deny,
}

pub(crate) struct HostKernelBridgeSpawnV2 {
    pub(crate) active_run: HostActiveRunRecordV2,
    pub(crate) child: HostBridgeChildLeaseV2,
}

#[derive(Clone)]
pub(crate) struct HostKernelRunCoordinatorV2 {
    active_runs: HostActiveRunBrokerV2,
}

impl HostKernelRunCoordinatorV2 {
    pub(crate) fn new(active_runs: HostActiveRunBrokerV2) -> Self {
        Self { active_runs }
    }

    /// Completes the Host half of an atomic RunOpen after Kernel has produced
    /// a safe reply and a process-private capability using the exact per-Run
    /// Settings ceiling. The capability is bound in memory and inherited only
    /// by the owned Session child; it is never inserted into request JSON.
    pub(crate) async fn register_opened_run_and_spawn(
        &self,
        input: HostKernelRunSpawnInputV2,
        opened_response: KernelCommandResponseEnvelopeV2,
        run_capability: Option<RunCapabilityV2>,
    ) -> Result<HostKernelBridgeSpawnV2, HostV2StorageError> {
        validate_spawn_input(&input)?;
        let run_open_reply = run_open_reply(opened_response)?;
        let run_capability = run_capability.ok_or_else(|| {
            HostV2StorageError::unauthorized(
                "host_kernel_run_capability_missing",
                "Kernel RunOpen did not return its private Run capability",
            )
        })?;
        let turn = self
            .active_runs
            .begin_session_turn(&input.session_id)
            .await?;
        let receipt = self.active_runs.register(HostActiveRunRegistrationV2 {
            session_id: input.session_id.clone(),
            host_run_id: input.host_run_id.clone(),
            run_id: run_open_reply.run_id.to_string(),
            workspace_binding_ref: input.workspace.workspace_binding_ref.to_string(),
            workspace_binding_digest: run_open_reply.workspace_binding_digest.as_str().to_string(),
            workspace_binding_identity: input.workspace.workspace_binding_identity.clone(),
            workspace_kind: input.workspace.workspace_kind,
            empty_workspace_key: input.workspace.empty_workspace_key.clone(),
            initial_input_id: input.initial_input.input_id.to_string(),
            initial_opaque_input_ref: input.initial_input.opaque_input_ref.clone(),
            run_settings: input.workspace.run_settings.clone(),
            recorded_at: input.initial_input.recorded_at.clone(),
        })?;
        self.active_runs.bind_run_transport_capability(
            &turn,
            &input.host_run_id,
            run_open_reply.run_id.as_str(),
            &run_capability,
        )?;

        let request = production_request(&input, &run_open_reply)?;
        let payload = serde_json::to_vec(&request).map_err(|error| {
            HostV2StorageError::invalid(
                "host_kernel_bridge_request_encode_failed",
                format!("encode Host Kernel v2 bridge request: {error}"),
            )
        })?;
        let bridge = find_session_host_bridge_v2().ok_or_else(|| {
            HostV2StorageError::not_found(
                "host_kernel_bridge_v2_unavailable",
                "Session Kernel v2 production bridge was not found",
            )
        })?;
        let node = crate::agent_bridge::find_session_host_node_daemon(&bridge);
        let mut command = Command::new(node);
        command
            .arg(bridge)
            .env(
                SESSION_KERNEL_RUN_CAPABILITY_ENV_V2,
                run_capability.expose_to_transport(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = self
            .active_runs
            .spawn_bridge_child(&turn, &input.host_run_id, &mut command)?;
        let mut stdin = child.take_stdin()?.ok_or_else(|| {
            HostV2StorageError::io(
                "host_kernel_bridge_v2_stdin_unavailable",
                "Session Kernel v2 bridge stdin is unavailable",
            )
        })?;
        stdin.write_all(&payload).map_err(|error| {
            HostV2StorageError::io(
                "host_kernel_bridge_v2_write_failed",
                format!("write Session Kernel v2 bridge request: {error}"),
            )
        })?;
        drop(stdin);
        Ok(HostKernelBridgeSpawnV2 {
            active_run: receipt.record,
            child,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HostKernelRunSpawnInputV2 {
    pub(crate) api_base: String,
    pub(crate) session_id: String,
    pub(crate) host_run_id: String,
    pub(crate) provider_profile_id: Option<String>,
    pub(crate) workspace: HostKernelRunWorkspaceV2,
    pub(crate) initial_input: HostKernelInitialInputV2,
    pub(crate) operation: HostKernelBridgeOperationV2,
}

fn run_open_reply(
    response: KernelCommandResponseEnvelopeV2,
) -> Result<RunOpenReplyV2, HostV2StorageError> {
    match response {
        KernelCommandResponseEnvelopeV2::Correlated {
            reply: KernelReplyV2::RunOpened(reply),
            ..
        } => {
            reply.validate().map_err(|_| {
                HostV2StorageError::conflict(
                    "host_kernel_run_open_reply_invalid",
                    "Kernel RunOpen returned an invalid public reply",
                )
            })?;
            Ok(reply)
        }
        _ => Err(HostV2StorageError::conflict(
            "host_kernel_run_open_failed",
            "Kernel RunOpen did not return RunOpened",
        )),
    }
}

fn production_request(
    input: &HostKernelRunSpawnInputV2,
    reply: &RunOpenReplyV2,
) -> Result<Value, HostV2StorageError> {
    let mut request = json!({
        "schemaVersion": SESSION_KERNEL_PRODUCTION_REQUEST_V2_SCHEMA,
        "apiBase": input.api_base,
        "sessionId": input.session_id,
        "hostRunId": input.host_run_id,
        "runId": reply.run_id,
        "historySchema": SESSION_KERNEL_PERSISTENCE_V2_SCHEMA,
        "prefetchedRun": {
            "schemaVersion": SESSION_KERNEL_PREFETCHED_RUN_V2_SCHEMA,
            "workspaceBindingRef": input.workspace.workspace_binding_ref,
            "inputId": input.initial_input.input_id,
            "opaqueInputRef": input.initial_input.opaque_input_ref,
            "runOpenReply": reply
        },
        "initialInput": input.initial_input,
        "operation": input.operation
    });
    if let Some(provider_profile_id) = &input.provider_profile_id {
        request["providerProfileId"] = Value::String(provider_profile_id.clone());
    }
    reject_transport_capabilities(&request)?;
    Ok(request)
}

fn validate_spawn_input(input: &HostKernelRunSpawnInputV2) -> Result<(), HostV2StorageError> {
    for (field, value, maximum) in [
        ("apiBase", input.api_base.as_str(), 4 * 1024),
        ("sessionId", input.session_id.as_str(), 512),
        ("hostRunId", input.host_run_id.as_str(), 512),
        (
            "workspaceBindingIdentity",
            input.workspace.workspace_binding_identity.as_str(),
            64 * 1024,
        ),
        (
            "opaqueInputRef",
            input.initial_input.opaque_input_ref.as_str(),
            64 * 1024,
        ),
        ("recordedAt", input.initial_input.recorded_at.as_str(), 1024),
    ] {
        crate::host_v2_storage::validate_bounded_identity(value, field, maximum)?;
    }
    if input.initial_input.text.len() > 1024 * 1024 {
        return Err(HostV2StorageError::invalid(
            "host_kernel_initial_input_too_large",
            "Session Kernel v2 initial input exceeds the Host limit",
        ));
    }
    if let Some(provider_profile_id) = &input.provider_profile_id {
        crate::host_v2_storage::validate_bounded_identity(
            provider_profile_id,
            "providerProfileId",
            512,
        )?;
    }
    match input.workspace.workspace_kind {
        HostRunWorkspaceKindV2::Bound if input.workspace.empty_workspace_key.is_some() => {
            Err(HostV2StorageError::invalid(
                "host_kernel_workspace_binding_invalid",
                "Bound Session Run cannot carry an empty workspace key",
            ))
        }
        HostRunWorkspaceKindV2::Empty
            if input.workspace.empty_workspace_key.is_none()
                || input.workspace.run_settings != HostRunSettingsCeilingV2::empty_workspace() =>
        {
            Err(HostV2StorageError::invalid(
                "host_kernel_workspace_binding_invalid",
                "Empty Session Run requires its managed key and zero capability ceiling",
            ))
        }
        _ => Ok(()),
    }
}

fn find_session_host_bridge_v2() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("DEEPCODE_SESSION_BRIDGE_V2") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut roots = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    roots
        .into_iter()
        .find_map(|root| find_bridge_from_root(&root))
}

fn find_bridge_from_root(root: &Path) -> Option<PathBuf> {
    root.ancestors().find_map(|ancestor| {
        [
            ancestor.join("session-core/dist/hostBridgeV2.js"),
            ancestor.join("userspace/session-core/dist/hostBridgeV2.js"),
            ancestor.join("DeepCode/userspace/session-core/dist/hostBridgeV2.js"),
        ]
        .into_iter()
        .find(|candidate| candidate.is_file())
    })
}

pub(crate) fn run_id_from_active_record(
    active: &HostActiveRunRecordV2,
) -> Result<RunId, HostV2StorageError> {
    RunId::new(active.run_id.clone()).map_err(|_| {
        HostV2StorageError::conflict(
            "host_active_run_identity_invalid",
            "Durable Host active-run record has an invalid Kernel Run identity",
        )
    })
}
