use crate::*;
use std::time::{SystemTime, UNIX_EPOCH};

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
                match run_interactive_decision(&client, args, host.clone()).await {
                    Ok(CliCommandOutcome::Completed) => {}
                    Ok(CliCommandOutcome::ActionRequired(message)) | Err(message) => {
                        println!("{message}");
                    }
                }
            }
            command if command.starts_with('/') => {
                println!("unknown command: {command}");
                println!("type /help to list available commands");
            }
            command => match ask(&client, command.to_string(), false, host.clone()).await {
                Ok(CliCommandOutcome::Completed) => {}
                Ok(CliCommandOutcome::ActionRequired(message)) | Err(message) => {
                    println!("{message}");
                }
            },
        }
    }
    Ok(())
}

pub(crate) async fn ask(
    client: &HttpKernelClient,
    prompt: String,
    plain: bool,
    host: SessionHostOptions,
) -> Result<CliCommandOutcome, String> {
    let session_id = session_id_for_turn(client, &host, &prompt).await?;
    let caller_request_id = new_cli_request_id("ask")?;
    let mut request = StartAgentRunRequest::ask(prompt, caller_request_id);
    request.workspace_path = workspace_path_for_host(&host);
    request.no_workspace = Some(host.no_workspace);
    let (result, final_text) =
        match start_and_wait_for_run(client, &session_id, request, !plain).await? {
            StartedRunOutcome::Settled { result, final_text } => (result, final_text),
            StartedRunOutcome::ActionRequired(message) => {
                return Ok(CliCommandOutcome::ActionRequired(message));
            }
        };
    if plain {
        println!("{final_text}");
        return Ok(CliCommandOutcome::Completed);
    }
    eprintln!("session: {}", result.run.session_id);
    println!("{final_text}");
    Ok(CliCommandOutcome::Completed)
}

