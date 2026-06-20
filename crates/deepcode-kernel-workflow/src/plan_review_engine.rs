use crate::{ActionBundleDraft, FileTargetRef, FileTargetRefKind, PlanContract, PlannedAction};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Component;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanReviewStatus {
    AutoAccepted,
    AwaitingUserApproval,
    AwaitingTemporaryGrant,
    Denied,
    NeedsRevision,
    InterfaceOnly,
}

pub type ProposalReviewStatus = PlanReviewStatus;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewFinding {
    pub code: String,
    pub message: String,
}

pub type ProposalReviewFinding = PlanReviewFinding;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredFileOperation {
    pub operation: String,
    pub target_path: String,
    pub capability: String,
    pub action_id: String,
    #[serde(default)]
    pub target_ref: Option<FileTargetRef>,
    #[serde(default)]
    pub target_kind: String,
    #[serde(default)]
    pub outside_workspace: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewInput {
    pub plan: PlanContract,
    #[serde(default)]
    pub action_bundle: Option<ActionBundleDraft>,
}

pub type ProposalReviewInput = PlanReviewInput;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewReport {
    pub plan_id: String,
    pub status: PlanReviewStatus,
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub required_permissions: Vec<String>,
    #[serde(default)]
    pub permission_gaps: Vec<String>,
    #[serde(default)]
    pub required_file_operations: Vec<RequiredFileOperation>,
    #[serde(default)]
    pub hard_floor_hits: Vec<String>,
    #[serde(default)]
    pub denied_reasons: Vec<String>,
    #[serde(default)]
    pub blocked_reasons: Vec<String>,
    #[serde(default)]
    pub findings: Vec<PlanReviewFinding>,
    pub kernel_generated_permission_summary: String,
}

pub type ProposalReviewReport = PlanReviewReport;

impl PlanReviewReport {
    pub fn denied(plan_id: impl Into<String>, reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self {
            plan_id: plan_id.into(),
            status: PlanReviewStatus::Denied,
            required_capabilities: Vec::new(),
            required_permissions: Vec::new(),
            permission_gaps: Vec::new(),
            required_file_operations: Vec::new(),
            hard_floor_hits: Vec::new(),
            denied_reasons: vec![reason.clone()],
            blocked_reasons: vec![reason],
            findings: Vec::new(),
            kernel_generated_permission_summary:
                "Kernel preflight: status=denied; capabilities=none; permissionGaps=none; hardFloor=none.".to_string(),
        }
    }

    pub fn interface_only(plan: &PlanContract) -> Self {
        Self {
            plan_id: plan.id.clone(),
            status: PlanReviewStatus::InterfaceOnly,
            required_capabilities: sorted(plan.required_capabilities.iter().cloned()),
            required_permissions: Vec::new(),
            permission_gaps: Vec::new(),
            required_file_operations: Vec::new(),
            hard_floor_hits: Vec::new(),
            denied_reasons: Vec::new(),
            blocked_reasons: vec![
                "PlanReviewGate is an interface placeholder; structured preflight is available through DefaultPlanReviewEngine.".to_string(),
            ],
            findings: Vec::new(),
            kernel_generated_permission_summary:
                "Kernel preflight: status=interfaceOnly; capabilities=notEvaluated; permissionGaps=notEvaluated; hardFloor=notEvaluated.".to_string(),
        }
    }
}

pub trait PlanReviewEngine {
    fn review_plan(&self, plan: &PlanContract) -> PlanReviewReport;

    fn review_input(&self, input: PlanReviewInput) -> PlanReviewReport {
        self.review_plan(&input.plan)
    }
}

pub trait ProposalReviewEngine: PlanReviewEngine {}

impl<T> ProposalReviewEngine for T where T: PlanReviewEngine {}

#[derive(Debug, Clone, Default)]
pub struct DefaultPlanReviewEngine;

pub type DefaultProposalReviewEngine = DefaultPlanReviewEngine;

impl PlanReviewEngine for DefaultPlanReviewEngine {
    fn review_plan(&self, plan: &PlanContract) -> PlanReviewReport {
        self.review_input(PlanReviewInput {
            plan: plan.clone(),
            action_bundle: None,
        })
    }

    fn review_input(&self, input: PlanReviewInput) -> PlanReviewReport {
        review_structured_plan(input)
    }
}

fn review_structured_plan(input: PlanReviewInput) -> PlanReviewReport {
    let mut capabilities = BTreeSet::new();
    for capability in &input.plan.required_capabilities {
        capabilities.insert(capability.clone());
    }
    if let Some(bundle) = &input.action_bundle {
        for action in &bundle.actions {
            capabilities.insert(action.capability.clone());
        }
    }
    let required_capabilities = sorted(capabilities.into_iter());

    let mut hard_floor_hits = Vec::new();
    let mut denied_reasons = Vec::new();
    let mut permission_gaps = Vec::new();
    let mut findings = Vec::new();

    for capability in &required_capabilities {
        if hard_floor_capability(capability) {
            hard_floor_hits.push(capability.clone());
            denied_reasons.push(format!("capability {capability} is blocked by hard floor"));
            continue;
        }
        if !known_capability(capability) {
            denied_reasons.push(format!("unknown capability {capability}"));
            continue;
        }
        if permission_gap_capability(capability) {
            permission_gaps.push(capability.clone());
        }
    }

    if input.plan.completion_criteria.is_empty()
        || input
            .plan
            .completion_criteria
            .iter()
            .any(|criteria| criteria.evidence_required.is_empty())
    {
        findings.push(PlanReviewFinding {
            code: "completion_evidence_required".to_string(),
            message: "completion criteria must declare evidence requirements".to_string(),
        });
    }

    let (required_file_operations, file_operation_findings) =
        required_file_operations_for_input(&input);
    findings.extend(file_operation_findings);

    let status = if !denied_reasons.is_empty() || !hard_floor_hits.is_empty() {
        PlanReviewStatus::Denied
    } else if !findings.is_empty() {
        PlanReviewStatus::NeedsRevision
    } else if !permission_gaps.is_empty() {
        PlanReviewStatus::AwaitingTemporaryGrant
    } else if input.plan.requires_user_approval {
        PlanReviewStatus::AwaitingUserApproval
    } else {
        PlanReviewStatus::AutoAccepted
    };

    let required_permissions = permission_gaps
        .iter()
        .map(|capability| format!("temporaryGrant:{capability}"))
        .collect::<Vec<_>>();
    let blocked_reasons = denied_reasons
        .iter()
        .cloned()
        .chain(findings.iter().map(|finding| finding.message.clone()))
        .collect::<Vec<_>>();

    PlanReviewReport {
        plan_id: input.plan.id,
        kernel_generated_permission_summary: permission_summary(
            &status,
            &required_capabilities,
            &permission_gaps,
            &hard_floor_hits,
        ),
        status,
        required_capabilities,
        required_permissions,
        permission_gaps,
        required_file_operations,
        hard_floor_hits,
        denied_reasons,
        blocked_reasons,
        findings,
    }
}

fn permission_summary(
    status: &PlanReviewStatus,
    capabilities: &[String],
    permission_gaps: &[String],
    hard_floor_hits: &[String],
) -> String {
    format!(
        "Kernel preflight: status={}; capabilities={}; permissionGaps={}; hardFloor={}.",
        status_name(status),
        list_or_none(capabilities),
        list_or_none(permission_gaps),
        list_or_none(hard_floor_hits)
    )
}

fn status_name(status: &PlanReviewStatus) -> &'static str {
    match status {
        PlanReviewStatus::AutoAccepted => "autoAccepted",
        PlanReviewStatus::AwaitingUserApproval => "awaitingUserApproval",
        PlanReviewStatus::AwaitingTemporaryGrant => "awaitingTemporaryGrant",
        PlanReviewStatus::Denied => "denied",
        PlanReviewStatus::NeedsRevision => "needsRevision",
        PlanReviewStatus::InterfaceOnly => "interfaceOnly",
    }
}

