use deepcode_kernel_client::{
    approval_response_command, cancel_command, focus_command, interaction_response_command,
    is_terminal_run_status, message_command_with_profile_and_plugins, plan_cancel_command,
    plan_confirm_command, plan_revision_command, ActivityProjection, ApprovalProjection,
    CreateConversationSessionRequest, FilesystemReference, FilesystemReferencePathInput,
    HttpKernelClient, InteractionProjection, KernelBootstrap, KernelBootstrapOptions,
    NarrativeProjection, PendingPlanProjection, PlanProjection, PluginCatalogProjection,
    PluginSelectionInput, ProjectionMessage, SessionProjection, SessionTimelineItem,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
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
        KernelBootstrapOptions::new(args.api.clone())
            .auto_start(!args.no_auto_start_kernel && !matches!(args.command, Command::StopHost)),
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
    StopHost,
    Diff {
        record_id: String,
        index: usize,
    },
    Ask(String),
    Chat,
    Show,
    Read {
        query: Value,
    },
    CancelPlan,
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
        start_byte: Option<u64>,
    },
}

#[derive(Debug, Clone)]
struct Args {
    api: Option<String>,
    no_auto_start_kernel: bool,
    workspace: Option<PathBuf>,
    session_id: Option<String>,
    plain: bool,
    plugins: Vec<String>,
    files: Vec<String>,
    directories: Vec<String>,
    command: Command,
}