async fn run_interactive_decision(
    client: &HttpKernelClient,
    args: &str,
    host: SessionHostOptions,
) -> Result<CliCommandOutcome, String> {
    let parts = args
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let Some(kind) = parts.first().cloned() else {
        return Err("usage: /decision <plan|permission> <accept|reject|revise> [run-id] [target-id] [guidance]".to_string());
    };
    let Some(decision) = parts.get(1).cloned() else {
        return Err("usage: /decision <plan|permission> <accept|reject|revise> [run-id] [target-id] [guidance]".to_string());
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
) -> Result<CliCommandOutcome, String> {
    if !matches!(kind.as_str(), "plan" | "permission") {
        return Err("decision kind must be plan or permission".to_string());
    }
    if !matches!(
        (kind.as_str(), decision.as_str()),
        ("plan", "accept" | "reject" | "revise") | ("permission", "accept" | "reject")
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
        .agent_timeline_v2(&session_id)
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
    eprintln!(
        "decision target: {kind} run={} target={}",
        pending.run_id, pending.target_id
    );
    let caller_request_id = new_cli_request_id("decision")?;
    let mut request = StartAgentRunRequest::resolve_decision(kind, decision, caller_request_id);
    request.run_id = Some(pending.run_id);
    request.target_id = Some(pending.target_id);
    request.guidance = guidance;
    let (result, final_text) =
        match start_and_wait_for_run(client, &session_id, request, true).await? {
            StartedRunOutcome::Settled { result, final_text } => (result, final_text),
            StartedRunOutcome::ActionRequired(message) => {
                return Ok(CliCommandOutcome::ActionRequired(message));
            }
        };
    eprintln!("session: {}", result.run.session_id);
    println!("{final_text}");
    Ok(CliCommandOutcome::Completed)
}

enum StartedRunOutcome {
    Settled {
        result: AgentRunResult,
        final_text: String,
    },
    ActionRequired(String),
}

enum RunPollDisposition {
    Continue,
    Refreshed(AgentRunResult),
    Settled,
    ActionRequired(String),
}

async fn reconcile_terminal_projection(
    client: &HttpKernelClient,
    result: &AgentRunResult,
    cursor: &mut LiveProjectionCursor,
) -> Result<Option<String>, String> {
    const TERMINAL_RECONCILE_WINDOW: Duration = Duration::from_secs(4);
    let deadline = Instant::now() + TERMINAL_RECONCILE_WINDOW;
    let mut last_error = None;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let timeline = match tokio::time::timeout(
            remaining,
            client.agent_timeline_v2(&result.run.session_id),
        )
        .await
        {
            Ok(Ok(timeline)) => timeline,
            Ok(Err(error)) => {
                last_error = Some(format!(
                    "failed to read typed Shared Projection v2 while reconciling Host Run {}: {error}",
                    result.run.run_id
                ));
                sleep_until_reconcile_retry(deadline).await;
                continue;
            }
            Err(_) => {
                last_error = Some(format!(
                    "timed out reconciling terminal Shared Projection v2 for Host Run {}",
                    result.run.run_id
                ));
                break;
            }
        };
        if let Err(error) = cursor.observe(&timeline) {
            last_error = Some(error);
            sleep_until_reconcile_retry(deadline).await;
            continue;
        }
        let Some(projection) = timeline.run_projection.as_ref() else {
            last_error = Some(format!(
                "shared session run {} settled without a canonical runProjection",
                result.run.run_id
            ));
            sleep_until_reconcile_retry(deadline).await;
            continue;
        };
        let Some(bound_run_id) = cursor.live_run_id.as_deref() else {
            last_error = Some(format!(
                "shared session run {} settled before its typed Run identity was published",
                result.run.run_id
            ));
            sleep_until_reconcile_retry(deadline).await;
            continue;
        };
        let expected_status = match result.run.status.as_str() {
            "completed" => AgentTimelineRunStatus::Succeeded,
            "failed" => AgentTimelineRunStatus::Failed,
            "cancelled" => AgentTimelineRunStatus::Cancelled,
            status => {
                return Err(format!(
                    "Host Run {} has unsupported terminal status {status}",
                    result.run.run_id
                ))
            }
        };
        if projection.run_id != bound_run_id {
            last_error = Some(format!(
                "Shared Projection v2 advanced from requested Kernel Run {bound_run_id} to {} before finalAnswer reconciliation",
                projection.run_id
            ));
        } else if projection.status != expected_status {
            last_error = Some(format!(
                "Host Run {} became {} while Kernel Run {} remained {:?}",
                result.run.run_id, result.run.status, projection.run_id, projection.status
            ));
        } else if expected_status != AgentTimelineRunStatus::Succeeded {
            return Ok(None);
        } else if let Some(text) = extract_committed_final_text_v2(&timeline) {
            return Ok(Some(text));
        } else {
            last_error = Some(format!(
                "shared session run {} settled without a committed finalAnswer",
                result.run.run_id
            ));
        }
        sleep_until_reconcile_retry(deadline).await;
    }
    Err(last_error.unwrap_or_else(|| {
        format!(
            "shared session run {} has no reconciled committed finalAnswer",
            result.run.run_id
        )
    }))
}

async fn sleep_until_reconcile_retry(deadline: Instant) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
        tokio::time::sleep(remaining.min(RUN_POLL_INTERVAL)).await;
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
) -> Result<StartedRunOutcome, String> {
    let baseline = client
        .agent_timeline_v2_optional(session_id)
        .await
        .map_err(|error| {
            format!("failed to establish typed Shared Projection v2 baseline: {error}")
        })?;
    let mut live_projection =
        LiveProjectionCursor::from_baseline(baseline.as_ref(), &request, show_progress)?;
    let mut start = Box::pin(client.start_agent_run(session_id, request));
    let mut refresh = tokio::time::interval(RUN_POLL_INTERVAL);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    refresh.tick().await;
    let result = 'start: loop {
        tokio::select! {
            result = &mut start => {
                break 'start result.map_err(|error| {
                    format!("failed to start shared session run: {error}")
                })?;
            }
            _ = refresh.tick() => {
                let mut projection = Box::pin(client.agent_timeline_v2_optional(session_id));
                tokio::select! {
                    result = &mut start => {
                        break 'start result.map_err(|error| {
                            format!("failed to start shared session run: {error}")
                        })?;
                    }
                    timeline = &mut projection => match timeline {
                        Ok(Some(timeline)) => {
                            if let Some(run_id) = timeline
                                .run_projection
                                .as_ref()
                                .map(|projection| projection.run_id.clone())
                            {
                                let mut mapping = Box::pin(
                                    client.get_agent_run(session_id, &run_id)
                                );
                                tokio::select! {
                                    result = &mut start => {
                                        break 'start result.map_err(|error| {
                                            format!("failed to start shared session run: {error}")
                                        })?;
                                    }
                                    mapped = &mut mapping => match mapped {
                                        Ok(mapped) => {
                                            if let Err(error) = live_projection.record_candidate(
                                                timeline,
                                                &mapped,
                                            ) {
                                                live_projection.report_refresh_error_once(&error);
                                            }
                                        }
                                        Err(error) => {
                                            live_projection.report_refresh_error_once(
                                                &format!(
                                                    "typed Run mapping is not available yet: {error}"
                                                ),
                                            );
                                        }
                                    },
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(error) => {
                            live_projection.report_refresh_error_once(&error.to_string());
                        }
                    },
                }
            }
        }
    };
    bind_live_projection_to_host_result(client, &result, &mut live_projection).await?;
    wait_for_started_run(client, result, live_projection).await
}

