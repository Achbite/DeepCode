use crate::*;
use serde_json::json;

pub(crate) async fn run_interactive(
    client: HttpKernelClient,
    mut host: SessionHostOptions,
) -> Result<(), String> {
    print_interactive_help(&host);
    let mut line = String::new();
    loop {
        print!("deepcode> ");
        io::stdout()
            .flush()
            .map_err(|error| format!("failed to flush prompt: {error}"))?;
        line.clear();
        let bytes = io::stdin()
            .read_line(&mut line)
            .map_err(|error| format!("failed to read stdin: {error}"))?;
        if bytes == 0 {
            break;
        }
        let input = line.trim();
        if input.is_empty() {
            continue;
        }
        match input {
            "/help" | "help" => print_interactive_help(&host),
            "/quit" | "/exit" | "quit" | "exit" | "q" => break,
            "/status" | "status" => {
                if let Err(error) = print_daemon_status(&client).await {
                    println!("{error}");
                }
            }
            "/sessions" | "sessions" => {
                if let Err(error) = print_sessions(&client, false, &host).await {
                    println!("{error}");
                }
            }
            "/timeline" | "timeline" => {
                if let Err(error) = print_timeline(&client, None, &host).await {
                    println!("{error}");
                }
            }
            "/workspace" | "workspace" => print_workspace_status(&host),
            command if command.starts_with("/workspace ") || command.starts_with("workspace ") => {
                let args = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                update_workspace(&mut host, args);
                print_workspace_status(&host);
            }
            command if command.starts_with("/decision ") || command.starts_with("decision ") => {
                let args = command
                    .split_once(' ')
                    .map(|(_, value)| value.trim())
                    .unwrap_or_default();
                if let Err(error) = run_interactive_decision(&client, args, host.clone()).await {
                    println!("{error}");
                }
            }
            command if command.starts_with('/') => {
                println!("unknown command: {command}");
                println!("type /help to list available commands");
            }
            command => {
                if let Err(error) = ask(&client, command.to_string(), false, host.clone()).await {
                    println!("{error}");
                }
            }
        }
    }
    Ok(())
}

pub(crate) async fn ask(
    client: &HttpKernelClient,
    prompt: String,
    plain: bool,
    host: SessionHostOptions,
) -> Result<(), String> {
    let session_id = session_id_for_turn(client, &host, &prompt).await?;
    let mut request = StartAgentRunRequest::ask(prompt);
    request.host_language = Some(deepcode_kernel_client::terminal_host_language());
    request.workspace_path = workspace_path_for_host(&host);
    request.no_workspace = Some(host.no_workspace);
    let result = start_and_wait_for_run(client, &session_id, request, !plain).await?;
    if plain {
        let mut text = result.run.final_text.clone().unwrap_or_default();
        if text.trim().is_empty() {
            if let Ok(timeline) = client.agent_timeline(&result.run.session_id).await {
                text = extract_plain_text(&timeline).unwrap_or_default();
            }
        }
        if text.trim().is_empty() {
            println!("({})", result.run.status);
        } else {
            println!("{text}");
        }
        return Ok(());
    }
    println!("session: {}", result.run.session_id);
    let timeline = client
        .agent_timeline(&result.run.session_id)
        .await
        .map_err(|error| format!("failed to read timeline: {error}"))?;
    render_timeline(&timeline);
    Ok(())
}

async fn run_interactive_decision(
    client: &HttpKernelClient,
    args: &str,
    host: SessionHostOptions,
) -> Result<(), String> {
    let parts = args
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let Some(kind) = parts.first().cloned() else {
        return Err("usage: /decision <requirement|plan|review|permission> <accept|reject|revise> [run-id] [target-id] [guidance]".to_string());
    };
    let Some(decision) = parts.get(1).cloned() else {
        return Err("usage: /decision <requirement|plan|review|permission> <accept|reject|revise> [run-id] [target-id] [guidance]".to_string());
    };
    let run_id = parts.get(2).cloned();
    let target_id = parts.get(3).cloned();
    let guidance = if parts.len() > 4 {
        Some(parts[4..].join(" "))
    } else {
        None
    };
    resolve_session_decision(client, kind, decision, run_id, target_id, guidance, host).await
}

