use deepcode_kernel_client::{HttpKernelClient, KernelClientConfig};
use std::env;
use std::io::{self, IsTerminal, Write};

const EXIT_DAEMON_UNAVAILABLE: i32 = 3;
const EXIT_BAD_ARGS: i32 = 4;

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = match Command::parse(args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}");
            print_help();
            std::process::exit(EXIT_BAD_ARGS);
        }
    };

    match command {
        Command::Help => print_help(),
        Command::Interactive => {
            if let Err(error) = run_interactive().await {
                eprintln!("{error}");
                std::process::exit(EXIT_DAEMON_UNAVAILABLE);
            }
        }
        Command::DaemonStatus { api } => {
            let client = client(api);
            match client.daemon_status().await {
                Ok(status) => {
                    println!("daemon: {}", status.service);
                    println!("api: {}", client.base_url());
                    println!("status: {}", if status.ok { "ok" } else { "degraded" });
                }
                Err(error) => {
                    eprintln!("daemon unavailable: {error}");
                    std::process::exit(EXIT_DAEMON_UNAVAILABLE);
                }
            }
        }
    }
}

enum Command {
    Help,
    Interactive,
    DaemonStatus { api: Option<String> },
}

impl Command {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut api = None;
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
                "-p" | "--print" => return Err(format!("{arg} was removed; use the SessionDriverLoop host bridge when CLI chat is reattached")),
                _ => rest.push(arg),
            }
        }

        match rest.as_slice() {
            [] => Ok(Command::Interactive),
            [daemon, status] if daemon == "daemon" && status == "status" => {
                Ok(Command::DaemonStatus { api })
            }
            _ => Err(format!("unknown command: {}", rest.join(" "))),
        }
    }
}

async fn run_interactive() -> Result<(), String> {
    print_interactive_help();
    let client = client(None);
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
            "/status" | "status" => match client.daemon_status().await {
                Ok(status) => {
                    println!("daemon: {}", status.service);
                    println!("api: {}", client.base_url());
                    println!("status: {}", if status.ok { "ok" } else { "degraded" });
                }
                Err(error) => println!("daemon unavailable: {error}"),
            },
            command if command.starts_with('/') => {
                println!("unknown command: {command}");
                println!("type /help to list available commands");
            }
            command => {
                println!("unknown command: {command}");
                println!(
                    "CLI chat is not wired in this Host shell; use /help for available commands."
                );
            }
        }
    }
    Ok(())
}

fn client(api: Option<String>) -> HttpKernelClient {
    let config = api
        .map(KernelClientConfig::new)
        .unwrap_or_else(KernelClientConfig::from_env);
    HttpKernelClient::new(config)
}

fn print_help() {
    println!(
        r#"DeepCode CLI Host Shell MVP

Usage:
  deepcode --help
  deepcode daemon status

Options:
  --api <url>       Kernel daemon HTTP base URL. Defaults to DEEPCODE_API_URL or http://$DEEPCODE_HOST:$DEEPCODE_PORT.

This stage-10.0 CLI is a Host shell over KernelClient. It does not own runtime,
workflow, permission, tool execution, or review state."#
    );
}

fn print_interactive_help() {
    println!(
        r#"DeepCode CLI Host Shell MVP

Type a command and press Enter:
  /help              Show this command list
  /status            Check Kernel daemon health
  /quit              Exit

Examples:
  /status

Non-interactive:
  deepcode daemon status

This Host shell does not expose the legacy chat-submit path. CLI chat will be reattached
through the same userspace SessionDriverLoop / Kernel boundary used by Editor and GUI."#
    );
    if !io::stdin().is_terminal() {
        println!("stdin is not a terminal; EOF exits immediately.");
    }
}