async fn bind_live_projection_to_host_result(
    client: &HttpKernelClient,
    result: &AgentRunResult,
    cursor: &mut LiveProjectionCursor,
) -> Result<(), String> {
    const IDENTITY_RECONCILE_WINDOW: Duration = Duration::from_secs(4);
    let Some(kernel_run_id) = result.run.kernel_run_id.as_deref() else {
        if result.run.is_terminal() {
            let message = result
                .run
                .message
                .as_deref()
                .filter(|message| !message.trim().is_empty())
                .unwrap_or("the shared Session run did not establish a Kernel Run identity");
            return Err(format!(
                "shared session run {} {} before Kernel Run identity binding: {message}",
                result.run.run_id, result.run.status
            ));
        }
        return Err(format!(
            "Host Run {} has no explicit Kernel Run identity",
            result.run.run_id
        ));
    };
    let deadline = Instant::now() + IDENTITY_RECONCILE_WINDOW;
    loop {
        match cursor.bind_host_result(result) {
            Ok(()) => return Ok(()),
            Err(error) if !cursor.has_host_candidate(&result.run.run_id) => {
                if Instant::now() >= deadline {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            continue;
        }
        let timeline = tokio::time::timeout(
            remaining,
            client.agent_timeline_v2_optional(&result.run.session_id),
        )
        .await
        .map_err(|_| {
            format!(
                "timed out binding Host Run {} to typed Shared Projection v2",
                result.run.run_id
            )
        })?
        .map_err(|error| {
            format!(
                "failed to read typed Shared Projection v2 while binding Host Run {}: {error}",
                result.run.run_id
            )
        })?;
        let Some(timeline) = timeline else {
            sleep_until_reconcile_retry(deadline).await;
            continue;
        };
        let Some(run_id) = timeline
            .run_projection
            .as_ref()
            .map(|projection| projection.run_id.clone())
        else {
            sleep_until_reconcile_retry(deadline).await;
            continue;
        };
        if run_id == kernel_run_id {
            cursor.record_candidate(timeline, result)?;
            continue;
        }
        match tokio::time::timeout(
            deadline.saturating_duration_since(Instant::now()),
            client.get_agent_run(&result.run.session_id, &run_id),
        )
        .await
        {
            Ok(Ok(mapped)) => cursor.record_candidate(timeline, &mapped)?,
            Ok(Err(_)) => sleep_until_reconcile_retry(deadline).await,
            Err(_) => {
                return Err(format!(
                    "timed out mapping typed Kernel Run {run_id} to Host Run {}",
                    result.run.run_id
                ))
            }
        }
    }
}

async fn refresh_live_projection(
    client: &HttpKernelClient,
    session_id: &str,
    cursor: &mut LiveProjectionCursor,
) -> Result<(), String> {
    match client.agent_timeline_v2_optional(session_id).await {
        Ok(Some(timeline)) => cursor.observe(&timeline),
        Ok(None) => Ok(()),
        Err(error) => {
            cursor.report_refresh_error_once(&error.to_string());
            Ok(())
        }
    }
}

async fn wait_for_started_run(
    client: &HttpKernelClient,
    mut result: AgentRunResult,
    mut live_projection: LiveProjectionCursor,
) -> Result<StartedRunOutcome, String> {
    let run_timeout = cli_run_timeout()?;
    let run_started = Instant::now();
    loop {
        match run_poll_disposition(client, &result.run).await? {
            RunPollDisposition::Continue => {}
            RunPollDisposition::Refreshed(refreshed) => {
                result = refreshed;
                continue;
            }
            RunPollDisposition::Settled => break,
            RunPollDisposition::ActionRequired(message) => {
                refresh_live_projection(client, &result.run.session_id, &mut live_projection)
                    .await?;
                live_projection.finish_commentary_line()?;
                return Ok(StartedRunOutcome::ActionRequired(message));
            }
        }
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
        refresh_live_projection(client, &result.run.session_id, &mut live_projection).await?;
        let session_id = result.run.session_id.clone();
        let run_id = result.run.run_id.clone();
        result = client
            .get_agent_run(&session_id, &run_id)
            .await
            .map_err(|error| format!("failed to read shared session run: {error}"))?;
    }
    if matches!(result.run.status.as_str(), "failed" | "cancelled") {
        let _ = reconcile_terminal_projection(client, &result, &mut live_projection).await?;
        live_projection.finish_commentary_line()?;
        let message = result
            .run
            .message
            .as_deref()
            .filter(|message| !message.trim().is_empty())
            .unwrap_or("the shared Session run did not complete successfully");
        return Err(format!(
            "shared session run {} {}: {message}",
            result.run.run_id, result.run.status
        ));
    }
    let final_text = reconcile_terminal_projection(client, &result, &mut live_projection)
        .await?
        .ok_or_else(|| {
            format!(
                "shared session run {} succeeded without a committed finalAnswer",
                result.run.run_id
            )
        })?;
    live_projection.finish_commentary_line()?;
    Ok(StartedRunOutcome::Settled { result, final_text })
}

async fn run_poll_disposition(
    client: &HttpKernelClient,
    run: &deepcode_kernel_client::AgentRunStatus,
) -> Result<RunPollDisposition, String> {
    if run.is_terminal() {
        return Ok(RunPollDisposition::Settled);
    }
    if run.status != "waiting" {
        return Ok(RunPollDisposition::Continue);
    }

    tokio::time::timeout(Duration::from_secs(2), reconcile_waiting_run(client, run))
        .await
        .map_err(|_| {
            format!(
                "timed out reconciling waiting Host Run {} with Shared Projection v2",
                run.run_id
            )
        })?
}

async fn reconcile_waiting_run(
    client: &HttpKernelClient,
    run: &deepcode_kernel_client::AgentRunStatus,
) -> Result<RunPollDisposition, String> {
    const WAIT_RECONCILE_ATTEMPTS: usize = 4;
    let mut mismatch = None;
    for attempt in 0..WAIT_RECONCILE_ATTEMPTS {
        let mut attempt_mismatch = None;
        let timeline = client
            .agent_timeline_v2(&run.session_id)
            .await
            .map_err(|error| {
                format!(
                    "failed to classify waiting run {} from typed Shared Projection v2: {error}",
                    run.run_id
                )
            })?;
        let projection = timeline.run_projection.as_ref().ok_or_else(|| {
            format!(
                "waiting run {} has no canonical runProjection in Shared Projection v2",
                run.run_id
            )
        })?;
        match client
            .get_agent_run(&run.session_id, &projection.run_id)
            .await
        {
            Ok(mapped)
                if mapped.run.session_id == run.session_id && mapped.run.run_id == run.run_id =>
            {
                if mapped.run.status != "waiting"
                    || mapped.run.message != run.message
                    || mapped.run.is_terminal()
                {
                    return Ok(RunPollDisposition::Refreshed(mapped));
                }
            }
            Ok(mapped) => {
                attempt_mismatch = Some(format!(
                    "waiting run binding mismatch: Host Run {} maps from Shared Projection v2 Run {} to session={} hostRun={}",
                    run.run_id, projection.run_id, mapped.run.session_id, mapped.run.run_id
                ));
            }
            Err(mapping_error) => {
                attempt_mismatch = Some(format!(
                    "failed to verify active waiting Host Run {} against Shared Projection v2 Run {}: {mapping_error}",
                    run.run_id, projection.run_id
                ));
            }
        }

        if attempt_mismatch.is_none() {
            match projection.status {
                AgentTimelineRunStatus::WaitingExternal => return Ok(RunPollDisposition::Continue),
                AgentTimelineRunStatus::WaitingUser | AgentTimelineRunStatus::Paused => {
                    let reason = projection
                        .wait
                        .0
                        .as_ref()
                        .and_then(|wait| wait.reason.as_deref())
                        .filter(|reason| !reason.trim().is_empty())
                        .unwrap_or("the Session requires an explicit user action");
                    return Ok(RunPollDisposition::ActionRequired(format!(
                        "shared session run {} requires user action: {reason}",
                        run.run_id
                    )));
                }
                AgentTimelineRunStatus::Active => {
                    attempt_mismatch = Some(format!(
                        "Host Run {} is waiting while Shared Projection v2 Run {} remains active",
                        run.run_id, projection.run_id
                    ));
                }
                AgentTimelineRunStatus::Succeeded
                | AgentTimelineRunStatus::Failed
                | AgentTimelineRunStatus::Cancelled => {
                    attempt_mismatch = Some(format!(
                        "Host Run {} remained waiting after Shared Projection v2 Run {} reached a terminal state",
                        run.run_id, projection.run_id
                    ));
                }
            }
        }

        let refreshed = client
            .get_agent_run(&run.session_id, &run.run_id)
            .await
            .map_err(|error| {
                format!(
                    "failed to refresh exact waiting Host Run {}: {error}",
                    run.run_id
                )
            })?;
        if refreshed.run.status != run.status
            || refreshed.run.message != run.message
            || refreshed.run.is_terminal()
        {
            return Ok(RunPollDisposition::Refreshed(refreshed));
        }
        mismatch = attempt_mismatch;
        if attempt + 1 < WAIT_RECONCILE_ATTEMPTS {
            tokio::time::sleep(RUN_POLL_INTERVAL).await;
        }
    }
    Err(mismatch.unwrap_or_else(|| {
        format!(
            "waiting run {} could not be reconciled with Shared Projection v2",
            run.run_id
        )
    }))
}

enum LiveProjectionExpectation {
    NewTurn {
        baseline_run_id: Option<String>,
        baseline_turn_ids: std::collections::HashSet<String>,
    },
    ExistingRun {
        run_id: String,
        turn_id: String,
    },
}

struct LiveProjectionCursor {
    last_revision: u64,
    expectation: LiveProjectionExpectation,
    live_run_id: Option<String>,
    live_turn_id: Option<String>,
    emit_updates: bool,
    block_text: std::collections::HashMap<String, String>,
    operation_state: std::collections::HashMap<String, String>,
    current_activity: Option<String>,
    commentary_line_open: bool,
    refresh_error_reported: bool,
    candidates: std::collections::HashMap<String, LiveProjectionCandidate>,
}

struct LiveProjectionCandidate {
    host_run_id: String,
    snapshot: AgentTimelineSnapshot,
}

impl LiveProjectionCursor {
    fn from_baseline(
        snapshot: Option<&AgentTimelineSnapshot>,
        request: &StartAgentRunRequest,
        emit_updates: bool,
    ) -> Result<Self, String> {
        let expectation = if request.op == "resolveDecision" {
            let projection = snapshot
                .and_then(|snapshot| snapshot.run_projection.as_ref())
                .ok_or_else(|| {
                    "resolveDecision live projection requires a typed baseline Run".to_string()
                })?;
            let run_id = request.run_id.clone().ok_or_else(|| {
                "resolveDecision live projection requires an exact Run identity".to_string()
            })?;
            if projection.run_id != run_id {
                return Err(format!(
                    "resolveDecision requested Run {run_id}, but the typed baseline is Run {}",
                    projection.run_id
                ));
            }
            LiveProjectionExpectation::ExistingRun {
                run_id,
                turn_id: projection.turn_id.clone().ok_or_else(|| {
                    "resolveDecision live projection requires an exact baseline turn".to_string()
                })?,
            }
        } else {
            LiveProjectionExpectation::NewTurn {
                baseline_run_id: snapshot
                    .and_then(|snapshot| snapshot.run_projection.as_ref())
                    .map(|projection| projection.run_id.clone()),
                baseline_turn_ids: snapshot
                    .map(|snapshot| snapshot.turns.iter().map(|turn| turn.id.clone()).collect())
                    .unwrap_or_default(),
            }
        };
        let mut cursor = Self {
            last_revision: snapshot.map(|snapshot| snapshot.revision).unwrap_or(0),
            expectation,
            live_run_id: None,
            live_turn_id: None,
            emit_updates,
            block_text: std::collections::HashMap::new(),
            operation_state: std::collections::HashMap::new(),
            current_activity: snapshot
                .and_then(|snapshot| snapshot.run_projection.as_ref())
                .and_then(|projection| projection.current_activity.0.as_ref())
                .map(current_activity_key),
            commentary_line_open: false,
            refresh_error_reported: false,
            candidates: std::collections::HashMap::new(),
        };
        if let Some(snapshot) = snapshot {
            for turn in &snapshot.turns {
                cursor.remember_turn(turn);
            }
        }
        Ok(cursor)
    }

    fn record_candidate(
        &mut self,
        snapshot: AgentTimelineSnapshot,
        mapped: &AgentRunResult,
    ) -> Result<(), String> {
        let projection = snapshot.run_projection.as_ref().ok_or_else(|| {
            "typed Shared Projection v2 candidate has no runProjection".to_string()
        })?;
        if snapshot.session_id != mapped.run.session_id {
            return Err(format!(
                "typed Shared Projection v2 candidate session {} mapped to Host session {}",
                snapshot.session_id, mapped.run.session_id
            ));
        }
        self.candidates.insert(
            projection.run_id.clone(),
            LiveProjectionCandidate {
                host_run_id: mapped.run.run_id.clone(),
                snapshot,
            },
        );
        Ok(())
    }

    fn bind_host_result(&mut self, result: &AgentRunResult) -> Result<(), String> {
        let expected_kernel_run_id = result.run.kernel_run_id.as_deref().ok_or_else(|| {
            format!(
                "Host Run {} has no explicit Kernel Run identity",
                result.run.run_id
            )
        })?;
        let matching = self
            .candidates
            .iter()
            .filter(|(run_id, candidate)| {
                run_id.as_str() == expected_kernel_run_id
                    && candidate.host_run_id == result.run.run_id
            })
            .map(|(run_id, _)| run_id.clone())
            .collect::<Vec<_>>();
        if matching.len() != 1 {
            return Err(format!(
                "Host Run {} has {} typed Kernel Run candidates; refusing to infer request identity",
                result.run.run_id,
                matching.len()
            ));
        }
        let run_id = &matching[0];
        let candidate = self.candidates.remove(run_id).ok_or_else(|| {
            "typed Shared Projection v2 candidate disappeared during binding".to_string()
        })?;
        let projection = candidate.snapshot.run_projection.as_ref().ok_or_else(|| {
            "typed Shared Projection v2 candidate has no runProjection".to_string()
        })?;
        if projection.run_id != *run_id
            || !self.accepts_unbound_projection(&candidate.snapshot, projection)?
        {
            return Err(format!(
                "Host Run {} does not match its typed Kernel Run projection",
                result.run.run_id
            ));
        }
        self.live_run_id = Some(projection.run_id.clone());
        self.live_turn_id = projection.turn_id.clone();
        self.observe(&candidate.snapshot)
    }

    fn has_host_candidate(&self, host_run_id: &str) -> bool {
        self.candidates
            .values()
            .any(|candidate| candidate.host_run_id == host_run_id)
    }

    fn observe(&mut self, snapshot: &AgentTimelineSnapshot) -> Result<(), String> {
        if snapshot.revision <= self.last_revision {
            return Ok(());
        }
        let Some(projection) = snapshot.run_projection.as_ref() else {
            return Ok(());
        };
        if let Some(live_run_id) = self.live_run_id.as_deref() {
            if live_run_id != projection.run_id {
                return Err(format!(
                    "typed Shared Projection v2 changed Run identity during one CLI request: {live_run_id} -> {}",
                    projection.run_id
                ));
            }
            if self.live_turn_id.as_deref() != projection.turn_id.as_deref() {
                return Err(format!(
                    "typed Shared Projection v2 changed turn identity during one CLI request: {:?} -> {:?}",
                    self.live_turn_id, projection.turn_id
                ));
            }
        } else if !self.accepts_unbound_projection(snapshot, projection)? {
            return Ok(());
        } else {
            self.live_run_id = Some(projection.run_id.clone());
            self.live_turn_id = projection.turn_id.clone();
        }
        let Some(turn_id) = projection.turn_id.as_deref() else {
            if self.emit_updates {
                self.render_current_activity(projection)?;
            }
            return Ok(());
        };
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == turn_id)
            .ok_or_else(|| {
                format!(
                    "typed Shared Projection v2 Run {} references missing turn {turn_id}",
                    projection.run_id
                )
            })?;
        if self.emit_updates {
            self.render_turn(turn)?;
            self.render_current_activity(projection)?;
        }
        self.last_revision = snapshot.revision;
        Ok(())
    }

    fn accepts_unbound_projection(
        &self,
        snapshot: &AgentTimelineSnapshot,
        projection: &deepcode_kernel_client::AgentTimelineRunProjection,
    ) -> Result<bool, String> {
        match &self.expectation {
            LiveProjectionExpectation::ExistingRun { run_id, turn_id } => Ok(projection.run_id
                == *run_id
                && projection.turn_id.as_deref() == Some(turn_id.as_str())),
            LiveProjectionExpectation::NewTurn {
                baseline_run_id,
                baseline_turn_ids,
            } => {
                let Some(turn_id) = projection.turn_id.as_deref() else {
                    return Ok(false);
                };
                if baseline_run_id.as_deref() == Some(projection.run_id.as_str()) {
                    return Ok(false);
                }
                let new_turn_ids = snapshot
                    .turns
                    .iter()
                    .filter(|turn| !baseline_turn_ids.contains(&turn.id))
                    .map(|turn| turn.id.as_str())
                    .collect::<Vec<_>>();
                if new_turn_ids.is_empty() {
                    return Ok(false);
                }
                if !new_turn_ids.contains(&turn_id) {
                    return Err(
                        "typed Shared Projection v2 mapped Run does not reference a new turn"
                            .to_string(),
                    );
                }
                Ok(true)
            }
        }
    }

    fn remember_turn(&mut self, turn: &deepcode_kernel_client::AgentTimelineTurn) {
        for block in &turn.blocks {
            if block.entry_role == AgentTimelineEntryRole::AgentUpdate {
                self.block_text
                    .insert(block.id.clone(), timeline_block_body_v2(block));
            }
        }
        for segment in &turn.work_segments {
            for operation in &segment.operations {
                self.operation_state.insert(
                    operation.operation_id.clone(),
                    work_operation_key(operation),
                );
            }
        }
    }

    fn render_turn(
        &mut self,
        turn: &deepcode_kernel_client::AgentTimelineTurn,
    ) -> Result<(), String> {
        let blocks = turn
            .blocks
            .iter()
            .map(|block| (block.id.as_str(), block))
            .collect::<std::collections::HashMap<_, _>>();
        let segments = turn
            .work_segments
            .iter()
            .map(|segment| (segment.id.as_str(), segment))
            .collect::<std::collections::HashMap<_, _>>();
        for part in &turn.parts {
            match part {
                AgentTimelineTurnPart::Block { block_id } => {
                    let block = blocks.get(block_id.as_str()).ok_or_else(|| {
                        format!("typed Shared Projection v2 references missing block {block_id}")
                    })?;
                    if block.entry_role != AgentTimelineEntryRole::AgentUpdate {
                        continue;
                    }
                    let next = timeline_block_body_v2(block);
                    let previous = self
                        .block_text
                        .get(block_id)
                        .map(String::as_str)
                        .unwrap_or_default();
                    if next.starts_with(previous) && next.len() > previous.len() {
                        let suffix = &next[previous.len()..];
                        if previous.is_empty() && self.commentary_line_open {
                            self.finish_commentary_line()?;
                        }
                        eprint!("{suffix}");
                        io::stderr().flush().map_err(|error| {
                            format!("failed to flush live Session commentary: {error}")
                        })?;
                        self.commentary_line_open = !next.ends_with('\n');
                    }
                    self.block_text.insert(block_id.clone(), next);
                }
                AgentTimelineTurnPart::WorkSegment { work_segment_id } => {
                    let segment = segments.get(work_segment_id.as_str()).ok_or_else(|| {
                        format!(
                            "typed Shared Projection v2 references missing work segment {work_segment_id}"
                        )
                    })?;
                    for operation in &segment.operations {
                        let next = work_operation_key(operation);
                        if self.operation_state.get(&operation.operation_id) != Some(&next) {
                            self.finish_commentary_line()?;
                            let name = operation
                                .display_name
                                .as_deref()
                                .unwrap_or(operation.tool_id.as_str());
                            let target = operation
                                .targets
                                .as_ref()
                                .filter(|targets| !targets.is_empty())
                                .map(|targets| format!(" — {}", targets.join(", ")))
                                .unwrap_or_default();
                            let effect = operation
                                .effect_summary
                                .as_deref()
                                .filter(|summary| !summary.trim().is_empty())
                                .map(|summary| format!(" — {summary}"))
                                .unwrap_or_default();
                            eprintln!(
                                "[work] {name} {}{target}{effect}",
                                work_operation_status(operation.status)
                            );
                            self.operation_state
                                .insert(operation.operation_id.clone(), next);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn render_current_activity(
        &mut self,
        projection: &deepcode_kernel_client::AgentTimelineRunProjection,
    ) -> Result<(), String> {
        let next = projection
            .current_activity
            .0
            .as_ref()
            .map(current_activity_key);
        if next != self.current_activity {
            if let Some(activity) = projection.current_activity.0.as_ref() {
                self.finish_commentary_line()?;
                eprintln!("[status] {}", current_activity_label(activity.code));
            }
            self.current_activity = next;
        }
        Ok(())
    }

    fn report_refresh_error_once(&mut self, error: &str) {
        if self.emit_updates && !self.refresh_error_reported {
            if self.commentary_line_open {
                eprintln!();
                self.commentary_line_open = false;
            }
            eprintln!("[status] live Shared Projection refresh unavailable: {error}");
            self.refresh_error_reported = true;
        }
    }

    fn finish_commentary_line(&mut self) -> Result<(), String> {
        if self.emit_updates && self.commentary_line_open {
            eprintln!();
            io::stderr()
                .flush()
                .map_err(|error| format!("failed to finish live Session commentary: {error}"))?;
            self.commentary_line_open = false;
        }
        Ok(())
    }
}

impl Drop for LiveProjectionCursor {
    fn drop(&mut self) {
        if self.emit_updates && self.commentary_line_open {
            eprintln!();
            self.commentary_line_open = false;
        }
    }
}

fn timeline_block_body_v2(block: &deepcode_kernel_client::AgentTimelineBlock) -> String {
    block
        .body_markdown
        .as_deref()
        .or_else(|| {
            block
                .localized_content
                .as_ref()
                .and_then(|content| content.text.as_deref())
        })
        .unwrap_or(block.summary.as_str())
        .to_string()
}

fn work_operation_key(operation: &deepcode_kernel_client::AgentTimelineWorkOperation) -> String {
    format!(
        "{:?}|{}|{}|{}",
        operation.status,
        operation.canonical_action.as_deref().unwrap_or_default(),
        operation
            .targets
            .as_ref()
            .map(|targets| targets.join("\u{1f}"))
            .unwrap_or_default(),
        operation.effect_summary.as_deref().unwrap_or_default()
    )
}

fn work_operation_status(
    status: deepcode_kernel_client::AgentTimelineWorkOperationStatus,
) -> &'static str {
    use deepcode_kernel_client::AgentTimelineWorkOperationStatus::*;
    match status {
        Preparing => "preparing",
        Queued => "queued",
        Running => "running",
        AwaitingCapability => "awaiting capability",
        Completed => "completed",
        Denied => "denied",
        Failed => "failed",
        FailedAfterObservedEffect => "failed after observed effect",
        Indeterminate => "indeterminate",
        Cancelled => "cancelled",
        Stale => "stale",
        Unexecuted => "unexecuted",
    }
}

fn current_activity_key(activity: &deepcode_kernel_client::AgentTimelineCurrentActivity) -> String {
    format!(
        "{:?}|{}|{}|{}",
        activity.code,
        activity.summary.as_deref().unwrap_or_default(),
        activity.operation_id.as_deref().unwrap_or_default(),
        activity.work_segment_id.as_deref().unwrap_or_default()
    )
}

fn current_activity_label(
    code: deepcode_kernel_client::AgentTimelineCurrentActivityCode,
) -> &'static str {
    use deepcode_kernel_client::AgentTimelineCurrentActivityCode::*;
    match code {
        SessionAdmitting => "Session is admitting the request",
        ProviderAwaitingFirstByte => "Provider is awaiting the first response byte",
        ProviderReasoning => "Provider is reasoning",
        ProviderComposing => "Provider is composing",
        ResourceResolving => "Workspace resources are resolving",
        KernelExecuting => "Kernel is executing an approved tool",
        SessionValidating => "Session is validating the response",
        SessionPersisting => "Session is persisting durable state",
        RetryBackoff => "Provider retry backoff",
    }
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
        .agent_timeline_v2(&session_id)
        .await
        .map_err(|error| format!("failed to read timeline: {error}"))?;
    println!("session: {session_id}");
    render_timeline(&timeline)?;
    Ok(())
}

pub(crate) async fn resolve_permission(
    client: &HttpKernelClient,
    permission_id: &str,
    decision: &str,
    host: SessionHostOptions,
) -> Result<CliCommandOutcome, String> {
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