fn list_or_none(values: &[String]) -> String {
    if values.is_empty() {
        "none".to_string()
    } else {
        values.join(",")
    }
}

fn sorted(values: impl Iterator<Item = String>) -> Vec<String> {
    values.collect::<BTreeSet<_>>().into_iter().collect()
}

fn required_file_operations_for_input(
    input: &PlanReviewInput,
) -> (Vec<RequiredFileOperation>, Vec<PlanReviewFinding>) {
    let mut operations = Vec::new();
    let mut findings = Vec::new();
    let mut seen = BTreeSet::new();
    let Some(bundle) = &input.action_bundle else {
        return (operations, findings);
    };
    for action in &bundle.actions {
        let Some(operation) = mutation_operation_for_action(action) else {
            continue;
        };
        let raw_target = action
            .target_ref
            .as_ref()
            .map(file_target_ref_raw_path)
            .or_else(|| {
                action
                    .target_path
                    .as_deref()
                    .map(str::to_string)
                    .or_else(|| {
                        action
                            .resource_scope
                            .iter()
                            .find_map(|scope| concrete_target(scope).map(str::to_string))
                    })
            });
        let Some(raw_target) = raw_target else {
            findings.push(file_operation_finding(
                "file_operation_target_required",
                action,
                "requires targetPath or resourceScope with a concrete file path",
            ));
            continue;
        };
        match normalize_file_operation_target(&raw_target) {
            Ok(target) => {
                let key = format!(
                    "{}:{}:{}:{}",
                    operation, action.capability, action.id, target.target_path
                );
                if seen.insert(key) {
                    operations.push(RequiredFileOperation {
                        operation: operation.to_string(),
                        target_path: target.target_path,
                        capability: action.capability.clone(),
                        action_id: action.id.clone(),
                        target_ref: Some(target.target_ref),
                        target_kind: target.target_kind.to_string(),
                        outside_workspace: target.outside_workspace,
                    });
                }
            }
            Err(reason) => findings.push(file_operation_finding(
                "file_operation_target_invalid",
                action,
                &reason,
            )),
        }
    }
    (operations, findings)
}

