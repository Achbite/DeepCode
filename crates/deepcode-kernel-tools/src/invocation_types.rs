use crate::types::ToolValidationError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_CANONICAL_INVOCATION_BYTES: usize = 1024 * 1024;
const MAX_ORDINARY_STRING_BYTES: usize = 16 * 1024;

fn empty_field(field: &'static str) -> ToolValidationError {
    ToolValidationError::EmptyField { field }
}

fn field_too_large(field: &'static str, maximum_bytes: usize) -> ToolValidationError {
    ToolValidationError::FieldTooLarge {
        field,
        maximum_bytes,
    }
}

fn invalid_value(field: &'static str, reason: &'static str) -> ToolValidationError {
    ToolValidationError::InvalidValue { field, reason }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum KernelToolKind {
    #[serde(rename = "fs.delete")]
    FsDelete,
    #[serde(rename = "fs.edit")]
    FsEdit,
    #[serde(rename = "fs.read")]
    FsRead,
    #[serde(rename = "fs.write")]
    FsWrite,
    #[serde(rename = "bash")]
    ProcessShell,
    #[serde(rename = "web.fetch")]
    WebFetch,
    #[serde(rename = "web.search")]
    WebSearch,
}

impl KernelToolKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FsDelete => "fs.delete",
            Self::FsEdit => "fs.edit",
            Self::FsRead => "fs.read",
            Self::FsWrite => "fs.write",
            Self::ProcessShell => "bash",
            Self::WebFetch => "web.fetch",
            Self::WebSearch => "web.search",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelWorkspaceMode {
    Read,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelTextEdit {
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelDeleteTarget {
    File { path: String },
    DirectoryTree { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "toolId",
    content = "arguments",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelCanonicalInvocation {
    #[serde(rename = "fs.read")]
    FsRead {
        path: String,
        start_line: u32,
        max_lines: u32,
        max_bytes: u32,
    },
    #[serde(rename = "fs.write")]
    FsWrite {
        path: String,
        content: String,
        executable: Option<bool>,
    },
    #[serde(rename = "fs.edit")]
    FsEdit {
        path: String,
        edits: Vec<KernelTextEdit>,
    },
    #[serde(rename = "fs.delete")]
    FsDelete(KernelDeleteTarget),
    #[serde(rename = "bash")]
    ProcessShell {
        command: String,
        workspace_mode: KernelWorkspaceMode,
        timeout: u32,
    },
    #[serde(rename = "web.search")]
    WebSearch { query: String, limit: u32 },
    #[serde(rename = "web.fetch")]
    WebFetch { url: String, max_bytes: u32 },
}

impl KernelCanonicalInvocation {
    pub fn tool_id(&self) -> KernelToolKind {
        match self {
            Self::FsRead { .. } => KernelToolKind::FsRead,
            Self::FsWrite { .. } => KernelToolKind::FsWrite,
            Self::FsEdit { .. } => KernelToolKind::FsEdit,
            Self::FsDelete(_) => KernelToolKind::FsDelete,
            Self::ProcessShell { .. } => KernelToolKind::ProcessShell,
            Self::WebSearch { .. } => KernelToolKind::WebSearch,
            Self::WebFetch { .. } => KernelToolKind::WebFetch,
        }
    }

    pub fn validate(&self) -> Result<(), ToolValidationError> {
        let encoded = serde_json::to_vec(self)
            .map_err(|_| invalid_value("canonicalInvocation", "must serialize"))?;
        if encoded.len() > MAX_CANONICAL_INVOCATION_BYTES {
            return Err(field_too_large(
                "canonicalInvocation",
                MAX_CANONICAL_INVOCATION_BYTES,
            ));
        }
        match self {
            Self::FsRead {
                path,
                start_line,
                max_lines,
                max_bytes,
            } => {
                validate_path(path, false)?;
                validate_u32("startLine", *start_line, 1, u32::MAX)?;
                validate_u32("maxLines", *max_lines, 1, 5_000)?;
                validate_u32("maxBytes", *max_bytes, 1_024, 1_048_576)?;
            }
            Self::FsWrite { path, .. } => validate_path(path, false)?,
            Self::FsEdit { path, edits } => {
                validate_path(path, false)?;
                if edits.is_empty() || edits.len() > 128 {
                    return Err(invalid_value(
                        "edits",
                        "must contain between 1 and 128 items",
                    ));
                }
                let mut old_texts = std::collections::HashSet::with_capacity(edits.len());
                for edit in edits {
                    validate_text("edits.oldText", &edit.old_text, false)?;
                    validate_text("edits.newText", &edit.new_text, true)?;
                    if !old_texts.insert(edit.old_text.as_str()) {
                        return Err(invalid_value("edits.oldText", "must be unique"));
                    }
                }
            }
            Self::FsDelete(target) => match target {
                KernelDeleteTarget::File { path } | KernelDeleteTarget::DirectoryTree { path } => {
                    validate_path(path, false)?
                }
            },
            Self::ProcessShell {
                command,
                workspace_mode: _,
                timeout,
            } => {
                validate_text("command", command, false)?;
                validate_u32("timeout", *timeout, 1, 600)?;
                if let Some(reason) = process_shell_hard_deny_reason(command) {
                    return Err(invalid_value("command", reason));
                }
            }
            Self::WebSearch { query, limit } => {
                validate_text("query", query, false)?;
                validate_u32("limit", *limit, 1, 10)?;
            }
            Self::WebFetch { url, max_bytes } => {
                validate_text("url", url, false)?;
                let lower = url.to_ascii_lowercase();
                if !(lower.starts_with("http://") || lower.starts_with("https://"))
                    || url_has_user_info(url)
                {
                    return Err(invalid_value("url", "must be HTTP(S) without user-info"));
                }
                validate_u32("maxBytes", *max_bytes, 1_024, 262_144)?;
            }
        }
        Ok(())
    }

    pub fn executor_arguments(&self) -> Value {
        match self {
            Self::FsRead {
                path,
                start_line,
                max_lines,
                max_bytes,
            } => json!({
                "path": path,
                "startLine": start_line,
                "maxLines": max_lines,
                "maxBytes": max_bytes,
            }),
            Self::FsWrite {
                path,
                content,
                executable,
            } => {
                let mut value = json!({ "path": path, "content": content });
                if let Some(executable) = executable {
                    value["executable"] = json!(executable);
                }
                value
            }
            Self::FsEdit { path, edits } => json!({
                "path": path,
                "edits": edits,
            }),
            Self::FsDelete(KernelDeleteTarget::File { path }) => json!({
                "path": path,
                "targetKind": "file",
            }),
            Self::FsDelete(KernelDeleteTarget::DirectoryTree { path }) => json!({
                "path": path,
                "targetKind": "directoryTree",
            }),
            Self::ProcessShell {
                command,
                workspace_mode,
                timeout,
            } => json!({
                "command": command,
                "workspaceMode": workspace_mode,
                "timeout": timeout,
            }),
            Self::WebSearch { query, limit } => json!({ "query": query, "limit": limit }),
            Self::WebFetch { url, max_bytes } => json!({ "url": url, "maxBytes": max_bytes }),
        }
    }
}

/// Returns the narrow, non-configurable reason that a shell command must not
/// be spawned. This is deliberately limited to disk/volume formatting and
/// obvious recursive cleanup of operating-system roots; it is not a general
/// shell policy engine.
pub fn process_shell_hard_deny_reason(command: &str) -> Option<&'static str> {
    process_shell_hard_deny_reason_at_depth(command, 0)
}

fn process_shell_hard_deny_reason_at_depth(
    command: &str,
    nesting_depth: usize,
) -> Option<&'static str> {
    for segment in shell_command_segments(command) {
        let words = shell_words(segment);
        let Some(program_index) = shell_program_index(&words) else {
            continue;
        };
        let program = executable_basename(&words[program_index]).to_ascii_lowercase();
        let arguments = &words[program_index + 1..];
        if program == "mkfs"
            || program.starts_with("mkfs.")
            || program == "newfs"
            || program.starts_with("newfs_")
            || matches!(program.as_str(), "format" | "format.com")
        {
            return Some("is always denied because it formats a disk or volume");
        }
        if program == "diskutil"
            && arguments.iter().any(|argument| {
                matches!(
                    argument.to_ascii_lowercase().as_str(),
                    "erasedisk" | "erasevolume" | "partitiondisk" | "zerodisk"
                )
            })
        {
            return Some("is always denied because it formats or erases a disk or volume");
        }
        if program == "rm" && rm_recursively_forces_system_root(arguments) {
            return Some("is always denied because it recursively removes a system root");
        }
        if nesting_depth < 4 && matches!(program.as_str(), "sh" | "bash" | "zsh" | "dash" | "ksh") {
            if let Some(nested) = shell_command_argument(arguments) {
                if let Some(reason) =
                    process_shell_hard_deny_reason_at_depth(nested, nesting_depth + 1)
                {
                    return Some(reason);
                }
            }
        }
    }
    None
}

fn shell_command_argument(arguments: &[String]) -> Option<&str> {
    arguments.windows(2).find_map(|pair| {
        let option = pair[0].as_str();
        (option == "-c" || option.starts_with('-') && option[1..].contains('c'))
            .then_some(pair[1].as_str())
    })
}

fn shell_command_segments(command: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0usize;
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in command.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
            continue;
        }
        if quote.is_none() && matches!(character, ';' | '\n' | '&' | '|') {
            segments.push(&command[start..index]);
            start = index + character.len_utf8();
        }
    }
    segments.push(&command[start..]);
    segments
}

fn shell_words(segment: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in segment.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            } else {
                current.push(character);
            }
            continue;
        }
        if character.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(character);
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn shell_program_index(words: &[String]) -> Option<usize> {
    let mut index = 0usize;
    while index < words.len() {
        let word = executable_basename(&words[index]).to_ascii_lowercase();
        if is_environment_assignment(&words[index]) {
            index += 1;
            continue;
        }
        if matches!(word.as_str(), "command" | "builtin" | "exec") {
            index += 1;
            continue;
        }
        if word == "env" || word == "sudo" {
            index += 1;
            while index < words.len()
                && (words[index].starts_with('-') || is_environment_assignment(&words[index]))
            {
                index += 1;
            }
            continue;
        }
        return Some(index);
    }
    None
}

