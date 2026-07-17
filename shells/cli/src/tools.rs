use crate::*;
use deepcode_kernel_abi::*;
use deepcode_kernel_tools::{KernelToolCatalogSnapshot, OperationExecutionMode};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) async fn run_kernel_tool_contract(
    client: &HttpKernelClient,
    tool_id: &str,
    workspace: &str,
    args_file: &str,
    approve_contract: bool,
) -> Result<(), String> {
    let input = read_json_object(Path::new(args_file))?;
    let args = input.get("args").cloned().unwrap_or_else(|| input.clone());
    let content_blocks = decode_content_blocks(
        input
            .get("contentBlocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    )?;
    let result = execute_kernel_tool_contract(
        client,
        tool_id,
        Path::new(workspace),
        args,
        content_blocks,
        approve_contract,
    )
    .await?;
    if result.get("outcome").and_then(Value::as_str) != Some("success") {
        return Err(format!("Kernel tool did not execute: {result}"));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&result)
            .map_err(|error| format!("encode tool result: {error}"))?
    );
    Ok(())
}

pub(crate) async fn verify_kernel_tool_contracts(
    client: &HttpKernelClient,
    workspace: &str,
    cases_path: &str,
    approve_contract: bool,
) -> Result<(), String> {
    let workspace = Path::new(workspace)
        .canonicalize()
        .map_err(|error| format!("canonicalize verify workspace: {error}"))?;
    if !workspace.is_dir() {
        return Err("tools verify workspace must be a directory".to_string());
    }
    let verify_root = workspace.join(format!(".deepcode-verify-{}", unique_cli_id()));
    fs::create_dir(&verify_root)
        .map_err(|error| format!("create isolated verify workspace: {error}"))?;
    let _guard = VerifyWorkspaceGuard(verify_root.clone());
    initialize_verify_git_repository(&verify_root)?;

    let content = fs::read_to_string(cases_path)
        .map_err(|error| format!("read verify cases {cases_path}: {error}"))?;
    let daemon_status = client
        .health()
        .await
        .map_err(|error| format!("read Kernel ToolCatalog for verification: {error}"))?;
    let catalog = daemon_status
        .raw
        .get("toolCatalogSnapshot")
        .cloned()
        .ok_or_else(|| "daemon health is missing toolCatalogSnapshot".to_string())?;
    let mut total = 0usize;
    let mut passed = 0usize;
    let mut results = Vec::new();
    let mut coverage = BTreeMap::<String, BTreeSet<String>>::new();
    for (index, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        total += 1;
        let raw_case: Value = serde_json::from_str(trimmed)
            .map_err(|error| format!("decode verify case line {}: {error}", index + 1))?;
        let expected_outcome = verify_expected_outcome(&raw_case);
        if let Some(tool_id) = raw_case.get("toolId").and_then(Value::as_str) {
            coverage
                .entry(tool_id.to_string())
                .or_default()
                .insert(expected_outcome.clone());
        }
        let template_context = VerifyTemplateContext::new(&verify_root);
        let case = match expand_verify_case(raw_case, &template_context) {
            Ok(case) => case,
            Err(blocked) => {
                let actual_outcome = "blocked";
                let case_passed = expected_outcome == actual_outcome;
                if case_passed {
                    passed += 1;
                }
                results.push(serde_json::json!({
                    "line": index + 1,
                    "toolId": null,
                    "expectedOutcome": expected_outcome,
                    "actualOutcome": actual_outcome,
                    "passed": case_passed,
                    "result": blocked
                }));
                continue;
            }
        };
        prepare_verify_case_resources(&verify_root, &case)?;
        let tool_id = case
            .get("toolId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("verify case line {} requires toolId", index + 1))?;
        let args = case
            .get("args")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let content_blocks = decode_content_blocks(
            case.get("contentBlocks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        )?;
        let case_result = execute_kernel_tool_contract(
            client,
            tool_id,
            &verify_root,
            args,
            content_blocks,
            approve_contract,
        )
        .await;
        let actual_outcome = verify_actual_outcome(&case_result);
        let expected_error = case.get("expectedErrorContains").and_then(Value::as_str);
        let evidence_text = match &case_result {
            Ok(value) => value.to_string(),
            Err(error) => error.clone(),
        };
        let error_matches = expected_error.is_none_or(|needle| evidence_text.contains(needle));
        let case_passed = actual_outcome == expected_outcome && error_matches;
        if case_passed {
            passed += 1;
        }
        results.push(serde_json::json!({
            "line": index + 1,
            "toolId": tool_id,
            "expectedOutcome": expected_outcome,
            "actualOutcome": actual_outcome,
            "expectedErrorContains": expected_error,
            "passed": case_passed,
            "result": case_result.as_ref().ok().map(verify_result_summary),
            "error": case_result.as_ref().err().map(|error| clipped_verify_error(error))
        }));
    }
    let coverage_errors = verify_catalog_case_coverage(&catalog, &coverage)?;
    let coverage_passed = coverage_errors.is_empty();
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "workspace": verify_root,
            "total": total,
            "passed": passed,
            "failed": total.saturating_sub(passed),
            "coveragePassed": coverage_passed,
            "coverageErrors": coverage_errors,
            "results": results
        }))
        .map_err(|error| format!("encode verify result: {error}"))?
    );
    if passed != total || !coverage_passed {
        return Err(format!(
            "tools verify failed: {passed}/{total} cases passed; catalog coverage passed={coverage_passed}"
        ));
    }
    Ok(())
}

