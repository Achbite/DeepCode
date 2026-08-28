use deepcode_kernel_client::{
    approval_response_command, cancel_command, interaction_response_command,
    is_terminal_run_status, message_command, plan_feedback_command, plan_ignore_command,
    plan_select_command, profile_selection_command, ActivityProjection, ApprovalProjection,
    CreateConversationSessionRequest, HttpKernelClient, InteractionProjection, KernelBootstrap,
    KernelBootstrapOptions, NarrativeProjection, PendingPlanProjection, ProjectionMessage,
    SessionProjection,
};
use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const EXIT_DAEMON_UNAVAILABLE: i32 = 3;
const EXIT_BAD_ARGS: i32 = 4;
const EXIT_ACTION_REQUIRED: i32 = 5;
const EXIT_RUN_FAILED: i32 = 6;
const EXIT_RUN_INDETERMINATE: i32 = 7;
const EXIT_RUN_CANCELLED: i32 = 8;
const EXIT_INTERRUPTED: i32 = 130;
const POLL_INTERVAL: Duration = Duration::from_millis(150);
const DEFAULT_RUN_TIMEOUT: Duration = Duration::from_secs(600);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[tokio::main]
async fn main() {
    let args = match Args::parse(env::args().skip(1).collect()) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}");
            print_help();
            std::process::exit(EXIT_BAD_ARGS);
        }
    };
    if matches!(args.command, Command::Help) {
        print_help();
        return;
    }
    let bootstrap = match KernelBootstrap::connect(
        KernelBootstrapOptions::new(args.api.clone()).auto_start(!args.no_auto_start_kernel),
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Daemon 不可用：{error}");
            std::process::exit(EXIT_DAEMON_UNAVAILABLE);
        }
    };
    let result = run(bootstrap.client(), args).await;
    drop(bootstrap);
    match result {
        Ok(Outcome::Done) => {}
        Ok(Outcome::ActionRequired) => std::process::exit(EXIT_ACTION_REQUIRED),
        Ok(Outcome::Failed) => std::process::exit(EXIT_RUN_FAILED),
        Ok(Outcome::Indeterminate) => std::process::exit(EXIT_RUN_INDETERMINATE),
        Ok(Outcome::Cancelled) => std::process::exit(EXIT_RUN_CANCELLED),
        Ok(Outcome::Interrupted) => std::process::exit(EXIT_INTERRUPTED),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(EXIT_DAEMON_UNAVAILABLE);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Command {
    Help,
    Status,
    Ask(String),
    Chat,
    Show,
    IgnorePlan,
    SelectModel {
        profile_id: String,
    },
    Cancel {
        run_id: String,
    },
    AttachDirectory {
        path: String,
    },
    DetachDirectory {
        workspace_id: String,
    },
    OpenResource {
        workspace_id: String,
        logical_path: String,
    },
}

#[derive(Debug, Clone)]
struct Args {
    api: Option<String>,
    no_auto_start_kernel: bool,
    workspace: Option<PathBuf>,
    session_id: Option<String>,
    plain: bool,
    command: Command,
}

impl Args {
    fn parse(values: Vec<String>) -> Result<Self, String> {
        let mut api = None;
        let mut no_auto_start_kernel = false;
        let mut workspace = None;
        let mut session_id = None;
        let mut plain = false;
        let mut positional = Vec::new();
        let mut index = 0;
        while index < values.len() {
            match values[index].as_str() {
                "--api" => {
                    index += 1;
                    api = Some(required_arg(&values, index, "--api")?.to_string());
                }
                "--no-auto-start-kernel" => no_auto_start_kernel = true,
                "--workspace" | "-C" => {
                    index += 1;
                    workspace = Some(PathBuf::from(required_arg(&values, index, "--workspace")?));
                }
                "--session" => {
                    index += 1;
                    session_id = Some(required_arg(&values, index, "--session")?.to_string());
                }
                "--plain" => plain = true,
                "--help" | "-h" => positional.push("help".to_string()),
                value if value.starts_with('-') => return Err(format!("未知选项：{value}")),
                _ => positional.push(values[index].clone()),
            }
            index += 1;
        }
        if session_id.is_some() && workspace.is_some() {
            return Err(
                "--session 指向已有 creation snapshot，不能同时使用 -C/--workspace。".to_string(),
            );
        }
        let command = match positional.first().map(String::as_str) {
            None => Command::Chat,
            Some("help") => Command::Help,
            Some("status") => Command::Status,
            Some("chat") => Command::Chat,
            Some("show") => Command::Show,
            Some("ask") => {
                let text = positional[1..].join(" ");
                if text.trim().is_empty() {
                    return Err("ask 需要非空输入。".to_string());
                }
                Command::Ask(text)
            }
            Some("ignore-plan") => {
                if positional.len() != 1 {
                    return Err("用法：ignore-plan --session <id>".to_string());
                }
                Command::IgnorePlan
            }
            Some("model") => {
                if positional.len() != 2 {
                    return Err("用法：model --session <id> <profile-id>".to_string());
                }
                Command::SelectModel {
                    profile_id: positional[1].clone(),
                }
            }
            Some("cancel") => {
                if positional.len() != 2 {
                    return Err("用法：cancel --session <id> <run-id>".to_string());
                }
                Command::Cancel {
                    run_id: positional[1].clone(),
                }
            }
            Some("attach-directory") => {
                if positional.len() != 2 {
                    return Err("用法：attach-directory --session <id> <path>".to_string());
                }
                Command::AttachDirectory {
                    path: positional[1].clone(),
                }
            }
            Some("detach-directory") => {
                if positional.len() != 2 {
                    return Err("用法：detach-directory --session <id> <workspace-id>".to_string());
                }
                Command::DetachDirectory {
                    workspace_id: positional[1].clone(),
                }
            }
            Some("open-resource") => {
                if positional.len() != 3 {
                    return Err(
                        "用法：open-resource --session <id> <workspace-id> <logical-path>"
                            .to_string(),
                    );
                }
                Command::OpenResource {
                    workspace_id: positional[1].clone(),
                    logical_path: positional[2].clone(),
                }
            }
            Some(other) => return Err(format!("未知命令：{other}")),
        };
        Ok(Self {
            api,
            no_auto_start_kernel,
            workspace,
            session_id,
            plain,
            command,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Done,
    ActionRequired,
    Failed,
    Indeterminate,
    Cancelled,
    Interrupted,
}

async fn run(client: &HttpKernelClient, args: Args) -> Result<Outcome, String> {
    match args.command {
        Command::Help => Ok(Outcome::Done),
        Command::Status => {
            let status = client
                .daemon_status()
                .await
                .map_err(|error| error.to_string())?;
            println!(
                "{}: {}",
                status.service,
                if status.ok { "ready" } else { "not ready" }
            );
            Ok(Outcome::Done)
        }
        Command::Ask(text) => {
            let projection =
                open_session(client, args.session_id.as_deref(), args.workspace.as_ref()).await?;
            if !args.plain {
                eprintln!("session: {}", projection.session_id);
            }
            submit_input_and_wait(client, &projection, &text, args.plain).await
        }
        Command::Chat => {
            run_chat(client, args.session_id.as_deref(), args.workspace.as_ref()).await
        }
        Command::Show => {
            let session_id = require_session(args.session_id.as_deref())?;
            let projection = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            render_projection(&projection, true);
            Ok(outcome_for_projection(&projection).unwrap_or(Outcome::Done))
        }
        Command::IgnorePlan => {
            let session_id = require_session(args.session_id.as_deref())?;
            let before = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            let plan = before
                .pending_plan
                .as_ref()
                .ok_or_else(|| "当前没有待处理 Plan。".to_string())?;
            let command = plan_ignore_command(session_id, &new_id("command"), plan);
            submit_checked(client, session_id, &command).await?;
            wait_for_projection(
                client,
                session_id,
                before.revision,
                last_timeline_sequence(&before),
                todo_sequence(&before),
                before.messages.len(),
                args.plain,
            )
            .await
        }
        Command::SelectModel { profile_id } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let projection = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            let run = projection
                .run
                .as_ref()
                .ok_or_else(|| "当前没有活动 run。".to_string())?;
            let command =
                profile_selection_command(session_id, &new_id("command"), &run.run_id, &profile_id);
            submit_checked(client, session_id, &command).await?;
            println!("下一次 Provider 调用将使用模型 Profile {profile_id}");
            Ok(Outcome::Done)
        }
        Command::Cancel { run_id } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let command = cancel_command(session_id, &new_id("command"), &run_id);
            submit_checked(client, session_id, &command).await?;
            let projection = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            render_run_state(&projection);
            Ok(outcome_for_projection(&projection).unwrap_or(Outcome::Done))
        }
        Command::AttachDirectory { path } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let projection = client
                .attach_conversation_directory_index(session_id, &path)
                .await
                .map_err(|error| error.to_string())?;
            if let Some(binding) = projection.session_directory_indexes.last() {
                println!(
                    "已附加目录索引：{} ({})；从下一次 run 起生效。",
                    binding.display_name, binding.workspace_id
                );
            } else {
                println!("该目录已在当前 Session 的有效目录集合中。");
            }
            Ok(Outcome::Done)
        }
        Command::DetachDirectory { workspace_id } => {
            let session_id = require_session(args.session_id.as_deref())?;
            client
                .detach_conversation_directory_index(session_id, &workspace_id)
                .await
                .map_err(|error| error.to_string())?;
            println!("已移除目录索引 {workspace_id}；仅影响之后启动的 run。");
            Ok(Outcome::Done)
        }
        Command::OpenResource {
            workspace_id,
            logical_path,
        } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let resource = client
                .conversation_resource_read(session_id, &workspace_id, &logical_path)
                .await
                .map_err(|error| error.to_string())?;
            print!("{}", resource.content);
            if !resource.content.ends_with('\n') {
                println!();
            }
            Ok(Outcome::Done)
        }
    }
}