pub(crate) async fn resolve_session_decision(
    client: &HttpKernelClient,
    kind: String,
    decision: String,
    run_id: Option<String>,
    target_id: Option<String>,
    guidance: Option<String>,
    host: SessionHostOptions,
) -> Result<(), String> {
    if !matches!(
        kind.as_str(),
        "requirement" | "plan" | "review" | "permission"
    ) {
        return Err("decision kind must be requirement, plan, review, or permission".to_string());
    }
    if !matches!(
        (kind.as_str(), decision.as_str()),
        (
            "requirement" | "plan" | "review",
            "accept" | "reject" | "revise"
        ) | ("permission", "accept" | "reject")
    ) {
        return Err(
            "permission decisions must be accept or reject; other decisions may also revise"
                .to_string(),
        );
    }
    if kind == "permission" && guidance.is_some() {
        return Err("permission decisions do not accept free-text guidance".to_string());
    }
    let session_id = if let Some(session_id) = host.session_id.clone() {
        session_id
    } else {
        current_session_id(client, &host).await?.ok_or_else(|| {
            "no current session; pass --session <id> or create a session first".to_string()
        })?
    };
    let timeline = client
        .agent_timeline(&session_id)
        .await
        .map_err(|error| format!("failed to read timeline for pending decision: {error}"))?;
    let pending = find_pending_session_decision(&timeline, &kind, run_id.as_deref()).ok_or_else(
        || {
            let run_hint = run_id
                .as_deref()
                .map(|value| format!(" for run {value}"))
                .unwrap_or_default();
            format!(
                "no exact pending {kind} decision{run_hint} is available in Shared Projection v2; legacy snapshots are read-only"
            )
        },
    )?;
    if target_id
        .as_deref()
        .is_some_and(|expected| expected != pending.target_id)
    {
        return Err(format!(
            "pending {kind} target changed: expected {}, current {}",
            target_id.as_deref().unwrap_or("-"),
            pending.target_id
        ));
    }
    println!(
        "decision target: {kind} run={} target={}",
        pending.run_id, pending.target_id
    );
    let caller_request_id = new_cli_request_id("decision")?;
    if let Ok(goal_receipt) = client.current_session_goal(&session_id).await {
        if let Some(goal_projection) = goal_receipt.projection.as_ref() {
            let goal_pending = goal_projection.get("pendingInteraction");
            let goal_matches = goal_pending
                .and_then(|value| value.get("kind"))
                .and_then(Value::as_str)
                == Some(kind.as_str())
                && goal_pending
                    .and_then(|value| value.get("interactionId"))
                    .and_then(Value::as_str)
                    == Some(pending.interaction_id.as_str())
                && goal_pending
                    .and_then(|value| value.get("interactionRevision"))
                    .and_then(Value::as_str)
                    == Some(pending.interaction_revision.as_str())
                && goal_pending
                    .and_then(|value| value.get("targetId"))
                    .and_then(Value::as_str)
                    == Some(pending.target_id.as_str());
            if goal_matches {
                let goal_id = goal_projection
                    .get("goalId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Goal Projection has no goalId".to_string())?;
                let goal_revision = goal_projection
                    .get("goalRevision")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "Goal Projection has no goalRevision".to_string())?;
                let expected_domain_head = goal_projection
                    .get("sourceDomainHead")
                    .cloned()
                    .ok_or_else(|| "Goal Projection has no sourceDomainHead".to_string())?;
                let receipt = client
                    .resolve_session_goal_interaction(
                        &session_id,
                        goal_id,
                        &pending.interaction_id,
                        ResolveSessionGoalInteractionRequest {
                            caller_request_id,
                            expected_goal_revision: goal_revision,
                            expected_domain_head,
                            interaction_revision: pending.interaction_revision,
                            target_id: pending.target_id,
                            run_id: pending.run_id,
                            decision_kind: kind,
                            decision,
                            guidance,
                            workspace_path: workspace_path_for_host(&host),
                            no_workspace: Some(host.no_workspace),
                            host_language: Some(
                                deepcode_kernel_client::terminal_host_language(),
                            ),
                        },
                    )
                    .await
                    .map_err(|error| {
                        format!("failed to resolve canonical Goal interaction: {error}")
                    })?;
                if let Some(host_run_id) = receipt.host_run_id.as_deref() {
                    let _ = wait_for_existing_run(
                        client,
                        &session_id,
                        host_run_id,
                        true,
                    )
                    .await?;
                }
                let current = client
                    .get_session_goal(&session_id, goal_id)
                    .await
                    .map_err(|error| format!("failed to read Goal after decision: {error}"))?;
                print_goal_receipt(&current);
                return Ok(());
            }
        }
    }
    let mut request = StartAgentRunRequest::resolve_decision(kind, decision);
    request.host_language = Some(deepcode_kernel_client::terminal_host_language());
    request.run_id = Some(pending.run_id);
    request.target_id = Some(pending.target_id);
    request.interaction_id = Some(pending.interaction_id);
    request.interaction_revision = Some(pending.interaction_revision);
    request.review_id = pending.review_id;
    request.decision_request_id = Some(caller_request_id);
    request.guidance = guidance;
    request.workspace_path = workspace_path_for_host(&host);
    request.no_workspace = Some(host.no_workspace);
    let result = start_and_wait_for_run(client, &session_id, request, true).await?;
    println!("session: {}", result.run.session_id);
    let timeline = client
        .agent_timeline(&result.run.session_id)
        .await
        .map_err(|error| format!("failed to read timeline: {error}"))?;
    render_decision_result(&timeline);
    Ok(())
}