pub(crate) fn verify_catalog_case_coverage(
    catalog: &Value,
    coverage: &BTreeMap<String, BTreeSet<String>>,
) -> Result<Vec<String>, String> {
    let catalog: KernelToolCatalogSnapshot = serde_json::from_value(catalog.clone())
        .map_err(|error| format!("decode Kernel ToolCatalog snapshot: {error}"))?;
    let mut errors = Vec::new();
    for tool in catalog.tools {
        let tool_id = tool.tool_id;
        let observed = coverage.get(&tool_id);
        let required = match (tool.execution_mode, tool.provider_visible) {
            (OperationExecutionMode::Blocked, _) => &["blocked"][..],
            (OperationExecutionMode::Execute, true) => &["success", "failure"][..],
            _ => &[][..],
        };
        for outcome in required {
            if !observed.is_some_and(|items| items.contains(*outcome)) {
                errors.push(format!("{tool_id} requires a {outcome} verification case"));
            }
        }
    }
    Ok(errors)
}

async fn execute_kernel_tool_contract(
    client: &HttpKernelClient,
    tool_id: &str,
    workspace: &Path,
    args: Value,
    content_blocks: Vec<KernelContentBlock>,
    approve_contract: bool,
) -> Result<Value, String> {
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("canonicalize tool workspace: {error}"))?;
    if !workspace.is_dir() {
        return Err("tool workspace must be a directory".to_string());
    }
    let suffix = unique_cli_id();
    let session_id = SessionId(format!("cli-tools-session-{suffix}"));
    let run_reply = client
        .kernel_command(KernelCommand::RunCreate {
            request_id: RequestId(format!("cli-tools-run-{suffix}")),
            session_id: Some(session_id.clone()),
            input: UserInput {
                text: format!("CLI verification for {tool_id}"),
                attachments: Vec::new(),
            },
            workspace_binding: Some(WorkspaceBinding {
                workspace_id: Some(format!("cli-workspace-{suffix}")),
                workspace_hash: None,
                open_path: Some(workspace.to_string_lossy().into_owned()),
                active_folder_id: None,
                folder_hash: None,
            }),
            profile_ref: None,
            run_overrides: None,
        })
        .await
        .map_err(|error| format!("RunCreate failed: {error}"))?;
    let (run_id, state_contract) = run_reply
        .events
        .iter()
        .rev()
        .find_map(|event| match event {
            KernelEvent::StateEntered {
                run_id,
                state_contract,
                ..
            } => Some((run_id.clone(), state_contract.clone())),
            _ => None,
        })
        .ok_or_else(|| "RunCreate did not return a Kernel state contract".to_string())?;
    let tool_catalog = state_contract
        .tool_catalog_snapshot
        .ok_or_else(|| "Kernel state contract is missing ToolCatalog snapshot".to_string())?;
    let catalog_version = tool_catalog.catalog_version.clone();
    let catalog_hash = tool_catalog.catalog_hash.clone();
    let tool_snapshot = tool_catalog
        .tools
        .iter()
        .find(|tool| tool.tool_id == tool_id)
        .ok_or_else(|| format!("Kernel ToolCatalog does not register {tool_id}"))?;
    let execution_mode = tool_snapshot.execution_mode;
    let action_id = format!("action-{suffix}");
    let bundle_id = format!("bundle-{suffix}");
    let proposal_id = format!("proposal-{suffix}");
    let plan_id = format!("plan-{suffix}");
    let plan_hash = format!("cli-plan-{suffix}");
    let task_id = format!("task-{suffix}");
    let plan_targets = tool_snapshot.plan_target_source.derive(&args);
    let planning_args = planning_args_from_catalog(tool_snapshot, &args)?;
    let plan_reply = client
        .kernel_command(KernelCommand::PlanAuthorizationSubmit {
            request_id: RequestId(format!("cli-tools-plan-{suffix}")),
            run_id: run_id.clone(),
            session_id: Some(session_id.clone()),
            intent: TaskIntentEnvelope {
                schema_version: TASK_INTENT_SCHEMA_VERSION.to_string(),
                plan_id: plan_id.clone(),
                plan_hash: plan_hash.clone(),
                run_id: run_id.clone(),
                session_id: Some(session_id.clone()),
                workspace_binding_hash: None,
                catalog_version,
                catalog_hash,
                tasks: vec![TaskIntentTask {
                    task_id,
                    tool_id: tool_id.to_string(),
                    targets: plan_targets,
                    depends_on: Vec::new(),
                    args: planning_args,
                }],
            },
        })
        .await
        .map_err(|error| format!("PlanAuthorizationSubmit failed: {error}"))?;
    let authorization_review = plan_reply
        .events
        .into_iter()
        .rev()
        .find_map(|event| match event {
            KernelEvent::PlanAuthorizationReviewed { review, .. } => Some(review),
            _ => None,
        })
        .ok_or_else(|| {
            "PlanAuthorizationSubmit did not return plan_authorization.reviewed".to_string()
        })?;
    if authorization_review.status != PlanAuthorizationStatus::Confirmable {
        if execution_mode == OperationExecutionMode::Blocked {
            return Ok(serde_json::json!({
                "outcome": "blocked",
                "toolId": tool_id,
                "executionMode": execution_mode,
                "authorizationReview": authorization_review
            }));
        }
        return Err(format!(
            "Kernel could not form a confirmable plan authorization: {authorization_review:?}"
        ));
    }
    let authorization_contract = authorization_review.authorization_contract.clone();
    let authorization_contract_id = authorization_contract.id.clone();
    let authorization_contract_hash = authorization_contract.contract_hash.clone();
    let mutation = authorization_contract
        .operations
        .iter()
        .any(|operation| !operation.write_set.is_empty());
    if mutation && !approve_contract {
        return Err(format!(
            "mutation plan authorization requires --approve-contract: {authorization_contract:?}"
        ));
    }
    client
        .kernel_command(KernelCommand::PlanAuthorizationDecisionSubmit {
            request_id: RequestId(format!("cli-tools-plan-decision-{suffix}")),
            run_id: run_id.clone(),
            session_id: Some(session_id.clone()),
            decision: PlanAuthorizationDecisionSubmit {
                decision_id: format!("plan-decision-{suffix}"),
                authorization_contract_id: authorization_contract_id.clone(),
                plan_id: plan_id.clone(),
                plan_hash: plan_hash.clone(),
                contract_hash: authorization_contract_hash,
                decision: PlanAuthorizationDecisionKind::Accept,
            },
        })
        .await
        .map_err(|error| format!("PlanAuthorizationDecisionSubmit failed: {error}"))?;
    let action_bundle = KernelActionBundle {
        version: "1".to_string(),
        id: bundle_id.clone(),
        goal: format!("Execute {tool_id} through the Kernel contract path."),
        requirement_id: None,
        actions: vec![KernelAction {
            action_id,
            tool_id: tool_id.to_string(),
            args,
            description: format!("Run {tool_id} through CLI verification."),
            depends_on: Vec::new(),
        }],
        continuation_expectations: Vec::new(),
        validation_expectations: vec![KernelValidationExpectation {
            id: format!("validation-{suffix}"),
            description: "Kernel records the terminal WorkUnit and ToolCompleted fact.".to_string(),
        }],
        review_expectations: vec![KernelReviewExpectation {
            id: format!("review-{suffix}"),
            description: "ReviewFacts reports the actual Kernel tool result.".to_string(),
        }],
    };
    let proposal_payload = serde_json::to_value(KernelActionProposal {
        action_bundle: action_bundle.clone(),
        content_blocks: content_blocks.clone(),
        authorization_contract_id: Some(authorization_contract_id.clone()),
    })
    .map_err(|error| format!("encode typed action proposal: {error}"))?;
    let proposal_reply = client
        .kernel_command(KernelCommand::ProposalSubmit {
            request_id: RequestId(format!("cli-tools-proposal-{suffix}")),
            run_id: run_id.clone(),
            session_id: Some(session_id.clone()),
            proposal: ProposalEnvelope {
                schema_version: "deepcode.agent.protocol.v4".to_string(),
                proposal_id,
                run_id: run_id.clone(),
                session_id: Some(session_id.clone()),
                source: ProposalEnvelopeSource::System,
                kind: ProposalEnvelopeKind::ActionBundle,
                payload: proposal_payload,
                referenced_resource_packet_refs: Vec::new(),
                referenced_evidence_refs: Vec::new(),
                parser_diagnostics: None,
            },
        })
        .await
        .map_err(|error| format!("ProposalSubmit failed: {error}"))?;
    let report = proposal_reply
        .events
        .into_iter()
        .rev()
        .find_map(|event| match event {
            KernelEvent::ProposalReviewed { report, .. } => Some(report),
            _ => None,
        })
        .ok_or_else(|| "ProposalSubmit did not return proposal.reviewed report".to_string())?;
    let contract = report.execution_contract.clone();
    if contract.status == KernelExecutionContractStatus::Denied {
        if execution_mode == OperationExecutionMode::Blocked {
            return Ok(serde_json::json!({
                "outcome": "blocked",
                "toolId": tool_id,
                "executionMode": execution_mode,
                "proposalReview": report
            }));
        }
        return Err(format!("Kernel denied execution contract: {report:?}"));
    }
    if contract.status != KernelExecutionContractStatus::AuthorizedByPlan {
        return Err(format!(
            "execution contract was not authorized by the accepted plan: {report:?}"
        ));
    }
    let batch_reply = client
        .kernel_command(KernelCommand::ActionBatchSubmit {
            request_id: RequestId(format!("cli-tools-batch-{suffix}")),
            run_id: run_id.clone(),
            session_id: Some(session_id.clone()),
            batch: KernelActionBatch {
                plan_id: bundle_id,
                contract_id: contract.id.clone(),
                contract_hash: contract.contract_hash.clone(),
                action_bundle,
                content_blocks,
            },
        })
        .await
        .map_err(|error| format!("ActionBatchSubmit failed: {error}"))?;
    if batch_reply
        .events
        .iter()
        .any(|event| matches!(event, KernelEvent::PermissionRequested { .. }))
    {
        return Err(format!(
            "Kernel requested additional permission after contract acceptance: {:?}",
            batch_reply.events
        ));
    }
    let facts_reply = client
        .kernel_command(KernelCommand::ReviewFactsGet {
            request_id: RequestId(format!("cli-tools-review-{suffix}")),
            run_id: run_id.clone(),
            session_id: Some(session_id),
        })
        .await
        .map_err(|error| format!("ReviewFactsGet failed: {error}"))?;
    let facts = facts_reply
        .events
        .into_iter()
        .rev()
        .find_map(|event| match event {
            KernelEvent::ReviewFactsProduced { facts, .. } => Some(facts),
            _ => None,
        })
        .ok_or_else(|| "ReviewFactsGet did not return review.facts_produced".to_string())?;
    let failed = !facts.failed_work_units.is_empty();
    let blocked = !facts.blocked_work_units.is_empty();
    let review_ready = facts.batch_review_ready;
    let completed_tool = facts
        .tool_results
        .iter()
        .any(|item| item.tool_id == tool_id && item.ok);
    if failed || blocked || !review_ready || !completed_tool {
        return Err(format!(
            "Kernel tool did not complete successfully: {facts:?}"
        ));
    }
    Ok(serde_json::json!({
        "outcome": "success",
        "runId": run_id.0,
        "contract": contract,
        "batchEvents": batch_reply.events,
        "reviewFacts": facts
    }))
}

