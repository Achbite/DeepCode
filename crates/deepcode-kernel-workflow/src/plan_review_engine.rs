use crate::{
    AccessScopeDraft, ActionBundleDraft, FileTargetRef, FileTargetRefKind, PlanContract,
    PlannedAction,
};
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
    pub target_resource_kind: String,
    #[serde(default)]
    pub recursive: bool,
    #[serde(default)]
    pub outside_workspace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredAccessScope {
    pub scope_kind: String,
    pub path: String,
    pub capability: String,
    #[serde(default)]
    pub operations: Vec<String>,
    pub reason: String,
    pub dependency_depth: u8,
    #[serde(default)]
    pub source_action_id: Option<String>,
    #[serde(default)]
    pub outside_workspace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionBundle {
    pub id: String,
    pub capability: String,
    pub resource_kind: String,
    #[serde(default)]
    pub resource_path: Option<String>,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub operation_ids: Vec<String>,
    pub risk_level: String,
    pub summary: String,
    pub grant_mode: String,
    pub expires_after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateInterventionRequired {
    pub id: String,
    pub intervention_kind: String,
    pub status: String,
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub permission_bundle_id: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelExecutionOperation {
    pub id: String,
    pub title: String,
    pub operation: String,
    pub capability: String,
    pub target_path: String,
    #[serde(default)]
    pub target_ref: Option<FileTargetRef>,
    pub target_kind: String,
    #[serde(default)]
    pub target_resource_kind: String,
    #[serde(default)]
    pub recursive: bool,
    pub outside_workspace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelExecutionContract {
    pub id: String,
    pub plan_id: String,
    pub status: String,
    pub source: String,
    pub user_approval_required: bool,
    #[serde(default)]
    pub operations: Vec<KernelExecutionOperation>,
    #[serde(default)]
    pub access_scopes: Vec<RequiredAccessScope>,
    #[serde(default)]
    pub permission_bundles: Vec<PermissionBundle>,
    #[serde(default)]
    pub interventions: Vec<GateInterventionRequired>,
    #[serde(default)]
    pub diagnostics: Vec<String>,
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
    pub required_access_scopes: Vec<RequiredAccessScope>,
    #[serde(default)]
    pub permission_bundles: Vec<PermissionBundle>,
    #[serde(default)]
    pub interventions: Vec<GateInterventionRequired>,
    #[serde(default)]
    pub execution_contract: Option<KernelExecutionContract>,
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
            required_access_scopes: Vec::new(),
            permission_bundles: Vec::new(),
            interventions: Vec::new(),
            execution_contract: None,
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
            required_access_scopes: Vec::new(),
            permission_bundles: Vec::new(),
            interventions: Vec::new(),
            execution_contract: None,
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
    let mut required_capabilities = sorted(capabilities.into_iter());

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
    let (required_access_scopes, access_scope_findings) = required_access_scopes_for_input(&input);
    findings.extend(access_scope_findings);
    for scope in &required_access_scopes {
        if !required_capabilities.contains(&scope.capability) {
            required_capabilities.push(scope.capability.clone());
        }
        if permission_gap_capability(&scope.capability)
            && !permission_gaps.contains(&scope.capability)
        {
            permission_gaps.push(scope.capability.clone());
        }
    }
    required_capabilities.sort();
    permission_gaps.sort();

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
    let permission_bundles = permission_bundles_for_review(
        &input.plan.id,
        &permission_gaps,
        &required_file_operations,
        &required_access_scopes,
    );
    let interventions =
        gate_interventions_for_review(&permission_bundles, &hard_floor_hits, &denied_reasons);
    let blocked_reasons = denied_reasons
        .iter()
        .cloned()
        .chain(findings.iter().map(|finding| finding.message.clone()))
        .collect::<Vec<_>>();

    let plan_id = input.plan.id;
    let status_name_text = status_name(&status).to_string();
    let execution_contract = Some(execution_contract_for_review(
        &plan_id,
        &status_name_text,
        &required_file_operations,
        &required_access_scopes,
        &permission_bundles,
        &interventions,
        &blocked_reasons,
        matches!(
            status,
            PlanReviewStatus::AwaitingTemporaryGrant | PlanReviewStatus::AwaitingUserApproval
        ),
    ));

    PlanReviewReport {
        plan_id,
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
        required_access_scopes,
        permission_bundles,
        interventions,
        execution_contract,
        hard_floor_hits,
        denied_reasons,
        blocked_reasons,
        findings,
    }
}

fn execution_contract_for_review(
    plan_id: &str,
    status: &str,
    required_file_operations: &[RequiredFileOperation],
    required_access_scopes: &[RequiredAccessScope],
    permission_bundles: &[PermissionBundle],
    interventions: &[GateInterventionRequired],
    diagnostics: &[String],
    user_approval_required: bool,
) -> KernelExecutionContract {
    KernelExecutionContract {
        id: format!("contract-{}", safe_contract_segment(plan_id)),
        plan_id: plan_id.to_string(),
        status: status.to_string(),
        source: "kernelPlanReview".to_string(),
        user_approval_required,
        operations: required_file_operations
            .iter()
            .map(|operation| KernelExecutionOperation {
                id: operation.action_id.clone(),
                title: format!("{} {}", operation.operation, operation.target_path),
                operation: operation.operation.clone(),
                capability: operation.capability.clone(),
                target_path: operation.target_path.clone(),
                target_ref: operation.target_ref.clone(),
                target_kind: operation.target_kind.clone(),
                target_resource_kind: operation.target_resource_kind.clone(),
                recursive: operation.recursive,
                outside_workspace: operation.outside_workspace,
            })
            .collect(),
        access_scopes: required_access_scopes.to_vec(),
        permission_bundles: permission_bundles.to_vec(),
        interventions: interventions.to_vec(),
        diagnostics: diagnostics.to_vec(),
    }
}

fn permission_bundles_for_review(
    plan_id: &str,
    permission_gaps: &[String],
    required_file_operations: &[RequiredFileOperation],
    required_access_scopes: &[RequiredAccessScope],
) -> Vec<PermissionBundle> {
    let gap_set = permission_gaps.iter().cloned().collect::<BTreeSet<_>>();
    let mut grouped: std::collections::BTreeMap<
        (String, String, Option<String>),
        Vec<&RequiredFileOperation>,
    > = std::collections::BTreeMap::new();
    for operation in required_file_operations {
        if !gap_set.contains(&operation.capability) {
            continue;
        }
        let is_directory = operation.target_resource_kind == "directory";
        let resource_kind = match (operation.outside_workspace, is_directory) {
            (true, true) => "externalDirectory".to_string(),
            (true, false) => "externalFile".to_string(),
            (false, true) => "workspaceDirectory".to_string(),
            (false, false) => "workspaceFile".to_string(),
        };
        let resource_path = if operation.outside_workspace || is_directory {
            Some(operation.target_path.clone())
        } else {
            None
        };
        grouped
            .entry((operation.capability.clone(), resource_kind, resource_path))
            .or_default()
            .push(operation);
    }
    for scope in required_access_scopes {
        if !gap_set.contains(&scope.capability) {
            continue;
        }
        grouped
            .entry((
                scope.capability.clone(),
                if scope.scope_kind == "oneHopDependency" {
                    "workspaceDependency".to_string()
                } else {
                    "workspaceModule".to_string()
                },
                Some(scope.path.clone()),
            ))
            .or_default();
    }

    let mut output = Vec::new();
    for (capability, resource_kind, resource_path) in permission_gaps
        .iter()
        .filter(|capability| {
            !required_file_operations
                .iter()
                .any(|operation| &operation.capability == *capability)
                && !required_access_scopes
                    .iter()
                    .any(|scope| &scope.capability == *capability)
        })
        .map(|capability| {
            (
                capability.clone(),
                resource_kind_for_capability(capability).to_string(),
                None,
            )
        })
    {
        output.push(permission_bundle(
            plan_id,
            &capability,
            &resource_kind,
            resource_path,
            Vec::new(),
            Vec::new(),
        ));
    }

    for ((capability, resource_kind, resource_path), operations) in grouped {
        let targets = operations
            .iter()
            .map(|operation| operation.target_path.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let operation_ids = operations
            .iter()
            .map(|operation| operation.action_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        output.push(permission_bundle(
            plan_id,
            &capability,
            &resource_kind,
            resource_path,
            targets,
            operation_ids,
        ));
    }
    output
}

fn permission_bundle(
    plan_id: &str,
    capability: &str,
    resource_kind: &str,
    resource_path: Option<String>,
    targets: Vec<String>,
    operation_ids: Vec<String>,
) -> PermissionBundle {
    let id = format!(
        "permission-{}-{}-{}",
        safe_contract_segment(plan_id),
        safe_contract_segment(capability),
        resource_path
            .as_deref()
            .map(safe_contract_segment)
            .unwrap_or_else(|| resource_kind.to_string())
    );
    let target_summary = if targets.is_empty() {
        "batch scope".to_string()
    } else {
        targets.join(", ")
    };
    PermissionBundle {
        id,
        capability: capability.to_string(),
        resource_kind: resource_kind.to_string(),
        resource_path,
        targets,
        operation_ids,
        risk_level: risk_level_for_capability(capability).to_string(),
        summary: format!("Kernel gate requires {capability} permission for {target_summary}."),
        grant_mode: "userDecision".to_string(),
        expires_after: "reviewOrTerminalWorkUnit".to_string(),
    }
}

fn gate_interventions_for_review(
    permission_bundles: &[PermissionBundle],
    hard_floor_hits: &[String],
    denied_reasons: &[String],
) -> Vec<GateInterventionRequired> {
    let mut output = permission_bundles
        .iter()
        .map(|bundle| GateInterventionRequired {
            id: format!("gate-{}", bundle.id),
            intervention_kind: "permission".to_string(),
            status: "requiresUserDecision".to_string(),
            capability: Some(bundle.capability.clone()),
            permission_bundle_id: Some(bundle.id.clone()),
            summary: bundle.summary.clone(),
            options: vec![
                "approve".to_string(),
                "reject".to_string(),
                "revise".to_string(),
            ],
        })
        .collect::<Vec<_>>();
    for capability in hard_floor_hits {
        output.push(GateInterventionRequired {
            id: format!("gate-hard-floor-{}", safe_contract_segment(capability)),
            intervention_kind: "hardFloor".to_string(),
            status: "blocked".to_string(),
            capability: Some(capability.clone()),
            permission_bundle_id: None,
            summary: format!("Kernel hard floor blocks capability {capability}."),
            options: vec!["revise".to_string(), "abort".to_string()],
        });
    }
    for (index, reason) in denied_reasons.iter().enumerate() {
        output.push(GateInterventionRequired {
            id: format!("gate-denied-{}", index + 1),
            intervention_kind: "diagnostic".to_string(),
            status: "blocked".to_string(),
            capability: None,
            permission_bundle_id: None,
            summary: reason.clone(),
            options: vec!["revise".to_string(), "abort".to_string()],
        });
    }
    output
}

fn resource_kind_for_capability(capability: &str) -> &'static str {
    match capability {
        "fs.write" | "fs.patch" | "fs.delete" => "workspaceFile",
        "process.exec" => "process",
        "network.egress" | "web.search" => "network",
        "git.write" | "git.push" => "git",
        "browser.control" => "browser",
        "secret.read" => "secret",
        _ => "capability",
    }
}

fn risk_level_for_capability(capability: &str) -> &'static str {
    match capability {
        "fs.delete" | "git.push" | "secret.read" => "high",
        "fs.write" | "fs.patch" | "process.exec" | "git.write" | "network.egress"
        | "browser.control" => "medium",
        _ => "low",
    }
}

fn safe_contract_segment(value: &str) -> String {
    let segment = value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if segment.is_empty() {
        "scope".to_string()
    } else {
        segment
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
                "requires targetPath or resourceScope with a concrete path",
            ));
            continue;
        };
        let target_resource_kind = action_target_resource_kind(action, &raw_target);
        let recursive = action.recursive
            || (target_resource_kind == "directory" && raw_target.trim().ends_with('/'));
        if operation == "delete" && target_resource_kind == "directory" && !recursive {
            findings.push(file_operation_finding(
                "file_operation_target_invalid",
                action,
                "directory delete requires targetKind=\"directory\" and recursive=true",
            ));
            continue;
        }
        match normalize_file_operation_target(&raw_target, target_resource_kind, recursive) {
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
                        target_resource_kind: target.target_resource_kind.to_string(),
                        recursive: target.recursive,
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

fn required_access_scopes_for_input(
    input: &PlanReviewInput,
) -> (Vec<RequiredAccessScope>, Vec<PlanReviewFinding>) {
    let mut scopes = Vec::new();
    let mut findings = Vec::new();
    let mut seen = BTreeSet::new();
    let Some(bundle) = &input.action_bundle else {
        return (scopes, findings);
    };
    for scope in &bundle.access_scopes {
        collect_required_access_scope(scope, None, &mut scopes, &mut findings, &mut seen);
    }
    for action in &bundle.actions {
        for scope in &action.access_scopes {
            collect_required_access_scope(
                scope,
                Some(action),
                &mut scopes,
                &mut findings,
                &mut seen,
            );
        }
    }
    (scopes, findings)
}

fn collect_required_access_scope(
    scope: &AccessScopeDraft,
    action: Option<&PlannedAction>,
    output: &mut Vec<RequiredAccessScope>,
    findings: &mut Vec<PlanReviewFinding>,
    seen: &mut BTreeSet<String>,
) {
    let scope_kind = scope.scope_kind.trim();
    if !matches!(scope_kind, "workspaceModule" | "oneHopDependency") {
        findings.push(access_scope_finding(
            "access_scope_kind_invalid",
            action,
            scope,
            "scopeKind must be workspaceModule or oneHopDependency",
        ));
        return;
    }
    let dependency_depth = scope
        .dependency_depth
        .unwrap_or(if scope_kind == "oneHopDependency" {
            1
        } else {
            0
        });
    if dependency_depth > 1 {
        findings.push(access_scope_finding(
            "access_scope_dependency_depth_invalid",
            action,
            scope,
            "dependencyDepth must be 0 or 1; recursive dependency expansion is not allowed",
        ));
        return;
    }
    let path = match normalize_access_scope_path(&scope.path) {
        Ok(path) => path,
        Err(reason) => {
            findings.push(access_scope_finding(
                "access_scope_path_invalid",
                action,
                scope,
                &reason,
            ));
            return;
        }
    };
    let mut capabilities = scope.capabilities.clone();
    if let Some(capability) = scope
        .capability
        .as_ref()
        .filter(|capability| !capability.trim().is_empty())
    {
        capabilities.push(capability.clone());
    }
    if capabilities.is_empty() {
        capabilities.push("fs.write".to_string());
        capabilities.push("fs.patch".to_string());
    }
    for capability in sorted(capabilities.into_iter()) {
        if !matches!(capability.as_str(), "fs.write" | "fs.patch") {
            findings.push(access_scope_finding(
                "access_scope_capability_invalid",
                action,
                scope,
                "accessScopes may only grant fs.write/fs.patch; use exact file operations for delete/rename or other capabilities",
            ));
            continue;
        }
        let operations = if scope.operations.is_empty() {
            operations_for_access_scope_capability(&capability)
        } else {
            scope.operations.clone()
        };
        let source_action_id = action
            .map(|action| action.id.clone())
            .or_else(|| scope.source_task_id.clone());
        let key = format!("{scope_kind}:{path}:{capability}:{dependency_depth}");
        if !seen.insert(key) {
            continue;
        }
        output.push(RequiredAccessScope {
            scope_kind: scope_kind.to_string(),
            path: path.clone(),
            capability,
            operations,
            reason: scope.reason.clone().unwrap_or_else(|| {
                "Kernel-reviewed workspace module scope requested by plan.".to_string()
            }),
            dependency_depth,
            source_action_id,
            outside_workspace: false,
        });
    }
}

fn normalize_access_scope_path(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() || normalized == "." || normalized == "./" {
        return Err("access scope must not be the workspace root".to_string());
    }
    if normalized.contains('*') {
        return Err("access scope must not contain wildcards".to_string());
    }
    let path = std::path::Path::new(&normalized);
    if path.is_absolute() {
        return Err("access scope must be workspace-relative; outside-workspace paths require exact file operations".to_string());
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => components.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("access scope must not escape the authorized workspace root".to_string())
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("access scope must be workspace-relative".to_string())
            }
        }
    }
    if components.is_empty() {
        return Err("access scope must not be the workspace root".to_string());
    }
    Ok(components.join("/"))
}

fn operations_for_access_scope_capability(capability: &str) -> Vec<String> {
    match capability {
        "fs.write" => vec!["create".to_string(), "write".to_string()],
        "fs.patch" => vec!["patch".to_string()],
        _ => Vec::new(),
    }
}

fn access_scope_finding(
    code: &str,
    action: Option<&PlannedAction>,
    scope: &AccessScopeDraft,
    reason: &str,
) -> PlanReviewFinding {
    let owner = action
        .map(|action| format!("action {}", action.id))
        .or_else(|| scope.source_task_id.as_ref().map(|id| format!("task {id}")))
        .unwrap_or_else(|| "actionBundle".to_string());
    PlanReviewFinding {
        code: code.to_string(),
        message: format!(
            "{owner} access scope {} ({}) {reason}",
            scope.path, scope.scope_kind
        ),
    }
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

fn action_target_resource_kind(action: &PlannedAction, raw_target: &str) -> &'static str {
    let explicit = action
        .target_resource_kind
        .as_deref()
        .or(action.target_kind.as_deref())
        .map(str::trim);
    match explicit {
        Some("directory") | Some("dir") => "directory",
        Some("file") => "file",
        _ if raw_target.trim().ends_with('/') => "directory",
        _ => "file",
    }
}

struct NormalizedFileOperationTarget {
    target_path: String,
    target_ref: FileTargetRef,
    target_kind: &'static str,
    target_resource_kind: &'static str,
    recursive: bool,
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

fn normalize_file_operation_target(
    raw: &str,
    target_resource_kind: &'static str,
    recursive: bool,
) -> Result<NormalizedFileOperationTarget, String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() || normalized == "." || normalized == "./" {
        return Err("target must be a concrete path, not the workspace root".to_string());
    }
    if normalized.contains('*') {
        return Err("target must be a concrete path, not a wildcard".to_string());
    }
    let normalized = if target_resource_kind == "directory" {
        normalized.trim_end_matches('/').to_string()
    } else {
        normalized
    };
    if normalized.is_empty() || normalized == "." || normalized == "./" {
        return Err("target must be a concrete path, not the workspace root".to_string());
    }
    let path = std::path::Path::new(&normalized);
    if path.is_absolute() {
        let mut has_normal_component = false;
        for component in path.components() {
            match component {
                Component::Normal(_) => has_normal_component = true,
                Component::CurDir => {}
                Component::ParentDir => {
                    return Err("absolute target must not contain parent traversal".to_string())
                }
                Component::RootDir | Component::Prefix(_) => {}
            }
        }
        if !has_normal_component {
            return Err("absolute target must be a concrete path, not a root".to_string());
        }
        if target_resource_kind != "directory" && raw.trim().ends_with('/') {
            return Err("file target must not end with a directory separator".to_string());
        }
        return Ok(NormalizedFileOperationTarget {
            target_path: normalized.clone(),
            target_ref: FileTargetRef {
                kind: FileTargetRefKind::AbsolutePath,
                path: normalized,
                root_id: None,
            },
            target_kind: "absolutePath",
            target_resource_kind,
            recursive,
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
        return Err("target must be a concrete path, not the workspace root".to_string());
    }
    let target = components.join("/");
    if target_resource_kind != "directory" && raw.trim().ends_with('/') {
        return Err(
            "directory targets must set targetKind=\"directory\" and recursive=true".to_string(),
        );
    }
    Ok(NormalizedFileOperationTarget {
        target_path: target.clone(),
        target_ref: FileTargetRef {
            kind: FileTargetRefKind::WorkspaceRelative,
            path: target,
            root_id: None,
        },
        target_kind: "workspaceRelative",
        target_resource_kind,
        recursive,
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
    use crate::{AccessScopeDraft, ActionBundleDraft, PlannedAction, ValidationExpectation};

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
                target_kind: None,
                target_resource_kind: None,
                recursive: false,
                resource_scope: vec!["src".to_string()],
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
                access_scopes: Vec::new(),
            }],
            access_scopes: Vec::new(),
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
                    target_kind: None,
                    target_resource_kind: None,
                    recursive: false,
                    resource_scope: Vec::new(),
                    can_parallelize: false,
                    conflict_keys: Vec::new(),
                    purpose: None,
                    access_scopes: Vec::new(),
                },
                PlannedAction {
                    id: "delete-generic".to_string(),
                    title: "Delete generic obsolete file".to_string(),
                    kind: Some("delete".to_string()),
                    capability: "fs.delete".to_string(),
                    target_ref: None,
                    target_path: None,
                    target_kind: None,
                    target_resource_kind: None,
                    recursive: false,
                    resource_scope: vec!["generic-obsolete.tmp".to_string()],
                    can_parallelize: false,
                    conflict_keys: Vec::new(),
                    purpose: None,
                    access_scopes: Vec::new(),
                },
            ],
            access_scopes: Vec::new(),
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
        let contract = report
            .execution_contract
            .as_ref()
            .expect("kernel execution contract");
        assert_eq!(contract.operations.len(), 2);
        assert_eq!(report.permission_bundles.len(), 2);
        assert_eq!(report.interventions.len(), 2);
        assert!(report
            .permission_bundles
            .iter()
            .any(|bundle| bundle.capability == "fs.delete"
                && bundle.resource_kind == "workspaceFile"
                && bundle.targets == vec!["generic-obsolete.tmp"]));
    }

    #[test]
    fn action_bundle_review_reports_required_directory_delete_operation() {
        let mut plan = PlanContract::low_risk_direct("plan-directory-delete", "directory delete");
        plan.completion_criteria[0]
            .evidence_required
            .push("tool fact".to_string());
        let bundle = ActionBundleDraft {
            id: "bundle-directory-delete".to_string(),
            goal: "delete generic directory".to_string(),
            actions: vec![PlannedAction {
                id: "delete-generic-directory".to_string(),
                title: "Delete generic directory".to_string(),
                kind: Some("delete".to_string()),
                capability: "fs.delete".to_string(),
                target_ref: None,
                target_path: Some("generic-directory".to_string()),
                target_kind: None,
                target_resource_kind: Some("directory".to_string()),
                recursive: true,
                resource_scope: Vec::new(),
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
                access_scopes: Vec::new(),
            }],
            access_scopes: Vec::new(),
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
        assert_eq!(operation.operation, "delete");
        assert_eq!(operation.capability, "fs.delete");
        assert_eq!(operation.target_path, "generic-directory");
        assert_eq!(operation.target_kind, "workspaceRelative");
        assert_eq!(operation.target_resource_kind, "directory");
        assert!(operation.recursive);
        assert!(report.permission_bundles.iter().any(|bundle| {
            bundle.capability == "fs.delete"
                && bundle.resource_kind == "workspaceDirectory"
                && bundle.targets == vec!["generic-directory"]
        }));
        let contract = report
            .execution_contract
            .as_ref()
            .expect("kernel execution contract");
        assert_eq!(contract.operations[0].target_resource_kind, "directory");
        assert!(contract.operations[0].recursive);
    }

    #[test]
    fn action_bundle_review_groups_same_capability_file_operations_into_one_permission_bundle() {
        let mut plan = PlanContract::low_risk_direct("plan-delete-many", "delete many files");
        plan.completion_criteria[0]
            .evidence_required
            .push("tool fact".to_string());
        let bundle = ActionBundleDraft {
            id: "bundle-delete-many".to_string(),
            goal: "delete generic files".to_string(),
            actions: (0..7)
                .map(|index| PlannedAction {
                    id: format!("delete-generic-{index}"),
                    title: format!("Delete generic file {index}"),
                    kind: Some("delete".to_string()),
                    capability: "fs.delete".to_string(),
                    target_ref: None,
                    target_path: Some(format!("generic-{index}.tmp")),
                    target_kind: None,
                    target_resource_kind: None,
                    recursive: false,
                    resource_scope: Vec::new(),
                    can_parallelize: false,
                    conflict_keys: Vec::new(),
                    purpose: None,
                    access_scopes: Vec::new(),
                })
                .collect(),
            access_scopes: Vec::new(),
            validation_expectations: Vec::new(),
            review_expectations: Vec::new(),
        };

        let report = DefaultPlanReviewEngine.review_input(PlanReviewInput {
            plan,
            action_bundle: Some(bundle),
        });

        assert_eq!(report.status, PlanReviewStatus::AwaitingTemporaryGrant);
        assert_eq!(report.required_file_operations.len(), 7);
        assert_eq!(report.permission_bundles.len(), 1);
        let bundle = &report.permission_bundles[0];
        assert_eq!(bundle.capability, "fs.delete");
        assert_eq!(bundle.resource_kind, "workspaceFile");
        assert_eq!(bundle.targets.len(), 7);
        assert_eq!(report.interventions.len(), 1);
        let contract = report
            .execution_contract
            .as_ref()
            .expect("kernel execution contract");
        assert_eq!(contract.operations.len(), 7);
        assert_eq!(contract.permission_bundles.len(), 1);
    }

    #[test]
    fn action_bundle_review_reports_workspace_module_access_scopes() {
        let mut plan = PlanContract::low_risk_direct("plan-module-scope", "module scope");
        plan.completion_criteria[0]
            .evidence_required
            .push("tool fact".to_string());
        let bundle = ActionBundleDraft {
            id: "bundle-module-scope".to_string(),
            goal: "edit module files".to_string(),
            actions: Vec::new(),
            access_scopes: vec![
                AccessScopeDraft {
                    scope_kind: "workspaceModule".to_string(),
                    path: "src/module".to_string(),
                    capability: Some("fs.write".to_string()),
                    capabilities: Vec::new(),
                    operations: vec!["create".to_string(), "write".to_string()],
                    reason: Some("module implementation".to_string()),
                    dependency_depth: Some(0),
                    source_task_id: Some("task-module".to_string()),
                },
                AccessScopeDraft {
                    scope_kind: "oneHopDependency".to_string(),
                    path: "src/common".to_string(),
                    capability: Some("fs.patch".to_string()),
                    capabilities: Vec::new(),
                    operations: vec!["patch".to_string()],
                    reason: Some("direct dependency".to_string()),
                    dependency_depth: Some(1),
                    source_task_id: Some("task-module".to_string()),
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
        assert_eq!(report.required_access_scopes.len(), 2);
        assert!(report.required_access_scopes.iter().any(|scope| {
            scope.scope_kind == "workspaceModule"
                && scope.path == "src/module"
                && scope.capability == "fs.write"
                && scope.dependency_depth == 0
        }));
        assert!(report.required_access_scopes.iter().any(|scope| {
            scope.scope_kind == "oneHopDependency"
                && scope.path == "src/common"
                && scope.capability == "fs.patch"
                && scope.dependency_depth == 1
        }));
        assert!(report.permission_bundles.iter().any(|bundle| {
            bundle.resource_kind == "workspaceModule"
                && bundle.resource_path.as_deref() == Some("src/module")
        }));
        let contract = report
            .execution_contract
            .as_ref()
            .expect("kernel execution contract");
        assert_eq!(contract.access_scopes.len(), 2);
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
                target_kind: None,
                target_resource_kind: None,
                recursive: false,
                resource_scope: Vec::new(),
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
                access_scopes: Vec::new(),
            }],
            access_scopes: Vec::new(),
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
                target_kind: None,
                target_resource_kind: None,
                recursive: false,
                resource_scope: Vec::new(),
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
                access_scopes: Vec::new(),
            }],
            access_scopes: Vec::new(),
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
                target_kind: None,
                target_resource_kind: None,
                recursive: false,
                resource_scope: Vec::new(),
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
                access_scopes: Vec::new(),
            }],
            access_scopes: Vec::new(),
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
