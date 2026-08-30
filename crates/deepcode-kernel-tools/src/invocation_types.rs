use crate::types::ToolValidationError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_CANONICAL_INVOCATION_BYTES: usize = 1024 * 1024;
const MAX_LIST_ITEMS: usize = 256;
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
    #[serde(rename = "code.grep")]
    CodeGrep,
    #[serde(rename = "document.read")]
    DocumentRead,
    #[serde(rename = "fs.create")]
    FsCreate,
    #[serde(rename = "fs.delete")]
    FsDelete,
    #[serde(rename = "fs.diff")]
    FsDiff,
    #[serde(rename = "fs.edit")]
    FsEdit,
    #[serde(rename = "fs.ensure_directory")]
    FsEnsureDirectory,
    #[serde(rename = "fs.glob")]
    FsGlob,
    #[serde(rename = "fs.list")]
    FsList,
    #[serde(rename = "fs.read")]
    FsRead,
    #[serde(rename = "fs.stat")]
    FsStat,
    #[serde(rename = "fs.write")]
    FsWrite,
    #[serde(rename = "process.shell")]
    ProcessShell,
    #[serde(rename = "github.read")]
    GithubRead,
    #[serde(rename = "github.search")]
    GithubSearch,
    #[serde(rename = "arxiv.read")]
    ArxivRead,
    #[serde(rename = "arxiv.search")]
    ArxivSearch,
    #[serde(rename = "web.fetch")]
    WebFetch,
    #[serde(rename = "web.search")]
    WebSearch,
}