fn verify_expected_outcome(case: &Value) -> String {
    case.get("expectedOutcome")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "success" | "failure" | "blocked"))
        .unwrap_or_else(|| {
            if case.get("expectedOk").and_then(Value::as_bool) == Some(false) {
                "failure"
            } else {
                "success"
            }
        })
        .to_string()
}

fn verify_actual_outcome(result: &Result<Value, String>) -> &str {
    match result {
        Ok(value) if value.get("outcome").and_then(Value::as_str) == Some("blocked") => "blocked",
        Ok(_) => "success",
        Err(_) => "failure",
    }
}

fn verify_result_summary(value: &Value) -> Value {
    let facts = value.get("reviewFacts");
    serde_json::json!({
        "outcome": value.get("outcome").cloned().unwrap_or(Value::Null),
        "runId": value.get("runId").cloned().unwrap_or(Value::Null),
        "contractId": value
            .get("contract")
            .and_then(|contract| contract.get("id"))
            .cloned()
            .unwrap_or(Value::Null),
        "authorizationReview": value
            .get("authorizationReview")
            .map(verify_review_summary)
            .unwrap_or(Value::Null),
        "proposalReview": value
            .get("proposalReview")
            .map(verify_review_summary)
            .unwrap_or(Value::Null),
        "batchReviewReady": facts
            .and_then(|facts| facts.get("batchReviewReady"))
            .cloned()
            .unwrap_or(Value::Null),
        "toolResults": facts
            .and_then(|facts| facts.get("toolResults"))
            .and_then(Value::as_array)
            .map(|items| items.iter().map(|item| serde_json::json!({
                "toolId": item.get("toolId").cloned().unwrap_or(Value::Null),
                "ok": item.get("ok").cloned().unwrap_or(Value::Null),
                "factKind": item.get("factKind").cloned().unwrap_or(Value::Null)
            })).collect::<Vec<_>>())
            .unwrap_or_default(),
        "failedWorkUnitCount": facts
            .and_then(|facts| facts.get("failedWorkUnits"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        "blockedWorkUnitCount": facts
            .and_then(|facts| facts.get("blockedWorkUnits"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    })
}

fn verify_review_summary(review: &Value) -> Value {
    let contract = review
        .get("authorizationContract")
        .or_else(|| review.get("executionContract"));
    serde_json::json!({
        "status": review.get("status").cloned().unwrap_or(Value::Null),
        "diagnostics": review
            .get("diagnostics")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(|item| serde_json::json!({
                "code": item.get("code").cloned().unwrap_or(Value::Null),
                "message": item.get("message").cloned().unwrap_or(Value::Null)
            })).collect::<Vec<_>>())
            .unwrap_or_default(),
        "contractId": contract
            .and_then(|contract| contract.get("id"))
            .cloned()
            .unwrap_or(Value::Null),
        "operations": contract
            .and_then(|contract| contract.get("operations"))
            .and_then(Value::as_array)
            .map(|items| items.iter().map(|item| serde_json::json!({
                "operationId": item.get("operationId").cloned().unwrap_or(Value::Null),
                "toolId": item.get("toolId").cloned().unwrap_or(Value::Null),
                "executionMode": item.get("executionMode").cloned().unwrap_or(Value::Null)
            })).collect::<Vec<_>>())
            .unwrap_or_default()
    })
}

fn clipped_verify_error(error: &str) -> String {
    const MAX_CHARS: usize = 1_200;
    if error.chars().count() <= MAX_CHARS {
        return error.to_string();
    }
    let mut clipped = error.chars().take(MAX_CHARS).collect::<String>();
    clipped.push_str("...[clipped]");
    clipped
}

fn planning_args_from_catalog(
    tool: &KernelToolCatalogEntryRef,
    args: &Value,
) -> Result<Value, String> {
    let schema = tool
        .planning_schema
        .as_object()
        .ok_or_else(|| "Kernel ToolCatalog entry is missing planningSchema".to_string())?;
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| "Kernel planningSchema is missing properties".to_string())?;
    let args = args
        .as_object()
        .ok_or_else(|| "Kernel tool args must be an object".to_string())?;
    let mut planning_args = serde_json::Map::new();
    for field in properties.keys() {
        if let Some(value) = args.get(field) {
            planning_args.insert(field.clone(), value.clone());
        }
    }
    Ok(Value::Object(planning_args))
}

fn decode_content_blocks(values: Vec<Value>) -> Result<Vec<KernelContentBlock>, String> {
    serde_json::from_value(Value::Array(values))
        .map_err(|error| format!("decode typed content blocks: {error}"))
}

fn read_json_object(path: &Path) -> Result<Value, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("read JSON {}: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|error| format!("decode JSON {}: {error}", path.display()))?;
    if !value.is_object() {
        return Err(format!("JSON {} must contain an object", path.display()));
    }
    Ok(value)
}

pub(crate) fn unique_cli_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}", std::process::id())
}

pub(crate) async fn bootstrap_kernel(
    api: Option<String>,
    no_auto_start_kernel: bool,
) -> Result<KernelBootstrap, String> {
    KernelBootstrap::connect(KernelBootstrapOptions::new(api).auto_start(!no_auto_start_kernel))
        .await
        .map_err(|error| format!("daemon unavailable: {error}"))
}
