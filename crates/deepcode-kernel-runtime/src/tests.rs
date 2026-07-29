use crate::executors::{EmptySecretProvider, KernelExecutorConfig};
use crate::v2::{KernelSessionServiceV2, PendingCapabilityDecisionClassV2, SettingsCeilingV2};
use deepcode_kernel_abi::v2::{
    CommandRequestId, ControlEpoch, InputId, KernelFactEnvelopeV2, OperationId, RunId,
    UserDecisionRefV2,
};
use deepcode_kernel_abi::v2_command::{
    CommandHandlingV2, DeadlineRequestV2, KernelCommandEnvelopeV2, KernelCommandResponseEnvelopeV2,
    KernelCommandV2, KernelReplyV2, RunOpenV2, ToolIntentSubmitReplyV2, ToolIntentSubmitV2,
};
use deepcode_kernel_abi::{
    CapabilityLeaseRefV2, CapabilityScopePreviewIdV2, PlanActionIdV2, PlanRevisionV2,
    RawToolArgumentsV2, RunCapabilityV2, ToolContextRefV2, ToolIdV2, ToolIntentAuthorityV2,
    UserDecisionReplyV2, UserDecisionV2, WorkspaceBindingRefV2,
};
use deepcode_kernel_ledger::v2::{CanonicalFactStore, FactQueryV2};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

static TEMP_INDEX: AtomicU64 = AtomicU64::new(0);

pub(super) struct TempWorkspace {
    root: PathBuf,
    workspace: PathBuf,
    store_path: PathBuf,
}