impl KernelToolKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CodeGrep => "code.grep",
            Self::DocumentRead => "document.read",
            Self::FsCreate => "fs.create",
            Self::FsDelete => "fs.delete",
            Self::FsDiff => "fs.diff",
            Self::FsEdit => "fs.edit",
            Self::FsEnsureDirectory => "fs.ensure_directory",
            Self::FsGlob => "fs.glob",
            Self::FsList => "fs.list",
            Self::FsRead => "fs.read",
            Self::FsStat => "fs.stat",
            Self::FsWrite => "fs.write",
            Self::ProcessShell => "process.shell",
            Self::GithubRead => "github.read",
            Self::GithubSearch => "github.search",
            Self::ArxivRead => "arxiv.read",
            Self::ArxivSearch => "arxiv.search",
            Self::WebFetch => "web.fetch",
            Self::WebSearch => "web.search",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelLineRange {
    Whole {},
    Lines { start_line: u32, end_line: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelDocumentPages {
    All {},
    Range { start_page: u32, end_page: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelSearchStrategy {
    Literal,
    Regex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelGithubSearchKind {
    Repositories,
    Code,
    Issues,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelArxivSearchField {
    All,
    Title,
    Author,
    Abstract,
    Category,
    Id,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelArxivSortBy {
    Relevance,
    LastUpdatedDate,
    SubmittedDate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelSortOrder {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelFileDigestPrecondition {
    ExpectedFileDigest { digest: String },
    ExpectedBeforeBlock { text: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelEditMatcher {
    ExactBlock {
        text: String,
    },
    ContextBlock {
        before: String,
        target: String,
        after: String,
    },
    LineRange {
        start_line: u32,
        end_line: u32,
        precondition: KernelFileDigestPrecondition,
    },
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
        range: KernelLineRange,
    },
    #[serde(rename = "fs.stat")]
    FsStat { path: String },
    #[serde(rename = "fs.list")]
    FsList {
        path: String,
        depth: u32,
        include_hidden: bool,
    },
    #[serde(rename = "fs.glob")]
    FsGlob {
        root: String,
        pattern: String,
        max_results: u32,
    },
    #[serde(rename = "fs.diff")]
    FsDiff {
        path: String,
        proposed_content: String,
    },
    #[serde(rename = "code.grep")]
    CodeGrep {
        root: String,
        query: String,
        include: Vec<String>,
        exclude: Vec<String>,
        strategy: KernelSearchStrategy,
        context_lines: u32,
        max_results: u32,
    },
    #[serde(rename = "fs.create")]
    FsCreate {
        path: String,
        content: String,
        executable: bool,
    },
    #[serde(rename = "fs.write")]
    FsWrite { path: String, content: String },
    #[serde(rename = "fs.edit")]
    FsEdit {
        path: String,
        matcher: KernelEditMatcher,
        replacement: String,
    },
    #[serde(rename = "fs.delete")]
    FsDelete(KernelDeleteTarget),
    #[serde(rename = "fs.ensure_directory")]
    FsEnsureDirectory { path: String },
    #[serde(rename = "document.read")]
    DocumentRead {
        path: String,
        pages: KernelDocumentPages,
    },
    #[serde(rename = "process.shell")]
    ProcessShell {
        command: String,
        cwd: String,
        timeout_ms: u32,
        max_output_bytes: u32,
    },
    #[serde(rename = "github.search")]
    GithubSearch {
        query: String,
        kind: KernelGithubSearchKind,
        page: u32,
        limit: u32,
    },
    #[serde(rename = "github.read")]
    GithubRead {
        repository: String,
        path: String,
        reference: Option<String>,
        max_bytes: u32,
    },
    #[serde(rename = "arxiv.search")]
    ArxivSearch {
        query: String,
        field: KernelArxivSearchField,
        start: u32,
        limit: u32,
        sort_by: KernelArxivSortBy,
        sort_order: KernelSortOrder,
    },
    #[serde(rename = "arxiv.read")]
    ArxivRead { id: String },
    #[serde(rename = "web.search")]
    WebSearch { query: String, limit: u32 },
    #[serde(rename = "web.fetch")]
    WebFetch { url: String, max_bytes: u32 },
}

impl KernelCanonicalInvocation {
    pub fn tool_id(&self) -> KernelToolKind {
        match self {
            Self::FsRead { .. } => KernelToolKind::FsRead,
            Self::FsStat { .. } => KernelToolKind::FsStat,
            Self::FsList { .. } => KernelToolKind::FsList,
            Self::FsGlob { .. } => KernelToolKind::FsGlob,
            Self::FsDiff { .. } => KernelToolKind::FsDiff,
            Self::CodeGrep { .. } => KernelToolKind::CodeGrep,
            Self::FsCreate { .. } => KernelToolKind::FsCreate,
            Self::FsWrite { .. } => KernelToolKind::FsWrite,
            Self::FsEdit { .. } => KernelToolKind::FsEdit,
            Self::FsDelete(_) => KernelToolKind::FsDelete,
            Self::FsEnsureDirectory { .. } => KernelToolKind::FsEnsureDirectory,
            Self::DocumentRead { .. } => KernelToolKind::DocumentRead,
            Self::ProcessShell { .. } => KernelToolKind::ProcessShell,
            Self::GithubSearch { .. } => KernelToolKind::GithubSearch,
            Self::GithubRead { .. } => KernelToolKind::GithubRead,
            Self::ArxivSearch { .. } => KernelToolKind::ArxivSearch,
            Self::ArxivRead { .. } => KernelToolKind::ArxivRead,
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
            Self::FsRead { path, range } => {
                validate_path(path, false)?;
                if let KernelLineRange::Lines {
                    start_line,
                    end_line,
                } = range
                {
                    validate_range("range", *start_line, *end_line)?;
                }
            }
            Self::FsStat { path } => validate_path(path, true)?,
            Self::FsList { path, depth, .. } => {
                validate_path(path, true)?;
                validate_u32("depth", *depth, 1, 16)?;
            }
            Self::FsGlob {
                root,
                pattern,
                max_results,
            } => {
                validate_path(root, true)?;
                validate_text("pattern", pattern, false)?;
                validate_u32("maxResults", *max_results, 1, 5_000)?;
            }
            Self::FsDiff { path, .. } => validate_path(path, false)?,
            Self::CodeGrep {
                root,
                query,
                include,
                exclude,
                context_lines,
                max_results,
                ..
            } => {
                validate_path(root, true)?;
                validate_text("query", query, false)?;
                validate_string_list("include", include)?;
                validate_string_list("exclude", exclude)?;
                validate_u32("contextLines", *context_lines, 0, 5)?;
                validate_u32("maxResults", *max_results, 1, 500)?;
            }
            Self::FsCreate { path, .. }
            | Self::FsWrite { path, .. }
            | Self::FsEnsureDirectory { path } => validate_path(path, false)?,
            Self::FsEdit { path, matcher, .. } => {
                validate_path(path, false)?;
                validate_matcher(matcher)?;
            }
            Self::FsDelete(target) => match target {
                KernelDeleteTarget::File { path } | KernelDeleteTarget::DirectoryTree { path } => {
                    validate_path(path, false)?
                }
            },
            Self::DocumentRead { path, pages } => {
                validate_path(path, false)?;
                if let KernelDocumentPages::Range {
                    start_page,
                    end_page,
                } = pages
                {
                    validate_range("pages", *start_page, *end_page)?;
                    if end_page - start_page + 1 > 50 {
                        return Err(invalid_value("pages", "cannot request more than 50 pages"));
                    }
                }
            }
            Self::ProcessShell {
                command,
                cwd,
                timeout_ms,
                max_output_bytes,
            } => {
                validate_text("command", command, false)?;
                validate_path(cwd, true)?;
                validate_u32("timeoutMs", *timeout_ms, 100, 600_000)?;
                validate_u32("maxOutputBytes", *max_output_bytes, 1_024, 1_048_576)?;
                if let Some(reason) = process_shell_hard_deny_reason(command) {
                    return Err(invalid_value("command", reason));
                }
            }
            Self::GithubSearch {
                query, page, limit, ..
            } => {
                validate_text("query", query, false)?;
                validate_u32("page", *page, 1, 100)?;
                validate_u32("limit", *limit, 1, 30)?;
            }
            Self::GithubRead {
                repository,
                path,
                reference,
                max_bytes,
            } => {
                validate_repository(repository)?;
                validate_path(path, true)?;
                if let Some(reference) = reference {
                    validate_text("ref", reference, false)?;
                }
                validate_u32("maxBytes", *max_bytes, 1_024, 262_144)?;
            }
            Self::ArxivSearch {
                query,
                start,
                limit,
                ..
            } => {
                validate_text("query", query, false)?;
                validate_u32("start", *start, 0, 10_000)?;
                validate_u32("limit", *limit, 1, 30)?;
            }
            Self::ArxivRead { id } => validate_arxiv_id(id)?,
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
            Self::FsRead { path, range } => match range {
                KernelLineRange::Whole {} => json!({ "path": path }),
                KernelLineRange::Lines {
                    start_line,
                    end_line,
                } => json!({
                    "path": path,
                    "startLine": start_line,
                    "endLine": end_line,
                }),
            },
            Self::FsStat { path } => json!({ "path": path }),
            Self::FsList {
                path,
                depth,
                include_hidden,
            } => json!({
                "path": path,
                "depth": depth,
                "includeHidden": include_hidden,
            }),
            Self::FsGlob {
                root,
                pattern,
                max_results,
            } => json!({
                "path": root,
                "pattern": pattern,
                "maxResults": max_results,
            }),
            Self::FsDiff {
                path,
                proposed_content,
            } => json!({
                "path": path,
                "proposedContent": proposed_content,
            }),
            Self::CodeGrep {
                root,
                query,
                include,
                exclude,
                strategy,
                context_lines,
                max_results,
            } => json!({
                "path": root,
                "query": query,
                "include": include,
                "exclude": exclude,
                "strategy": strategy,
                "contextLines": context_lines,
                "maxResults": max_results,
            }),
            Self::FsCreate {
                path,
                content,
                executable,
            } => json!({
                "path": path,
                "content": content,
                "executable": executable,
            }),
            Self::FsWrite { path, content } => json!({ "path": path, "content": content }),
            Self::FsEdit {
                path,
                matcher,
                replacement,
            } => json!({
                "path": path,
                "patchSpec": { "match": matcher_for_executor(matcher) },
                "replacement": replacement,
            }),
            Self::FsDelete(KernelDeleteTarget::File { path }) => json!({
                "path": path,
                "targetKind": "file",
            }),
            Self::FsDelete(KernelDeleteTarget::DirectoryTree { path }) => json!({
                "path": path,
                "targetKind": "directoryTree",
            }),
            Self::FsEnsureDirectory { path } => json!({ "path": path }),
            Self::DocumentRead { path, pages } => match pages {
                KernelDocumentPages::All {} => json!({ "path": path }),
                KernelDocumentPages::Range {
                    start_page,
                    end_page,
                } => json!({
                    "path": path,
                    "startPage": start_page,
                    "endPage": end_page,
                }),
            },
            Self::ProcessShell {
                command,
                cwd,
                timeout_ms,
                max_output_bytes,
            } => json!({
                "command": command,
                "cwd": cwd,
                "timeoutMs": timeout_ms,
                "maxOutputBytes": max_output_bytes,
            }),
            Self::GithubSearch {
                query,
                kind,
                page,
                limit,
            } => json!({
                "query": query,
                "kind": kind,
                "page": page,
                "limit": limit,
            }),
            Self::GithubRead {
                repository,
                path,
                reference,
                max_bytes,
            } => {
                let mut value = json!({
                    "repository": repository,
                    "path": path,
                    "maxBytes": max_bytes,
                });
                if let Some(reference) = reference {
                    value["ref"] = json!(reference);
                }
                value
            }
            Self::ArxivSearch {
                query,
                field,
                start,
                limit,
                sort_by,
                sort_order,
            } => json!({
                "query": query,
                "field": field,
                "start": start,
                "limit": limit,
                "sortBy": sort_by,
                "sortOrder": sort_order,
            }),
            Self::ArxivRead { id } => json!({ "id": id }),
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

fn matcher_for_executor(matcher: &KernelEditMatcher) -> Value {
    match matcher {
        KernelEditMatcher::ExactBlock { text } => json!({
            "kind": "exactBlock",
            "text": text,
        }),
        KernelEditMatcher::ContextBlock {
            before,
            target,
            after,
        } => json!({
            "kind": "contextBlock",
            "before": before,
            "target": target,
            "after": after,
        }),
        KernelEditMatcher::LineRange {
            start_line,
            end_line,
            precondition,
        } => {
            let mut value = json!({
                "kind": "lineRange",
                "startLine": start_line,
                "endLine": end_line,
            });
            match precondition {
                KernelFileDigestPrecondition::ExpectedFileDigest { digest } => {
                    value["expectedFileHash"] = Value::String(digest.clone());
                }
                KernelFileDigestPrecondition::ExpectedBeforeBlock { text } => {
                    value["expectedBeforeBlock"] = Value::String(text.clone());
                }
            }
            value
        }
    }
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

fn validate_repository(repository: &str) -> Result<(), ToolValidationError> {
    validate_text("repository", repository, false)?;
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty()
        || name.is_empty()
        || parts.next().is_some()
        || !owner.chars().all(is_github_name_character)
        || !name.chars().all(is_github_name_character)
    {
        return Err(invalid_value("repository", "must use owner/name"));
    }
    Ok(())
}

fn is_github_name_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
}

fn validate_arxiv_id(id: &str) -> Result<(), ToolValidationError> {
    validate_text("id", id, false)?;
    if id
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(invalid_value("id", "must be an arXiv identifier"));
    }
    Ok(())
}

fn validate_string_list(field: &'static str, values: &[String]) -> Result<(), ToolValidationError> {
    if values.len() > MAX_LIST_ITEMS {
        return Err(invalid_value(field, "has too many items"));
    }
    for value in values {
        validate_text(field, value, false)?;
    }
    if !values.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(invalid_value(field, "must be sorted and unique"));
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

fn validate_range(field: &'static str, start: u32, end: u32) -> Result<(), ToolValidationError> {
    if start == 0 || end == 0 || start > end {
        return Err(invalid_value(field, "requires one-based start <= end"));
    }
    Ok(())
}

fn validate_matcher(value: &KernelEditMatcher) -> Result<(), ToolValidationError> {
    match value {
        KernelEditMatcher::ExactBlock { text } => validate_text("matcher.text", text, false),
        KernelEditMatcher::ContextBlock {
            before,
            target,
            after,
        } => {
            validate_text("matcher.before", before, true)?;
            validate_text("matcher.target", target, false)?;
            validate_text("matcher.after", after, true)
        }
        KernelEditMatcher::LineRange {
            start_line,
            end_line,
            precondition,
        } => {
            validate_range("matcher.lineRange", *start_line, *end_line)?;
            match precondition {
                KernelFileDigestPrecondition::ExpectedFileDigest { digest } => {
                    validate_file_digest("expectedFileDigest", digest)
                }
                KernelFileDigestPrecondition::ExpectedBeforeBlock { text } => {
                    validate_text("expectedBeforeBlock", text, false)
                }
            }
        }
    }
}

fn validate_file_digest(field: &'static str, value: &str) -> Result<(), ToolValidationError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(invalid_value(field, "must include the sha256: prefix"));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_value(
            field,
            "must be sha256: followed by 64 lowercase hexadecimal characters",
        ));
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
