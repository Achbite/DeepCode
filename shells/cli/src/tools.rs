use crate::*;
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
    let content_blocks = input
        .get("contentBlocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
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
        let content_blocks = case
            .get("contentBlocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
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
    let tools = catalog
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| "Kernel ToolCatalog snapshot is missing tools".to_string())?;
    let mut errors = Vec::new();
    for tool in tools {
        let tool_id = tool
            .get("toolId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Kernel ToolCatalog entry is missing toolId".to_string())?;
        let execution_mode = tool
            .get("executionMode")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                format!("Kernel ToolCatalog entry {tool_id} is missing executionMode")
            })?;
        let provider_visible = tool
            .get("providerVisible")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let observed = coverage.get(tool_id);
        let required = if execution_mode == "blocked" {
            &["blocked"][..]
        } else if execution_mode == "execute" && provider_visible {
            &["success", "failure"][..]
        } else {
            &[][..]
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
    content_blocks: Vec<Value>,
    approve_contract: bool,
) -> Result<Value, String> {
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("canonicalize tool workspace: {error}"))?;
    if !workspace.is_dir() {
        return Err("tool workspace must be a directory".to_string());
    }
    let suffix = unique_cli_id();
    let session_id = format!("cli-tools-session-{suffix}");
    let request_id = format!("cli-tools-run-{suffix}");
    let run_reply = client
        .kernel_command(serde_json::json!({
            "kind": "runCreate",
            "requestId": request_id,
            "sessionId": session_id,
            "input": { "text": format!("CLI verification for {tool_id}"), "attachments": [] },
            "workspaceBinding": {
                "workspaceId": format!("cli-workspace-{suffix}"),
                "workspaceHash": null,
                "openPath": workspace,
                "activeFolderId": null,
                "folderHash": null
            },
            "profileRef": null,
            "runOverrides": null
        }))
        .await
        .map_err(|error| format!("RunCreate failed: {error}"))?;
    let run_id = event_string(&run_reply, "state.entered", "runId")
        .ok_or_else(|| "RunCreate did not return state.entered runId".to_string())?;
    let state_contract = event_value(&run_reply, "state.entered", "stateContract")
        .ok_or_else(|| "RunCreate did not return a Kernel state contract".to_string())?;
    let tool_catalog = state_contract
        .get("toolCatalogSnapshot")
        .ok_or_else(|| "Kernel state contract is missing ToolCatalog snapshot".to_string())?;
    let catalog_version = tool_catalog
        .get("catalogVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| "Kernel ToolCatalog snapshot is missing catalogVersion".to_string())?;
    let catalog_hash = tool_catalog
        .get("catalogHash")
        .and_then(Value::as_str)
        .ok_or_else(|| "Kernel ToolCatalog snapshot is missing catalogHash".to_string())?;
    let tool_snapshot = tool_catalog
        .get("tools")
        .and_then(Value::as_array)
        .and_then(|tools| {
            tools
                .iter()
                .find(|tool| tool.get("toolId").and_then(Value::as_str) == Some(tool_id))
        })
        .ok_or_else(|| format!("Kernel ToolCatalog does not register {tool_id}"))?;
    let execution_mode = tool_snapshot
        .get("executionMode")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let action_id = format!("action-{suffix}");
    let bundle_id = format!("bundle-{suffix}");
    let proposal_id = format!("proposal-{suffix}");
    let plan_id = format!("plan-{suffix}");
    let plan_hash = format!("cli-plan-{suffix}");
    let task_id = format!("task-{suffix}");
    let plan_targets = plan_targets_for_tool(tool_id, &args);
    let planning_args = planning_args_from_catalog(tool_snapshot, &args)?;
    let plan_reply = client
        .kernel_command(serde_json::json!({
            "kind": "planAuthorizationSubmit",
            "requestId": format!("cli-tools-plan-{suffix}"),
            "runId": run_id,
            "sessionId": session_id,
            "intent": {
                "schemaVersion": "deepcode.kernel.task-intent.v2",
                "planId": plan_id,
                "planHash": plan_hash,
                "runId": run_id,
                "sessionId": session_id,
                "workspaceBindingHash": null,
                "catalogVersion": catalog_version,
                "catalogHash": catalog_hash,
                "tasks": [{
                    "taskId": task_id,
                    "toolId": tool_id,
                    "targets": plan_targets,
                    "dependsOn": [],
                    "args": planning_args
                }]
            }
        }))
        .await
        .map_err(|error| format!("PlanAuthorizationSubmit failed: {error}"))?;
    let authorization_review = event_value(&plan_reply, "plan_authorization.reviewed", "review")
        .ok_or_else(|| {
            "PlanAuthorizationSubmit did not return plan_authorization.reviewed".to_string()
        })?;
    if authorization_review.get("status").and_then(Value::as_str) != Some("confirmable") {
        if execution_mode == "blocked" {
            return Ok(serde_json::json!({
                "outcome": "blocked",
                "toolId": tool_id,
                "executionMode": execution_mode,
                "authorizationReview": authorization_review
            }));
        }
        return Err(format!(
            "Kernel could not form a confirmable plan authorization: {authorization_review}"
        ));
    }
    let authorization_contract = authorization_review
        .get("authorizationContract")
        .ok_or_else(|| "plan authorization review is missing its contract".to_string())?;
    let authorization_contract_id = authorization_contract
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "plan authorization contract is missing id".to_string())?;
    let authorization_contract_hash = authorization_contract
        .get("contractHash")
        .and_then(Value::as_str)
        .ok_or_else(|| "plan authorization contract is missing contractHash".to_string())?;
    let mutation = authorization_contract
        .get("operations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|operation| {
            operation
                .get("writeSet")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
        });
    if mutation && !approve_contract {
        return Err(format!(
            "mutation plan authorization requires --approve-contract: {authorization_contract}"
        ));
    }
    client
        .kernel_command(serde_json::json!({
            "kind": "planAuthorizationDecisionSubmit",
            "requestId": format!("cli-tools-plan-decision-{suffix}"),
            "runId": run_id,
            "sessionId": session_id,
            "decision": {
                "decisionId": format!("plan-decision-{suffix}"),
                "authorizationContractId": authorization_contract_id,
                "planId": plan_id,
                "planHash": plan_hash,
                "contractHash": authorization_contract_hash,
                "decision": "accept"
            }
        }))
        .await
        .map_err(|error| format!("PlanAuthorizationDecisionSubmit failed: {error}"))?;
    let action_bundle = serde_json::json!({
        "id": bundle_id,
        "goal": format!("Execute {tool_id} through the Kernel contract path."),
        "actions": [{
            "actionId": action_id,
            "toolId": tool_id,
            "args": args,
            "description": format!("Run {tool_id} through CLI verification."),
            "dependsOn": []
        }],
        "validationExpectations": [{
            "id": format!("validation-{suffix}"),
            "description": "Kernel records the terminal WorkUnit and ToolCompleted fact."
        }],
        "reviewExpectations": [{
            "id": format!("review-{suffix}"),
            "description": "ReviewFacts reports the actual Kernel tool result."
        }]
    });
    let proposal_reply = client
        .kernel_command(serde_json::json!({
            "kind": "proposalSubmit",
            "requestId": format!("cli-tools-proposal-{suffix}"),
            "runId": run_id,
            "sessionId": session_id,
            "proposal": {
                "schemaVersion": "deepcode.agent.protocol.v4",
                "proposalId": proposal_id,
                "runId": run_id,
                "sessionId": session_id,
                "source": "system",
                "kind": "actionBundle",
                "payload": {
                    "userPlanMarkdown": format!("Execute `{tool_id}` through the Kernel execution contract."),
                    "contentBlocks": content_blocks,
                    "actionBundle": action_bundle,
                    "authorizationContractId": authorization_contract_id
                },
                "referencedResourcePacketRefs": [],
                "referencedEvidenceRefs": [],
                "parserDiagnostics": null
            }
        }))
        .await
        .map_err(|error| format!("ProposalSubmit failed: {error}"))?;
    let report = event_value(&proposal_reply, "proposal.reviewed", "report")
        .ok_or_else(|| "ProposalSubmit did not return proposal.reviewed report".to_string())?;
    let contract = report
        .get("executionContract")
        .cloned()
        .ok_or_else(|| "proposal review is missing executionContract".to_string())?;
    let contract_id = contract
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "execution contract is missing id".to_string())?;
    let contract_status = contract
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("denied");
    if contract_status == "denied" {
        if execution_mode == "blocked" {
            return Ok(serde_json::json!({
                "outcome": "blocked",
                "toolId": tool_id,
                "executionMode": execution_mode,
                "proposalReview": report
            }));
        }
        return Err(format!("Kernel denied execution contract: {report}"));
    }
    if contract_status != "authorizedByPlan" {
        return Err(format!(
            "execution contract was not authorized by the accepted plan: {report}"
        ));
    }
    let contract_hash = contract
        .get("contractHash")
        .and_then(Value::as_str)
        .ok_or_else(|| "execution contract is missing contractHash".to_string())?;
    let batch_reply = client
        .kernel_command(serde_json::json!({
            "kind": "actionBatchSubmit",
            "requestId": format!("cli-tools-batch-{suffix}"),
            "runId": run_id,
            "sessionId": session_id,
            "batch": {
                "planId": bundle_id,
                "contractId": contract_id,
                "contractHash": contract_hash,
                "contentBlocks": content_blocks,
                "actionBundle": action_bundle
            }
        }))
        .await
        .map_err(|error| format!("ActionBatchSubmit failed: {error}"))?;
    if has_event(&batch_reply, "permission.requested") {
        return Err(format!(
            "Kernel requested additional permission after contract acceptance: {batch_reply}"
        ));
    }
    let facts_reply = client
        .kernel_command(serde_json::json!({
            "kind": "reviewFactsGet",
            "requestId": format!("cli-tools-review-{suffix}"),
            "runId": run_id,
            "sessionId": session_id
        }))
        .await
        .map_err(|error| format!("ReviewFactsGet failed: {error}"))?;
    let facts = event_value(&facts_reply, "review.facts_produced", "facts")
        .ok_or_else(|| "ReviewFactsGet did not return review.facts_produced".to_string())?;
    let failed = facts
        .get("failedWorkUnits")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    let blocked = facts
        .get("blockedWorkUnits")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    let review_ready = facts
        .get("batchReviewReady")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let completed_tool = facts
        .get("toolResults")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("toolId").and_then(Value::as_str) == Some(tool_id)
                    && item.get("ok").and_then(Value::as_bool) == Some(true)
            })
        });
    if failed || blocked || !review_ready || !completed_tool {
        return Err(format!(
            "Kernel tool did not complete successfully: {facts}"
        ));
    }
    Ok(serde_json::json!({
        "outcome": "success",
        "runId": run_id,
        "contract": contract,
        "batchEvents": batch_reply.get("events").cloned().unwrap_or(Value::Null),
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

fn plan_targets_for_tool(tool_id: &str, args: &Value) -> Vec<String> {
    let path = args.get("path").and_then(Value::as_str).map(str::to_string);
    match tool_id {
        "fs.rename" => [
            path,
            args.get("destinationPath")
                .and_then(Value::as_str)
                .map(str::to_string),
        ]
        .into_iter()
        .flatten()
        .collect(),
        "fs.glob" | "code.grep" => vec![path.unwrap_or_else(|| ".".to_string())],
        tool if tool.starts_with("fs.") || tool == "document.read" => path.into_iter().collect(),
        "git.status" | "git.diff" => git_targets(args, "workspace"),
        "git.stage" | "git.unstage" | "git.commit" | "git.push" => git_targets(args, "index"),
        "web.fetch" => args
            .get("url")
            .and_then(Value::as_str)
            .map(|value| vec![format!("network:{value}")])
            .unwrap_or_default(),
        "web.search" => args
            .get("query")
            .and_then(Value::as_str)
            .map(|value| vec![format!("network:{value}")])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn planning_args_from_catalog(tool: &Value, args: &Value) -> Result<Value, String> {
    let schema = tool
        .get("planningSchema")
        .and_then(Value::as_object)
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

fn git_targets(args: &Value, fallback: &str) -> Vec<String> {
    let mut paths = args
        .get("paths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|path| format!("git:{path}"))
        .collect::<Vec<_>>();
    if paths.is_empty() {
        if let Some(path) = args.get("path").and_then(Value::as_str) {
            paths.push(format!("git:{path}"));
        }
    }
    if paths.is_empty() {
        paths.push(format!("git:{fallback}"));
    }
    paths
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

fn event_value(reply: &Value, kind: &str, field: &str) -> Option<Value> {
    reply
        .get("events")
        .and_then(Value::as_array)?
        .iter()
        .rev()
        .find(|event| event.get("kind").and_then(Value::as_str) == Some(kind))?
        .get(field)
        .cloned()
}

fn event_string(reply: &Value, kind: &str, field: &str) -> Option<String> {
    event_value(reply, kind, field)?
        .as_str()
        .map(str::to_string)
}

fn has_event(reply: &Value, kind: &str) -> bool {
    reply
        .get("events")
        .and_then(Value::as_array)
        .is_some_and(|events| {
            events
                .iter()
                .any(|event| event.get("kind").and_then(Value::as_str) == Some(kind))
        })
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