async fn open_session(
    client: &HttpKernelClient,
    session_id: Option<&str>,
    workspace: Option<&PathBuf>,
) -> Result<SessionProjection, String> {
    if let Some(session_id) = session_id {
        return client
            .conversation_projection(session_id)
            .await
            .map_err(|error| error.to_string());
    }
    let workspace_paths = match workspace {
        Some(path) => Some(vec![path
            .canonicalize()
            .map_err(|error| format!("工作区不可用 {}：{error}", path.display()))?
            .to_string_lossy()
            .to_string()]),
        None => None,
    };
    client
        .create_conversation_session(&CreateConversationSessionRequest {
            session_id: None,
            workspace_paths,
            project_id: None,
            profile_id: None,
        })
        .await
        .map_err(|error| error.to_string())
}

async fn submit_input_and_wait(
    client: &HttpKernelClient,
    before: &SessionProjection,
    text: &str,
    plain: bool,
) -> Result<Outcome, String> {
    let command = contextual_input_command(before, text)?;
    submit_checked(client, &before.session_id, &command).await?;
    wait_for_projection(
        client,
        &before.session_id,
        before.revision,
        last_timeline_sequence(before),
        todo_sequence(before),
        before.messages.len(),
        plain,
    )
    .await
}

fn contextual_input_command(
    projection: &SessionProjection,
    text: &str,
) -> Result<serde_json::Value, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("输入不能为空。".to_string());
    }
    if let Some(approval) = projection.pending_approval.as_ref() {
        let decision = approval_decision_for_input(text)?;
        return Ok(approval_response_command(
            &projection.session_id,
            &new_id("command"),
            approval,
            decision,
        ));
    }
    if let Some(plan) = projection.pending_plan.as_ref() {
        if let Ok(index) = text.parse::<usize>() {
            if let Some(option) = index
                .checked_sub(1)
                .and_then(|index| plan.options.get(index))
            {
                return Ok(plan_select_command(
                    &projection.session_id,
                    &new_id("command"),
                    plan,
                    &option.option_id,
                ));
            }
        }
        return Ok(plan_feedback_command(
            &projection.session_id,
            &new_id("command"),
            plan,
            text,
        ));
    }
    if let Some(interaction) = projection.pending_interaction.as_ref() {
        let response = interaction_response_for_input(interaction, text);
        return Ok(interaction_response_command(
            &projection.session_id,
            &new_id("command"),
            interaction,
            &response,
        ));
    }
    Ok(message_command(
        &projection.session_id,
        &new_id("command"),
        text,
    ))
}

