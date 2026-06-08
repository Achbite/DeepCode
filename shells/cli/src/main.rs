use deepcode_kernel_client::{HttpKernelClient, KernelClientConfig, PromptMode, PromptRunResult};
use serde_json::Value;
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
        Command::Ask { api, prompt } => {
            let client = client(api);
            match client.send_prompt(&prompt, PromptMode::Ask).await {
                Ok(result) => print_prompt_result(&client, result).await,
                Err(error) => {
                    eprintln!("run failed: {error}");
                    std::process::exit(EXIT_DAEMON_UNAVAILABLE);
                }
            }
        }
    }
}

enum Command {
    Help,
    Interactive,
    Ask { api: Option<String>, prompt: String },
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
                "-p" | "--print" => {
                    let prompt = iter.collect::<Vec<_>>().join(" ");
                    if prompt.trim().is_empty() {
                        return Err("-p requires a prompt".to_string());
                    }
                    return Ok(Command::Ask { api, prompt });
                }
                _ => rest.push(arg),
            }
        }

        match rest.as_slice() {
            [] => Ok(Command::Interactive),
            [daemon, status] if daemon == "daemon" && status == "status" => {
                Ok(Command::DaemonStatus { api })
            }
            [ask, prompt @ ..] if ask == "ask" && !prompt.is_empty() => Ok(Command::Ask {
                api,
                prompt: prompt.join(" "),
            }),
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
            command if command.starts_with("/ask ") => {
                run_prompt(&client, command.trim_start_matches("/ask ").trim()).await;
            }
            command if command.starts_with("ask ") => {
                run_prompt(&client, command.trim_start_matches("ask ").trim()).await;
            }
            command if command.starts_with('/') => {
                println!("unknown command: {command}");
                println!("type /help to list available commands");
            }
            prompt => run_prompt(&client, prompt).await,
        }
    }
    Ok(())
}

async fn run_prompt(client: &HttpKernelClient, prompt: &str) {
    if prompt.trim().is_empty() {
        println!("prompt is empty; type /help for usage");
        return;
    }
    match client.send_prompt(prompt, PromptMode::Ask).await {
        Ok(result) => {
            print_prompt_result(client, result).await;
        }
        Err(error) => println!("run failed: {error}"),
    }
}

async fn print_prompt_result(client: &HttpKernelClient, result: PromptRunResult) {
    let printed_final = result.final_answer.is_some();
    if let Some(answer) = result.final_answer.as_ref() {
        println!("{answer}");
    }

    match client.agent_timeline(&result.session_id).await {
        Ok(timeline) => print_timeline(&timeline, printed_final),
        Err(error) if printed_final => eprintln!("timeline unavailable: {error}"),
        Err(_) => {
            println!("session: {}", result.session_id);
            for event in result.events {
                println!("{}", format_event(&event));
            }
        }
    }
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
  deepcode -p "<prompt>"
  deepcode ask "<prompt>"
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

Type a prompt and press Enter, or use:
  /help              Show this command list
  /status            Check Kernel daemon health
  /ask <prompt>      Send one prompt through KernelClient
  /quit              Exit

Examples:
  /status
  /ask summarize current workspace

Non-interactive:
  deepcode -p "<prompt>"
  deepcode daemon status

This is still stage 10.0; full CLI behavior remains stage 16."#
    );
    if !io::stdin().is_terminal() {
        println!("stdin is not a terminal; EOF exits immediately.");
    }
}

fn print_timeline(timeline: &Value, omit_assistant_body: bool) {
    let Some(turns) = timeline.get("turns").and_then(Value::as_array) else {
        return;
    };
    let mut lines = Vec::new();
    for turn in turns {
        let turn_status = value_str(turn, "status").unwrap_or("unknown");
        let Some(blocks) = turn.get("blocks").and_then(Value::as_array) else {
            continue;
        };
        for block in blocks {
            let kind = value_str(block, "kind").unwrap_or("stage");
            if kind == "user" || (omit_assistant_body && kind == "assistant") {
                continue;
            }
            let title = value_str(block, "title").unwrap_or(kind);
            let status = value_str(block, "status").unwrap_or(turn_status);
            let summary = value_str(block, "summary").unwrap_or("");
            lines.push(format!("[{kind}:{status}] {title} {summary}"));
        }
    }
    if lines.is_empty() {
        return;
    }
    println!("-- Timeline --");
    for line in lines {
        println!("{line}");
    }
}

fn value_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn format_event(event: &Value) -> String {
    let kind = event
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("event");
    let payload = event.get("payload").unwrap_or(event);
    let text = payload
        .get("content")
        .or_else(|| payload.get("message"))
        .or_else(|| payload.get("text"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if text.is_empty() {
        format!("[{kind}]")
    } else {
        format!("[{kind}] {text}")
    }
}
