use deepcode_kernel_client::{
    terminal_workspace_scope, AgentRunResult, CreateAgentSessionRequest, HttpKernelClient,
    KernelBootstrap, KernelBootstrapOptions, ListAgentSessionsRequest, PermissionDecision,
    StartAgentRunRequest, TerminalWorkspaceScope,
};
use serde_json::Value;
use std::env;
use std::io::{self, IsTerminal, Write};
use std::time::Duration;

const EXIT_DAEMON_UNAVAILABLE: i32 = 3;
const EXIT_BAD_ARGS: i32 = 4;
const RUN_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[tokio::main]
async fn main() {
    let command = match Command::parse(env::args().skip(1).collect()) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}");
            print_help();
            std::process::exit(EXIT_BAD_ARGS);
        }
    };

    if let Err(error) = run(command).await {
        eprintln!("{error}");
        std::process::exit(EXIT_DAEMON_UNAVAILABLE);
    }
}

async fn run(command: Command) -> Result<(), String> {
    match command {
        Command::Help => {
            print_help();
            Ok(())
        }
        Command::Interactive {
            api,
            no_auto_start_kernel,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            run_interactive(bootstrap.client().clone(), host).await
        }
        Command::DaemonStatus {
            api,
            no_auto_start_kernel,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            print_daemon_status(bootstrap.client()).await
        }
        Command::SessionsList {
            api,
            no_auto_start_kernel,
            include_archived,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            print_sessions(bootstrap.client(), include_archived, &host).await
        }
        Command::SessionsNew {
            api,
            no_auto_start_kernel,
            title,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            create_session(bootstrap.client(), title, &host).await
        }
        Command::SessionsResume {
            api,
            no_auto_start_kernel,
            session_id,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            activate_and_print_timeline(bootstrap.client(), &session_id).await
        }
        Command::SessionsRename {
            api,
            no_auto_start_kernel,
            session_id,
            title,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            rename_session(bootstrap.client(), &session_id, &title).await
        }
        Command::SessionsDelete {
            api,
            no_auto_start_kernel,
            session_id,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            delete_or_archive_session(bootstrap.client(), &session_id, false).await
        }
        Command::SessionsArchive {
            api,
            no_auto_start_kernel,
            session_id,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            delete_or_archive_session(bootstrap.client(), &session_id, true).await
        }
        Command::Timeline {
            api,
            no_auto_start_kernel,
            session_id,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            print_timeline(bootstrap.client(), session_id, &host).await
        }
        Command::Permission {
            api,
            no_auto_start_kernel,
            permission_id,
            decision,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            resolve_permission(bootstrap.client(), &permission_id, decision).await
        }
        Command::Decision {
            api,
            no_auto_start_kernel,
            kind,
            decision,
            run_id,
            target_id,
            guidance,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            resolve_session_decision(
                bootstrap.client(),
                kind,
                decision,
                run_id,
                target_id,
                guidance,
                host,
            )
            .await
        }
        Command::Ask {
            api,
            no_auto_start_kernel,
            prompt,
            plain,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            ask(bootstrap.client(), prompt, plain, host).await
        }
    }
}

enum Command {
    Help,
    Interactive {
        api: Option<String>,
        no_auto_start_kernel: bool,
        host: SessionHostOptions,
    },
    DaemonStatus {
        api: Option<String>,
        no_auto_start_kernel: bool,
    },
    SessionsList {
        api: Option<String>,
        no_auto_start_kernel: bool,
        include_archived: bool,
        host: SessionHostOptions,
    },
    SessionsNew {
        api: Option<String>,
        no_auto_start_kernel: bool,
        title: Option<String>,
        host: SessionHostOptions,
    },
    SessionsResume {
        api: Option<String>,
        no_auto_start_kernel: bool,
        session_id: String,
    },
    SessionsRename {
        api: Option<String>,
        no_auto_start_kernel: bool,
        session_id: String,
        title: String,
    },
    SessionsDelete {
        api: Option<String>,
        no_auto_start_kernel: bool,
        session_id: String,
    },
    SessionsArchive {
        api: Option<String>,
        no_auto_start_kernel: bool,
        session_id: String,
    },
    Timeline {
        api: Option<String>,
        no_auto_start_kernel: bool,
        session_id: Option<String>,
        host: SessionHostOptions,
    },
    Permission {
        api: Option<String>,
        no_auto_start_kernel: bool,
        permission_id: String,
        decision: PermissionDecision,
    },
    Decision {
        api: Option<String>,
        no_auto_start_kernel: bool,
        kind: String,
        decision: String,
        run_id: Option<String>,
        target_id: Option<String>,
        guidance: Option<String>,
        host: SessionHostOptions,
    },
    Ask {
        api: Option<String>,
        no_auto_start_kernel: bool,
        prompt: String,
        plain: bool,
        host: SessionHostOptions,
    },
}

