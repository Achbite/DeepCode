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
    let (result, final_text, final_already_streamed) =
        match start_and_wait_for_run(client, &session_id, request, !plain).await? {
            StartedRunOutcome::Settled {
                result,
                final_text,
                final_already_streamed,
            } => (result, final_text, final_already_streamed),
            StartedRunOutcome::ActionRequired(message) => {
                return Ok(CliCommandOutcome::ActionRequired(message));
            }
        };
    if plain {
        println!("{final_text}");
        return Ok(CliCommandOutcome::Completed);
    }
    eprintln!("session: {}", result.run.session_id);
    if !final_already_streamed {
        println!("{final_text}");
    }
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
                "no exact pending {kind} decision{run_hint} is available in Shared Projection v2; unsupported histories are rejected"
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
    let (result, final_text, final_already_streamed) =
        match start_and_wait_for_run(client, &session_id, request, true).await? {
            StartedRunOutcome::Settled {
                result,
                final_text,
                final_already_streamed,
            } => (result, final_text, final_already_streamed),
            StartedRunOutcome::ActionRequired(message) => {
                return Ok(CliCommandOutcome::ActionRequired(message));
            }
        };
    eprintln!("session: {}", result.run.session_id);
    if !final_already_streamed {
        println!("{final_text}");
    }
    Ok(CliCommandOutcome::Completed)
}

enum StartedRunOutcome {
    Settled {
        result: AgentRunResult,
        final_text: String,
        final_already_streamed: bool,
    },
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

async fn wait_for_optional_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => std::future::pending().await,
    }
}

fn bounded_cli_stage_deadline(run_deadline: Option<Instant>, stage_window: Duration) -> Instant {
    let stage_deadline = Instant::now() + stage_window;
    run_deadline
        .map(|deadline| deadline.min(stage_deadline))
        .unwrap_or(stage_deadline)
}

