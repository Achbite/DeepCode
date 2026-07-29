use deepcode_kernel_abi::v2::{
    NetworkOriginV2, NetworkTargetObservationDigestV2, ResourceStateDigestV2, ToolOutputDigestV2,
    V2ValidationError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_CANONICAL_INVOCATION_BYTES: usize = 1024 * 1024;
const MAX_LIST_ITEMS: usize = 256;
const MAX_ORDINARY_STRING_BYTES: usize = 16 * 1024;

fn empty_field(field: &'static str) -> V2ValidationError {
    V2ValidationError::EmptyField { field }
}

fn field_too_large(field: &'static str, maximum_bytes: usize) -> V2ValidationError {
    V2ValidationError::FieldTooLarge {
        field,
        maximum_bytes,
    }
}

fn invalid_value(field: &'static str, reason: &'static str) -> V2ValidationError {
    V2ValidationError::InvalidValue { field, reason }
}

fn typed_digest<T: Serialize>(
    domain: &'static str,
    value: &T,
) -> Result<[u8; 32], V2ValidationError> {
    let encoded =
        serde_json::to_vec(value).map_err(|_| invalid_value("digestPreimage", "must serialize"))?;
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(encoded);
    Ok(hasher.finalize().into())
}

fn encoded_digest(bytes: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(71);
    encoded.push_str("sha256:");
    for byte in bytes {
        encoded.push(char::from(HEX[(byte >> 4) as usize]));
        encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    encoded
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
    #[serde(rename = "fs.rename")]
    FsRename,
    #[serde(rename = "fs.write")]
    FsWrite,
    #[serde(rename = "git.commit")]
    GitCommit,
    #[serde(rename = "git.diff")]
    GitDiff,
    #[serde(rename = "git.stage")]
    GitStage,
    #[serde(rename = "git.status")]
    GitStatus,
    #[serde(rename = "git.unstage")]
    GitUnstage,
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
            Self::FsRename => "fs.rename",
            Self::FsWrite => "fs.write",
            Self::GitCommit => "git.commit",
            Self::GitDiff => "git.diff",
            Self::GitStage => "git.stage",
            Self::GitStatus => "git.status",
            Self::GitUnstage => "git.unstage",
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
    ExpectedFileDigest { digest: ResourceStateDigestV2 },
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
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelGitDiffScope {
    Repository {},
    Paths { paths: Vec<String> },
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
    #[serde(rename = "fs.rename")]
    FsRename {
        source_path: String,
        destination_path: String,
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
    #[serde(rename = "git.status")]
    GitStatus {},
    #[serde(rename = "git.diff")]
    GitDiff {
        scope: KernelGitDiffScope,
        staged: bool,
    },
    #[serde(rename = "git.stage")]
    GitStage { paths: Vec<String> },
    #[serde(rename = "git.unstage")]
    GitUnstage { paths: Vec<String> },
    #[serde(rename = "git.commit")]
    GitCommit { message: String },
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
            Self::FsRename { .. } => KernelToolKind::FsRename,
            Self::FsDelete(_) => KernelToolKind::FsDelete,
            Self::FsEnsureDirectory { .. } => KernelToolKind::FsEnsureDirectory,
            Self::DocumentRead { .. } => KernelToolKind::DocumentRead,
            Self::GitStatus { .. } => KernelToolKind::GitStatus,
            Self::GitDiff { .. } => KernelToolKind::GitDiff,
            Self::GitStage { .. } => KernelToolKind::GitStage,
            Self::GitUnstage { .. } => KernelToolKind::GitUnstage,
            Self::GitCommit { .. } => KernelToolKind::GitCommit,
            Self::WebSearch { .. } => KernelToolKind::WebSearch,
            Self::WebFetch { .. } => KernelToolKind::WebFetch,
        }
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
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
            Self::FsDiff {
                path,
                proposed_content: _,
            } => validate_path(path, false)?,
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
                validate_string_list("include", include, true)?;
                validate_string_list("exclude", exclude, true)?;
                validate_u32("contextLines", *context_lines, 0, 5)?;
                validate_u32("maxResults", *max_results, 1, 500)?;
            }
            Self::FsCreate { path, .. }
            | Self::FsWrite { path, .. }
            | Self::FsEnsureDirectory { path } => validate_path(path, false)?,
            Self::FsEdit {
                path,
                matcher,
                replacement: _,
            } => {
                validate_path(path, false)?;
                validate_matcher(matcher)?;
            }
            Self::FsRename {
                source_path,
                destination_path,
            } => {
                validate_path(source_path, false)?;
                validate_path(destination_path, false)?;
                if source_path == destination_path {
                    return Err(invalid_value(
                        "destinationPath",
                        "must differ from sourcePath",
                    ));
                }
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
            Self::GitStatus {} => {}
            Self::GitDiff { scope, .. } => {
                if let KernelGitDiffScope::Paths { paths } = scope {
                    validate_path_list("paths", paths, false)?;
                }
            }
            Self::GitStage { paths } | Self::GitUnstage { paths } => {
                validate_path_list("paths", paths, false)?
            }
            Self::GitCommit { message } => validate_text("message", message, false)?,
            Self::WebSearch { query, limit } => {
                validate_text("query", query, false)?;
                validate_u32("limit", *limit, 1, 10)?;
            }
            Self::WebFetch { url, max_bytes } => {
                validate_text("url", url, false)?;
                let lower = url.to_ascii_lowercase();
                if !(lower.starts_with("http://") || lower.starts_with("https://"))
                    || authority_url_has_user_info(url)
                {
                    return Err(invalid_value("url", "must be HTTP(S) without user-info"));
                }
                validate_u32("maxBytes", *max_bytes, 1_024, 262_144)?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelTextMediaType {
    TextPlainUtf8,
    TextMarkdownUtf8,
    ApplicationJsonUtf8,
    TextDiffUtf8,
    TextDocumentUtf8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelWorkspaceObjectKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelPathEntrySize {
    Unavailable {},
    Bytes { value: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelPathEntry {
    pub relative_path: String,
    pub kind: KernelWorkspaceObjectKind,
    pub size: KernelPathEntrySize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelSearchMatch {
    pub relative_path: String,
    pub line: u32,
    pub column: u32,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelWebSearchItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelNetworkPublicTarget {
    pub origin: NetworkOriginV2,
    pub target_observation_digest: NetworkTargetObservationDigestV2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelToolOutputPayload {
    Utf8Text {
        media_type: KernelTextMediaType,
        text: String,
    },
    PathEntries {
        entries: Vec<KernelPathEntry>,
    },
    SearchMatches {
        matches: Vec<KernelSearchMatch>,
    },
    WebSearchResults {
        items: Vec<KernelWebSearchItem>,
    },
    WebResponse {
        status_code: u16,
        final_target: KernelNetworkPublicTarget,
        content_type: String,
        body: String,
    },
    NoPrimaryContent {},
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KernelOutputTruncation {
    Complete {},
    Truncated { retained_bytes: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelToolOutput {
    pub full_digest: ToolOutputDigestV2,
    pub total_bytes: u64,
    pub truncation: KernelOutputTruncation,
    pub payload: KernelToolOutputPayload,
}

pub fn kernel_tool_output_digest(
    tool_id: KernelToolKind,
    payload: &KernelToolOutputPayload,
) -> Result<ToolOutputDigestV2, V2ValidationError> {
    ToolOutputDigestV2::parse(encoded_digest(typed_digest(
        "deepcode.kernel.tool-output.v2",
        &serde_json::json!({
            "toolId":tool_id,
            "typedOutputPayload":payload,
        }),
    )?))
}

pub fn measure_kernel_output_payload(
    tool_id: KernelToolKind,
    payload: KernelToolOutputPayload,
) -> Result<KernelToolOutput, V2ValidationError> {
    let total_bytes = serde_json::to_vec(&payload)
        .map_err(|_| invalid_value("toolOutput", "must serialize"))?
        .len() as u64;
    Ok(KernelToolOutput {
        full_digest: kernel_tool_output_digest(tool_id, &payload)?,
        total_bytes,
        truncation: KernelOutputTruncation::Complete {},
        payload,
    })
}

fn validate_path(value: &str, allow_dot: bool) -> Result<(), V2ValidationError> {
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

fn validate_path_list(
    field: &'static str,
    values: &[String],
    allow_dot: bool,
) -> Result<(), V2ValidationError> {
    if values.is_empty() || values.len() > MAX_LIST_ITEMS {
        return Err(invalid_value(
            field,
            "must be a non-empty list of at most 256 paths",
        ));
    }
    for value in values {
        validate_path(value, allow_dot)?;
    }
    if !values.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(invalid_value(field, "must be sorted and unique"));
    }
    Ok(())
}

fn validate_string_list(
    field: &'static str,
    values: &[String],
    allow_empty_list: bool,
) -> Result<(), V2ValidationError> {
    if (!allow_empty_list && values.is_empty()) || values.len() > MAX_LIST_ITEMS {
        return Err(invalid_value(field, "has an invalid item count"));
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
) -> Result<(), V2ValidationError> {
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
) -> Result<(), V2ValidationError> {
    if !(minimum..=maximum).contains(&value) {
        return Err(invalid_value(field, "is outside the contract range"));
    }
    Ok(())
}

fn validate_range(field: &'static str, start: u32, end: u32) -> Result<(), V2ValidationError> {
    if start == 0 || end == 0 || start > end {
        return Err(invalid_value(field, "requires one-based start <= end"));
    }
    Ok(())
}

fn validate_matcher(value: &KernelEditMatcher) -> Result<(), V2ValidationError> {
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
            if let KernelFileDigestPrecondition::ExpectedBeforeBlock { text } = precondition {
                validate_text("expectedBeforeBlock", text, false)?;
            }
            Ok(())
        }
    }
}

fn authority_url_has_user_info(url: &str) -> bool {
    let Some(rest) = url.split_once("://").map(|(_, rest)| rest) else {
        return true;
    };
    rest.split('/')
        .next()
        .is_some_and(|authority| authority.contains('@'))
}