fn concrete_target(value: &String) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn mutation_operation_for_action(action: &PlannedAction) -> Option<&'static str> {
    match action
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some("delete") => Some("delete"),
        Some("create") => Some("create"),
        Some("rename") => Some("rename"),
        Some("write" | "patch" | "replaceBlock" | "insertBefore" | "insertAfter") => Some("write"),
        Some(_) | None => mutation_operation_for_capability(&action.capability),
    }
}

fn mutation_operation_for_capability(capability: &str) -> Option<&'static str> {
    match capability {
        "fs.write" => Some("write"),
        "fs.patch" => Some("write"),
        "fs.delete" => Some("delete"),
        _ => None,
    }
}

struct NormalizedFileOperationTarget {
    target_path: String,
    target_ref: FileTargetRef,
    target_kind: &'static str,
    outside_workspace: bool,
}

fn file_target_ref_raw_path(target_ref: &FileTargetRef) -> String {
    match target_ref.kind {
        FileTargetRefKind::WorkspaceRelative | FileTargetRefKind::AbsolutePath => {
            target_ref.path.clone()
        }
        FileTargetRefKind::RootRelative => target_ref
            .root_id
            .as_deref()
            .map(str::trim)
            .filter(|root| !root.is_empty())
            .map(|root| {
                if target_ref.path.trim().is_empty() {
                    root.to_string()
                } else {
                    format!("{}/{}", root.trim_end_matches('/'), target_ref.path)
                }
            })
            .unwrap_or_else(|| target_ref.path.clone()),
    }
}

fn normalize_file_operation_target(raw: &str) -> Result<NormalizedFileOperationTarget, String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() || normalized == "." || normalized == "./" {
        return Err("target must be a concrete file path, not the workspace root".to_string());
    }
    if normalized.contains('*') {
        return Err("target must be a concrete file path, not a wildcard".to_string());
    }
    let path = std::path::Path::new(&normalized);
    if path.is_absolute() {
        let mut has_file_component = false;
        for component in path.components() {
            match component {
                Component::Normal(_) => has_file_component = true,
                Component::CurDir => {}
                Component::ParentDir => {
                    return Err("absolute target must not contain parent traversal".to_string())
                }
                Component::RootDir | Component::Prefix(_) => {}
            }
        }
        if !has_file_component || normalized.ends_with('/') {
            return Err(
                "absolute target must be a concrete file path, not a directory".to_string(),
            );
        }
        return Ok(NormalizedFileOperationTarget {
            target_path: normalized.clone(),
            target_ref: FileTargetRef {
                kind: FileTargetRefKind::AbsolutePath,
                path: normalized,
                root_id: None,
            },
            target_kind: "absolutePath",
            outside_workspace: true,
        });
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => components.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("target must not escape the authorized workspace root".to_string())
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(
                    "target must be workspace-relative or a concrete absolute file path"
                        .to_string(),
                )
            }
        }
    }
    if components.is_empty() {
        return Err("target must be a concrete file path, not the workspace root".to_string());
    }
    let target = components.join("/");
    if target.ends_with('/') {
        return Err("target must be a concrete file path, not a directory".to_string());
    }
    Ok(NormalizedFileOperationTarget {
        target_path: target.clone(),
        target_ref: FileTargetRef {
            kind: FileTargetRefKind::WorkspaceRelative,
            path: target,
            root_id: None,
        },
        target_kind: "workspaceRelative",
        outside_workspace: false,
    })
}