async fn cancel_exact_run_before_cli_exit(
    client: &HttpKernelClient,
    result: &AgentRunResult,
) -> Result<(), String> {
    const CANCEL_REQUEST_WINDOW: Duration = Duration::from_secs(4);
    if result.run.is_terminal() {
        return Ok(());
    }
    let caller_request_id = match new_cli_request_id("cancel-on-exit") {
        Ok(request_id) => request_id,
        Err(error) => {
            return Err(format!(
                "could not create the exact cancellation identity for Host Run {}: {error}",
                result.run.run_id
            ))
        }
    };
    match tokio::time::timeout(
        CANCEL_REQUEST_WINDOW,
        client.cancel_agent_run_by_id(
            &result.run.session_id,
            &result.run.run_id,
            AgentRunCallerRequest::new(caller_request_id),
        ),
    )
    .await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(format!(
            "exact cancellation for Host Run {} failed: {error}",
            result.run.run_id
        )),
        Err(_) => Err(format!(
            "exact cancellation for Host Run {} did not complete within {} ms",
            result.run.run_id,
            CANCEL_REQUEST_WINDOW.as_millis()
        )),
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
    const PROJECTION_BASELINE_WINDOW: Duration = Duration::from_secs(10);
    const RUN_ADMISSION_WINDOW: Duration = Duration::from_secs(15);
    let run_timeout = cli_run_timeout()?;
    let run_started = Instant::now();
    let run_deadline = run_timeout.map(|limit| run_started + limit);
    let baseline_deadline = bounded_cli_stage_deadline(run_deadline, PROJECTION_BASELINE_WINDOW);
    let baseline_budget = baseline_deadline.saturating_duration_since(run_started);
    let mut baseline_request = Box::pin(client.agent_timeline_v2_optional(session_id));
    let baseline = tokio::select! {
        baseline = &mut baseline_request => baseline.map_err(|error| {
            format!("failed to establish typed Shared Projection v2 baseline: {error}")
        })?,
        _ = wait_for_cli_interrupt() => {
            return Err(
                "CLI was interrupted before Session Run admission; the owned Kernel guard will be reclaimed"
                    .to_string(),
            );
        }
        _ = wait_for_optional_deadline(Some(baseline_deadline)) => {
            return Err(format!(
                "Shared Projection baseline exceeded its bounded phase window of {} ms",
                baseline_budget.as_millis()
            ));
        }
    };
    drop(baseline_request);
    let mut live_projection =
        LiveProjectionCursor::from_baseline(baseline.as_ref(), &request, show_progress)?;
    let mut start = Box::pin(client.start_agent_run(session_id, request));
    let admission_started = Instant::now();
    let admission_deadline = bounded_cli_stage_deadline(run_deadline, RUN_ADMISSION_WINDOW);
    let admission_budget = admission_deadline.saturating_duration_since(admission_started);
    let mut refresh = tokio::time::interval(RUN_POLL_INTERVAL);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    refresh.tick().await;
    let mut result = 'start: loop {
        tokio::select! {
            result = &mut start => {
                break 'start result.map_err(|error| {
                    format!("failed to start shared session run: {error}")
                })?;
            }
            _ = wait_for_cli_interrupt() => {
                return Err(
                    "CLI was interrupted before the daemon returned an exact Run identity; the owned Kernel guard will be reclaimed"
                        .to_string(),
                );
            }
            _ = wait_for_optional_deadline(Some(admission_deadline)) => {
                return Err(format!(
                    "shared Session Run admission exceeded its bounded phase window of {} ms before an exact Run identity was available",
                    admission_budget.as_millis()
                ));
            }
            _ = refresh.tick() => {
                let mut projection = Box::pin(client.agent_timeline_v2_optional(session_id));
                tokio::select! {
                    result = &mut start => {
                        break 'start result.map_err(|error| {
                            format!("failed to start shared session run: {error}")
                        })?;
                    }
                    _ = wait_for_cli_interrupt() => {
                        return Err(
                            "CLI was interrupted before the daemon returned an exact Run identity; the owned Kernel guard will be reclaimed"
                                .to_string(),
                        );
                    }
                    _ = wait_for_optional_deadline(Some(admission_deadline)) => {
                        return Err(format!(
                            "shared Session Run admission exceeded its bounded phase window of {} ms before an exact Run identity was available",
                            admission_budget.as_millis()
                        ));
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
                                    _ = wait_for_cli_interrupt() => {
                                        return Err(
                                            "CLI was interrupted before the daemon returned an exact Run identity; the owned Kernel guard will be reclaimed"
                                                .to_string(),
                                        );
                                    }
                                    _ = wait_for_optional_deadline(Some(admission_deadline)) => {
                                        return Err(format!(
                                            "shared Session Run admission exceeded its bounded phase window of {} ms before an exact Run identity was available",
                                            admission_budget.as_millis()
                                        ));
                                    }
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
    let mut binding = Box::pin(bind_live_projection_to_host_result(
        client,
        &result,
        &mut live_projection,
    ));
    let binding_result = tokio::select! {
        binding = &mut binding => binding,
        _ = wait_for_cli_interrupt() => Err(
            "CLI was interrupted while binding the exact typed Run identity".to_string(),
        ),
        _ = wait_for_optional_deadline(run_deadline) => Err(format!(
            "typed Run identity binding exceeded the configured CLI timeout of {} ms",
            run_timeout.map(|limit| limit.as_millis()).unwrap_or_default()
        )),
    };
    drop(binding);
    if let Err(error) = binding_result {
        return match cancel_exact_run_before_cli_exit(client, &result).await {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("{error}; {cleanup}")),
        };
    }
    match wait_for_started_run(
        client,
        &mut result,
        live_projection,
        run_timeout,
        run_deadline,
    )
    .await
    {
        Ok(outcome) => Ok(outcome),
        Err(error) => match cancel_exact_run_before_cli_exit(client, &result).await {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("{error}; {cleanup}")),
        },
    }
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

