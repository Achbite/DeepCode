mod render;

use deepcode_kernel_client::{
    approval_response_command, cancel_command, focus_command, interaction_response_command,
    is_terminal_run_status, message_command_with_profile_and_plugins, plan_cancel_command,
    plan_confirm_command, plan_revision_command, CreateConversationSessionRequest,
    FilesystemReference, FilesystemReferencePathInput, HttpKernelClient, InteractionProjection,
    KernelBootstrap, KernelBootstrapOptions, PluginCatalogProjection, PluginSelectionInput,
    SessionProjection,
};
use render::{
    render_action_required_if_any, render_projection, render_run_state, render_terminal_error,
    CliRenderState,
};
use serde_json::{json, Value};
use std::collections::HashSet;
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
            render_projection(&mut io::stdout().lock(), &projection)
                .map_err(|error| error.to_string())?;
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
            wait_for_projection(client, &before, args.plain).await
        }
        Command::Cancel { run_id } => {
            let session_id = require_session(args.session_id.as_deref())?;
            let command = cancel_command(session_id, &new_id("command"), &run_id);
            submit_checked(client, session_id, &command).await?;
            let projection = client
                .conversation_projection(session_id)
                .await
                .map_err(|error| error.to_string())?;
            render_run_state(&mut io::stdout().lock(), &projection)
                .map_err(|error| error.to_string())?;
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
    wait_for_projection(client, before, plain).await
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
    before: &SessionProjection,
    plain: bool,
) -> Result<Outcome, String> {
    let timeout = env::var("DEEPCODE_CLI_RUN_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_RUN_TIMEOUT);
    let deadline = Instant::now() + timeout;
    let session_id = &before.session_id;
    let mut output = if plain {
        CliRenderState::default()
    } else {
        CliRenderState::after(before)
    };
    loop {
        if Instant::now() >= deadline {
            output
                .finish_text(&mut io::stdout().lock())
                .map_err(|error| error.to_string())?;
            return Err("等待 Agent 运行结束超时。".to_string());
        }
        let projection = match client.conversation_projection(session_id).await {
            Ok(projection) => projection,
            Err(error) => {
                output
                    .finish_text(&mut io::stdout().lock())
                    .map_err(|error| error.to_string())?;
                return Err(error.to_string());
            }
        };
        if !plain {
            output
                .render(&mut io::stdout().lock(), &projection)
                .map_err(|error| error.to_string())?;
        }
        if let Some(run) = projection.run.as_ref() {
            if run.status == "waiting" {
                output
                    .render_action_required(&mut io::stdout().lock(), &projection)
                    .map_err(|error| error.to_string())?;
                return Ok(Outcome::ActionRequired);
            }
            if is_terminal_run_status(&run.status) {
                if plain && run.status == "completed" {
                    if let Some(text) = projection.last_assistant_text(before.messages.len()) {
                        println!("{text}");
                    }
                } else if !plain {
                    let mut stdout = io::stdout().lock();
                    output
                        .finish_run(&mut stdout, &projection)
                        .map_err(|error| error.to_string())?;
                    render_run_state(&mut stdout, &projection)
                        .map_err(|error| error.to_string())?;
                    stdout.flush().map_err(|error| error.to_string())?;
                }
                render_terminal_error(&mut io::stderr().lock(), &projection)
                    .map_err(|error| error.to_string())?;
                return Ok(outcome_for_projection(&projection).unwrap_or(Outcome::Done));
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
            interrupted = tokio::signal::ctrl_c() => {
                interrupted.map_err(|error| error.to_string())?;
                output.finish_text(&mut io::stdout().lock()).map_err(|error| error.to_string())?;
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
    render_action_required_if_any(&mut io::stdout().lock(), &projection)
        .map_err(|error| error.to_string())?;
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
            "/show" => render_projection(&mut io::stdout().lock(), &projection)
                .map_err(|error| error.to_string())?,
            "/cancel-plan" => {
                let plan = projection
                    .pending_plan
                    .as_ref()
                    .ok_or_else(|| "当前没有待处理 Plan。".to_string())?;
                let command = plan_cancel_command(&projection.session_id, &new_id("command"), plan);
                submit_checked(client, &projection.session_id, &command).await?;
                let outcome = wait_for_projection(client, &projection, false).await?;
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
                    render_run_state(&mut io::stdout().lock(), &projection)
                        .map_err(|error| error.to_string())?;
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

fn is_plan_confirmation_input(input: &str) -> bool {
    matches!(
        input.trim().to_ascii_lowercase().as_str(),
        "1" | "y" | "yes" | "confirm"
    ) || matches!(input.trim(), "确认" | "同意")
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