pub(crate) async fn start_goal(
    client: &HttpKernelClient,
    objective: String,
    host: SessionHostOptions,
) -> Result<(), String> {
    let session_id = session_id_for_turn(client, &host, &objective).await?;
    let observed = client
        .get_agent_session(&session_id)
        .await
        .map_err(|error| format!("failed to read Session before Goal start: {error}"))?;
    let expected_domain_head = observed
        .domain_state_if_writable()
        .map_err(|error| format!("Goal start requires a writable Session: {error}"))?
        .cloned()
        .and_then(|state| state.get("head").cloned())
        .ok_or_else(|| "Goal start requires a canonical Session domain head".to_string())?;
    let receipt = client
        .start_session_goal(
            &session_id,
            StartSessionGoalRequest {
                caller_request_id: new_cli_request_id("goal-start")?,
                expected_goal_revision: 0,
                expected_domain_head,
                objective,
                workspace_path: workspace_path_for_host(&host),
                no_workspace: Some(host.no_workspace),
                host_language: Some(deepcode_kernel_client::terminal_host_language()),
            },
        )
        .await
        .map_err(|error| format!("failed to start Goal: {error}"))?;
    if let Some(host_run_id) = receipt.host_run_id.as_deref() {
        let _ = wait_for_existing_run(client, &session_id, host_run_id, true).await?;
    }
    let current = client
        .current_session_goal(&session_id)
        .await
        .map_err(|error| format!("failed to read started Goal: {error}"))?;
    print_goal_receipt(&current);
    Ok(())
}

pub(crate) async fn show_goal(
    client: &HttpKernelClient,
    goal_id: Option<String>,
    host: SessionHostOptions,
) -> Result<(), String> {
    let session_id = goal_session_id(client, &host).await?;
    let receipt = match goal_id.as_deref() {
        Some(goal_id) => client.get_session_goal(&session_id, goal_id).await,
        None => client.current_session_goal(&session_id).await,
    }
    .map_err(|error| format!("failed to read Goal: {error}"))?;
    print_goal_receipt(&receipt);
    Ok(())
}

pub(crate) async fn step_goal(
    client: &HttpKernelClient,
    goal_id: Option<String>,
    host: SessionHostOptions,
) -> Result<(), String> {
    let (session_id, goal_id, revision, head) =
        active_goal_mutation_context(client, goal_id, &host).await?;
    let result = client
        .advance_session_goal(
            &session_id,
            &goal_id,
            json!({
                "callerRequestId": new_cli_request_id("goal-step")?,
                "expectedGoalRevision": revision,
                "expectedDomainHead": head,
            }),
        )
        .await
        .map_err(|error| format!("failed to advance Goal: {error}"))?;
    print_goal_value(&result);
    Ok(())
}