async fn wait_for_started_run(
    client: &HttpKernelClient,
    result: &mut AgentRunResult,
    mut live_projection: LiveProjectionCursor,
    run_timeout: Option<Duration>,
    run_deadline: Option<Instant>,
) -> Result<StartedRunOutcome, String> {
    let mut projection_stream = if live_projection.bound_run_terminal().is_some() {
        None
    } else {
        reopen_live_projection_stream(client, &result, &live_projection, run_deadline).await?
    };
    let mut maintenance_tick = tokio::time::interval(RUN_POLL_INTERVAL);
    maintenance_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    maintenance_tick.tick().await;
    loop {
        if let Some(projection_status) = live_projection.bound_run_terminal() {
            *result =
                reconcile_host_terminal_after_projection(client, result, projection_status).await?;
            break;
        }
        if let Some(message) = live_projection.bound_action_required(&result.run.run_id) {
            reconcile_host_wait_after_projection(client, &result).await?;
            live_projection.finish_commentary_line()?;
            return Ok(StartedRunOutcome::ActionRequired(message));
        }
        tokio::select! {
            stream_event = next_live_projection_event(&mut projection_stream) => {
                match stream_event {
                    Ok(Some(event)) => {
                        if live_projection.apply_stream_event(&event)? {
                            reconcile_live_projection_snapshot(
                                client,
                                &result.run.session_id,
                                &mut live_projection,
                                run_deadline,
                            )
                            .await?;
                            projection_stream = reopen_live_projection_stream(
                                client,
                                &result,
                                &live_projection,
                                run_deadline,
                            )
                            .await?;
                        }
                    }
                    Ok(None) => {
                        reconcile_live_projection_snapshot(
                            client,
                            &result.run.session_id,
                            &mut live_projection,
                            run_deadline,
                        )
                        .await?;
                        projection_stream = None;
                    }
                    Err(error) => {
                        live_projection.report_refresh_error_once(&error.to_string());
                        reconcile_live_projection_snapshot(
                            client,
                            &result.run.session_id,
                            &mut live_projection,
                            run_deadline,
                        )
                        .await?;
                        projection_stream = None;
                    }
                }
            }
            _ = wait_for_cli_interrupt() => {
                return Err(format!(
                    "shared session run {} was interrupted by the CLI user",
                    result.run.run_id
                ));
            }
            _ = wait_for_optional_deadline(run_deadline) => {
                return Err(format!(
                    "shared session run {} is still {} after {} ms",
                    result.run.run_id,
                    result.run.status,
                    run_timeout.map(|limit| limit.as_millis()).unwrap_or_default()
                ));
            }
            _ = maintenance_tick.tick() => {
                if projection_stream.is_none()
                    && live_projection.bound_run_terminal().is_none()
                {
                    projection_stream = reopen_live_projection_stream(
                        client,
                        &result,
                        &live_projection,
                        run_deadline,
                    )
                    .await?;
                }
            }
        }
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
    let final_already_streamed = live_projection.committed_final_was_streamed(&final_text);
    live_projection.finish_commentary_line()?;
    Ok(StartedRunOutcome::Settled {
        result: result.clone(),
        final_text,
        final_already_streamed,
    })
}

async fn reconcile_live_projection_snapshot(
    client: &HttpKernelClient,
    session_id: &str,
    cursor: &mut LiveProjectionCursor,
    run_deadline: Option<Instant>,
) -> Result<(), String> {
    const SNAPSHOT_RECONCILE_WINDOW: Duration = Duration::from_secs(4);
    let requested_at = Instant::now();
    let stage_deadline = requested_at + SNAPSHOT_RECONCILE_WINDOW;
    let deadline = run_deadline
        .map(|deadline| deadline.min(stage_deadline))
        .unwrap_or(stage_deadline);
    let budget = deadline.saturating_duration_since(requested_at);
    if budget.is_zero() {
        return Err(
            "typed Shared Projection snapshot reconciliation exceeded the configured CLI timeout"
                .to_string(),
        );
    }
    let mut request = Box::pin(client.agent_timeline_v2(session_id));
    let timeline = tokio::select! {
        timeline = &mut request => timeline.map_err(|error| {
            format!("failed to reconcile typed Shared Projection v2 snapshot: {error}")
        })?,
        _ = wait_for_cli_interrupt() => {
            return Err(
                "CLI was interrupted while reconciling the typed Shared Projection snapshot"
                    .to_string(),
            );
        }
        _ = wait_for_optional_deadline(Some(deadline)) => {
            return Err(format!(
                "typed Shared Projection snapshot reconciliation exceeded {} ms",
                budget.as_millis()
            ));
        }
    };
    cursor.observe(&timeline)
}

async fn next_live_projection_event(
    stream: &mut Option<deepcode_kernel_client::AgentTimelineSseStream>,
) -> deepcode_kernel_client::KernelClientResult<
    Option<deepcode_kernel_client::AgentTimelineStreamEvent>,
> {
    match stream {
        Some(stream) => stream.next_event().await,
        None => std::future::pending().await,
    }
}

async fn reopen_live_projection_stream(
    client: &HttpKernelClient,
    result: &AgentRunResult,
    cursor: &LiveProjectionCursor,
    run_deadline: Option<Instant>,
) -> Result<Option<deepcode_kernel_client::AgentTimelineSseStream>, String> {
    const SSE_OPEN_WINDOW: Duration = Duration::from_secs(10);
    if cursor.bound_run_terminal().is_some() {
        return Ok(None);
    }
    let open_started = Instant::now();
    let stage_deadline = open_started + SSE_OPEN_WINDOW;
    let deadline = run_deadline
        .map(|deadline| deadline.min(stage_deadline))
        .unwrap_or(stage_deadline);
    let open_budget = deadline.saturating_duration_since(open_started);
    tokio::select! {
        stream = client.agent_timeline_stream_v2(
            &result.run.session_id,
            Some(cursor.last_revision),
        ) => stream.map(Some).map_err(|error| {
            format!(
                "failed to open typed Shared Projection v2 stream for Host Run {}: {error}",
                result.run.run_id
            )
        }),
        _ = wait_for_cli_interrupt() => Err(format!(
            "CLI was interrupted while opening the typed Shared Projection stream for Host Run {}",
            result.run.run_id
        )),
        _ = wait_for_optional_deadline(Some(deadline)) => Err(format!(
            "opening the typed Shared Projection stream for Host Run {} exceeded {} ms",
            result.run.run_id,
            open_budget.as_millis()
        )),
    }
}

async fn reconcile_host_terminal_after_projection(
    client: &HttpKernelClient,
    current: &AgentRunResult,
    projection_status: AgentTimelineRunStatus,
) -> Result<AgentRunResult, String> {
    const HOST_TERMINAL_RECONCILE_WINDOW: Duration = Duration::from_secs(4);
    let expected = match projection_status {
        AgentTimelineRunStatus::Succeeded => "completed",
        AgentTimelineRunStatus::Failed => "failed",
        AgentTimelineRunStatus::Cancelled => "cancelled",
        _ => {
            return Err(format!(
                "Shared Projection Run is not terminal: {projection_status:?}"
            ))
        }
    };
    let deadline = Instant::now() + HOST_TERMINAL_RECONCILE_WINDOW;
    let mut last_status = current.run.status.clone();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let refreshed = tokio::time::timeout(
            remaining,
            client.get_agent_run(&current.run.session_id, &current.run.run_id),
        )
        .await
        .map_err(|_| {
            format!(
                "timed out reconciling Host Run {} after canonical projection terminal",
                current.run.run_id
            )
        })?
        .map_err(|error| {
            format!(
                "failed to reconcile Host Run {} after canonical projection terminal: {error}",
                current.run.run_id
            )
        })?;
        if refreshed.run.status == expected {
            return Ok(refreshed);
        }
        last_status = refreshed.run.status.clone();
        sleep_until_reconcile_retry(deadline).await;
    }
    Err(format!(
        "canonical projection reached {projection_status:?}, but Host Run {} remained {last_status} after {} ms",
        current.run.run_id,
        HOST_TERMINAL_RECONCILE_WINDOW.as_millis()
    ))
}