impl TempWorkspace {
    pub(super) fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "deepcode-kernel-v2-{label}-{}-{}",
            std::process::id(),
            TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
        ));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("create isolated v2 workspace");
        Self {
            store_path: root.join("kernel-v2.sqlite3"),
            root,
            workspace,
        }
    }

    pub(super) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(super) fn store_path(&self) -> &Path {
        &self.store_path
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(super) struct OpenedRun {
    pub(super) run_id: RunId,
    pub(super) control_epoch: ControlEpoch,
    pub(super) tool_context_ref: ToolContextRefV2,
    pub(super) run_capability: RunCapabilityV2,
}

pub(super) fn open_run(
    service: &KernelSessionServiceV2,
    workspace: &Path,
    workspace_binding_ref: WorkspaceBindingRefV2,
    label: &str,
) -> OpenedRun {
    let envelope = KernelCommandEnvelopeV2::new(
        CommandRequestId::new(format!("request-open-{label}")).expect("valid request id"),
        KernelCommandV2::RunOpen(RunOpenV2 {
            workspace_binding_ref,
            input_id: InputId::new(format!("input-{label}")).expect("valid input id"),
            opaque_input_ref: format!("opaque-input-{label}"),
        }),
    );
    let (response, capability) = service
        .open_run(envelope, workspace, SettingsCeilingV2::default())
        .into_parts();
    let opened = match response {
        KernelCommandResponseEnvelopeV2::Correlated {
            handling: CommandHandlingV2::Evaluated,
            reply: KernelReplyV2::RunOpened(opened),
            ..
        } => opened,
        other => panic!("expected evaluated RunOpen, got {other:?}"),
    };
    OpenedRun {
        run_id: opened.run_id,
        control_epoch: opened.control_epoch,
        tool_context_ref: opened.tool_context.context_ref(),
        run_capability: capability.expect("Host RunOpen must return a private run capability"),
    }
}

pub(super) struct V2Harness {
    pub(super) service: KernelSessionServiceV2,
    pub(super) temp: TempWorkspace,
    pub(super) opened: OpenedRun,
}

impl V2Harness {
    pub(super) fn new(label: &str) -> Self {
        let temp = TempWorkspace::new(label);
        let service = KernelSessionServiceV2::from_store(
            CanonicalFactStore::open_in_memory().expect("open isolated fact store"),
            KernelExecutorConfig::default(),
            Arc::new(EmptySecretProvider),
        )
        .expect("open v2 Kernel service");
        let binding_ref = WorkspaceBindingRefV2::new(format!("workspace-{label}"))
            .expect("valid workspace binding ref");
        let opened = open_run(&service, temp.workspace(), binding_ref, label);
        Self {
            service,
            temp,
            opened,
        }
    }

    pub(super) fn plan_intent(
        &self,
        request_id: &str,
        operation_id: &str,
        path: &str,
        lease: Option<CapabilityLeaseRefV2>,
    ) -> KernelCommandEnvelopeV2 {
        plan_intent(&self.opened, request_id, operation_id, path, lease)
    }

    pub(super) fn submit(
        &self,
        envelope: KernelCommandEnvelopeV2,
    ) -> (CommandHandlingV2, ToolIntentSubmitReplyV2) {
        tool_intent_response(
            self.service
                .handle_session_command(envelope, &self.opened.run_capability),
        )
    }

    pub(super) fn allow_preview(
        &self,
        preview_id: CapabilityScopePreviewIdV2,
        label: &str,
    ) -> UserDecisionReplyV2 {
        let pending = self
            .service
            .resolve_pending_capability_decision_host(
                preview_id,
                UserDecisionRefV2::new(format!("decision-ref-{label}"))
                    .expect("valid decision ref"),
            )
            .expect("resolve pending decision")
            .expect("preview remains current");
        let decision = match pending.class {
            PendingCapabilityDecisionClassV2::Capability => {
                UserDecisionV2::CapabilityAllow(pending.binding)
            }
            PendingCapabilityDecisionClassV2::ScopeExpansion => {
                UserDecisionV2::ScopeExpansionAllow(pending.binding)
            }
        };
        let (reply, handling) = self
            .service
            .apply_host_user_decision(
                CommandRequestId::new(format!("decision-request-{label}"))
                    .expect("valid decision request id"),
                pending.run_id,
                pending.expected_control_epoch,
                decision,
            )
            .expect("apply trusted Host decision");
        assert_eq!(handling, CommandHandlingV2::Evaluated);
        reply
    }

    pub(super) fn facts_for_operation(&self, operation_id: &str) -> Vec<KernelFactEnvelopeV2> {
        self.service
            .fact_reader()
            .query(&FactQueryV2 {
                run_id: Some(self.opened.run_id.to_string()),
                operation_id: Some(operation_id.to_owned()),
                ..FactQueryV2::default()
            })
            .expect("query canonical facts")
    }

    pub(super) fn wait_for_effect(&self, operation_id: &str) -> Vec<KernelFactEnvelopeV2> {
        for _ in 0..400 {
            let facts = self.facts_for_operation(operation_id);
            if facts.iter().any(|fact| {
                matches!(
                    &fact.payload,
                    deepcode_kernel_abi::v2::KernelFactPayloadV2::Effect(_)
                )
            }) {
                return facts;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        panic!("operation {operation_id} did not record an Effect fact within 2 seconds");
    }
}

pub(super) fn plan_intent(
    opened: &OpenedRun,
    request_id: &str,
    operation_id: &str,
    path: &str,
    lease: Option<CapabilityLeaseRefV2>,
) -> KernelCommandEnvelopeV2 {
    KernelCommandEnvelopeV2::new(
        CommandRequestId::new(request_id).expect("valid request id"),
        KernelCommandV2::ToolIntentSubmit(ToolIntentSubmitV2 {
            run_id: opened.run_id.clone(),
            expected_control_epoch: opened.control_epoch,
            operation_id: OperationId::new(operation_id).expect("valid operation id"),
            idempotency_key: format!("idempotency-{operation_id}"),
            tool_id: ToolIdV2::parse("fs.ensure_directory").expect("registered ToolId"),
            raw_arguments: RawToolArgumentsV2::new(serde_json::json!({ "path": path }))
                .expect("object arguments"),
            authority: ToolIntentAuthorityV2::PlanAction {
                plan_revision: PlanRevisionV2::new("plan-revision-1").expect("valid plan revision"),
                plan_action_id: PlanActionIdV2::new("plan-action-1").expect("valid PlanAction id"),
                lease,
            },
            deadline: DeadlineRequestV2::ContractDefault {},
            tool_context_ref: opened.tool_context_ref.clone(),
        }),
    )
}

pub(super) fn tool_intent_response(
    response: KernelCommandResponseEnvelopeV2,
) -> (CommandHandlingV2, ToolIntentSubmitReplyV2) {
    match response {
        KernelCommandResponseEnvelopeV2::Correlated {
            handling,
            reply: KernelReplyV2::ToolIntentSubmission(reply),
            ..
        } => (handling, reply),
        other => panic!("expected ToolIntentSubmission, got {other:?}"),
    }
}

mod v2_grant_tests;
mod v2_invocation_tests;
mod v2_unified_tests;