pub(crate) async fn run_goal(
    client: &HttpKernelClient,
    goal_id: Option<String>,
    host: SessionHostOptions,
) -> Result<(), String> {
    let mut selected_goal = goal_id;
    loop {
        let (session_id, goal_id, revision, head) =
            active_goal_mutation_context(client, selected_goal.clone(), &host).await?;
        selected_goal = Some(goal_id.clone());
        let result = client
            .advance_session_goal(
                &session_id,
                &goal_id,
                json!({
                    "callerRequestId": new_cli_request_id("goal-run-step")?,
                    "expectedGoalRevision": revision,
                    "expectedDomainHead": head,
                }),
            )
            .await
            .map_err(|error| format!("failed to advance Goal: {error}"))?;
        print_goal_value(&result);
        if result.get("outcome").and_then(Value::as_str) != Some("continue") {
            return Ok(());
        }
    }
}

pub(crate) async fn resume_goal(
    client: &HttpKernelClient,
    goal_id: Option<String>,
    host: SessionHostOptions,
) -> Result<(), String> {
    let (session_id, goal_id, revision, head) =
        active_goal_mutation_context(client, goal_id, &host).await?;
    let result = client
        .resume_session_goal(
            &session_id,
            &goal_id,
            json!({
                "callerRequestId": new_cli_request_id("goal-resume")?,
                "expectedGoalRevision": revision,
                "expectedDomainHead": head,
            }),
        )
        .await
        .map_err(|error| format!("failed to resume Goal: {error}"))?;
    print_goal_value(&result);
    Ok(())
}

pub(crate) async fn cancel_goal(
    client: &HttpKernelClient,
    goal_id: Option<String>,
    host: SessionHostOptions,
) -> Result<(), String> {
    let (session_id, goal_id, revision, head) =
        active_goal_mutation_context(client, goal_id, &host).await?;
    let result = client
        .cancel_session_goal(
            &session_id,
            &goal_id,
            json!({
                "callerRequestId": new_cli_request_id("goal-cancel")?,
                "expectedGoalRevision": revision,
                "expectedDomainHead": head,
            }),
        )
        .await
        .map_err(|error| format!("failed to cancel Goal: {error}"))?;
    print_goal_value(&result);
    Ok(())
}

async fn active_goal_mutation_context(
    client: &HttpKernelClient,
    goal_id: Option<String>,
    host: &SessionHostOptions,
) -> Result<(String, String, u64, Value), String> {
    let session_id = goal_session_id(client, host).await?;
    let receipt = match goal_id.as_deref() {
        Some(goal_id) => client.get_session_goal(&session_id, goal_id).await,
        None => client.current_session_goal(&session_id).await,
    }
    .map_err(|error| format!("failed to read Goal mutation context: {error}"))?;
    let projection = receipt
        .projection
        .ok_or_else(|| "Session has no Goal".to_string())?;
    let goal_id = projection
        .get("goalId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Goal Projection has no goalId".to_string())?
        .to_string();
    let revision = projection
        .get("goalRevision")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Goal Projection has no goalRevision".to_string())?;
    let head = projection
        .get("sourceDomainHead")
        .cloned()
        .ok_or_else(|| "Goal Projection has no sourceDomainHead".to_string())?;
    Ok((session_id, goal_id, revision, head))
}

async fn goal_session_id(
    client: &HttpKernelClient,
    host: &SessionHostOptions,
) -> Result<String, String> {
    if let Some(session_id) = host.session_id.clone() {
        return Ok(session_id);
    }
    current_session_id(client, host).await?.ok_or_else(|| {
        "no current session; pass --session <id> or create a session first".to_string()
    })
}

fn print_goal_receipt(receipt: &deepcode_kernel_client::SessionGoalCommandReceipt) {
    match receipt.projection.as_ref() {
        Some(projection) => print_goal_value(projection),
        None => println!("goal: none"),
    }
}

fn print_goal_value(value: &Value) {
    let projection = value.get("projection").unwrap_or(value);
    if projection.is_null() {
        println!("goal: none");
        return;
    }
    println!(
        "goal: {} r{} {}",
        projection.get("goalId").and_then(Value::as_str).unwrap_or("-"),
        projection
            .get("goalRevision")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        projection
            .get("lifecycle")
            .and_then(Value::as_str)
            .unwrap_or("-")
    );
    if let Some(objective) = projection.get("objective").and_then(Value::as_str) {
        println!("objective: {objective}");
    }
    if let Some(pending) = projection.get("pendingInteraction") {
        println!(
            "waiting: {} interaction={} target={}",
            pending.get("kind").and_then(Value::as_str).unwrap_or("-"),
            pending
                .get("interactionId")
                .and_then(Value::as_str)
                .unwrap_or("-"),
            pending.get("targetId").and_then(Value::as_str).unwrap_or("-")
        );
    }
}