async fn reconcile_host_wait_after_projection(
    client: &HttpKernelClient,
    current: &AgentRunResult,
) -> Result<(), String> {
    const HOST_WAIT_RECONCILE_WINDOW: Duration = Duration::from_secs(4);
    let deadline = Instant::now() + HOST_WAIT_RECONCILE_WINDOW;
    let mut last_status = current.run.status.clone();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let mut request = Box::pin(tokio::time::timeout(
            remaining,
            client.get_agent_run(&current.run.session_id, &current.run.run_id),
        ));
        let refreshed = tokio::select! {
            refreshed = &mut request => refreshed
                .map_err(|_| {
                    format!(
                        "timed out reconciling Host Run {} after canonical user-action wait",
                        current.run.run_id
                    )
                })?
                .map_err(|error| {
                    format!(
                        "failed to reconcile Host Run {} after canonical user-action wait: {error}",
                        current.run.run_id
                    )
                })?,
            _ = wait_for_cli_interrupt() => {
                return Err(format!(
                    "CLI was interrupted while reconciling user-action wait for Host Run {}",
                    current.run.run_id
                ));
            }
        };
        if refreshed.run.session_id != current.run.session_id
            || refreshed.run.run_id != current.run.run_id
        {
            return Err(format!(
                "Host wait reconciliation changed identity for Run {}",
                current.run.run_id
            ));
        }
        if refreshed.run.status == "waiting" {
            return Ok(());
        }
        last_status = refreshed.run.status.clone();
        sleep_until_reconcile_retry(deadline).await;
    }
    Err(format!(
        "canonical projection requires user action, but Host Run {} remained {last_status} after {} ms",
        current.run.run_id,
        HOST_WAIT_RECONCILE_WINDOW.as_millis()
    ))
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
    action_required_after_revision: u64,
    ignored_action_interaction_id: Option<String>,
    snapshot: Option<AgentTimelineSnapshot>,
    expectation: LiveProjectionExpectation,
    live_run_id: Option<String>,
    live_turn_id: Option<String>,
    emit_updates: bool,
    block_text: std::collections::HashMap<String, String>,
    emitted_block_text: std::collections::HashMap<String, String>,
    operation_state: std::collections::HashMap<String, String>,
    current_activity: Option<String>,
    commentary_line_open: bool,
    open_text_role: Option<AgentTimelineEntryRole>,
    tty_updates: bool,
    replaceable_line_open: bool,
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
        let ignored_action_interaction_id = match &expectation {
            LiveProjectionExpectation::ExistingRun { .. } => Some(
                snapshot
                    .and_then(|snapshot| snapshot.run_projection.as_ref())
                    .and_then(|projection| projection.wait.0.as_ref())
                    .and_then(|wait| wait.interaction_id.clone())
                    .ok_or_else(|| {
                        "resolveDecision live projection requires the exact baseline interaction identity"
                            .to_string()
                    })?,
            ),
            LiveProjectionExpectation::NewTurn { .. } => None,
        };
        let mut cursor = Self {
            last_revision: snapshot.map(|snapshot| snapshot.revision).unwrap_or(0),
            action_required_after_revision: snapshot.map(|snapshot| snapshot.revision).unwrap_or(0),
            ignored_action_interaction_id,
            snapshot: snapshot.cloned(),
            expectation,
            live_run_id: None,
            live_turn_id: None,
            emit_updates,
            block_text: std::collections::HashMap::new(),
            emitted_block_text: std::collections::HashMap::new(),
            operation_state: std::collections::HashMap::new(),
            current_activity: snapshot
                .and_then(|snapshot| snapshot.run_projection.as_ref())
                .and_then(|projection| projection.current_activity.0.as_ref())
                .map(current_activity_key),
            commentary_line_open: false,
            open_text_role: None,
            tty_updates: emit_updates && io::stderr().is_terminal(),
            replaceable_line_open: false,
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
        if snapshot.revision < self.last_revision {
            return Ok(());
        }
        if snapshot.revision == self.last_revision {
            let Some(current) = self.snapshot.as_ref() else {
                return Ok(());
            };
            let current = serde_json::to_vec(current).map_err(|error| {
                format!("failed to compare current Shared Projection snapshot: {error}")
            })?;
            let incoming = serde_json::to_vec(snapshot).map_err(|error| {
                format!("failed to compare incoming Shared Projection snapshot: {error}")
            })?;
            if current == incoming {
                return Ok(());
            }
            return Err(format!(
                "Shared Projection revision {} has conflicting snapshot content; reconciliation cannot select an authority",
                snapshot.revision
            ));
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
            self.last_revision = snapshot.revision;
            self.snapshot = Some(snapshot.clone());
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
        self.snapshot = Some(snapshot.clone());
        Ok(())
    }

    fn apply_stream_event(
        &mut self,
        event: &deepcode_kernel_client::AgentTimelineStreamEvent,
    ) -> Result<bool, String> {
        match deepcode_kernel_client::reduce_agent_timeline_stream_event(
            self.snapshot.as_ref(),
            event,
        )
        .map_err(|error| error.to_string())?
        {
            deepcode_kernel_client::AgentTimelineStreamReduction::Unchanged => Ok(false),
            deepcode_kernel_client::AgentTimelineStreamReduction::Replace(snapshot) => {
                self.observe(&snapshot)?;
                Ok(false)
            }
            deepcode_kernel_client::AgentTimelineStreamReduction::ReconcileRequired { .. } => {
                Ok(true)
            }
        }
    }

    fn bound_run_terminal(&self) -> Option<AgentTimelineRunStatus> {
        let run = self.snapshot.as_ref()?.run_projection.as_ref()?;
        if self.live_run_id.as_deref() == Some(run.run_id.as_str()) && run.status.is_terminal() {
            Some(run.status)
        } else {
            None
        }
    }

    fn bound_action_required(&self, host_run_id: &str) -> Option<String> {
        if self.last_revision <= self.action_required_after_revision {
            return None;
        }
        let run = self.snapshot.as_ref()?.run_projection.as_ref()?;
        if self.live_run_id.as_deref() != Some(run.run_id.as_str())
            || !matches!(
                run.status,
                AgentTimelineRunStatus::WaitingUser | AgentTimelineRunStatus::Paused
            )
        {
            return None;
        }
        let wait = run.wait.0.as_ref()?;
        if wait.interaction_id.as_deref() == self.ignored_action_interaction_id.as_deref() {
            return None;
        }
        let reason = wait
            .reason
            .as_deref()
            .filter(|reason| !reason.trim().is_empty())
            .unwrap_or("the Session requires an explicit user action");
        Some(format!(
            "shared session run {host_run_id} requires user action: {reason}"
        ))
    }

    fn committed_final_was_streamed(&self, final_text: &str) -> bool {
        let Some(snapshot) = self.snapshot.as_ref() else {
            return false;
        };
        let Some(run) = snapshot.run_projection.as_ref() else {
            return false;
        };
        if self.live_run_id.as_deref() != Some(run.run_id.as_str()) {
            return false;
        }
        let Some(turn_id) = run.turn_id.as_deref() else {
            return false;
        };
        let Some(turn) = snapshot.turns.iter().find(|turn| turn.id == turn_id) else {
            return false;
        };
        let blocks = turn
            .blocks
            .iter()
            .map(|block| (block.id.as_str(), block))
            .collect::<std::collections::HashMap<_, _>>();
        let mut streamed = String::new();
        let mut found_final = false;
        for part in &turn.parts {
            let AgentTimelineTurnPart::Block { block_id } = part else {
                continue;
            };
            let Some(block) = blocks.get(block_id.as_str()) else {
                return false;
            };
            if block.entry_role != AgentTimelineEntryRole::FinalAnswer
                || block.durability != AgentTimelineDurability::Committed
            {
                continue;
            }
            found_final = true;
            let body = timeline_block_body_v2(block);
            if self.emitted_block_text.get(block_id) != Some(&body) {
                return false;
            }
            streamed.push_str(&body);
        }
        found_final && streamed.trim() == final_text.trim()
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
            if matches!(
                block.entry_role,
                AgentTimelineEntryRole::AgentUpdate | AgentTimelineEntryRole::FinalAnswer
            ) {
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
                    if !matches!(
                        block.entry_role,
                        AgentTimelineEntryRole::AgentUpdate | AgentTimelineEntryRole::FinalAnswer
                    ) {
                        continue;
                    }
                    let next = timeline_block_body_v2(block);
                    let previous = self.block_text.get(block_id).cloned().unwrap_or_default();
                    if next.starts_with(&previous) && next.len() > previous.len() {
                        let suffix = &next[previous.len()..];
                        if previous.is_empty()
                            && self.commentary_line_open
                            && !(block.entry_role == AgentTimelineEntryRole::FinalAnswer
                                && self.open_text_role == Some(AgentTimelineEntryRole::FinalAnswer))
                        {
                            self.finish_commentary_line()?;
                        }
                        self.clear_replaceable_line()?;
                        eprint!("{suffix}");
                        io::stderr().flush().map_err(|error| {
                            format!("failed to flush live Session commentary: {error}")
                        })?;
                        self.commentary_line_open = !next.ends_with('\n');
                        self.open_text_role = self.commentary_line_open.then_some(block.entry_role);
                        let emitted_prefix = self
                            .emitted_block_text
                            .get(block_id)
                            .map(String::as_str)
                            .unwrap_or_default();
                        if previous.is_empty() || emitted_prefix == previous.as_str() {
                            self.emitted_block_text
                                .insert(block_id.clone(), next.clone());
                        }
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
                            self.render_replaceable_line(format!(
                                "[work] {name} {}{target}{effect}",
                                work_operation_status(operation.status)
                            ))?;
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
                self.render_replaceable_line(format!(
                    "[status] {}",
                    current_activity_label(activity.code)
                ))?;
            } else {
                self.clear_replaceable_line()?;
            }
            self.current_activity = next;
        }
        Ok(())
    }

    fn report_refresh_error_once(&mut self, error: &str) {
        if self.emit_updates && !self.refresh_error_reported {
            let _ = self.finish_commentary_line();
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
            self.open_text_role = None;
        }
        self.clear_replaceable_line()?;
        Ok(())
    }

    fn render_replaceable_line(&mut self, line: String) -> Result<(), String> {
        if !self.emit_updates {
            return Ok(());
        }
        if self.tty_updates {
            eprint!("\r\x1b[2K{line}");
            io::stderr()
                .flush()
                .map_err(|error| format!("failed to refresh live Session status: {error}"))?;
            self.replaceable_line_open = true;
        } else {
            eprintln!("{line}");
        }
        Ok(())
    }

    fn clear_replaceable_line(&mut self) -> Result<(), String> {
        if self.tty_updates && self.replaceable_line_open {
            eprint!("\r\x1b[2K");
            io::stderr()
                .flush()
                .map_err(|error| format!("failed to clear live Session status: {error}"))?;
            self.replaceable_line_open = false;
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
        if self.tty_updates && self.replaceable_line_open {
            eprint!("\r\x1b[2K");
            let _ = io::stderr().flush();
            self.replaceable_line_open = false;
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