fn executable_basename(value: &str) -> &str {
    value
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(value)
}

fn is_environment_assignment(value: &str) -> bool {
    let Some((name, _)) = value.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.chars().enumerate().all(|(index, character)| {
            character == '_'
                || character.is_ascii_alphanumeric() && (index > 0 || !character.is_ascii_digit())
        })
}

fn rm_recursively_forces_system_root(arguments: &[String]) -> bool {
    let mut recursive = false;
    let mut force = false;
    let mut targets = Vec::new();
    let mut options_finished = false;
    for argument in arguments {
        if !options_finished && argument == "--" {
            options_finished = true;
            continue;
        }
        if !options_finished && argument.starts_with("--") {
            recursive |= argument == "--recursive";
            force |= argument == "--force";
            continue;
        }
        if !options_finished && argument.starts_with('-') && argument != "-" {
            recursive |= argument[1..].chars().any(|flag| matches!(flag, 'r' | 'R'));
            force |= argument[1..].chars().any(|flag| flag == 'f');
            continue;
        }
        targets.push(argument.as_str());
    }
    recursive && force && targets.into_iter().any(is_system_root_target)
}

fn is_system_root_target(target: &str) -> bool {
    let mut normalized = target.replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    let lower = normalized.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "/" | "/*"
            | "/."
            | "/system"
            | "/system/*"
            | "/system/volumes"
            | "/system/volumes/*"
            | "/system/volumes/data"
            | "/system/volumes/data/*"
            | "c:"
            | "c:/*"
    )
}