fn new_cli_request_id(prefix: &str) -> Result<String, String> {
    Ok(format!(
        "cli-{prefix}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("system clock is before Unix epoch: {error}"))?
            .as_nanos()
    ))
}

async fn wait_for_existing_run(
    client: &HttpKernelClient,
    session_id: &str,
    run_id: &str,
    show_progress: bool,
) -> Result<AgentRunResult, String> {
    let result = client
        .get_agent_run(session_id, run_id)
        .await
        .map_err(|error| format!("failed to read Goal host run: {error}"))?;
    wait_for_started_run(client, result, show_progress).await
}

async fn session_id_for_turn(
    client: &HttpKernelClient,
    host: &SessionHostOptions,
    title: &str,
) -> Result<String, String> {
    if let Some(session_id) = host.session_id.clone() {
        return Ok(session_id);
    }
    if let Some(session_id) = current_session_id(client, host).await? {
        return Ok(session_id);
    }
    let scope = workspace_scope(host);
    let result = client
        .create_agent_session(CreateAgentSessionRequest {
            initial_mode: Some("plan".to_string()),
            workspace_id: scope.as_ref().map(|scope| scope.workspace_id.clone()),
            workspace_hash: scope.as_ref().map(|scope| scope.workspace_hash.clone()),
            title: Some(title.to_string()),
            ..CreateAgentSessionRequest::default()
        })
        .await
        .map_err(|error| format!("failed to create session: {error}"))?;
    session_id(&result.session)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "created session has no id".to_string())
}

async fn start_and_wait_for_run(
    client: &HttpKernelClient,
    session_id: &str,
    request: StartAgentRunRequest,
    show_progress: bool,
) -> Result<AgentRunResult, String> {
    let result = client
        .start_agent_run(session_id, request)
        .await
        .map_err(|error| format!("failed to start shared session run: {error}"))?;
    wait_for_started_run(client, result, show_progress).await
}

async fn wait_for_started_run(
    client: &HttpKernelClient,
    mut result: AgentRunResult,
    show_progress: bool,
) -> Result<AgentRunResult, String> {
    let run_timeout = cli_run_timeout()?;
    let run_started = Instant::now();
    let mut last_progress_key = run_progress_key(&result.run);
    let mut last_progress_emit = Instant::now();
    if show_progress {
        print_run_progress(&result.run);
    }
    while !result.run.is_terminal() {
        if let Some(limit) = run_timeout {
            if run_started.elapsed() >= limit {
                return Err(format!(
                    "shared session run {} is still {} after {} ms; inspect it with `DeepCode-CLI timeline {}` or set {CLI_RUN_TIMEOUT_ENV}=0 to wait without a CLI-side timeout",
                    result.run.run_id,
                    result.run.status,
                    limit.as_millis(),
                    result.run.session_id
                ));
            }
        }
        tokio::time::sleep(RUN_POLL_INTERVAL).await;
        let session_id = result.run.session_id.clone();
        let run_id = result.run.run_id.clone();
        result = client
            .get_agent_run(&session_id, &run_id)
            .await
            .map_err(|error| format!("failed to read shared session run: {error}"))?;
        if show_progress {
            let progress_key = run_progress_key(&result.run);
            if progress_key != last_progress_key
                || last_progress_emit.elapsed() >= Duration::from_secs(5)
            {
                print_run_progress(&result.run);
                last_progress_key = progress_key;
                last_progress_emit = Instant::now();
            }
        }
    }
    if show_progress && run_progress_key(&result.run) != last_progress_key {
        print_run_progress(&result.run);
    }
    Ok(result)
}

fn cli_run_timeout() -> Result<Option<Duration>, String> {
    let Ok(value) = env::var(CLI_RUN_TIMEOUT_ENV) else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "0" {
        return Ok(None);
    }
    let millis = trimmed
        .parse::<u64>()
        .map_err(|_| format!("{CLI_RUN_TIMEOUT_ENV} must be a positive integer number of milliseconds, or 0 to disable"))?;
    Ok(Some(Duration::from_millis(millis)))
}

