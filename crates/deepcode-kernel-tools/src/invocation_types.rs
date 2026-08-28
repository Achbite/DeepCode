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
    #[serde(rename = "fs.write")]
    FsWrite,
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
            Self::FsWrite => "fs.write",
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
    #[serde(rename = "web.search")]
    WebSearch { query: String, limit: u32 },
    #[serde(rename = "web.fetch")]
    WebFetch { url: String, max_bytes: u32 },
}

impl KernelCanonicalInvocation {
    pub fn tool_id(&self) -> KernelToolKind {
        match self {
            Self::FsRead { .. } => KernelToolKind::FsRead,
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
            Self::WebSearch { query, limit } => json!({ "query": query, "limit": limit }),
            Self::WebFetch { url, max_bytes } => json!({ "url": url, "maxBytes": max_bytes }),
        }
    }
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
                    validate_text("expectedFileDigest", digest, false)
                }
                KernelFileDigestPrecondition::ExpectedBeforeBlock { text } => {
                    validate_text("expectedBeforeBlock", text, false)
                }
            }
        }
    }
}

fn url_has_user_info(url: &str) -> bool {
    let Some(rest) = url.split_once("://").map(|(_, rest)| rest) else {
        return true;
    };
    rest.split('/')
        .next()
        .is_some_and(|authority| authority.contains('@'))
}