fn validate_path(value: &str, allow_dot: bool) -> Result<(), ToolValidationError> {
    validate_text("path", value, false)?;
    if value.contains('\\')
        || value.starts_with('/')
        || value.as_bytes().get(1) == Some(&b':')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == ".." || (part == "." && value != "."))
        || (!allow_dot && value == ".")
    {
        return Err(invalid_value(
            "path",
            "must be a normalized workspace-relative path",
        ));
    }
    Ok(())
}

fn validate_text(
    field: &'static str,
    value: &str,
    allow_empty: bool,
) -> Result<(), ToolValidationError> {
    if (!allow_empty && value.trim().is_empty()) || value.contains('\0') {
        return Err(empty_field(field));
    }
    if value.len() > MAX_ORDINARY_STRING_BYTES {
        return Err(field_too_large(field, MAX_ORDINARY_STRING_BYTES));
    }
    Ok(())
}

fn validate_u32(
    field: &'static str,
    value: u32,
    minimum: u32,
    maximum: u32,
) -> Result<(), ToolValidationError> {
    if !(minimum..=maximum).contains(&value) {
        return Err(invalid_value(field, "is outside the supported range"));
    }
    Ok(())
}

fn url_has_user_info(url: &str) -> bool {
    let Some(rest) = url.split_once("://").map(|(_, rest)| rest) else {
        return true;
    };
    rest.split('/')
        .next()
        .is_some_and(|authority| authority.contains('@'))
}