fn run_progress_key(run: &deepcode_kernel_client::AgentRunStatus) -> String {
    format!(
        "{}|{}",
        run.status,
        run.message.as_deref().unwrap_or_default()
    )
}

fn print_run_progress(run: &deepcode_kernel_client::AgentRunStatus) {
    if let Some(message) = run
        .message
        .as_deref()
        .filter(|message| !message.trim().is_empty())
    {
        println!("run: {} {} - {}", run.run_id, run.status, message);
    } else {
        println!("run: {} {}", run.run_id, run.status);
    }
}

async fn current_session_id(
    client: &HttpKernelClient,
    host: &SessionHostOptions,
) -> Result<Option<String>, String> {
    let current = client
        .current_agent_session(session_list_request(host, None))
        .await
        .map_err(|error| format!("failed to read current session: {error}"))?;
    Ok(current
        .as_ref()
        .and_then(|result| session_id(&result.session))
        .map(ToOwned::to_owned))
}

fn workspace_path(explicit: Option<String>, no_workspace: bool) -> Option<String> {
    if no_workspace {
        return None;
    }
    if let Some(path) = explicit {
        return Some(path);
    }
    env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

fn workspace_path_for_host(host: &SessionHostOptions) -> Option<String> {
    workspace_path(host.workspace.clone(), host.no_workspace)
}

fn workspace_scope(host: &SessionHostOptions) -> Option<TerminalWorkspaceScope> {
    let path = workspace_path_for_host(host);
    terminal_workspace_scope(path.as_deref())
}

fn session_list_request(
    host: &SessionHostOptions,
    include_archived: Option<bool>,
) -> ListAgentSessionsRequest {
    let scope = workspace_scope(host);
    ListAgentSessionsRequest {
        workspace_id: scope.as_ref().map(|scope| scope.workspace_id.clone()),
        workspace_hash: scope.as_ref().map(|scope| scope.workspace_hash.clone()),
        include_archived,
    }
}

pub(crate) fn workspace_status(host: &SessionHostOptions) -> String {
    if host.no_workspace {
        return "workspace: none (ordinary chat only)".to_string();
    }
    if host.workspace.is_some() {
        return format!(
            "workspace: {}",
            workspace_path_for_host(host).unwrap_or_else(|| "-".to_string())
        );
    }
    format!(
        "workspace: cwd fallback {}",
        workspace_path_for_host(host).unwrap_or_else(|| "-".to_string())
    )
}

fn print_workspace_status(host: &SessionHostOptions) {
    println!("{}", workspace_status(host));
    if let Some(scope) = workspace_scope(host) {
        println!("scope: {} / {}", scope.workspace_id, scope.workspace_hash);
        println!("normalized: {}", scope.normalized_path);
    } else {
        println!("scope: none");
    }
}

fn update_workspace(host: &mut SessionHostOptions, args: &str) {
    match args.trim() {
        "" => {}
        "clear" | "none" | "off" => {
            host.workspace = None;
            host.no_workspace = true;
        }
        "cwd" | "." => {
            host.workspace = env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().to_string());
            host.no_workspace = false;
        }
        path => {
            host.workspace = Some(path.to_string());
            host.no_workspace = false;
        }
    }
}

pub(crate) async fn print_daemon_status(client: &HttpKernelClient) -> Result<(), String> {
    let status = client
        .daemon_status()
        .await
        .map_err(|error| format!("daemon unavailable: {error}"))?;
    println!("daemon: {}", status.service);
    println!("api: {}", client.base_url());
    println!("status: {}", if status.ok { "ok" } else { "degraded" });
    Ok(())
}

pub(crate) async fn print_sessions(
    client: &HttpKernelClient,
    include_archived: bool,
    host: &SessionHostOptions,
) -> Result<(), String> {
    let result = client
        .list_agent_sessions(session_list_request(host, Some(include_archived)))
        .await
        .map_err(|error| format!("failed to list sessions: {error}"))?;
    println!("{}", workspace_status(host));
    println!(
        "current: {}",
        result.current_session_id.as_deref().unwrap_or("-")
    );
    println!(
        "scope: {}",
        result.workspace_scope_key.as_deref().unwrap_or("-")
    );
    for session in result.sessions {
        let id = session_id(&session).unwrap_or("unknown");
        let title = session_title(&session);
        let updated = session
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or("-");
        println!("{id}\t{updated}\t{title}");
    }
    Ok(())
}