impl Command {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut api = None;
        let mut plain = false;
        let mut include_archived = false;
        let mut workspace = env::var("DEEPCODE_WORKSPACE")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let mut no_workspace = false;
        let mut no_auto_start_kernel = false;
        let mut session_id = None;
        let mut rest = Vec::new();
        let mut iter = args.into_iter();
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--help" | "-h" => return Ok(Command::Help),
                "--api" => {
                    api = iter.next();
                    if api.is_none() {
                        return Err("--api requires a URL".to_string());
                    }
                }
                "--no-auto-start-kernel" => no_auto_start_kernel = true,
                "-p" | "--print" => plain = true,
                "--include-archived" => include_archived = true,
                "--workspace" | "-C" => {
                    workspace = iter.next();
                    if workspace.is_none() {
                        return Err(format!("{arg} requires a path"));
                    }
                }
                "--no-workspace" => no_workspace = true,
                "--session" => {
                    session_id = iter.next();
                    if session_id.is_none() {
                        return Err("--session requires a session id".to_string());
                    }
                }
                _ => rest.push(arg),
            }
        }
        let host = SessionHostOptions {
            workspace,
            no_workspace,
            session_id,
        };

        match rest.as_slice() {
            [] => Ok(Command::Interactive {
                api,
                no_auto_start_kernel,
                host,
            }),
            [daemon, status] if daemon == "daemon" && status == "status" => {
                Ok(Command::DaemonStatus {
                    api,
                    no_auto_start_kernel,
                })
            }
            [sessions, list] if sessions == "sessions" && list == "list" => {
                Ok(Command::SessionsList {
                    api,
                    no_auto_start_kernel,
                    include_archived,
                    host,
                })
            }
            [sessions, new] if sessions == "sessions" && new == "new" => Ok(Command::SessionsNew {
                api,
                no_auto_start_kernel,
                title: None,
                host,
            }),
            [sessions, new, title @ ..] if sessions == "sessions" && new == "new" => {
                Ok(Command::SessionsNew {
                    api,
                    no_auto_start_kernel,
                    title: Some(title.join(" ")),
                    host,
                })
            }
            [sessions, action, session_id]
                if sessions == "sessions" && matches!(action.as_str(), "resume" | "use") =>
            {
                Ok(Command::SessionsResume {
                    api,
                    no_auto_start_kernel,
                    session_id: session_id.to_string(),
                })
            }
            [sessions, rename, session_id, title @ ..]
                if sessions == "sessions" && rename == "rename" && !title.is_empty() =>
            {
                Ok(Command::SessionsRename {
                    api,
                    no_auto_start_kernel,
                    session_id: session_id.to_string(),
                    title: title.join(" "),
                })
            }
            [sessions, delete, session_id] if sessions == "sessions" && delete == "delete" => {
                Ok(Command::SessionsDelete {
                    api,
                    no_auto_start_kernel,
                    session_id: session_id.to_string(),
                })
            }
            [sessions, archive, session_id] if sessions == "sessions" && archive == "archive" => {
                Ok(Command::SessionsArchive {
                    api,
                    no_auto_start_kernel,
                    session_id: session_id.to_string(),
                })
            }
            [timeline] if timeline == "timeline" => Ok(Command::Timeline {
                api,
                no_auto_start_kernel,
                session_id: None,
                host,
            }),
            [timeline, session_id] if timeline == "timeline" => Ok(Command::Timeline {
                api,
                no_auto_start_kernel,
                session_id: Some(session_id.to_string()),
                host,
            }),
            [permission, allow, permission_id]
                if permission == "permission" && allow == "allow" =>
            {
                Ok(Command::Permission {
                    api,
                    no_auto_start_kernel,
                    permission_id: permission_id.to_string(),
                    decision: PermissionDecision::Allow,
                })
            }
            [permission, deny, permission_id] if permission == "permission" && deny == "deny" => {
                Ok(Command::Permission {
                    api,
                    no_auto_start_kernel,
                    permission_id: permission_id.to_string(),
                    decision: PermissionDecision::Deny,
                })
            }
            [decision_cmd, kind, decision, tail @ ..] if decision_cmd == "decision" => {
                let run_id = tail.first().cloned();
                let target_id = tail.get(1).cloned();
                let guidance = if tail.len() > 2 {
                    Some(tail[2..].join(" "))
                } else {
                    None
                };
                Ok(Command::Decision {
                    api,
                    no_auto_start_kernel,
                    kind: kind.to_string(),
                    decision: decision.to_string(),
                    run_id,
                    target_id,
                    guidance,
                    host,
                })
            }
            [kind, decision, tail @ ..]
                if matches!(kind.as_str(), "requirement" | "plan" | "review")
                    && matches!(decision.as_str(), "accept" | "reject" | "revise") =>
            {
                let run_id = tail.first().cloned();
                let target_id = tail.get(1).cloned();
                let guidance = if tail.len() > 2 {
                    Some(tail[2..].join(" "))
                } else {
                    None
                };
                Ok(Command::Decision {
                    api,
                    no_auto_start_kernel,
                    kind: kind.to_string(),
                    decision: decision.to_string(),
                    run_id,
                    target_id,
                    guidance,
                    host,
                })
            }
            [ask, prompt @ ..] if ask == "ask" && !prompt.is_empty() => Ok(Command::Ask {
                api,
                no_auto_start_kernel,
                prompt: prompt.join(" "),
                plain,
                host,
            }),
            prompt if plain && !prompt.is_empty() => Ok(Command::Ask {
                api,
                no_auto_start_kernel,
                prompt: prompt.join(" "),
                plain,
                host,
            }),
            _ => Err(format!("unknown command: {}", rest.join(" "))),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct SessionHostOptions {
    workspace: Option<String>,
    no_workspace: bool,
    session_id: Option<String>,
}

async fn run_interactive(
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

async fn ask(
    client: &HttpKernelClient,
    prompt: String,
    plain: bool,
    host: SessionHostOptions,
) -> Result<(), String> {
    let session_id = session_id_for_turn(client, &host, &prompt).await?;
    let mut request = StartAgentRunRequest::ask(prompt);
    request.workspace_path = workspace_path_for_host(&host);
    request.no_workspace = Some(host.no_workspace);
    let result = start_and_wait_for_run(client, &session_id, request).await?;
    if plain {
        let mut text = result.run.final_text.clone().unwrap_or_default();
        if text.trim().is_empty() {
            if let Ok(timeline) = client.agent_timeline(&result.run.session_id).await {
                text = extract_final_text(&timeline).unwrap_or_default();
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

async fn resolve_session_decision(
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
    let mut request = StartAgentRunRequest::resolve_decision(kind, decision);
    request.run_id = run_id;
    request.target_id = target_id;
    request.guidance = guidance;
    request.workspace_path = workspace_path_for_host(&host);
    request.no_workspace = Some(host.no_workspace);
    let result = start_and_wait_for_run(client, &session_id, request).await?;
    println!("session: {}", result.run.session_id);
    let timeline = client
        .agent_timeline(&result.run.session_id)
        .await
        .map_err(|error| format!("failed to read timeline: {error}"))?;
    render_timeline(&timeline);
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
) -> Result<AgentRunResult, String> {
    let mut result = client
        .start_agent_run(session_id, request)
        .await
        .map_err(|error| format!("failed to start shared session run: {error}"))?;
    while !result.run.is_terminal() {
        tokio::time::sleep(RUN_POLL_INTERVAL).await;
        let session_id = result.run.session_id.clone();
        let run_id = result.run.run_id.clone();
        result = client
            .get_agent_run(&session_id, &run_id)
            .await
            .map_err(|error| format!("failed to read shared session run: {error}"))?;
    }
    Ok(result)
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

fn workspace_status(host: &SessionHostOptions) -> String {
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

async fn print_daemon_status(client: &HttpKernelClient) -> Result<(), String> {
    let status = client
        .daemon_status()
        .await
        .map_err(|error| format!("daemon unavailable: {error}"))?;
    println!("daemon: {}", status.service);
    println!("api: {}", client.base_url());
    println!("status: {}", if status.ok { "ok" } else { "degraded" });
    Ok(())
}

async fn print_sessions(
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

async fn create_session(
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

async fn activate_and_print_timeline(
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

async fn rename_session(
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

async fn delete_or_archive_session(
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

async fn print_timeline(
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

async fn resolve_permission(
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

async fn bootstrap_kernel(
    api: Option<String>,
    no_auto_start_kernel: bool,
) -> Result<KernelBootstrap, String> {
    KernelBootstrap::connect(KernelBootstrapOptions::new(api).auto_start(!no_auto_start_kernel))
        .await
        .map_err(|error| format!("daemon unavailable: {error}"))
}

fn render_timeline(timeline: &Value) {
    let turns = timeline
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for turn in turns {
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        println!("turn: {status}");
        for block in turn
            .get("blocks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let kind = block
                .get("narrativeKind")
                .or_else(|| block.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("stage");
            let title = block
                .get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or(kind);
            let body = block
                .get("bodyMarkdown")
                .or_else(|| block.get("summary"))
                .and_then(Value::as_str)
                .unwrap_or("");
            println!("  {kind}: {title}");
            for line in body.lines().take(12) {
                println!("    {line}");
            }
        }
    }
}

fn extract_final_text(timeline: &Value) -> Option<String> {
    let turns = timeline.get("turns").and_then(Value::as_array)?;
    for turn in turns.iter().rev() {
        let Some(blocks) = turn.get("blocks").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks.iter().rev() {
            let narrative = block
                .get("narrativeKind")
                .or_else(|| block.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if narrative != "assistantText" && narrative != "assistant" {
                continue;
            }
            let text = block
                .get("bodyMarkdown")
                .or_else(|| block.get("summary"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn session_id(session: &Value) -> Option<&str> {
    session.get("id").and_then(Value::as_str)
}

fn session_title(session: &Value) -> &str {
    session
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Untitled Session")
}

fn print_help() {
    println!(
        r#"DeepCode CLI Host Shell

Usage:
  DeepCode-CLI --help
  DeepCode-CLI daemon status
  DeepCode-CLI sessions list [--include-archived]
  DeepCode-CLI sessions new [title]
  DeepCode-CLI sessions resume <session-id>
  DeepCode-CLI sessions rename <session-id> <title>
  DeepCode-CLI sessions delete <session-id>
  DeepCode-CLI sessions archive <session-id>
  DeepCode-CLI timeline [session-id]
  DeepCode-CLI permission allow <permission-id>
  DeepCode-CLI permission deny <permission-id>
  DeepCode-CLI decision <requirement|plan|review> <accept|reject|revise> [--session <id>] [run-id] [target-id] [guidance]
  DeepCode-CLI ask [-p|--print] [--session <id>] [--workspace <path>|--no-workspace] <prompt>

Options:
  --api <url>                 Kernel daemon HTTP base URL. Defaults to DEEPCODE_API_URL or http://$DEEPCODE_HOST:$DEEPCODE_PORT.
  --no-auto-start-kernel      Do not start a local Kernel when the API is unavailable.
  --workspace, -C             Bind the turn to a workspace path. Defaults to DEEPCODE_WORKSPACE or the current directory.
  --no-workspace              Send an ordinary chat turn without a workspace binding.
  --session <id>              Continue a specific Agent session.

Environment:
  DEEPCODE_KERNEL_AUTO_START=0 disables local Kernel auto-start.
  DEEPCODE_KERNEL_BIN=/path/to/deepcode-kernel overrides Kernel binary lookup.
  DEEPCODE_WORKSPACE=/path/to/project sets the default terminal workspace.
  DEEPCODE_SESSION_BRIDGE=/path/to/hostBridge.js overrides daemon session-core lookup.
  DEEPCODE_NODE=/path/to/node overrides daemon internal Node runtime lookup.
  DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS controls daemon session run timeout. Defaults to 600000; 0 disables it.

Session Runtime:
  Ordinary input is submitted to daemon /api/agent/sessions/:id/runs.
  CLI only polls run status and renders shared timeline projection.
  If the daemon session runtime is missing, run `pnpm --filter @deepcode/session-core build`
  or use a packaged distribution that includes session-core/dist, node_modules/@deepcode/protocol,
  and node/bin/node.

Boundary:
  CLI/TUI/GUI/Editor are shells over the same daemon Session Runtime, Kernel permissions, and timeline projection."#
    );
}

fn print_interactive_help(host: &SessionHostOptions) {
    println!(
        r#"DeepCode CLI Host Shell

Core:
  /help                 Show this command list
  /status               Check Kernel daemon health
  /workspace            Show current workspace binding
  /workspace <path>     Bind terminal turns to a workspace
  /workspace cwd        Bind to the current directory
  /workspace clear      Clear workspace binding; ordinary chat remains available
  /quit                 Exit

Sessions:
  /sessions             List Agent sessions for the current workspace scope
  /timeline             Print current session timeline

Permissions and decisions:
  /decision ...         Resolve requirement/plan/review through the shared Session Runtime
  decision plan accept  Confirm a pending plan
  decision plan revise  Submit review guidance for a pending plan
  decision plan reject  End a pending plan
  any text              Send a message through the shared Session Runtime

Non-interactive:
  DeepCode-CLI daemon status
  DeepCode-CLI sessions list
  DeepCode-CLI timeline [session-id]
  DeepCode-CLI ask "..."          Run a live turn
  DeepCode-CLI -p ask "..."       Print only the final answer

This shell uses the same daemon Session Runtime and Kernel permission settings as the GUI/Editor."#
    );
    println!("{}", workspace_status(host));
    println!("session runtime: daemon /runs");
    println!(
        "session run timeout: DEEPCODE_SESSION_BRIDGE_TIMEOUT_MS, default 600000 ms, 0 disables"
    );
    if !io::stdin().is_terminal() {
        println!("stdin is not a terminal; EOF exits immediately.");
    }
}