impl Args {
    fn parse(values: Vec<String>) -> Result<Self, String> {
        let mut api = None;
        let mut no_auto_start_kernel = false;
        let mut workspace = None;
        let mut session_id = None;
        let mut plain = false;
        let mut plugins = Vec::new();
        let mut files = Vec::new();
        let mut directories = Vec::new();
        let mut read_query = serde_json::Map::new();
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
                "--view" | "--record" | "--request" | "--before" | "--limit" | "--offset" => {
                    let option = values[index].clone();
                    index += 1;
                    let value = required_arg(&values, index, &option)?;
                    let field = match option.as_str() {
                        "--view" => "view",
                        "--record" => "recordId",
                        "--request" => "providerRequestId",
                        "--before" => "before",
                        "--offset" => "offset",
                        _ => "limit",
                    };
                    let value = if matches!(field, "before" | "limit" | "offset") {
                        let number = value
                            .parse::<u64>()
                            .map_err(|_| format!("{option} 需要正整数。"))?;
                        if (number == 0 && field != "offset")
                            || (field == "limit" && number > 50)
                            || number > 9_007_199_254_740_991
                        {
                            return Err(format!("{option} 超出有效范围。"));
                        }
                        json!(number)
                    } else {
                        json!(value)
                    };
                    read_query.insert(field.into(), value);
                }
                "--plain" => plain = true,
                "--plugin" => {
                    index += 1;
                    plugins.push(required_arg(&values, index, "--plugin")?.to_string());
                }
                "--file" => {
                    index += 1;
                    files.push(required_arg(&values, index, "--file")?.to_string());
                }
                "--directory" => {
                    index += 1;
                    directories.push(required_arg(&values, index, "--directory")?.to_string());
                }
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
            Some("stop-host") if positional.len() == 1 => Command::StopHost,
            Some("diff") if positional.len() == 3 => Command::Diff {
                record_id: positional[1].clone(),
                index: positional[2]
                    .parse()
                    .map_err(|_| "diff index must be a nonnegative integer")?,
            },
            Some("chat") => Command::Chat,
            Some("show") => Command::Show,
            Some("read") => {
                if positional.len() != 1 || session_id.is_none() {
                    return Err("用法：read --session <id> [--view summary|messages|tools|plans|context|reasoning] [--before <sequence>] [--limit 1..50]".into());
                }
                Command::Read {
                    query: Value::Object(read_query.clone()),
                }
            }
            Some("ask") => {
                let text = positional[1..].join(" ");
                if text.trim().is_empty() {
                    return Err("ask 需要非空输入。".to_string());
                }
                Command::Ask(text)
            }
            Some("cancel-plan") => {
                if positional.len() != 1 {
                    return Err("用法：cancel-plan --session <id>".to_string());
                }
                Command::CancelPlan
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
                if positional.len() != 3 && positional.len() != 4 {
                    return Err(
                        "用法：open-resource --session <id> <workspace-id> <logical-path>"
                            .to_string(),
                    );
                }
                Command::OpenResource {
                    workspace_id: positional[1].clone(),
                    logical_path: positional[2].clone(),
                    start_byte: positional
                        .get(3)
                        .map(|value| value.parse::<u64>().map_err(|_| "invalid startByte"))
                        .transpose()?,
                }
            }
            Some(other) => return Err(format!("未知命令：{other}")),
        };
        if !read_query.is_empty() && !matches!(command, Command::Read { .. }) {
            return Err("--view/--record/--request/--before/--limit 仅用于 read。".into());
        }
        Ok(Self {
            api,
            no_auto_start_kernel,
            workspace,
            session_id,
            plain,
            plugins,
            files,
            directories,
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

#[derive(Debug, Clone)]
struct PluginBinding {
    catalog_revision: String,
    selections: Vec<PluginSelectionInput>,
}

async fn resolve_plugin_selections(
    client: &HttpKernelClient,
    plugin_uris: &[String],
    filesystem_references: &[FilesystemReference],
) -> Result<Option<PluginBinding>, String> {
    if plugin_uris.is_empty() && filesystem_references.is_empty() {
        return Ok(None);
    }
    let catalog = client
        .conversation_plugin_catalog()
        .await
        .map_err(|error| error.to_string())?;
    let mut effective_uris = plugin_uris.to_vec();
    for reference in filesystem_references {
        if reference.kind != "file" {
            continue;
        }
        let Some(media_type) = reference.media_type.as_deref() else {
            return Err("文件引用缺少 mediaType。".to_string());
        };
        let matches = catalog
            .plugins
            .iter()
            .filter(|plugin| {
                plugin
                    .activation_media_types
                    .iter()
                    .any(|candidate| candidate == media_type)
            })
            .collect::<Vec<_>>();
        if media_type == "application/pdf" && matches.len() != 1 {
            return Err("plugin_selection_unavailable:application/pdf".to_string());
        }
        if let [plugin] = matches.as_slice() {
            effective_uris.push(plugin.uri.clone());
        }
    }
    if effective_uris.is_empty() {
        return Ok(None);
    }
    plugin_binding_from_catalog(catalog, &effective_uris).map(Some)
}

async fn resolve_cli_filesystem_references(
    client: &HttpKernelClient,
    session_id: &str,
    files: &[String],
    directories: &[String],
) -> Result<Vec<FilesystemReference>, String> {
    if files.len() + directories.len() > 8 {
        return Err("单次 ask 最多附加八个文件系统引用。".to_string());
    }
    let references = files
        .iter()
        .map(|path| FilesystemReferencePathInput {
            path: path.clone(),
            kind: "file".to_string(),
        })
        .chain(directories.iter().map(|path| FilesystemReferencePathInput {
            path: path.clone(),
            kind: "directory".to_string(),
        }))
        .collect::<Vec<_>>();
    if references.is_empty() {
        return Ok(Vec::new());
    }
    client
        .resolve_conversation_filesystem_references(session_id, references)
        .await
        .map_err(|error| error.to_string())
}

fn plugin_binding_from_catalog(
    catalog: PluginCatalogProjection,
    plugin_uris: &[String],
) -> Result<PluginBinding, String> {
    let mut seen = HashSet::new();
    let mut selections = Vec::with_capacity(plugin_uris.len());
    for uri in plugin_uris {
        if !seen.insert(uri.as_str()) {
            continue;
        }
        let plugin = catalog
            .plugins
            .iter()
            .find(|plugin| plugin.uri == *uri)
            .ok_or_else(|| format!("插件不在当前目录中或不可用：{uri}"))?;
        selections.push(PluginSelectionInput {
            selection_id: new_id("plugin-selection"),
            uri: plugin.uri.clone(),
            label: plugin.display_name.clone(),
        });
    }
    Ok(PluginBinding {
        catalog_revision: catalog.revision,
        selections,
    })
}

async fn run(client: &HttpKernelClient, args: Args) -> Result<Outcome, String> {
    if !args.plugins.is_empty() && !matches!(&args.command, Command::Ask(_) | Command::Chat) {
        return Err("--plugin 只适用于 ask 或 chat。".to_string());
    }
    if (!args.files.is_empty() || !args.directories.is_empty())
        && !matches!(&args.command, Command::Ask(_))
    {
        return Err("--file/--directory 只适用于单次 ask。".to_string());
    }
    match args.command {
        Command::Help => Ok(Outcome::Done),
        Command::StopHost => {
            client
                .stop_host()
                .await
                .map_err(|error| error.to_string())?;
            println!("共享 Host 已接纳停止请求。");
            Ok(Outcome::Done)
        }
        Command::Diff { record_id, index } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let change = client
                .conversation_change_read(session_id, &record_id, index)
                .await
                .map_err(|error| error.to_string())?;
            print!("{}", change.unified_diff());
            Ok(Outcome::Done)
        }
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
            let filesystem_references = resolve_cli_filesystem_references(
                client,
                &projection.session_id,
                &args.files,
                &args.directories,
            )
            .await?;
            let plugin_binding =
                resolve_plugin_selections(client, &args.plugins, &filesystem_references).await?;
            if !args.plain {
                eprintln!("session: {}", projection.session_id);
            }
            submit_input_and_wait(
                client,
                &projection,
                &text,
                None,
                &filesystem_references,
                plugin_binding.as_ref(),
                args.plain,
            )
            .await
        }
        Command::Chat => {
            run_chat(
                client,
                args.session_id.as_deref(),
                args.workspace.as_ref(),
                &args.plugins,
            )
            .await
        }
        Command::Read { query } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let result = client
                .conversation_read(session_id, &query)
                .await
                .map_err(|error| error.to_string())?;
            println!(
                "{}",
                serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
            );
            Ok(Outcome::Done)
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
        Command::CancelPlan => {
            let session_id = require_session(args.session_id.as_deref())?;
            let before = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            let plan = before
                .pending_plan
                .as_ref()
                .ok_or_else(|| "当前没有待处理 Plan。".to_string())?;
            let command = plan_cancel_command(session_id, &new_id("command"), plan);
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
            let before = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            let projection = client
                .attach_conversation_directory_index(session_id, &path)
                .await
                .map_err(|error| error.to_string())?;
            let added = projection
                .session_directory_indexes
                .iter()
                .filter(|binding| {
                    before
                        .session_directory_indexes
                        .iter()
                        .all(|existing| existing.workspace_id != binding.workspace_id)
                })
                .collect::<Vec<_>>();
            if let [binding] = added.as_slice() {
                println!(
                    "已附加目录索引：{} ({})；从下一次 run 起生效。",
                    binding.display_name, binding.workspace_id
                );
            } else {
                println!("目录索引集合已更新；从下一次 run 起使用共享投影中的有效目录集合。");
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
            start_byte,
        } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let resource = client
                .conversation_resource_read_range(
                    session_id,
                    &workspace_id,
                    &logical_path,
                    start_byte,
                )
                .await
                .map_err(|error| error.to_string())?;
            if let Some(next) = resource.next_byte {
                eprintln!("部分内容；续读：deepcode-cli open-resource --session {session_id} {workspace_id} {logical_path:?} {next}");
            }
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
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    plugin_binding: Option<&PluginBinding>,
    plain: bool,
) -> Result<Outcome, String> {
    let command = contextual_input_command(
        before,
        text,
        profile_id,
        filesystem_references,
        plugin_binding,
    )?;
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
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    plugin_binding: Option<&PluginBinding>,
) -> Result<serde_json::Value, String> {
    let original_text = text;
    let text = text.trim();
    if text.is_empty() {
        return Err("输入不能为空。".to_string());
    }
    let has_plugin_selection = plugin_binding.is_some_and(|binding| !binding.selections.is_empty());
    let has_filesystem_references = !filesystem_references.is_empty();
    if let Some(approval) = projection.pending_approval.as_ref() {
        if has_plugin_selection || has_filesystem_references {
            return Err("插件和文件系统引用不能用于已有 run 的 effect 回应。".to_string());
        }
        let decision = approval_decision_for_input(text)?;
        return Ok(approval_response_command(
            &projection.session_id,
            &new_id("command"),
            approval,
            decision,
        ));
    }
    if let Some(plan) = projection.pending_plan.as_ref() {
        if has_plugin_selection || has_filesystem_references {
            return Err("插件和文件系统引用不能用于已有 run 的 Plan 回应。".to_string());
        }
        if is_plan_confirmation_input(text) {
            return Ok(plan_confirm_command(
                &projection.session_id,
                &new_id("command"),
                plan,
            ));
        }
        return Ok(plan_revision_command(
            &projection.session_id,
            &new_id("command"),
            plan,
            text,
        ));
    }
    if let Some(interaction) = projection.pending_interaction.as_ref() {
        if has_plugin_selection || has_filesystem_references {
            return Err("插件和文件系统引用不能用于已有 run 的交互回应。".to_string());
        }
        let response = interaction_response_for_input(interaction, text);
        return Ok(interaction_response_command(
            &projection.session_id,
            &new_id("command"),
            interaction,
            &response,
        ));
    }
    let empty = PluginBinding {
        catalog_revision: String::new(),
        selections: Vec::new(),
    };
    let plugins = plugin_binding.unwrap_or(&empty);
    if let Some(task) = text.strip_prefix("/focus") {
        if !task.is_empty() && !task.chars().next().is_some_and(char::is_whitespace) {
            return Err("未知命令；/focus 后必须以空格分隔任务正文。".to_string());
        }
        let task = task.trim();
        if task.is_empty() {
            return Err("/focus 需要非空任务正文。".to_string());
        }
        return Ok(focus_command(
            &projection.session_id,
            &new_id("command"),
            task,
            profile_id,
            filesystem_references,
            &plugins.catalog_revision,
            &plugins.selections,
        ));
    }
    if text.starts_with('/') {
        return Err(format!("未知命令：{text}"));
    }
    Ok(message_command_with_profile_and_plugins(
        &projection.session_id,
        &new_id("command"),
        original_text,
        profile_id,
        filesystem_references,
        &plugins.catalog_revision,
        &plugins.selections,
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
    let mut live_text = HashMap::<String, String>::new();
    let mut live_stream: Option<String> = None;
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
                let live_stream_visible =
                    projection.assistant_draft.as_ref().is_some_and(|draft| {
                        draft.blocks.iter().any(|block| {
                            block.text().is_some_and(|(stream_id, _)| {
                                live_stream.as_deref() == Some(stream_id)
                            })
                        })
                    });
                if !live_stream_visible && live_open {
                    eprintln!();
                    live_open = false;
                }
                render_increment_except(&projection, rendered_sequence, Some(&mut live_text));
                if projection
                    .todo_list
                    .as_ref()
                    .is_some_and(|todo| todo.sequence > rendered_todo_sequence)
                {
                    render_todo(&projection);
                }
            }
            rendered_sequence = last_timeline_sequence(&projection);
            rendered_todo_sequence = todo_sequence(&projection);
            last_revision = projection.revision;
        }
        if !plain {
            if let Some(draft) = projection.assistant_draft.as_ref() {
                if let Some(preview) = draft.plan_preview.as_ref() {
                    let key = format!(
                        "plan-preview:{}:{}",
                        draft.turn_id, preview.provider_call_id
                    );
                    let status = format!(
                        "正在生成计划 · {} · {} 个步骤",
                        preview.title,
                        preview.steps.len()
                    );
                    if live_text.get(&key) != Some(&status) {
                        if live_open {
                            eprintln!();
                            live_open = false;
                        }
                        eprintln!("{status}");
                        live_text.insert(key, status);
                    }
                }
                for block in &draft.blocks {
                    let Some((stream_id, content)) = block.text() else {
                        continue;
                    };
                    let previous = live_text.get(stream_id).map(String::as_str).unwrap_or("");
                    if content == previous {
                        continue;
                    }
                    if live_stream.as_deref() != Some(stream_id) && live_open {
                        eprintln!();
                        live_open = false;
                    }
                    if let Some(delta) = content.strip_prefix(previous) {
                        eprint!("{delta}");
                    } else {
                        if live_open {
                            eprintln!();
                        }
                        eprint!("{content}");
                    }
                    io::stderr().flush().map_err(|error| error.to_string())?;
                    live_open = true;
                    live_stream = Some(stream_id.to_string());
                    live_text.insert(stream_id.to_string(), content.to_string());
                }
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
    initial_plugin_uris: &[String],
) -> Result<Outcome, String> {
    if !io::stdin().is_terminal() {
        return Err("chat 需要交互式终端；非交互调用请使用 ask。".to_string());
    }
    let mut projection = open_session(client, session_id, workspace).await?;
    let mut plugin_catalog = client
        .conversation_plugin_catalog()
        .await
        .map_err(|error| error.to_string())?;
    let mut selected_plugins = if initial_plugin_uris.is_empty() {
        Vec::new()
    } else {
        plugin_binding_from_catalog(plugin_catalog.clone(), initial_plugin_uris)?.selections
    };
    println!("session: {}", projection.session_id);
    println!("普通文本用于消息、交互回应或 Plan 修订；Plan 输入 1/确认后执行；effect 审批输入 1/允许或 2/拒绝；@ 显示插件，@<名称或 URI> 为下一次请求选择插件；/focus <task> 启动聚焦上下文；/attach <path> 与 /detach <workspace-id> 管理对话目录索引；/cancel-plan；/model <profile> 设置后续消息草稿；/cancel；/quit。");
    render_action_required_if_any(&projection);
    let mut line = String::new();
    let mut next_message_profile_id: Option<String> = None;
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
            "/cancel-plan" => {
                let plan = projection
                    .pending_plan
                    .as_ref()
                    .ok_or_else(|| "当前没有待处理 Plan。".to_string())?;
                let command = plan_cancel_command(&projection.session_id, &new_id("command"), plan);
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
                if profile_id.is_empty() {
                    println!("用法：/model <profile>");
                    continue;
                }
                next_message_profile_id = Some(profile_id.to_string());
                println!("后续普通消息将提交模型 Profile {profile_id}；当前 run 不变。");
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
            value if value.starts_with('@') => {
                let query = value.trim_start_matches('@').trim();
                if query.is_empty() {
                    plugin_catalog = client
                        .conversation_plugin_catalog()
                        .await
                        .map_err(|error| error.to_string())?;
                    print_plugin_catalog(&plugin_catalog, &selected_plugins, "");
                    continue;
                }
                let exact = plugin_catalog.plugins.iter().find(|plugin| {
                    plugin.uri == query || plugin.display_name.eq_ignore_ascii_case(query)
                });
                if let Some(plugin) = exact {
                    if selected_plugins
                        .iter()
                        .any(|selection| selection.uri == plugin.uri)
                    {
                        println!("插件已为下一次请求选择：{}", plugin.display_name);
                    } else {
                        selected_plugins.push(PluginSelectionInput {
                            selection_id: new_id("plugin-selection"),
                            uri: plugin.uri.clone(),
                            label: plugin.display_name.clone(),
                        });
                        println!("已为下一次请求选择插件：{}", plugin.display_name);
                    }
                } else {
                    print_plugin_catalog(&plugin_catalog, &selected_plugins, query);
                }
            }
            text if !text.starts_with('/') || text == "/focus" || text.starts_with("/focus ") => {
                let consumes_plugins = projection.pending_plan.is_none()
                    && projection.pending_interaction.is_none()
                    && projection.pending_approval.is_none();
                let plugin_binding = if selected_plugins.is_empty() {
                    None
                } else {
                    Some(PluginBinding {
                        catalog_revision: plugin_catalog.revision.clone(),
                        selections: selected_plugins.clone(),
                    })
                };
                let outcome = submit_input_and_wait(
                    client,
                    &projection,
                    line.trim_end_matches(['\r', '\n']),
                    next_message_profile_id.as_deref(),
                    &[],
                    plugin_binding.as_ref(),
                    false,
                )
                .await?;
                if consumes_plugins {
                    selected_plugins.clear();
                }
                projection = refresh_projection(client, &projection.session_id).await?;
                if matches!(
                    outcome,
                    Outcome::Failed | Outcome::Indeterminate | Outcome::Cancelled
                ) {
                    return Ok(outcome);
                }
            }
            value if value.starts_with('/') => println!("未知命令：{value}"),
            _ => unreachable!("all non-slash input is handled above"),
        }
    }
}

fn print_plugin_catalog(
    catalog: &PluginCatalogProjection,
    selected: &[PluginSelectionInput],
    query: &str,
) {
    let query = query.to_lowercase();
    let matches = catalog.plugins.iter().filter(|plugin| {
        query.is_empty()
            || plugin.display_name.to_lowercase().contains(&query)
            || plugin.uri.to_lowercase().contains(&query)
    });
    let mut found = false;
    for plugin in matches {
        found = true;
        let marker = if selected.iter().any(|selection| selection.uri == plugin.uri) {
            "*"
        } else {
            " "
        };
        println!(
            "{marker} {}\n    {}\n    {}",
            plugin.display_name, plugin.uri, plugin.short_description
        );
    }
    if !found {
        println!("没有匹配的可用插件。");
    } else {
        println!("输入 @<完整名称或 plugin:// URI> 为下一次请求选择插件。");
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
    mut streamed_text: Option<&mut HashMap<String, String>>,
) {
    let items = timeline_items(projection);
    let last_by_run: HashMap<_, _> = items
        .iter()
        .filter_map(|item| item.run_id().map(|run| (run.to_string(), item.sequence())))
        .collect();
    for item in items
        .into_iter()
        .filter(|item| item.sequence() > after_sequence)
    {
        let last_run = item
            .run_id()
            .filter(|run| last_by_run.get(*run) == Some(&item.sequence()))
            .map(str::to_string);
        match item {
            TimelineItem::Message {
                value: message,
                stream_id,
                ..
            } => {
                if !render_stream_remainder(
                    &message.content,
                    stream_id,
                    streamed_text.as_deref_mut(),
                ) {
                    println!("{}: {}", message.role, message.content);
                    render_attachments(message);
                }
            }
            TimelineItem::Narrative {
                value: narrative,
                stream_id,
                ..
            } => {
                if !render_stream_remainder(
                    &narrative.content,
                    Some(stream_id),
                    streamed_text.as_deref_mut(),
                ) {
                    println!("{}", narrative.content);
                }
            }
            TimelineItem::Plan { value: plan, .. } => render_timeline_plan(plan),
            TimelineItem::ToolGroup { activities, .. } => {
                for activity in activities {
                    render_tool_activity(projection, activity);
                }
            }
        }
        if let Some(run_id) = last_run {
            let changes = projection.file_changes_for_run(&run_id);
            if !changes.is_empty() {
                println!("本轮修改 · {run_id}");
                for (record, index, change) in changes {
                    println!(
                        "  {} {} · deepcode-cli diff --session {} {} {}",
                        change.kind, change.path, projection.session_id, record, index
                    );
                }
            }
        }
    }
}

fn render_stream_remainder(
    content: &str,
    stream_id: Option<&str>,
    streamed_text: Option<&mut HashMap<String, String>>,
) -> bool {
    let (Some(stream_id), Some(streamed_text)) = (stream_id, streamed_text) else {
        return false;
    };
    let Some(previous) = streamed_text.insert(stream_id.to_string(), content.to_string()) else {
        return false;
    };
    let Some(remaining) = content.strip_prefix(previous.as_str()) else {
        return false;
    };
    if !remaining.is_empty() {
        eprintln!("{remaining}");
    }
    true
}

fn render_tool_activity(projection: &SessionProjection, activity: &ActivityProjection) {
    let operation = activity
        .tool
        .as_ref()
        .map(|tool| tool.operation.as_str())
        .unwrap_or(activity.label.as_str());
    println!("工具 {operation} [{}]", activity.status);
    if let Some(tool) = activity.tool.as_ref() {
        if let Some(shell) = tool.shell.as_ref() {
            println!("  $ {}", shell.command);
            println!("  cwd: {}", shell.cwd);
            if let Some(result) = shell.result.as_ref() {
                println!(
                    "  environment: shell={} · interactive={} · pathSource={} · writeScope={} · homeWritable={}",
                    result.environment.shell,
                    result.environment.interactive,
                    result.environment.path_source,
                    result.environment.write_scope,
                    result.environment.home_writable,
                );
                let exit = result
                    .exit_code
                    .map_or_else(|| "signal/timeout".to_string(), |code| code.to_string());
                println!(
                    "  exit: {exit} · {} ms · {} bytes{}{}",
                    result.duration_ms,
                    result.captured_bytes,
                    if result.timed_out {
                        " · timed out"
                    } else {
                        ""
                    },
                    if result.truncated {
                        " · truncated"
                    } else {
                        ""
                    },
                );
                print_tool_stream("stdout", &result.stdout);
                print_tool_stream("stderr", &result.stderr);
            }
        }
        for (index, change) in tool.file_changes.iter().enumerate() {
            if let Some(record) = &tool.record_id {
                println!(
                    "  {} {} -> deepcode-cli diff --session {} {} {}",
                    change.kind, change.path, projection.session_id, record, index
                );
            }
        }
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

fn print_tool_stream(label: &str, output: &str) {
    if output.is_empty() {
        return;
    }
    println!("  {label}:");
    for line in output.lines() {
        println!("    {line}");
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
    let cache = match (usage.cache_available, usage.cache_hit_ratio) {
        (true, Some(ratio)) => format!("{:.0}%", ratio * 100.0),
        _ => "--%".to_string(),
    };
    let coverage = if usage.cache_complete {
        "complete"
    } else if usage.cache_available {
        "partial"
    } else {
        "unavailable"
    };
    eprintln!(
        "Provider 调用 {} · 输入 {} · 输出 {} · 缓存命中 {} · 缓存读取 {} · 缓存未命中 {} · 缓存报告 {}/{} ({})",
        usage.provider_call_count,
        usage.input_tokens,
        usage.output_tokens,
        cache,
        usage.cache_read_input_tokens,
        usage.cache_miss_input_tokens,
        usage.reported_call_count,
        usage.provider_call_count,
        coverage,
    );
}

fn render_attachments(message: &ProjectionMessage) {
    if !message.filesystem_references.is_empty() {
        println!(
            "  文件系统引用：{}",
            message
                .filesystem_references
                .iter()
                .map(|reference| reference.display_name.as_str())
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
            "输入 1/确认；输入其他非空文本请求修订；显式运行 `deepcode-cli cancel-plan --session {}` 取消。",
            projection.session_id,
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
    println!("Plan · revision {}", plan.revision);
    println!("{}", plan.title);
    println!("{}", plan.summary);
    for (index, step) in plan.steps.iter().enumerate() {
        println!("{}. {}", index + 1, step.title);
        println!("   {}", step.details);
        if let Some(verification) = step.verification.as_ref() {
            for item in verification {
                println!("   验证：{item}");
            }
        }
    }
}

fn render_timeline_plan(plan: &PlanProjection) {
    println!("Plan · revision {} · {}", plan.revision, plan.status);
    println!("{}", plan.title);
    println!("{}", plan.summary);
    for (index, step) in plan.steps.iter().enumerate() {
        println!("{}. {}", index + 1, step.title);
        println!("   {}", step.details);
        if let Some(verification) = step.verification.as_ref() {
            for item in verification {
                println!("   验证：{item}");
            }
        }
    }
}

fn is_plan_confirmation_input(input: &str) -> bool {
    matches!(
        input.trim().to_ascii_lowercase().as_str(),
        "1" | "y" | "yes" | "confirm"
    ) || matches!(input.trim(), "确认" | "同意")
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
    Message {
        sequence: u64,
        value: &'a ProjectionMessage,
        stream_id: Option<&'a str>,
    },
    Narrative {
        sequence: u64,
        value: &'a NarrativeProjection,
        stream_id: &'a str,
    },
    Plan {
        sequence: u64,
        value: &'a PlanProjection,
    },
    ToolGroup {
        sequence: u64,
        activities: Vec<&'a ActivityProjection>,
    },
}

impl TimelineItem<'_> {
    fn run_id(&self) -> Option<&str> {
        match self {
            Self::Message { value, .. } => value.run_id.as_deref(),
            Self::Narrative { value, .. } => Some(&value.run_id),
            Self::Plan { value, .. } => Some(&value.run_id),
            Self::ToolGroup { activities, .. } => {
                activities.first().map(|activity| activity.run_id.as_str())
            }
        }
    }

    fn sequence(&self) -> u64 {
        match self {
            Self::Message { sequence, .. }
            | Self::Narrative { sequence, .. }
            | Self::Plan { sequence, .. }
            | Self::ToolGroup { sequence, .. } => *sequence,
        }
    }
}

fn timeline_items(projection: &SessionProjection) -> Vec<TimelineItem<'_>> {
    projection
        .timeline
        .iter()
        .map(|item| match item {
            SessionTimelineItem::Message {
                sequence,
                message_id,
                stream_id,
                ..
            } => TimelineItem::Message {
                sequence: *sequence,
                stream_id: stream_id.as_deref(),
                value: projection
                    .messages
                    .iter()
                    .find(|message| message.message_id == *message_id)
                    .expect("validated Session timeline message reference"),
            },
            SessionTimelineItem::Narrative {
                sequence,
                narrative_id,
                stream_id,
                ..
            } => TimelineItem::Narrative {
                sequence: *sequence,
                stream_id,
                value: projection
                    .narratives
                    .iter()
                    .find(|narrative| narrative.narrative_id == *narrative_id)
                    .expect("validated Session timeline narrative reference"),
            },
            SessionTimelineItem::Plan {
                sequence,
                plan_id,
                revision,
                ..
            } => TimelineItem::Plan {
                sequence: *sequence,
                value: projection
                    .plans
                    .iter()
                    .find(|plan| plan.plan_id == *plan_id && plan.revision == *revision)
                    .expect("validated Session timeline plan reference"),
            },
            SessionTimelineItem::ToolGroup {
                sequence,
                activity_ids,
                ..
            } => TimelineItem::ToolGroup {
                sequence: *sequence,
                activities: activity_ids
                    .iter()
                    .map(|activity_id| {
                        projection
                            .activities
                            .iter()
                            .find(|activity| activity.activity_id == *activity_id)
                            .expect("validated Session timeline activity reference")
                    })
                    .collect(),
            },
        })
        .collect()
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
        "failed" | "releaseFailed" => Some(Outcome::Failed),
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
  deepcode-cli ask [-C <workspace>] [--session <id>] [--file <path>]... [--directory <path>]... [--plugin <plugin://uri>]... [--plain] <message-or-response>
  deepcode-cli chat [-C <workspace>] [--session <id>] [--plugin <plugin://uri>]...
  deepcode-cli show --session <id>
  deepcode-cli read --session <id> [--view summary|messages|tools|plans|context|reasoning] [--before <sequence>] [--limit 1..50] [--record <id>] [--request <id>]
  deepcode-cli cancel-plan --session <id>
  deepcode-cli cancel --session <id> <run-id>
  deepcode-cli attach-directory --session <id> <path>
  deepcode-cli detach-directory --session <id> <workspace-id>
  deepcode-cli open-resource --session <id> <workspace-id> <logical-path>
  deepcode-cli diff --session <id> <record-id> <file-index>
  deepcode-cli stop-host
  deepcode-cli status

只有显式 -C/--workspace 会为新 Session 创建 creation binding；已有 Session 通过 attach-directory/detach-directory 管理对话目录索引。
Plan 等待时，输入 1/确认，其他非空输入作为修订说明；cancel-plan 明确取消。
文件与目录引用只在 ask 中显式选择；--file 与 --directory 均可重复，文件内容不会嵌入首轮 Provider 请求。
插件只在 ask/chat 中显式选择；--plugin 可重复。PDF 文件按 mediaType 要求一个已配置的 Skill 插件。交互 chat 使用 @ 查看并选择下一次请求的插件，/focus <task> 作为类型化命令提交。
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
    fn ask_parser_keeps_repeatable_filesystem_references() {
        let args = Args::parse(vec![
            "ask".into(),
            "--file".into(),
            "/tmp/report.pdf".into(),
            "--file".into(),
            "/tmp/notes.txt".into(),
            "--directory".into(),
            "/tmp/project".into(),
            "检查引用".into(),
        ])
        .expect("ask references parse");
        assert_eq!(args.files, ["/tmp/report.pdf", "/tmp/notes.txt"]);
        assert_eq!(args.directories, ["/tmp/project"]);
        assert_eq!(args.command, Command::Ask("检查引用".to_string()));
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
                start_byte: None,
            }
        );
    }

    #[test]
    fn failed_indeterminate_and_cancelled_are_distinct_nonzero_cli_outcomes() {
        assert_eq!(outcome_for_status("failed"), Some(Outcome::Failed));
        assert_eq!(outcome_for_status("releaseFailed"), Some(Outcome::Failed));
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
