use deepcode_kernel_client::{
    CreateAgentSessionRequest, HttpKernelClient, KernelClientConfig, ListAgentSessionsRequest,
    PermissionDecision, SessionHostBridgeRequest,
};
use serde_json::Value;
use std::env;
use std::io::{self, IsTerminal, Write};

const EXIT_DAEMON_UNAVAILABLE: i32 = 3;
const EXIT_BAD_ARGS: i32 = 4;

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
        Command::Interactive { api, host } => run_interactive(client(api), host).await,
        Command::DaemonStatus { api } => print_daemon_status(&client(api)).await,
        Command::SessionsList {
            api,
            include_archived,
        } => print_sessions(&client(api), include_archived).await,
        Command::SessionsNew { api, title } => create_session(&client(api), title).await,
        Command::SessionsResume { api, session_id } => {
            activate_and_print_timeline(&client(api), &session_id).await
        }
        Command::SessionsRename {
            api,
            session_id,
            title,
        } => rename_session(&client(api), &session_id, &title).await,
        Command::SessionsDelete { api, session_id } => {
            delete_or_archive_session(&client(api), &session_id, false).await
        }
        Command::SessionsArchive { api, session_id } => {
            delete_or_archive_session(&client(api), &session_id, true).await
        }
        Command::Timeline { api, session_id } => print_timeline(&client(api), session_id).await,
        Command::Permission {
            api,
            permission_id,
            decision,
        } => resolve_permission(&client(api), &permission_id, decision).await,
        Command::Decision {
            api,
            kind,
            decision,
            run_id,
            target_id,
            guidance,
            host,
        } => {
            resolve_session_decision(
                &client(api),
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
            prompt,
            plain,
            host,
        } => ask(&client(api), prompt, plain, host).await,
    }
}