fn file_operation_finding(code: &str, action: &PlannedAction, reason: &str) -> PlanReviewFinding {
    PlanReviewFinding {
        code: code.to_string(),
        message: format!(
            "file operation action {} ({}) {}",
            action.id, action.capability, reason
        ),
    }
}

fn known_capability(capability: &str) -> bool {
    matches!(
        capability,
        "fs.read"
            | "fs.diff"
            | "fs.write"
            | "fs.patch"
            | "fs.delete"
            | "fs.list"
            | "code.search"
            | "git.read"
            | "git.write"
            | "git.push"
            | "browser.control"
            | "process.propose"
            | "process.exec"
            | "network.egress"
            | "secret.read"
            | "web.search"
            | "context.assemble"
            | "plan.review"
            | "policy.inspect"
            | "evidence.query"
            | "permission.preflight"
            | "validation.read"
            | "reviewgate.evaluate"
            | "config.modify"
            | "kernel.modify"
    )
}

fn permission_gap_capability(capability: &str) -> bool {
    matches!(
        capability,
        "fs.write"
            | "fs.patch"
            | "fs.delete"
            | "git.write"
            | "git.push"
            | "browser.control"
            | "process.exec"
            | "network.egress"
            | "secret.read"
    )
}

fn hard_floor_capability(capability: &str) -> bool {
    matches!(capability, "kernel.modify" | "config.modify")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActionBundleDraft, PlannedAction, ValidationExpectation};

    #[test]
    fn default_plan_review_engine_auto_accepts_read_only_plan() {
        let plan = PlanContract::low_risk_direct("plan-1", "inspect workspace");
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.plan_id, "plan-1");
        assert_eq!(report.status, PlanReviewStatus::AutoAccepted);
        assert_eq!(report.required_capabilities, vec!["fs.read"]);
        assert!(report.permission_gaps.is_empty());
        assert!(report
            .kernel_generated_permission_summary
            .contains("status=autoAccepted"));
    }

    #[test]
    fn write_process_network_and_secret_create_permission_gaps() {
        for capability in ["fs.write", "process.exec", "network.egress", "secret.read"] {
            let mut plan = PlanContract::low_risk_direct("plan-gap", "gap");
            plan.required_capabilities = vec![capability.to_string()];
            let report = DefaultPlanReviewEngine.review_plan(&plan);
            assert_eq!(report.status, PlanReviewStatus::AwaitingTemporaryGrant);
            assert_eq!(report.permission_gaps, vec![capability]);
            assert_eq!(
                report.required_permissions,
                vec![format!("temporaryGrant:{capability}")]
            );
        }
    }

    #[test]
    fn unknown_capability_is_denied() {
        let mut plan = PlanContract::low_risk_direct("plan-unknown", "unknown");
        plan.required_capabilities = vec!["workspace.fly".to_string()];
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.status, PlanReviewStatus::Denied);
        assert!(report.denied_reasons[0].contains("unknown capability"));
    }

    #[test]
    fn hard_floor_capability_is_denied() {
        let mut plan = PlanContract::low_risk_direct("plan-hard-floor", "hard floor");
        plan.required_capabilities = vec!["kernel.modify".to_string()];
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.status, PlanReviewStatus::Denied);
        assert_eq!(report.hard_floor_hits, vec!["kernel.modify"]);
    }

    #[test]
    fn explicit_user_approval_waits_for_user_when_no_permission_gap() {
        let mut plan = PlanContract::low_risk_direct("plan-user", "needs user");
        plan.requires_user_approval = true;
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.status, PlanReviewStatus::AwaitingUserApproval);
    }

    #[test]
    fn missing_evidence_needs_revision() {
        let mut plan = PlanContract::low_risk_direct("plan-evidence", "needs evidence");
        plan.completion_criteria[0].evidence_required.clear();
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.status, PlanReviewStatus::NeedsRevision);
        assert_eq!(report.findings[0].code, "completion_evidence_required");
    }

    #[test]
    fn action_bundle_capabilities_are_reviewed_without_copying_llm_text() {
        let plan = PlanContract::low_risk_direct("plan-bundle", "bundle");
        let bundle = ActionBundleDraft {
            id: "bundle-1".to_string(),
            goal: "bundle".to_string(),
            actions: vec![PlannedAction {
                id: "action-1".to_string(),
                title: "LLM says admin permission is needed".to_string(),
                kind: None,
                capability: "fs.write".to_string(),
                target_ref: None,
                target_path: None,
                resource_scope: vec!["src".to_string()],
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
            }],
            validation_expectations: vec![ValidationExpectation {
                id: "check-1".to_string(),
                description: "file exists".to_string(),
                command: None,
            }],
            review_expectations: Vec::new(),
        };
        let report = DefaultPlanReviewEngine.review_input(PlanReviewInput {
            plan,
            action_bundle: Some(bundle),
        });

        assert_eq!(report.status, PlanReviewStatus::AwaitingTemporaryGrant);
        assert_eq!(report.permission_gaps, vec!["fs.write"]);
        assert!(!report
            .kernel_generated_permission_summary
            .contains("admin permission"));
    }

    #[test]
    fn action_bundle_review_reports_required_file_operations() {
        let mut plan = PlanContract::low_risk_direct("plan-file-ops", "file ops");
        plan.completion_criteria[0]
            .evidence_required
            .push("tool fact".to_string());
        let bundle = ActionBundleDraft {
            id: "bundle-file-ops".to_string(),
            goal: "update generic files".to_string(),
            actions: vec![
                PlannedAction {
                    id: "write-generic".to_string(),
                    title: "Write generic output".to_string(),
                    kind: Some("write".to_string()),
                    capability: "fs.write".to_string(),
                    target_ref: None,
                    target_path: Some("./generic-output.txt".to_string()),
                    resource_scope: Vec::new(),
                    can_parallelize: false,
                    conflict_keys: Vec::new(),
                    purpose: None,
                },
                PlannedAction {
                    id: "delete-generic".to_string(),
                    title: "Delete generic obsolete file".to_string(),
                    kind: Some("delete".to_string()),
                    capability: "fs.delete".to_string(),
                    target_ref: None,
                    target_path: None,
                    resource_scope: vec!["generic-obsolete.tmp".to_string()],
                    can_parallelize: false,
                    conflict_keys: Vec::new(),
                    purpose: None,
                },
            ],
            validation_expectations: Vec::new(),
            review_expectations: Vec::new(),
        };

        let report = DefaultPlanReviewEngine.review_input(PlanReviewInput {
            plan,
            action_bundle: Some(bundle),
        });

        assert_eq!(report.status, PlanReviewStatus::AwaitingTemporaryGrant);
        assert_eq!(report.required_file_operations.len(), 2);
        assert!(report.required_file_operations.iter().any(|operation| {
            operation.operation == "write"
                && operation.capability == "fs.write"
                && operation.target_path == "generic-output.txt"
                && operation.target_ref.as_ref().is_some_and(|target| {
                    target.kind == FileTargetRefKind::WorkspaceRelative
                        && target.path == "generic-output.txt"
                })
                && operation.target_kind == "workspaceRelative"
                && !operation.outside_workspace
        }));
        assert!(report.required_file_operations.iter().any(|operation| {
            operation.operation == "delete"
                && operation.capability == "fs.delete"
                && operation.target_path == "generic-obsolete.tmp"
                && operation.target_ref.as_ref().is_some_and(|target| {
                    target.kind == FileTargetRefKind::WorkspaceRelative
                        && target.path == "generic-obsolete.tmp"
                })
                && operation.target_kind == "workspaceRelative"
                && !operation.outside_workspace
        }));
    }

    #[test]
    fn action_bundle_review_reports_absolute_file_targets_as_outside_workspace() {
        let plan = PlanContract::low_risk_direct("plan-absolute-file-op", "absolute file op");
        let absolute_target = std::env::temp_dir()
            .join(format!("deepcode-plan-review-{}.txt", std::process::id()))
            .to_string_lossy()
            .replace('\\', "/");
        let bundle = ActionBundleDraft {
            id: "bundle-absolute-file-op".to_string(),
            goal: "update outside file".to_string(),
            actions: vec![PlannedAction {
                id: "write-absolute".to_string(),
                title: "Write outside file".to_string(),
                kind: Some("write".to_string()),
                capability: "fs.write".to_string(),
                target_ref: None,
                target_path: Some(absolute_target.clone()),
                resource_scope: Vec::new(),
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
            }],
            validation_expectations: Vec::new(),
            review_expectations: Vec::new(),
        };

        let report = DefaultPlanReviewEngine.review_input(PlanReviewInput {
            plan,
            action_bundle: Some(bundle),
        });

        assert_eq!(report.status, PlanReviewStatus::AwaitingTemporaryGrant);
        assert_eq!(report.required_file_operations.len(), 1);
        let operation = &report.required_file_operations[0];
        assert_eq!(operation.operation, "write");
        assert_eq!(operation.capability, "fs.write");
        assert_eq!(operation.target_path, absolute_target);
        assert!(operation.target_ref.as_ref().is_some_and(|target| {
            target.kind == FileTargetRefKind::AbsolutePath && target.path == absolute_target
        }));
        assert_eq!(operation.target_kind, "absolutePath");
        assert!(operation.outside_workspace);
    }

    #[test]
    fn action_bundle_review_accepts_canonical_target_ref() {
        let plan = PlanContract::low_risk_direct("plan-target-ref", "target ref file op");
        let bundle = ActionBundleDraft {
            id: "bundle-target-ref".to_string(),
            goal: "delete target ref file".to_string(),
            actions: vec![PlannedAction {
                id: "delete-target-ref".to_string(),
                title: "Delete target ref file".to_string(),
                kind: Some("delete".to_string()),
                capability: "fs.delete".to_string(),
                target_ref: Some(FileTargetRef {
                    kind: FileTargetRefKind::WorkspaceRelative,
                    path: "generic-target-ref.tmp".to_string(),
                    root_id: None,
                }),
                target_path: None,
                resource_scope: Vec::new(),
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
            }],
            validation_expectations: Vec::new(),
            review_expectations: Vec::new(),
        };

        let report = DefaultPlanReviewEngine.review_input(PlanReviewInput {
            plan,
            action_bundle: Some(bundle),
        });

        assert_eq!(report.status, PlanReviewStatus::AwaitingTemporaryGrant);
        assert_eq!(report.required_file_operations.len(), 1);
        let operation = &report.required_file_operations[0];
        assert_eq!(operation.target_path, "generic-target-ref.tmp");
        assert!(operation.target_ref.as_ref().is_some_and(|target| {
            target.kind == FileTargetRefKind::WorkspaceRelative
                && target.path == "generic-target-ref.tmp"
        }));
    }

    #[test]
    fn action_bundle_review_rejects_mutation_without_concrete_file_target() {
        let plan = PlanContract::low_risk_direct("plan-invalid-file-op", "invalid file op");
        let bundle = ActionBundleDraft {
            id: "bundle-invalid-file-op".to_string(),
            goal: "delete root".to_string(),
            actions: vec![PlannedAction {
                id: "delete-root".to_string(),
                title: "Delete root".to_string(),
                kind: Some("delete".to_string()),
                capability: "fs.delete".to_string(),
                target_ref: None,
                target_path: Some(".".to_string()),
                resource_scope: Vec::new(),
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
            }],
            validation_expectations: Vec::new(),
            review_expectations: Vec::new(),
        };

        let report = DefaultPlanReviewEngine.review_input(PlanReviewInput {
            plan,
            action_bundle: Some(bundle),
        });

        assert_eq!(report.status, PlanReviewStatus::NeedsRevision);
        assert!(report.required_file_operations.is_empty());
        assert!(report
            .findings
            .iter()
            .any(|finding| finding.code == "file_operation_target_invalid"));
    }
}