fn approval_decision_for_input(input: &str) -> Result<&'static str, String> {
    match input.trim().to_lowercase().as_str() {
        "1" | "allow" | "允许" | "同意" => Ok("allow"),
        "2" | "deny" | "拒绝" | "不同意" => Ok("deny"),
        _ => Err("当前等待 effect 裁决：输入 1/允许 或 2/拒绝。".to_string()),
    }
}

fn interaction_response_for_input(interaction: &InteractionProjection, input: &str) -> String {
    input
        .parse::<usize>()
        .ok()
        .and_then(|index| index.checked_sub(1))
        .and_then(|index| interaction.options.as_ref()?.get(index))
        .map(|option| option.label.clone())
        .unwrap_or_else(|| input.to_string())
}

async fn submit_checked(
    client: &HttpKernelClient,
    session_id: &str,
    command: &serde_json::Value,
) -> Result<(), String> {
    let reply = client
        .submit_conversation_command(session_id, command)
        .await
        .map_err(|error| error.to_string())?;
    if reply.status == "rejected" {
        let error = reply
            .error
            .map(|value| format!("{}: {}", value.code, value.message))
            .unwrap_or_else(|| "命令被拒绝。".to_string());
        return Err(error);
    }
    Ok(())
}

async fn wait_for_projection(
    client: &HttpKernelClient,
    session_id: &str,
    start_revision: u64,
    start_timeline_sequence: u64,
    start_todo_sequence: u64,
    start_message_count: usize,
    plain: bool,
) -> Result<Outcome, String> {
    let timeout = env::var("DEEPCODE_CLI_RUN_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_RUN_TIMEOUT);
    let deadline = Instant::now() + timeout;
    let mut last_revision = start_revision;
    let mut rendered_sequence = start_timeline_sequence;
    let mut rendered_todo_sequence = start_todo_sequence;
    let mut live_turn: Option<String> = None;
    let mut live_text = String::new();
    let mut live_open = false;
    loop {
        if Instant::now() >= deadline {
            return Err("等待 Agent 运行结束超时。".to_string());
        }
        let projection = client
            .conversation_projection(session_id)
            .await
            .map_err(|error| error.to_string())?;
        if projection.revision > last_revision {
            if !plain {
                let current_turn = projection
                    .assistant_draft
                    .as_ref()
                    .map(|draft| draft.turn_id.as_str());
                let previous_turn_closed = live_turn.as_deref() != current_turn;
                if previous_turn_closed && live_open {
                    eprintln!();
                    live_open = false;
                }
                render_increment_except(
                    &projection,
                    rendered_sequence,
                    previous_turn_closed.then_some(live_text.as_str()),
                );
                if projection
                    .todo_list
                    .as_ref()
                    .is_some_and(|todo| todo.sequence > rendered_todo_sequence)
                {
                    render_todo(&projection);
                }
                if previous_turn_closed {
                    live_turn = None;
                    live_text.clear();
                }
            }
            rendered_sequence = last_timeline_sequence(&projection);
            rendered_todo_sequence = todo_sequence(&projection);
            last_revision = projection.revision;
        }
        if !plain {
            if let Some(draft) = projection.assistant_draft.as_ref() {
                if live_turn.as_deref() != Some(draft.turn_id.as_str()) {
                    if live_open {
                        eprintln!();
                    }
                    live_turn = Some(draft.turn_id.clone());
                    live_text.clear();
                    live_open = false;
                }
                if draft.content.starts_with(&live_text) {
                    let delta = &draft.content[live_text.len()..];
                    if !delta.is_empty() {
                        eprint!("{delta}");
                        io::stderr().flush().map_err(|error| error.to_string())?;
                        live_open = true;
                    }
                } else {
                    if live_open {
                        eprintln!();
                    }
                    eprint!("{}", draft.content);
                    io::stderr().flush().map_err(|error| error.to_string())?;
                    live_open = true;
                }
                live_text = draft.content.clone();
            }
        }
        if let Some(run) = projection.run.as_ref() {
            if run.status == "waiting" {
                render_action_required(&projection);
                return Ok(Outcome::ActionRequired);
            }
            if is_terminal_run_status(&run.status) {
                if plain && run.status == "completed" {
                    if let Some(text) = projection.last_assistant_text(start_message_count) {
                        println!("{text}");
                    }
                } else if !plain {
                    render_run_state(&projection);
                }
                render_terminal_error(&projection);
                return Ok(outcome_for_projection(&projection).unwrap_or(Outcome::Done));
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
            interrupted = tokio::signal::ctrl_c() => {
                interrupted.map_err(|error| error.to_string())?;
                if let Some(run) = projection.run.as_ref() {
                    let command = cancel_command(session_id, &new_id("command"), &run.run_id);
                    submit_checked(client, session_id, &command).await?;
                    eprintln!("已请求取消 run {}", run.run_id);
                }
                return Ok(Outcome::Interrupted);
            }
        }
    }
}

async fn run_chat(
    client: &HttpKernelClient,
    session_id: Option<&str>,
    workspace: Option<&PathBuf>,
) -> Result<Outcome, String> {
    if !io::stdin().is_terminal() {
        return Err("chat 需要交互式终端；非交互调用请使用 ask。".to_string());
    }
    let mut projection = open_session(client, session_id, workspace).await?;
    println!("session: {}", projection.session_id);
    println!("普通文本用于消息、交互回应或 Plan 反馈；Plan 可输入编号；effect 审批输入 1/允许或 2/拒绝；/attach <path> 与 /detach <workspace-id> 管理对话目录索引；/ignore；/model；/cancel；/quit。");
    render_action_required_if_any(&projection);
    let mut line = String::new();
    loop {
        print!("deepcode> ");
        io::stdout().flush().map_err(|error| error.to_string())?;
        line.clear();
        if io::stdin()
            .read_line(&mut line)
            .map_err(|error| error.to_string())?
            == 0
        {
            return Ok(
                if projection.pending_plan.is_some()
                    || projection.pending_interaction.is_some()
                    || projection.pending_approval.is_some()
                {
                    Outcome::ActionRequired
                } else {
                    Outcome::Done
                },
            );
        }
        let input = line.trim();
        if input.is_empty() {
            continue;
        }
        match input {
            "/quit" | "/exit" => return Ok(Outcome::Done),
            "/show" => render_projection(&projection, true),
            "/ignore" => {
                let plan = projection
                    .pending_plan
                    .as_ref()
                    .ok_or_else(|| "当前没有待处理 Plan。".to_string())?;
                let command = plan_ignore_command(&projection.session_id, &new_id("command"), plan);
                submit_checked(client, &projection.session_id, &command).await?;
                let outcome = wait_for_projection(
                    client,
                    &projection.session_id,
                    projection.revision,
                    last_timeline_sequence(&projection),
                    todo_sequence(&projection),
                    projection.messages.len(),
                    false,
                )
                .await?;
                projection = refresh_projection(client, &projection.session_id).await?;
                if matches!(
                    outcome,
                    Outcome::Failed | Outcome::Indeterminate | Outcome::Cancelled
                ) {
                    return Ok(outcome);
                }
            }
            "/cancel" => {
                if let Some(run) = projection.run.as_ref() {
                    let command =
                        cancel_command(&projection.session_id, &new_id("command"), &run.run_id);
                    submit_checked(client, &projection.session_id, &command).await?;
                    projection = refresh_projection(client, &projection.session_id).await?;
                    render_run_state(&projection);
                }
            }
            value if value.starts_with("/model ") => {
                let profile_id = value.trim_start_matches("/model ").trim();
                let run = projection
                    .run
                    .as_ref()
                    .ok_or_else(|| "当前没有活动 run。".to_string())?;
                let command = profile_selection_command(
                    &projection.session_id,
                    &new_id("command"),
                    &run.run_id,
                    profile_id,
                );
                submit_checked(client, &projection.session_id, &command).await?;
                projection = refresh_projection(client, &projection.session_id).await?;
            }
            value if value.starts_with("/attach ") => {
                let path = value.trim_start_matches("/attach ").trim();
                if path.is_empty() {
                    println!("用法：/attach <path>");
                    continue;
                }
                projection = client
                    .attach_conversation_directory_index(&projection.session_id, path)
                    .await
                    .map_err(|error| error.to_string())?;
                println!("目录索引已附加；从下一次 run 起使用当前有效目录集合。");
            }
            value if value.starts_with("/detach ") => {
                let workspace_id = value.trim_start_matches("/detach ").trim();
                if workspace_id.is_empty() {
                    println!("用法：/detach <workspace-id>");
                    continue;
                }
                projection = client
                    .detach_conversation_directory_index(&projection.session_id, workspace_id)
                    .await
                    .map_err(|error| error.to_string())?;
                println!("目录索引已移除；运行中的 run 保留其冻结快照。");
            }
            value if value.starts_with('/') => println!("未知命令：{value}"),
            text => {
                let outcome = submit_input_and_wait(client, &projection, text, false).await?;
                projection = refresh_projection(client, &projection.session_id).await?;
                if matches!(
                    outcome,
                    Outcome::Failed | Outcome::Indeterminate | Outcome::Cancelled
                ) {
                    return Ok(outcome);
                }
            }
        }
    }
}

async fn refresh_projection(
    client: &HttpKernelClient,
    session_id: &str,
) -> Result<SessionProjection, String> {
    client
        .conversation_projection(session_id)
        .await
        .map_err(|error| error.to_string())
}

fn render_projection(projection: &SessionProjection, include_messages: bool) {
    println!(
        "session={} revision={} run={}",
        projection.session_id,
        projection.revision,
        projection
            .run
            .as_ref()
            .map(|run| format!("{}:{}", run.run_id, run.status))
            .unwrap_or_else(|| "-".to_string()),
    );
    if !projection.session_directory_indexes.is_empty() {
        println!("对话目录索引：");
        for binding in &projection.session_directory_indexes {
            println!("  {} ({})", binding.display_name, binding.workspace_id);
        }
    }
    if include_messages {
        render_increment(projection, 0);
    }
    for activity in projection
        .activities
        .iter()
        .filter(|activity| activity.kind != "tool")
    {
        eprintln!(
            "{} [{}]: {}",
            activity.kind, activity.status, activity.label
        );
    }
    render_todo(projection);
    render_usage(projection);
    render_action_required_if_any(projection);
    render_terminal_error(projection);
}

fn render_increment(projection: &SessionProjection, after_sequence: u64) {
    render_increment_except(projection, after_sequence, None);
}

fn render_increment_except(
    projection: &SessionProjection,
    after_sequence: u64,
    suppress_content: Option<&str>,
) {
    let mut suppressed = false;
    for item in timeline_items(projection)
        .into_iter()
        .filter(|item| item.sequence() > after_sequence)
    {
        match item {
            TimelineItem::Message(message) => {
                if !suppressed && suppress_content == Some(message.content.as_str()) {
                    suppressed = true;
                    continue;
                }
                println!("{}: {}", message.role, message.content);
                render_attachments(message);
            }
            TimelineItem::Narrative(narrative) => {
                if !suppressed && suppress_content == Some(narrative.content.as_str()) {
                    suppressed = true;
                    continue;
                }
                println!("{}", narrative.content);
            }
            TimelineItem::Tool(activity) => render_tool_activity(projection, activity),
        }
    }
}

fn render_tool_activity(projection: &SessionProjection, activity: &ActivityProjection) {
    let operation = activity
        .tool
        .as_ref()
        .map(|tool| tool.operation.as_str())
        .unwrap_or(activity.label.as_str());
    println!("工具 {operation} [{}]", activity.status);
    if let Some(tool) = activity.tool.as_ref() {
        for resource in &tool.resources {
            match (
                resource.kind.as_str(),
                resource.workspace_id.as_deref(),
                resource.logical_path.as_deref(),
                resource.uri.as_deref(),
            ) {
                ("workspacePath", Some(workspace_id), Some(logical_path), _) => println!(
                    "  {} -> deepcode-cli open-resource --session {} {} {:?}",
                    resource.label, projection.session_id, workspace_id, logical_path,
                ),
                ("url", _, _, Some(uri)) => println!("  {} -> {uri}", resource.label),
                _ => println!("  {}", resource.label),
            }
        }
    }
}

fn render_todo(projection: &SessionProjection) {
    let Some(todo) = projection.todo_list.as_ref() else {
        return;
    };
    println!("Todo");
    if todo.items.is_empty() {
        println!("  （空）");
        return;
    }
    for item in &todo.items {
        let marker = match item.status.as_str() {
            "completed" => "[x]",
            "inProgress" => "[>]",
            _ => "[ ]",
        };
        println!("  {marker} {}", item.label);
    }
}

fn render_usage(projection: &SessionProjection) {
    let usage = &projection.token_usage;
    let cache_total = usage
        .cache_read_input_tokens
        .checked_add(usage.cache_miss_input_tokens);
    let cache = if usage.cache_reported_call_count > 0 {
        cache_total
            .filter(|total| *total > 0)
            .map(|total| {
                format!(
                    "{:.0}%",
                    usage.cache_read_input_tokens as f64 * 100.0 / total as f64
                )
            })
            .unwrap_or_else(|| "--%".to_string())
    } else {
        "--%".to_string()
    };
    eprintln!(
        "Provider 调用 {} · 输入 {} · 输出 {} · 缓存命中 {}",
        usage.provider_call_count, usage.input_tokens, usage.output_tokens, cache
    );
}

fn render_attachments(message: &ProjectionMessage) {
    if !message.attachments.is_empty() {
        println!(
            "  附件：{}",
            message
                .attachments
                .iter()
                .map(|attachment| attachment.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
}

fn render_action_required_if_any(projection: &SessionProjection) {
    if projection.pending_plan.is_some()
        || projection.pending_interaction.is_some()
        || projection.pending_approval.is_some()
    {
        render_action_required(projection);
    }
}

fn render_action_required(projection: &SessionProjection) {
    if let Some(plan) = projection.pending_plan.as_ref() {
        render_plan(plan);
        eprintln!(
            "输入 1..{} 选择；输入其他非空文本调整；显式运行 `deepcode-cli ignore-plan --session {}` 忽略并直接回答。",
            plan.options.len(), projection.session_id,
        );
    }
    if let Some(interaction) = projection.pending_interaction.as_ref() {
        render_interaction(interaction);
        eprintln!(
            "继续：deepcode-cli ask --session {} <response>",
            projection.session_id
        );
    }
    if let Some(approval) = projection.pending_approval.as_ref() {
        render_approval(approval);
        eprintln!("继续：输入 1/允许 或 2/拒绝。");
    }
}

fn render_approval(approval: &ApprovalProjection) {
    println!("需要你批准：{}", approval.preview.summary);
    for target in &approval.preview.logical_targets {
        println!("  - {target}");
    }
}

fn render_plan(plan: &PendingPlanProjection) {
    println!("Plan");
    println!("{}", plan.prompt);
    for (index, option) in plan.options.iter().enumerate() {
        println!("{}. {}", index + 1, option.label);
        if let Some(description) = option.description.as_deref() {
            println!("   {description}");
        }
        for operation in &option.operations_display {
            println!("   - {operation}");
        }
    }
}

fn render_interaction(interaction: &InteractionProjection) {
    println!("需要你回答：{}", interaction.prompt);
    if let Some(options) = interaction.options.as_ref() {
        for (index, option) in options.iter().enumerate() {
            match option.description.as_deref() {
                Some(description) => println!("  {}. {}: {}", index + 1, option.label, description),
                None => println!("  {}. {}", index + 1, option.label),
            }
        }
    }
}

enum TimelineItem<'a> {
    Message(&'a ProjectionMessage),
    Narrative(&'a NarrativeProjection),
    Tool(&'a ActivityProjection),
}

impl TimelineItem<'_> {
    fn sequence(&self) -> u64 {
        match self {
            Self::Message(value) => value.sequence,
            Self::Narrative(value) => value.sequence,
            Self::Tool(value) => value.sequence,
        }
    }
}

fn timeline_items(projection: &SessionProjection) -> Vec<TimelineItem<'_>> {
    let tool_count = projection
        .activities
        .iter()
        .filter(|activity| activity.kind == "tool")
        .count();
    let mut items =
        Vec::with_capacity(projection.messages.len() + projection.narratives.len() + tool_count);
    items.extend(projection.messages.iter().map(TimelineItem::Message));
    items.extend(projection.narratives.iter().map(TimelineItem::Narrative));
    items.extend(
        projection
            .activities
            .iter()
            .filter(|activity| activity.kind == "tool")
            .map(TimelineItem::Tool),
    );
    items.sort_by_key(TimelineItem::sequence);
    items
}

fn todo_sequence(projection: &SessionProjection) -> u64 {
    projection
        .todo_list
        .as_ref()
        .map(|todo| todo.sequence)
        .unwrap_or(0)
}

fn last_timeline_sequence(projection: &SessionProjection) -> u64 {
    timeline_items(projection)
        .last()
        .map(TimelineItem::sequence)
        .unwrap_or(0)
}

fn render_run_state(projection: &SessionProjection) {
    if let Some(run) = projection.run.as_ref() {
        eprintln!("run {}: {}", run.run_id, run.status);
        render_usage(projection);
    }
}

fn render_terminal_error(projection: &SessionProjection) {
    if let Some(error) = projection.terminal_error.as_ref() {
        eprintln!("{}: {}", error.code, error.message);
    }
}

fn outcome_for_projection(projection: &SessionProjection) -> Option<Outcome> {
    outcome_for_status(&projection.run.as_ref()?.status)
}

fn outcome_for_status(status: &str) -> Option<Outcome> {
    match status {
        "failed" => Some(Outcome::Failed),
        "indeterminate" => Some(Outcome::Indeterminate),
        "completed" => Some(Outcome::Done),
        "cancelled" => Some(Outcome::Cancelled),
        "waiting" => Some(Outcome::ActionRequired),
        _ => None,
    }
}

fn require_session(session_id: Option<&str>) -> Result<&str, String> {
    session_id.ok_or_else(|| "该命令需要 --session <id>。".to_string())
}

fn required_arg<'a>(values: &'a [String], index: usize, option: &str) -> Result<&'a str, String> {
    values
        .get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("{option} 缺少参数。"))
}

fn new_id(kind: &str) -> String {
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{kind}:{}:{clock:x}:{sequence:x}", std::process::id())
}

fn print_help() {
    println!(
        r#"DeepCode 本地编码 Agent

用法：
  deepcode-cli ask [-C <workspace>] [--session <id>] [--plain] <message-or-response>
  deepcode-cli chat [-C <workspace>] [--session <id>]
  deepcode-cli show --session <id>
  deepcode-cli ignore-plan --session <id>
  deepcode-cli model --session <id> <profile-id>
  deepcode-cli cancel --session <id> <run-id>
  deepcode-cli attach-directory --session <id> <path>
  deepcode-cli detach-directory --session <id> <workspace-id>
  deepcode-cli open-resource --session <id> <workspace-id> <logical-path>
  deepcode-cli status

只有显式 -C/--workspace 会为新 Session 创建 creation binding；已有 Session 通过 attach-directory/detach-directory 管理对话目录索引。
Plan 等待时，数字 1..N 选择对应 option，其他非空输入作为调整反馈；ignore-plan 才表示忽略。
所有终端命令都通过 ConversationPort，并只读取共享 SessionProjection。"#,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ask_parser_keeps_explicit_workspace_and_message() {
        let args = Args::parse(vec![
            "ask".into(),
            "-C".into(),
            "/tmp/project".into(),
            "解释".into(),
            "代码".into(),
        ])
        .expect("ask parses");
        assert_eq!(args.workspace, Some(PathBuf::from("/tmp/project")));
        assert_eq!(args.command, Command::Ask("解释 代码".to_string()));
    }

    #[test]
    fn no_workspace_is_implicit() {
        let args = Args::parse(vec!["ask".into(), "解释".into()]).expect("ask parses");
        assert_eq!(args.workspace, None);
    }

    #[test]
    fn existing_session_rejects_workspace_rebinding() {
        assert!(Args::parse(vec![
            "ask".into(),
            "--session".into(),
            "s".into(),
            "-C".into(),
            "/tmp/project".into(),
            "继续".into(),
        ])
        .is_err());
    }

    #[test]
    fn direct_tool_commands_are_not_exposed() {
        assert!(Args::parse(vec!["tools".into(), "run".into(), "fs.write".into()]).is_err());
    }

    #[test]
    fn open_resource_parser_keeps_workspace_identity_and_logical_path() {
        let args = Args::parse(vec![
            "open-resource".into(),
            "--session".into(),
            "session:test".into(),
            "workspace:test".into(),
            "docs/设计 说明.md".into(),
        ])
        .expect("open-resource parses");
        assert_eq!(args.session_id.as_deref(), Some("session:test"));
        assert_eq!(
            args.command,
            Command::OpenResource {
                workspace_id: "workspace:test".to_string(),
                logical_path: "docs/设计 说明.md".to_string(),
            }
        );
    }

    #[test]
    fn failed_indeterminate_and_cancelled_are_distinct_nonzero_cli_outcomes() {
        assert_eq!(outcome_for_status("failed"), Some(Outcome::Failed));
        assert_eq!(
            outcome_for_status("indeterminate"),
            Some(Outcome::Indeterminate)
        );
        assert_eq!(outcome_for_status("cancelled"), Some(Outcome::Cancelled));
        assert_ne!(EXIT_RUN_FAILED, 0);
        assert_ne!(EXIT_RUN_INDETERMINATE, 0);
        assert_ne!(EXIT_RUN_CANCELLED, 0);
        assert_ne!(EXIT_RUN_FAILED, EXIT_RUN_INDETERMINATE);
        assert_ne!(EXIT_RUN_FAILED, EXIT_RUN_CANCELLED);
        assert_ne!(EXIT_RUN_INDETERMINATE, EXIT_RUN_CANCELLED);
    }
}