enum Command {
    Help,
    Interactive {
        api: Option<String>,
        host: SessionHostOptions,
    },
    DaemonStatus {
        api: Option<String>,
    },
    SessionsList {
        api: Option<String>,
        include_archived: bool,
    },
    SessionsNew {
        api: Option<String>,
        title: Option<String>,
    },
    SessionsResume {
        api: Option<String>,
        session_id: String,
    },
    SessionsRename {
        api: Option<String>,
        session_id: String,
        title: String,
    },
    SessionsDelete {
        api: Option<String>,
        session_id: String,
    },
    SessionsArchive {
        api: Option<String>,
        session_id: String,
    },
    Timeline {
        api: Option<String>,
        session_id: Option<String>,
    },
    Permission {
        api: Option<String>,
        permission_id: String,
        decision: PermissionDecision,
    },
    Decision {
        api: Option<String>,
        kind: String,
        decision: String,
        run_id: Option<String>,
        target_id: Option<String>,
        guidance: Option<String>,
        host: SessionHostOptions,
    },
    Ask {
        api: Option<String>,
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
        let mut workspace = None;
        let mut no_workspace = false;
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
            [] => Ok(Command::Interactive { api, host }),
            [daemon, status] if daemon == "daemon" && status == "status" => {
                Ok(Command::DaemonStatus { api })
            }
            [sessions, list] if sessions == "sessions" && list == "list" => {
                Ok(Command::SessionsList {
                    api,
                    include_archived,
                })
            }
            [sessions, new] if sessions == "sessions" && new == "new" => {
                Ok(Command::SessionsNew { api, title: None })
            }
            [sessions, new, title @ ..] if sessions == "sessions" && new == "new" => {
                Ok(Command::SessionsNew {
                    api,
                    title: Some(title.join(" ")),
                })
            }
            [sessions, action, session_id]
                if sessions == "sessions" && matches!(action.as_str(), "resume" | "use") =>
            {
                Ok(Command::SessionsResume {
                    api,
                    session_id: session_id.to_string(),
                })
            }
            [sessions, rename, session_id, title @ ..]
                if sessions == "sessions" && rename == "rename" && !title.is_empty() =>
            {
                Ok(Command::SessionsRename {
                    api,
                    session_id: session_id.to_string(),
                    title: title.join(" "),
                })
            }
            [sessions, delete, session_id] if sessions == "sessions" && delete == "delete" => {
                Ok(Command::SessionsDelete {
                    api,
                    session_id: session_id.to_string(),
                })
            }
            [sessions, archive, session_id] if sessions == "sessions" && archive == "archive" => {
                Ok(Command::SessionsArchive {
                    api,
                    session_id: session_id.to_string(),
                })
            }
            [timeline] if timeline == "timeline" => Ok(Command::Timeline {
                api,
                session_id: None,
            }),
            [timeline, session_id] if timeline == "timeline" => Ok(Command::Timeline {
                api,
                session_id: Some(session_id.to_string()),
            }),
            [permission, allow, permission_id]
                if permission == "permission" && allow == "allow" =>
            {
                Ok(Command::Permission {
                    api,
                    permission_id: permission_id.to_string(),
                    decision: PermissionDecision::Allow,
                })
            }
            [permission, deny, permission_id] if permission == "permission" && deny == "deny" => {
                Ok(Command::Permission {
                    api,
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
                prompt: prompt.join(" "),
                plain,
                host,
            }),
            prompt if plain && !prompt.is_empty() => Ok(Command::Ask {
                api,
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

async fn run_interactive(client: HttpKernelClient, host: SessionHostOptions) -> Result<(), String> {
    print_interactive_help();
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
            "/help" | "help" => print_interactive_help(),
            "/quit" | "/exit" | "quit" | "exit" | "q" => break,
            "/status" | "status" => {
                if let Err(error) = print_daemon_status(&client).await {
                    println!("{error}");
                }
            }
            "/sessions" | "sessions" => {
                if let Err(error) = print_sessions(&client, false).await {
                    println!("{error}");
                }
            }
            "/timeline" | "timeline" => {
                if let Err(error) = print_timeline(&client, None).await {
                    println!("{error}");
                }
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
    let mut request = SessionHostBridgeRequest::ask(prompt);
    request.session_id = host.session_id;
    request.workspace_path = workspace_path(host.workspace, host.no_workspace);
    request.no_workspace = host.no_workspace;
    let result = client
        .run_session_host_bridge(request)
        .map_err(|error| format!("failed to run shared session driver: {error}"))?;
    if plain {
        let text = result.final_text.unwrap_or_default();
        if text.trim().is_empty() {
            println!("(no final answer yet)");
        } else {
            println!("{text}");
        }
        return Ok(());
    }
    if let Some(session_id) = result.session_id.as_deref() {
        println!("session: {session_id}");
    }
    if let Some(timeline) = result.timeline.as_ref() {
        render_timeline(timeline);
    } else if let Some(text) = result.final_text {
        println!("{text}");
    }
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
    let session_id = if let Some(session_id) = host.session_id {
        session_id
    } else {
        current_session_id(client).await?.ok_or_else(|| {
            "no current session; pass --session <id> or create a session first".to_string()
        })?
    };
    let mut request = SessionHostBridgeRequest::resolve_decision(kind, decision);
    request.session_id = Some(session_id);
    request.run_id = run_id;
    request.target_id = target_id;
    request.guidance = guidance;
    request.workspace_path = workspace_path(host.workspace, host.no_workspace);
    request.no_workspace = host.no_workspace;
    let result = client
        .run_session_host_bridge(request)
        .map_err(|error| format!("failed to resolve shared session decision: {error}"))?;
    if let Some(session_id) = result.session_id.as_deref() {
        println!("session: {session_id}");
    }
    if let Some(timeline) = result.timeline.as_ref() {
        render_timeline(timeline);
    }
    Ok(())
}

async fn current_session_id(client: &HttpKernelClient) -> Result<Option<String>, String> {
    let current = client
        .current_agent_session(ListAgentSessionsRequest::default())
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

async fn print_sessions(client: &HttpKernelClient, include_archived: bool) -> Result<(), String> {
    let result = client
        .list_agent_sessions(ListAgentSessionsRequest {
            include_archived: Some(include_archived),
            ..ListAgentSessionsRequest::default()
        })
        .await
        .map_err(|error| format!("failed to list sessions: {error}"))?;
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

async fn create_session(client: &HttpKernelClient, title: Option<String>) -> Result<(), String> {
    let result = client
        .create_agent_session(CreateAgentSessionRequest {
            initial_mode: Some("plan".to_string()),
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
    print_timeline(client, Some(session_id.to_string())).await
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
) -> Result<(), String> {
    let session_id = match requested_session_id {
        Some(id) => id,
        None => {
            let current = client
                .current_agent_session(ListAgentSessionsRequest::default())
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

fn client(api: Option<String>) -> HttpKernelClient {
    let config = api
        .map(KernelClientConfig::new)
        .unwrap_or_else(KernelClientConfig::from_env);
    HttpKernelClient::new(config)
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
  deepcode-cli --help
  deepcode-cli daemon status
  deepcode-cli sessions list [--include-archived]
  deepcode-cli sessions new [title]
  deepcode-cli sessions resume <session-id>
  deepcode-cli sessions rename <session-id> <title>
  deepcode-cli sessions delete <session-id>
  deepcode-cli sessions archive <session-id>
  deepcode-cli timeline [session-id]
  deepcode-cli permission allow <permission-id>
  deepcode-cli permission deny <permission-id>
  deepcode-cli decision <requirement|plan|review> <accept|reject|revise> [--session <id>] [run-id] [target-id] [guidance]
  deepcode-cli ask [-p|--print] [--session <id>] [--workspace <path>|--no-workspace] <prompt>

Options:
  --api <url>       Kernel daemon HTTP base URL. Defaults to DEEPCODE_API_URL or http://$DEEPCODE_HOST:$DEEPCODE_PORT.
  --workspace, -C   Bind the turn to a workspace path. Defaults to the current directory for terminal chat.
  --no-workspace    Send an ordinary chat turn without a workspace binding.
  --session <id>    Continue a specific Agent session.

Boundary:
  CLI/TUI/GUI/Editor are shells over the same SessionDriverLoop, Kernel permissions, and timeline projection."#
    );
}

fn print_interactive_help() {
    println!(
        r#"DeepCode CLI Host Shell

Commands:
  /help              Show this command list
  /status            Check Kernel daemon health
  /sessions          List Agent sessions
  /timeline          Print current session timeline
  /decision ...      Resolve requirement/plan/review through the shared SessionDriverLoop
  /quit              Exit
  any text           Send a message through the shared SessionDriverLoop

Non-interactive:
  deepcode-cli daemon status
  deepcode-cli sessions list
  deepcode-cli timeline [session-id]
  deepcode-cli ask "..."          Run a live turn
  deepcode-cli -p ask "..."       Print only the final answer

This shell uses the same SessionDriverLoop and Kernel permission settings as the GUI/Editor."#
    );
    if !io::stdin().is_terminal() {
        println!("stdin is not a terminal; EOF exits immediately.");
    }
}
