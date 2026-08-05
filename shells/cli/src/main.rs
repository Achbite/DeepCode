use deepcode_kernel_client::{
    terminal_workspace_scope, AgentRunCallerRequest, AgentRunResult, AgentTimelineDurability,
    AgentTimelineEntryRole, AgentTimelineRunStatus, AgentTimelineSnapshot, AgentTimelineStatus,
    AgentTimelineTurnPart, CreateAgentSessionRequest, HttpKernelClient, KernelBootstrap,
    KernelBootstrapOptions, ListAgentSessionsRequest, StartAgentRunRequest, TerminalWorkspaceScope,
};
use serde_json::Value;
use std::env;
use std::io::{self, IsTerminal, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const EXIT_DAEMON_UNAVAILABLE: i32 = 3;
const EXIT_BAD_ARGS: i32 = 4;
const EXIT_ACTION_REQUIRED: i32 = 5;
const EXIT_INTERRUPTED: i32 = 130;
const RUN_POLL_INTERVAL: Duration = Duration::from_millis(250);
const CLI_RUN_TIMEOUT_ENV: &str = "DEEPCODE_CLI_RUN_TIMEOUT_MS";
const CLI_INTERRUPT_CLEANUP_WINDOW: Duration = Duration::from_secs(5);
static CLI_INTERRUPT_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) enum CliCommandOutcome {
    Completed,
    ActionRequired(String),
}

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

    CLI_INTERRUPT_REQUESTED.store(false, Ordering::SeqCst);
    let interrupt_task = tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            CLI_INTERRUPT_REQUESTED.store(true, Ordering::SeqCst);
        }
    });
    let mut running = Box::pin(run(command));
    let outcome = tokio::select! {
        outcome = &mut running => outcome,
        _ = wait_for_cli_interrupt() => {
            match tokio::time::timeout(CLI_INTERRUPT_CLEANUP_WINDOW, &mut running).await {
                Ok(outcome) => outcome,
                Err(_) => Err(
                    "CLI interrupt cleanup timed out; the owned Kernel guard was reclaimed, but an externally owned Run may still require cancellation"
                        .to_string(),
                ),
            }
        }
    };
    drop(running);
    interrupt_task.abort();

    if CLI_INTERRUPT_REQUESTED.load(Ordering::SeqCst) {
        if let Err(error) = outcome {
            eprintln!("{error}");
        } else {
            eprintln!("CLI was interrupted by the user");
        }
        std::process::exit(EXIT_INTERRUPTED);
    }

    match outcome {
        Ok(CliCommandOutcome::Completed) => {}
        Ok(CliCommandOutcome::ActionRequired(message)) => {
            eprintln!("{message}");
            std::process::exit(EXIT_ACTION_REQUIRED);
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(EXIT_DAEMON_UNAVAILABLE);
        }
    }
}

async fn wait_for_cli_interrupt() {
    while !CLI_INTERRUPT_REQUESTED.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(crate) async fn run(command: Command) -> Result<CliCommandOutcome, String> {
    match command {
        Command::Help => {
            print_help();
            Ok(CliCommandOutcome::Completed)
        }
        Command::Interactive {
            api,
            no_auto_start_kernel,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            run_interactive(bootstrap.client().clone(), host)
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::DaemonStatus {
            api,
            no_auto_start_kernel,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            print_daemon_status(bootstrap.client())
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::SessionsList {
            api,
            no_auto_start_kernel,
            include_archived,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            print_sessions(bootstrap.client(), include_archived, &host)
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::SessionsNew {
            api,
            no_auto_start_kernel,
            title,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            create_session(bootstrap.client(), title, &host)
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::SessionsResume {
            api,
            no_auto_start_kernel,
            session_id,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            activate_and_print_timeline(bootstrap.client(), &session_id)
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::SessionsRename {
            api,
            no_auto_start_kernel,
            session_id,
            title,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            rename_session(bootstrap.client(), &session_id, &title)
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::SessionsProfile {
            api,
            no_auto_start_kernel,
            session_id,
            profile_id,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            print_or_update_session_profile(bootstrap.client(), &session_id, profile_id.as_deref())
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::SessionsDelete {
            api,
            no_auto_start_kernel,
            session_id,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            delete_or_archive_session(bootstrap.client(), &session_id, false)
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::SessionsArchive {
            api,
            no_auto_start_kernel,
            session_id,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            delete_or_archive_session(bootstrap.client(), &session_id, true)
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::Timeline {
            api,
            no_auto_start_kernel,
            session_id,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            print_timeline(bootstrap.client(), session_id, &host)
                .await
                .map(|_| CliCommandOutcome::Completed)
        }
        Command::Permission {
            api,
            no_auto_start_kernel,
            permission_id,
            decision,
            host,
        } => {
            let bootstrap = bootstrap_kernel(api, no_auto_start_kernel).await?;
            resolve_permission(bootstrap.client(), &permission_id, &decision, host).await
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
    SessionsProfile {
        api: Option<String>,
        no_auto_start_kernel: bool,
        session_id: String,
        profile_id: Option<String>,
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
        decision: String,
        host: SessionHostOptions,
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
            [sessions, profile, session_id] if sessions == "sessions" && profile == "profile" => {
                Ok(Command::SessionsProfile {
                    api,
                    no_auto_start_kernel,
                    session_id: session_id.to_string(),
                    profile_id: None,
                })
            }
            [sessions, profile, session_id, profile_id]
                if sessions == "sessions" && profile == "profile" =>
            {
                Ok(Command::SessionsProfile {
                    api,
                    no_auto_start_kernel,
                    session_id: session_id.to_string(),
                    profile_id: Some(profile_id.to_string()),
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
                    decision: "accept".to_string(),
                    host,
                })
            }
            [permission, deny, permission_id] if permission == "permission" && deny == "deny" => {
                Ok(Command::Permission {
                    api,
                    no_auto_start_kernel,
                    permission_id: permission_id.to_string(),
                    decision: "reject".to_string(),
                    host,
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
                if matches!(
                    (kind.as_str(), decision.as_str()),
                    ("plan", "accept" | "reject" | "revise") | ("permission", "accept" | "reject")
                ) =>
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
pub(crate) struct SessionHostOptions {
    pub(crate) workspace: Option<String>,
    pub(crate) no_workspace: bool,
    pub(crate) session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingSessionDecision {
    pub(crate) run_id: String,
    pub(crate) target_id: String,
}

pub(crate) async fn bootstrap_kernel(
    api: Option<String>,
    no_auto_start_kernel: bool,
) -> Result<KernelBootstrap, String> {
    KernelBootstrap::connect(KernelBootstrapOptions::new(api).auto_start(!no_auto_start_kernel))
        .await
        .map_err(|error| format!("daemon unavailable: {error}"))
}

mod render;
mod session;

pub(crate) use render::*;
pub(crate) use session::*;

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;
