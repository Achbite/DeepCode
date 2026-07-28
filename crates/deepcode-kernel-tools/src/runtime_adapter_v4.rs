use deepcode_kernel_abi::v2::{
    NetworkOriginV2, NetworkTargetObservationDigestV2, ResourceStateDigestV2, ToolOutputDigestV2,
    V2ValidationError,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const KERNEL_TOOL_CATALOG_V4_VERSION: &str = "deepcode.kernel.tools.v4";

pub const MAX_CANONICAL_INVOCATION_BYTES_V4: usize = 1024 * 1024;
pub const MAX_INVOCATION_SCHEMA_BYTES_V4: usize = 64 * 1024;
pub const MAX_TOOL_CATALOG_BYTES_V4: usize = 2 * 1024 * 1024;
const MAX_LIST_ITEMS_V4: usize = 256;
const MAX_ORDINARY_STRING_BYTES_V4: usize = 16 * 1024;

fn empty_field(field: &'static str) -> V2ValidationError {
    V2ValidationError::EmptyField { field }
}

fn zero_value(field: &'static str) -> V2ValidationError {
    V2ValidationError::ZeroValue { field }
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

macro_rules! digest_type {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, V2ValidationError> {
                let value = value.into();
                let valid = value.strip_prefix("sha256:").is_some_and(|hex| {
                    hex.len() == 64
                        && hex
                            .as_bytes()
                            .iter()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
                });
                if !valid {
                    return Err(invalid_value(
                        stringify!($name),
                        "must be sha256:<64 lowercase hex>",
                    ));
                }
                Ok(Self(value))
            }

            pub(crate) fn from_raw_digest(bytes: [u8; 32]) -> Self {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let mut encoded = String::with_capacity(71);
                encoded.push_str("sha256:");
                for byte in bytes {
                    encoded.push(char::from(HEX[(byte >> 4) as usize]));
                    encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
                }
                Self(encoded)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

digest_type!(ToolCatalogDigestV4);
digest_type!(ToolContractDigestV4);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum AuthorityToolIdV4 {
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

impl AuthorityToolIdV4 {
    pub const ALL: [Self; 19] = [
        Self::CodeGrep,
        Self::DocumentRead,
        Self::FsCreate,
        Self::FsDelete,
        Self::FsDiff,
        Self::FsEdit,
        Self::FsEnsureDirectory,
        Self::FsGlob,
        Self::FsList,
        Self::FsRead,
        Self::FsRename,
        Self::FsWrite,
        Self::GitCommit,
        Self::GitDiff,
        Self::GitStage,
        Self::GitStatus,
        Self::GitUnstage,
        Self::WebFetch,
        Self::WebSearch,
    ];

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionAvailabilityV4 {
    Ready,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectClassV4 {
    Read,
    Mutation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectScopeV4 {
    WorkspaceRead,
    WorkspaceWrite,
    RepositoryRead,
    RepositoryIndexWrite,
    RepositoryHistoryWrite,
    NetworkRead,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolRiskV4 {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceAccessV4 {
    Read,
    Write,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetExistenceV4 {
    MustExist,
    MustNotExist,
    MayExist,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceObjectKindV4 {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryAreaV4 {
    State,
    Index,
    History,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndpointKindRelationV4 {
    SameAsSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverwritePolicyV4 {
    Forbidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathEndpointConstraintV4 {
    pub access: ResourceAccessV4,
    pub existence: TargetExistenceV4,
    pub allowed_kinds: Vec<WorkspaceObjectKindV4>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ResourceConstraintV4 {
    WorkspacePath {
        access: ResourceAccessV4,
        existence: TargetExistenceV4,
        allowed_kinds: Vec<WorkspaceObjectKindV4>,
    },
    WorkspacePathPair {
        source: PathEndpointConstraintV4,
        destination: PathEndpointConstraintV4,
        kind_relation: EndpointKindRelationV4,
        overwrite: OverwritePolicyV4,
    },
    WorkspaceSearch {
        root_existence: TargetExistenceV4,
    },
    Repository {
        access: ResourceAccessV4,
        area: RepositoryAreaV4,
    },
    NetworkQuery {},
    NetworkUrl {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CancellationV4 {
    Unavailable,
    BeforeEffectOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdempotencyV4 {
    ReadOnlyObservation,
    MutationGuarded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeadlineV4 {
    pub default_ms: u32,
    pub maximum_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationV4 {
    OutputDigest,
    FileContentReadBack,
    TargetAbsenceReadBack,
    DirectoryTypeReadBack,
    RenameReadBack,
    RepositoryStateReadBack,
    ResponseDigestAndReviewedTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RollbackV4 {
    NotApplicable,
    NotProvided,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputBudgetV4 {
    pub maximum_canonical_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupV4 {
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct InvocationInputSchemaV4(Value);

impl InvocationInputSchemaV4 {
    pub fn new(value: Value) -> Result<Self, V2ValidationError> {
        validate_schema(&value, 0)?;
        let bytes = serde_json::to_vec(&value)
            .map_err(|_| invalid_value("invocationInput", "must serialize"))?;
        if bytes.len() > MAX_INVOCATION_SCHEMA_BYTES_V4 {
            return Err(field_too_large(
                "invocationInput",
                MAX_INVOCATION_SCHEMA_BYTES_V4,
            ));
        }
        Ok(Self(value))
    }
}

impl<'de> Deserialize<'de> for InvocationInputSchemaV4 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolContractV4 {
    pub tool_id: AuthorityToolIdV4,
    pub execution_availability: ExecutionAvailabilityV4,
    pub effect_class: EffectClassV4,
    pub effect_scope: EffectScopeV4,
    pub risk: ToolRiskV4,
    pub resource_constraint: ResourceConstraintV4,
    pub cancellation: CancellationV4,
    pub idempotency: IdempotencyV4,
    pub deadline: DeadlineV4,
    pub verification: VerificationV4,
    pub rollback: RollbackV4,
    pub output_budget: OutputBudgetV4,
    pub cleanup: CleanupV4,
    pub invocation_input: InvocationInputSchemaV4,
    pub contract_digest: ToolContractDigestV4,
}

impl ToolContractV4 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.deadline.default_ms == 0
            || self.deadline.maximum_ms == 0
            || self.deadline.default_ms > self.deadline.maximum_ms
        {
            return Err(invalid_value(
                "deadline",
                "requires 0 < defaultMs <= maximumMs",
            ));
        }
        if self.output_budget.maximum_canonical_bytes == 0 {
            return Err(zero_value("outputBudget.maximumCanonicalBytes"));
        }
        if self.cleanup.required {
            return Err(invalid_value(
                "cleanup.required",
                "must be false in the v4 catalog",
            ));
        }
        validate_resource_constraint(&self.resource_constraint)?;
        if tool_contract_digest_v4(self)? != self.contract_digest {
            return Err(invalid_value(
                "contractDigest",
                "does not match contract content",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCatalogV4 {
    pub catalog_version: String,
    pub tools: Vec<ToolContractV4>,
    pub catalog_digest: ToolCatalogDigestV4,
}

impl ToolCatalogV4 {
    pub fn validate(&self) -> Result<(), V2ValidationError> {
        if self.catalog_version != KERNEL_TOOL_CATALOG_V4_VERSION {
            return Err(invalid_value(
                "catalogVersion",
                "must be deepcode.kernel.tools.v4",
            ));
        }
        if self.tools.len() != AuthorityToolIdV4::ALL.len() {
            return Err(invalid_value(
                "tools",
                "must contain exactly the 19 v4 identities",
            ));
        }
        for (contract, expected) in self.tools.iter().zip(AuthorityToolIdV4::ALL) {
            if contract.tool_id != expected {
                return Err(invalid_value(
                    "tools",
                    "must use exact lexical identity order",
                ));
            }
            contract.validate()?;
        }
        if tool_catalog_digest_v4(&self.tools)? != self.catalog_digest {
            return Err(invalid_value(
                "catalogDigest",
                "does not match contract leaves",
            ));
        }
        let bytes =
            serde_json::to_vec(self).map_err(|_| invalid_value("catalog", "must serialize"))?;
        if bytes.len() > MAX_TOOL_CATALOG_BYTES_V4 {
            return Err(field_too_large("catalog", MAX_TOOL_CATALOG_BYTES_V4));
        }
        Ok(())
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
pub enum LineRangeV4 {
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
pub enum DocumentPagesV4 {
    All {},
    Range { start_page: u32, end_page: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchStrategyV4 {
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
pub enum FileDigestPreconditionV4 {
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
pub enum EditMatcherV4 {
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
        precondition: FileDigestPreconditionV4,
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
pub enum DeleteTargetV4 {
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
pub enum GitDiffScopeV4 {
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
pub enum ToolInvocationInputV4 {
    #[serde(rename = "fs.read")]
    FsRead { path: String, range: LineRangeV4 },
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
        strategy: SearchStrategyV4,
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
        matcher: EditMatcherV4,
        replacement: String,
    },
    #[serde(rename = "fs.rename")]
    FsRename {
        source_path: String,
        destination_path: String,
    },
    #[serde(rename = "fs.delete")]
    FsDelete(DeleteTargetV4),
    #[serde(rename = "fs.ensure_directory")]
    FsEnsureDirectory { path: String },
    #[serde(rename = "document.read")]
    DocumentRead {
        path: String,
        pages: DocumentPagesV4,
    },
    #[serde(rename = "git.status")]
    GitStatus {},
    #[serde(rename = "git.diff")]
    GitDiff { scope: GitDiffScopeV4, staged: bool },
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

impl ToolInvocationInputV4 {
    pub fn tool_id(&self) -> AuthorityToolIdV4 {
        match self {
            Self::FsRead { .. } => AuthorityToolIdV4::FsRead,
            Self::FsList { .. } => AuthorityToolIdV4::FsList,
            Self::FsGlob { .. } => AuthorityToolIdV4::FsGlob,
            Self::FsDiff { .. } => AuthorityToolIdV4::FsDiff,
            Self::CodeGrep { .. } => AuthorityToolIdV4::CodeGrep,
            Self::FsCreate { .. } => AuthorityToolIdV4::FsCreate,
            Self::FsWrite { .. } => AuthorityToolIdV4::FsWrite,
            Self::FsEdit { .. } => AuthorityToolIdV4::FsEdit,
            Self::FsRename { .. } => AuthorityToolIdV4::FsRename,
            Self::FsDelete(_) => AuthorityToolIdV4::FsDelete,
            Self::FsEnsureDirectory { .. } => AuthorityToolIdV4::FsEnsureDirectory,
            Self::DocumentRead { .. } => AuthorityToolIdV4::DocumentRead,
            Self::GitStatus { .. } => AuthorityToolIdV4::GitStatus,
            Self::GitDiff { .. } => AuthorityToolIdV4::GitDiff,
            Self::GitStage { .. } => AuthorityToolIdV4::GitStage,
            Self::GitUnstage { .. } => AuthorityToolIdV4::GitUnstage,
            Self::GitCommit { .. } => AuthorityToolIdV4::GitCommit,
            Self::WebSearch { .. } => AuthorityToolIdV4::WebSearch,
            Self::WebFetch { .. } => AuthorityToolIdV4::WebFetch,
        }
    }

    pub fn validate(&self) -> Result<(), V2ValidationError> {
        let encoded = serde_json::to_vec(self)
            .map_err(|_| invalid_value("canonicalInvocation", "must serialize"))?;
        if encoded.len() > MAX_CANONICAL_INVOCATION_BYTES_V4 {
            return Err(field_too_large(
                "canonicalInvocation",
                MAX_CANONICAL_INVOCATION_BYTES_V4,
            ));
        }
        match self {
            Self::FsRead { path, range } => {
                validate_path(path, false)?;
                if let LineRangeV4::Lines {
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
                DeleteTargetV4::File { path } | DeleteTargetV4::DirectoryTree { path } => {
                    validate_path(path, false)?
                }
            },
            Self::DocumentRead { path, pages } => {
                validate_path(path, false)?;
                if let DocumentPagesV4::Range {
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
                if let GitDiffScopeV4::Paths { paths } = scope {
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
pub enum TextMediaTypeV4 {
    TextPlainUtf8,
    TextMarkdownUtf8,
    ApplicationJsonUtf8,
    TextDiffUtf8,
    TextDocumentUtf8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PathEntrySizeV4 {
    Unavailable {},
    Bytes { value: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PathEntryV4 {
    pub relative_path: String,
    pub kind: WorkspaceObjectKindV4,
    pub size: PathEntrySizeV4,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchMatchV4 {
    pub relative_path: String,
    pub line: u32,
    pub column: u32,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchItemV4 {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkPublicTargetV4 {
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
pub enum ToolOutputPayloadV4 {
    Utf8Text {
        media_type: TextMediaTypeV4,
        text: String,
    },
    PathEntries {
        entries: Vec<PathEntryV4>,
    },
    SearchMatches {
        matches: Vec<SearchMatchV4>,
    },
    WebSearchResults {
        items: Vec<WebSearchItemV4>,
    },
    WebResponse {
        status_code: u16,
        final_target: NetworkPublicTargetV4,
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
pub enum OutputTruncationV4 {
    Complete {},
    Truncated { retained_bytes: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolOutputV4 {
    pub full_digest: ToolOutputDigestV2,
    pub total_bytes: u64,
    pub truncation: OutputTruncationV4,
    pub payload: ToolOutputPayloadV4,
}

pub fn tool_contract_digest_v4(
    contract: &ToolContractV4,
) -> Result<ToolContractDigestV4, V2ValidationError> {
    Ok(ToolContractDigestV4::from_raw_digest(typed_digest(
        "deepcode.kernel.tools.v4/contract",
        &serde_json::json!({
            "toolId":contract.tool_id,
            "executionAvailability":contract.execution_availability,
            "effectClass":contract.effect_class,
            "effectScope":contract.effect_scope,
            "risk":contract.risk,
            "resourceConstraint":contract.resource_constraint,
            "cancellation":contract.cancellation,
            "idempotency":contract.idempotency,
            "deadline":contract.deadline,
            "verification":contract.verification,
            "rollback":contract.rollback,
            "outputBudget":contract.output_budget,
            "cleanup":contract.cleanup,
            "invocationInput":contract.invocation_input,
        }),
    )?))
}

pub fn tool_catalog_digest_v4(
    contracts: &[ToolContractV4],
) -> Result<ToolCatalogDigestV4, V2ValidationError> {
    let leaves = contracts
        .iter()
        .map(|contract| {
            serde_json::json!({
                "toolId":contract.tool_id,
                "contractDigest":contract.contract_digest,
            })
        })
        .collect::<Vec<_>>();
    Ok(ToolCatalogDigestV4::from_raw_digest(typed_digest(
        "deepcode.kernel.tools.v4/catalog",
        &serde_json::json!({
            "catalogVersion":KERNEL_TOOL_CATALOG_V4_VERSION,
            "contracts":leaves,
        }),
    )?))
}

pub fn tool_output_digest_v4(
    tool_id: AuthorityToolIdV4,
    payload: &ToolOutputPayloadV4,
) -> Result<ToolOutputDigestV2, V2ValidationError> {
    ToolOutputDigestV2::parse(encoded_digest(typed_digest(
        "deepcode.kernel.tools.v4/output",
        &serde_json::json!({
            "toolId":tool_id,
            "typedOutputPayload":payload,
        }),
    )?))
}

pub fn output_payload_measure_v4(
    tool_id: AuthorityToolIdV4,
    payload: ToolOutputPayloadV4,
) -> Result<ToolOutputV4, V2ValidationError> {
    let total_bytes = serde_json::to_vec(&payload)
        .map_err(|_| invalid_value("toolOutput", "must serialize"))?
        .len() as u64;
    Ok(ToolOutputV4 {
        full_digest: tool_output_digest_v4(tool_id, &payload)?,
        total_bytes,
        truncation: OutputTruncationV4::Complete {},
        payload,
    })
}

fn validate_schema(value: &Value, depth: usize) -> Result<(), V2ValidationError> {
    if depth > 32 {
        return Err(invalid_value(
            "invocationInput",
            "schema nesting exceeds 32",
        ));
    }
    match value {
        Value::Object(object) => {
            const ALLOWED: &[&str] = &[
                "type",
                "properties",
                "required",
                "additionalProperties",
                "items",
                "enum",
                "const",
                "minimum",
                "maximum",
                "minItems",
                "maxItems",
                "uniqueItems",
                "oneOf",
            ];
            for (key, child) in object {
                if !ALLOWED.contains(&key.as_str()) {
                    return Err(invalid_value(
                        "invocationInput",
                        "contains an unsupported schema keyword",
                    ));
                }
                validate_schema(child, depth + 1)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                validate_schema(child, depth + 1)?;
            }
        }
        Value::Number(number) if number.as_u64().is_none() => {
            return Err(invalid_value(
                "invocationInput",
                "contains a negative or floating-point number",
            ));
        }
        _ => {}
    }
    Ok(())
}

fn validate_resource_constraint(value: &ResourceConstraintV4) -> Result<(), V2ValidationError> {
    let validate_kinds = |kinds: &[WorkspaceObjectKindV4]| {
        if kinds.is_empty() {
            return Err(empty_field("allowedKinds"));
        }
        if !kinds.windows(2).all(|pair| pair[0] < pair[1]) {
            return Err(invalid_value("allowedKinds", "must be sorted and unique"));
        }
        Ok(())
    };
    match value {
        ResourceConstraintV4::WorkspacePath { allowed_kinds, .. } => validate_kinds(allowed_kinds),
        ResourceConstraintV4::WorkspacePathPair {
            source,
            destination,
            kind_relation,
            overwrite,
        } => {
            validate_kinds(&source.allowed_kinds)?;
            validate_kinds(&destination.allowed_kinds)?;
            if *kind_relation != EndpointKindRelationV4::SameAsSource
                || *overwrite != OverwritePolicyV4::Forbidden
            {
                return Err(invalid_value(
                    "workspacePathPair",
                    "must preserve same-kind and no-overwrite semantics",
                ));
            }
            Ok(())
        }
        _ => Ok(()),
    }
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
    if values.is_empty() || values.len() > MAX_LIST_ITEMS_V4 {
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
    if (!allow_empty_list && values.is_empty()) || values.len() > MAX_LIST_ITEMS_V4 {
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
    if value.len() > MAX_ORDINARY_STRING_BYTES_V4 {
        return Err(field_too_large(field, MAX_ORDINARY_STRING_BYTES_V4));
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

fn validate_matcher(value: &EditMatcherV4) -> Result<(), V2ValidationError> {
    match value {
        EditMatcherV4::ExactBlock { text } => validate_text("matcher.text", text, false),
        EditMatcherV4::ContextBlock {
            before,
            target,
            after,
        } => {
            validate_text("matcher.before", before, true)?;
            validate_text("matcher.target", target, false)?;
            validate_text("matcher.after", after, true)
        }
        EditMatcherV4::LineRange {
            start_line,
            end_line,
            precondition,
        } => {
            validate_range("matcher.lineRange", *start_line, *end_line)?;
            if let FileDigestPreconditionV4::ExpectedBeforeBlock { text } = precondition {
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
