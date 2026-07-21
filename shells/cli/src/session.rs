use crate::*;

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
        return Err("usage: /decision <requirement|plan|review> <accept|reject|revise> [run-id] [target-id] [guidance]".to_string());
    };
    let Some(decision) = parts.get(1).cloned() else {
        return Err("usage: /decision <requirement|plan|review> <accept|reject|revise> [run-id] [target-id] [guidance]".to_string());
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
    if !matches!(kind.as_str(), "requirement" | "plan" | "review") {
        return Err("decision kind must be requirement, plan, or review".to_string());
    }
    if !matches!(decision.as_str(), "accept" | "reject" | "revise") {
        return Err("decision must be accept, reject, or revise".to_string());
    }
    let session_id = if let Some(session_id) = host.session_id.clone() {
        session_id
    } else {
        current_session_id(client, &host).await?.ok_or_else(|| {
            "no current session; pass --session <id> or create a session first".to_string()
        })?
    };
    let mut resolved_run_id = run_id;
    let mut resolved_target_id = target_id;
    if resolved_run_id.is_none()
        || (resolved_target_id.is_none() && matches!(kind.as_str(), "requirement" | "plan"))
    {
        let timeline = client
            .agent_timeline(&session_id)
            .await
            .map_err(|error| format!("failed to read timeline for pending decision: {error}"))?;
        let pending = find_pending_session_decision(&timeline, &kind, resolved_run_id.as_deref())
            .ok_or_else(|| {
                let run_hint = resolved_run_id
                    .as_deref()
                    .map(|value| format!(" for run {value}"))
                    .unwrap_or_default();
                format!(
                    "no pending {kind} decision{run_hint} found in current session timeline; pass run-id and target-id explicitly"
                )
            })?;
        if resolved_run_id.is_none() {
            resolved_run_id = Some(pending.run_id);
        }
        if resolved_target_id.is_none() {
            resolved_target_id = pending.target_id;
        }
        println!(
            "decision target: {kind} run={} target={}",
            resolved_run_id.as_deref().unwrap_or("-"),
            resolved_target_id.as_deref().unwrap_or("-")
        );
    }
    let mut request = StartAgentRunRequest::resolve_decision(kind, decision);
    request.run_id = resolved_run_id;
    request.target_id = resolved_target_id;
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
    let mut result = client
        .start_agent_run(session_id, request)
        .await
        .map_err(|error| format!("failed to start shared session run: {error}"))?;
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
    decision: PermissionDecision,
) -> Result<(), String> {
    client
        .resolve_permission(permission_id, decision)
        .await
        .map_err(|error| format!("failed to resolve permission: {error}"))?;
    println!("permission {permission_id}: {}", decision.as_str());
    Ok(())
}