pub(crate) async fn create_session(
    client: &HttpKernelClient,
    title: Option<String>,
    host: &SessionHostOptions,
) -> Result<(), String> {
    let scope = workspace_scope(host);
    let result = client
        .create_agent_session(CreateAgentSessionRequest {
            initial_mode: Some("plan".to_string()),
            workspace_id: scope.as_ref().map(|scope| scope.workspace_id.clone()),
            workspace_hash: scope.as_ref().map(|scope| scope.workspace_hash.clone()),
            title,
            ..CreateAgentSessionRequest::default()
        })
        .await
        .map_err(|error| format!("failed to create session: {error}"))?;
    println!(
        "{}\t{}",
        session_id(&result.session).unwrap_or("unknown"),
        session_title(&result.session)
    );
    Ok(())
}

pub(crate) async fn activate_and_print_timeline(
    client: &HttpKernelClient,
    session_id: &str,
) -> Result<(), String> {
    client
        .activate_agent_session(session_id)
        .await
        .map_err(|error| format!("failed to activate session: {error}"))?;
    print_timeline(
        client,
        Some(session_id.to_string()),
        &SessionHostOptions::default(),
    )
    .await
}

pub(crate) async fn rename_session(
    client: &HttpKernelClient,
    target_session_id: &str,
    title: &str,
) -> Result<(), String> {
    let result = client
        .rename_agent_session(target_session_id, title)
        .await
        .map_err(|error| format!("failed to rename session: {error}"))?;
    println!(
        "renamed: {}\t{}",
        session_id(&result.session).unwrap_or(target_session_id),
        session_title(&result.session)
    );
    Ok(())
}

pub(crate) async fn print_or_update_session_profile(
    client: &HttpKernelClient,
    target_session_id: &str,
    profile_id: Option<&str>,
) -> Result<(), String> {
    let result = if let Some(profile_id) = profile_id {
        client
            .update_agent_session_profile(target_session_id, Some(profile_id))
            .await
            .map_err(|error| format!("failed to update session Profile: {error}"))?
    } else {
        client
            .get_agent_session(target_session_id)
            .await
            .map_err(|error| format!("failed to read session Profile: {error}"))?
    };
    let selected = result
        .session
        .get("profileId")
        .and_then(Value::as_str)
        .unwrap_or("unavailable");
    println!("session: {target_session_id}");
    println!("profile: {selected}");
    Ok(())
}

pub(crate) async fn delete_or_archive_session(
    client: &HttpKernelClient,
    session_id: &str,
    archive: bool,
) -> Result<(), String> {
    let result = if archive {
        client.archive_agent_session(session_id, true).await
    } else {
        client.delete_agent_session(session_id).await
    }
    .map_err(|error| format!("failed to update session: {error}"))?;
    println!(
        "current: {}",
        result.current_session_id.as_deref().unwrap_or("-")
    );
    println!("visible sessions: {}", result.sessions.len());
    Ok(())
}

pub(crate) async fn print_timeline(
    client: &HttpKernelClient,
    requested_session_id: Option<String>,
    host: &SessionHostOptions,
) -> Result<(), String> {
    let session_id = match requested_session_id {
        Some(id) => id,
        None => {
            let current = client
                .current_agent_session(session_list_request(host, None))
                .await
                .map_err(|error| format!("failed to read current session: {error}"))?;
            let Some(current) = current else {
                return Err("no current session".to_string());
            };
            session_id(&current.session)
                .ok_or_else(|| "current session has no id".to_string())?
                .to_string()
        }
    };
    let timeline = client
        .agent_timeline(&session_id)
        .await
        .map_err(|error| format!("failed to read timeline: {error}"))?;
    println!("session: {session_id}");
    render_timeline(&timeline);
    Ok(())
}

pub(crate) async fn resolve_permission(
    client: &HttpKernelClient,
    permission_id: &str,
    decision: &str,
    host: SessionHostOptions,
) -> Result<(), String> {
    if permission_id.trim().is_empty() {
        return Err("permission alias requires a non-empty permission id".to_string());
    }
    resolve_session_decision(
        client,
        "permission".to_string(),
        decision.to_string(),
        None,
        Some(permission_id.to_string()),
        None,
        host,
    )
    .await
}
