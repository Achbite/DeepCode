use std::collections::BTreeMap;

use deepcode_kernel_abi::v2::PlatformV2;
use deepcode_kernel_abi::v2::V2ValidationError;
use deepcode_kernel_abi::{
    tool_catalog_digest_v4, tool_contract_digest_v4, AuthorityToolIdV4, CancellationV4, CleanupV4,
    DeadlineV4, DeleteTargetV4, EffectClassV4, EffectScopeV4, EndpointKindRelationV4,
    ExecutionAvailabilityV4, GitDiffScopeV4, IdempotencyV4, InvocationInputSchemaV4,
    OutputBudgetV4, OverwritePolicyV4, PathEndpointConstraintV4, RepositoryAreaV4,
    ResourceAccessV4, ResourceConstraintV4, RollbackV4, TargetExistenceV4, ToolCatalogDigestV4,
    ToolCatalogV4, ToolContractDigestV4, ToolContractV4, ToolInvocationInputV4, ToolRiskV4,
    VerificationV4, WorkspaceObjectKindV4, KERNEL_TOOL_CATALOG_V4_VERSION,
};
use serde_json::{json, Value};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

use crate::{
    KernelExecutorBinding, KernelToolRegistration, KernelToolRegistry, OperationExecutionMode,
    ToolRiskLevel,
};

const FS_DEFAULT_MS: u32 = 10_000;
const FS_MAXIMUM_MS: u32 = 30_000;
const GIT_DEFAULT_MS: u32 = 30_000;
const GIT_MAXIMUM_MS: u32 = 120_000;
const WEB_DEFAULT_MS: u32 = 15_000;
const WEB_MAXIMUM_MS: u32 = 60_000;
const FS_OUTPUT_BYTES: u32 = 4_194_304;
const GIT_OUTPUT_BYTES: u32 = 65_536;
const WEB_OUTPUT_BYTES: u32 = 262_144;
const ZERO_DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone)]
pub(crate) struct AuthorityToolDescriptorV4 {
    tool_id: AuthorityToolIdV4,
    availability: ExecutionAvailabilityV4,
    effect_class: EffectClassV4,
    effect_scope: EffectScopeV4,
    risk: ToolRiskV4,
    resource_constraint: ResourceConstraintV4,
    cancellation: CancellationV4,
    idempotency: IdempotencyV4,
    deadline: DeadlineV4,
    verification: VerificationV4,
    rollback: RollbackV4,
    output_budget: OutputBudgetV4,
    invocation_input: InvocationInputSchemaV4,
}

#[derive(Debug, Error)]
pub enum AuthorityCatalogErrorV4 {
    #[error("built-in registry is missing v4 tool `{0}`")]
    MissingBuiltInRegistration(&'static str),
    #[error("built-in v4 registration `{0}` has no descriptor")]
    MissingDescriptor(&'static str),
    #[error("built-in v4 registration `{0}` has a mismatched risk")]
    RiskMismatch(&'static str),
    #[error("ready built-in v4 registration `{0}` has no executable binding")]
    ReadyBindingUnavailable(&'static str),
    #[error("blocked built-in v4 registration `{0}` unexpectedly has execute availability")]
    BlockedBindingMismatch(&'static str),
    #[error(transparent)]
    Contract(#[from] V2ValidationError),
}

#[derive(Debug, Clone)]
struct LocalAuthorityToolEntryV4 {
    contract: ToolContractV4,
    ready_binding: Option<KernelExecutorBinding>,
}

/// Trusted projection built only from the compiled-in registry, never from a wire catalog.
#[derive(Debug, Clone)]
pub struct LocalAuthorityToolCatalogV4 {
    catalog: ToolCatalogV4,
    entries: BTreeMap<AuthorityToolIdV4, LocalAuthorityToolEntryV4>,
}

impl LocalAuthorityToolCatalogV4 {
    pub fn from_builtin_registry() -> Result<Self, AuthorityCatalogErrorV4> {
        Self::project(&KernelToolRegistry::default())
    }

    fn project(registry: &KernelToolRegistry) -> Result<Self, AuthorityCatalogErrorV4> {
        let mut entries = BTreeMap::new();
        let mut contracts = Vec::with_capacity(AuthorityToolIdV4::ALL.len());
        for tool_id in AuthorityToolIdV4::ALL {
            let registration = registry.get(tool_id.as_str()).ok_or(
                AuthorityCatalogErrorV4::MissingBuiltInRegistration(tool_id.as_str()),
            )?;
            let descriptor = registration
                .authority_v4
                .clone()
                .ok_or(AuthorityCatalogErrorV4::MissingDescriptor(tool_id.as_str()))?;
            if descriptor.tool_id != tool_id {
                return Err(AuthorityCatalogErrorV4::MissingDescriptor(tool_id.as_str()));
            }
            verify_v1_projection(registration, &descriptor)?;
            let contract = descriptor.into_contract()?;
            let ready_binding = match contract.execution_availability {
                ExecutionAvailabilityV4::Ready => {
                    if registration.contract.execution.execution_mode
                        != OperationExecutionMode::Execute
                    {
                        return Err(AuthorityCatalogErrorV4::ReadyBindingUnavailable(
                            tool_id.as_str(),
                        ));
                    }
                    Some(registration.executor_binding.ok_or(
                        AuthorityCatalogErrorV4::ReadyBindingUnavailable(tool_id.as_str()),
                    )?)
                }
                ExecutionAvailabilityV4::Blocked => None,
            };
            contracts.push(contract.clone());
            entries.insert(
                tool_id,
                LocalAuthorityToolEntryV4 {
                    contract,
                    ready_binding,
                },
            );
        }
        let catalog_digest = tool_catalog_digest_v4(&contracts)?;
        let catalog = ToolCatalogV4 {
            catalog_version: KERNEL_TOOL_CATALOG_V4_VERSION.to_owned(),
            tools: contracts,
            catalog_digest,
        };
        catalog.validate()?;
        Ok(Self { catalog, entries })
    }

    pub fn wire_catalog(&self) -> &ToolCatalogV4 {
        &self.catalog
    }

    pub fn catalog_digest(&self) -> &ToolCatalogDigestV4 {
        &self.catalog.catalog_digest
    }

    pub fn contract(&self, tool_id: AuthorityToolIdV4) -> &ToolContractV4 {
        &self
            .entries
            .get(&tool_id)
            .expect("closed v4 catalog contains every ABI identity")
            .contract
    }

    pub fn ready_binding(&self, tool_id: AuthorityToolIdV4) -> Option<KernelExecutorBinding> {
        self.entries.get(&tool_id)?.ready_binding
    }
}

impl AuthorityToolDescriptorV4 {
    fn into_contract(self) -> Result<ToolContractV4, V2ValidationError> {
        let mut contract = ToolContractV4 {
            tool_id: self.tool_id,
            execution_availability: self.availability,
            effect_class: self.effect_class,
            effect_scope: self.effect_scope,
            risk: self.risk,
            resource_constraint: self.resource_constraint,
            cancellation: self.cancellation,
            idempotency: self.idempotency,
            deadline: self.deadline,
            verification: self.verification,
            rollback: self.rollback,
            output_budget: self.output_budget,
            cleanup: CleanupV4 { required: false },
            invocation_input: self.invocation_input,
            contract_digest: ToolContractDigestV4::parse(ZERO_DIGEST)?,
        };
        contract.contract_digest = tool_contract_digest_v4(&contract)?;
        contract.validate()?;
        Ok(contract)
    }
}

fn verify_v1_projection(
    registration: &KernelToolRegistration,
    descriptor: &AuthorityToolDescriptorV4,
) -> Result<(), AuthorityCatalogErrorV4> {
    let expected_risk = match registration.risk() {
        ToolRiskLevel::Low => ToolRiskV4::Low,
        ToolRiskLevel::Medium => ToolRiskV4::Medium,
        ToolRiskLevel::High => ToolRiskV4::High,
        ToolRiskLevel::Critical => ToolRiskV4::Critical,
    };
    if expected_risk != descriptor.risk {
        return Err(AuthorityCatalogErrorV4::RiskMismatch(
            descriptor.tool_id.as_str(),
        ));
    }
    if descriptor.availability == ExecutionAvailabilityV4::Blocked
        && descriptor.cancellation != CancellationV4::Unavailable
    {
        return Err(AuthorityCatalogErrorV4::BlockedBindingMismatch(
            descriptor.tool_id.as_str(),
        ));
    }
    Ok(())
}

pub(crate) fn authority_descriptor_v4(tool_id: &'static str) -> Option<AuthorityToolDescriptorV4> {
    let tool_id = AuthorityToolIdV4::ALL
        .into_iter()
        .find(|candidate| candidate.as_str() == tool_id)?;
    descriptor_for(tool_id).ok()
}

fn descriptor_for(
    tool_id: AuthorityToolIdV4,
) -> Result<AuthorityToolDescriptorV4, V2ValidationError> {
    use AuthorityToolIdV4 as Tool;
    use EffectClassV4 as Class;
    use EffectScopeV4 as Effect;
    use ExecutionAvailabilityV4 as Availability;
    use ResourceAccessV4 as Access;
    use TargetExistenceV4 as Existence;
    use ToolRiskV4 as Risk;
    use VerificationV4 as Verification;

    let descriptor = match tool_id {
        Tool::CodeGrep => ready_fs_read_descriptor(
            tool_id,
            ResourceConstraintV4::WorkspaceSearch {
                root_existence: Existence::MustExist,
            },
            object_schema(
                json!({
                    "root": {"type":"string"},
                    "query": {"type":"string"},
                    "include": string_array_schema(0),
                    "exclude": string_array_schema(0),
                    "strategy": {"type":"string","enum":["literal","regex"]},
                    "contextLines": {"type":"integer","minimum":0,"maximum":5},
                    "maxResults": {"type":"integer","minimum":1,"maximum":500}
                }),
                &[
                    "root",
                    "query",
                    "include",
                    "exclude",
                    "strategy",
                    "contextLines",
                    "maxResults",
                ],
            ),
        )?,
        Tool::DocumentRead => ready_fs_read_descriptor(
            tool_id,
            workspace_path(
                Access::Read,
                Existence::MustExist,
                &[WorkspaceObjectKindV4::File],
            ),
            object_schema(
                json!({"path":{"type":"string"},"pages":page_range_schema()}),
                &["path", "pages"],
            ),
        )?,
        Tool::FsCreate => ready_fs_file_mutation_descriptor(
            tool_id,
            Existence::MustNotExist,
            object_schema(
                json!({
                    "path":{"type":"string"},
                    "content":{"type":"string"},
                    "executable":{"type":"boolean"}
                }),
                &["path", "content", "executable"],
            ),
        )?,
        Tool::FsDelete => ready_fs_descriptor(
            tool_id,
            Class::Mutation,
            Risk::High,
            workspace_path(
                Access::Write,
                Existence::MustExist,
                &[
                    WorkspaceObjectKindV4::File,
                    WorkspaceObjectKindV4::Directory,
                ],
            ),
            Verification::TargetAbsenceReadBack,
            delete_schema(),
        )?,
        Tool::FsDiff => ready_fs_read_descriptor(
            tool_id,
            workspace_path(
                Access::Read,
                Existence::MustExist,
                &[WorkspaceObjectKindV4::File],
            ),
            object_schema(
                json!({"path":{"type":"string"},"proposedContent":{"type":"string"}}),
                &["path", "proposedContent"],
            ),
        )?,
        Tool::FsEdit => ready_fs_file_mutation_descriptor(
            tool_id,
            Existence::MustExist,
            object_schema(
                json!({
                    "path":{"type":"string"},
                    "matcher":edit_matcher_schema(),
                    "replacement":{"type":"string"}
                }),
                &["path", "matcher", "replacement"],
            ),
        )?,
        Tool::FsEnsureDirectory => ready_fs_descriptor(
            tool_id,
            Class::Mutation,
            Risk::Medium,
            workspace_path(
                Access::Write,
                Existence::MayExist,
                &[WorkspaceObjectKindV4::Directory],
            ),
            Verification::DirectoryTypeReadBack,
            object_schema(json!({"path":{"type":"string"}}), &["path"]),
        )?,
        Tool::FsGlob => ready_fs_read_descriptor(
            tool_id,
            ResourceConstraintV4::WorkspaceSearch {
                root_existence: Existence::MustExist,
            },
            object_schema(
                json!({
                    "root":{"type":"string"},
                    "pattern":{"type":"string"},
                    "maxResults":{"type":"integer","minimum":1,"maximum":5000}
                }),
                &["root", "pattern", "maxResults"],
            ),
        )?,
        Tool::FsList => ready_fs_read_descriptor(
            tool_id,
            workspace_path(
                Access::Read,
                Existence::MustExist,
                &[WorkspaceObjectKindV4::Directory],
            ),
            object_schema(
                json!({
                    "path":{"type":"string"},
                    "depth":{"type":"integer","minimum":1,"maximum":16},
                    "includeHidden":{"type":"boolean"}
                }),
                &["path", "depth", "includeHidden"],
            ),
        )?,
        Tool::FsRead => ready_fs_read_descriptor(
            tool_id,
            workspace_path(
                Access::Read,
                Existence::MustExist,
                &[WorkspaceObjectKindV4::File],
            ),
            object_schema(
                json!({"path":{"type":"string"},"range":line_range_schema()}),
                &["path", "range"],
            ),
        )?,
        Tool::FsRename => descriptor(
            tool_id,
            Availability::Blocked,
            Class::Mutation,
            Effect::WorkspaceWrite,
            Risk::High,
            ResourceConstraintV4::WorkspacePathPair {
                source: PathEndpointConstraintV4 {
                    access: Access::Write,
                    existence: Existence::MustExist,
                    allowed_kinds: vec![
                        WorkspaceObjectKindV4::File,
                        WorkspaceObjectKindV4::Directory,
                    ],
                },
                destination: PathEndpointConstraintV4 {
                    access: Access::Write,
                    existence: Existence::MustNotExist,
                    allowed_kinds: vec![
                        WorkspaceObjectKindV4::File,
                        WorkspaceObjectKindV4::Directory,
                    ],
                },
                kind_relation: EndpointKindRelationV4::SameAsSource,
                overwrite: OverwritePolicyV4::Forbidden,
            },
            FS_DEFAULT_MS,
            FS_MAXIMUM_MS,
            Verification::RenameReadBack,
            FS_OUTPUT_BYTES,
            schema_for(
                tool_id,
                object_schema(
                    json!({
                        "sourcePath":{"type":"string"},
                        "destinationPath":{"type":"string"}
                    }),
                    &["sourcePath", "destinationPath"],
                ),
            )?,
        ),
        Tool::FsWrite => ready_fs_file_mutation_descriptor(
            tool_id,
            Existence::MustExist,
            object_schema(
                json!({"path":{"type":"string"},"content":{"type":"string"}}),
                &["path", "content"],
            ),
        )?,
        Tool::GitCommit => git_descriptor(
            tool_id,
            Class::Mutation,
            Effect::RepositoryHistoryWrite,
            Risk::High,
            RepositoryAreaV4::History,
            Access::Write,
            object_schema(json!({"message":{"type":"string"}}), &["message"]),
        )?,
        Tool::GitDiff => git_descriptor(
            tool_id,
            Class::Read,
            Effect::RepositoryRead,
            Risk::Low,
            RepositoryAreaV4::State,
            Access::Read,
            object_schema(
                json!({
                    "scope":git_diff_scope_schema(),
                    "staged":{"type":"boolean"}
                }),
                &["scope", "staged"],
            ),
        )?,
        Tool::GitStage => git_descriptor(
            tool_id,
            Class::Mutation,
            Effect::RepositoryIndexWrite,
            Risk::High,
            RepositoryAreaV4::Index,
            Access::Write,
            object_schema(json!({"paths":string_array_schema(1)}), &["paths"]),
        )?,
        Tool::GitStatus => git_descriptor(
            tool_id,
            Class::Read,
            Effect::RepositoryRead,
            Risk::Low,
            RepositoryAreaV4::State,
            Access::Read,
            object_schema(json!({}), &[]),
        )?,
        Tool::GitUnstage => git_descriptor(
            tool_id,
            Class::Mutation,
            Effect::RepositoryIndexWrite,
            Risk::High,
            RepositoryAreaV4::Index,
            Access::Write,
            object_schema(json!({"paths":string_array_schema(1)}), &["paths"]),
        )?,
        Tool::WebFetch => descriptor(
            tool_id,
            Availability::Ready,
            Class::Read,
            Effect::NetworkRead,
            Risk::High,
            ResourceConstraintV4::NetworkUrl {},
            WEB_DEFAULT_MS,
            WEB_MAXIMUM_MS,
            Verification::ResponseDigestAndReviewedTarget,
            WEB_OUTPUT_BYTES,
            schema_for(
                tool_id,
                object_schema(
                    json!({
                        "url":{"type":"string"},
                        "maxBytes":{"type":"integer","minimum":1024,"maximum":262144}
                    }),
                    &["url", "maxBytes"],
                ),
            )?,
        ),
        Tool::WebSearch => descriptor(
            tool_id,
            Availability::Ready,
            Class::Read,
            Effect::NetworkRead,
            Risk::High,
            ResourceConstraintV4::NetworkQuery {},
            WEB_DEFAULT_MS,
            WEB_MAXIMUM_MS,
            Verification::ResponseDigestAndReviewedTarget,
            WEB_OUTPUT_BYTES,
            schema_for(
                tool_id,
                object_schema(
                    json!({
                        "query":{"type":"string"},
                        "limit":{"type":"integer","minimum":1,"maximum":10}
                    }),
                    &["query", "limit"],
                ),
            )?,
        ),
    };
    Ok(descriptor)
}

#[allow(clippy::too_many_arguments)]
fn descriptor(
    tool_id: AuthorityToolIdV4,
    availability: ExecutionAvailabilityV4,
    effect_class: EffectClassV4,
    effect_scope: EffectScopeV4,
    risk: ToolRiskV4,
    resource_constraint: ResourceConstraintV4,
    default_ms: u32,
    maximum_ms: u32,
    verification: VerificationV4,
    maximum_canonical_bytes: u32,
    invocation_input: InvocationInputSchemaV4,
) -> AuthorityToolDescriptorV4 {
    let mutation = effect_class == EffectClassV4::Mutation;
    AuthorityToolDescriptorV4 {
        tool_id,
        availability,
        effect_class,
        effect_scope,
        risk,
        resource_constraint,
        cancellation: if availability == ExecutionAvailabilityV4::Ready {
            CancellationV4::BeforeEffectOnly
        } else {
            CancellationV4::Unavailable
        },
        idempotency: if mutation {
            IdempotencyV4::MutationGuarded
        } else {
            IdempotencyV4::ReadOnlyObservation
        },
        deadline: DeadlineV4 {
            default_ms,
            maximum_ms,
        },
        verification,
        rollback: if mutation {
            RollbackV4::NotProvided
        } else {
            RollbackV4::NotApplicable
        },
        output_budget: OutputBudgetV4 {
            maximum_canonical_bytes,
        },
        invocation_input,
    }
}

fn ready_fs_descriptor(
    tool_id: AuthorityToolIdV4,
    effect_class: EffectClassV4,
    risk: ToolRiskV4,
    resource_constraint: ResourceConstraintV4,
    verification: VerificationV4,
    arguments_schema: Value,
) -> Result<AuthorityToolDescriptorV4, V2ValidationError> {
    let effect_scope = match effect_class {
        EffectClassV4::Read => EffectScopeV4::WorkspaceRead,
        EffectClassV4::Mutation => EffectScopeV4::WorkspaceWrite,
    };
    Ok(descriptor(
        tool_id,
        ExecutionAvailabilityV4::Ready,
        effect_class,
        effect_scope,
        risk,
        resource_constraint,
        FS_DEFAULT_MS,
        FS_MAXIMUM_MS,
        verification,
        FS_OUTPUT_BYTES,
        schema_for(tool_id, arguments_schema)?,
    ))
}

fn ready_fs_read_descriptor(
    tool_id: AuthorityToolIdV4,
    resource_constraint: ResourceConstraintV4,
    arguments_schema: Value,
) -> Result<AuthorityToolDescriptorV4, V2ValidationError> {
    ready_fs_descriptor(
        tool_id,
        EffectClassV4::Read,
        ToolRiskV4::Low,
        resource_constraint,
        VerificationV4::OutputDigest,
        arguments_schema,
    )
}

fn ready_fs_file_mutation_descriptor(
    tool_id: AuthorityToolIdV4,
    existence: TargetExistenceV4,
    arguments_schema: Value,
) -> Result<AuthorityToolDescriptorV4, V2ValidationError> {
    ready_fs_descriptor(
        tool_id,
        EffectClassV4::Mutation,
        ToolRiskV4::Medium,
        workspace_path(
            ResourceAccessV4::Write,
            existence,
            &[WorkspaceObjectKindV4::File],
        ),
        VerificationV4::FileContentReadBack,
        arguments_schema,
    )
}

#[allow(clippy::too_many_arguments)]
fn git_descriptor(
    tool_id: AuthorityToolIdV4,
    effect_class: EffectClassV4,
    effect_scope: EffectScopeV4,
    risk: ToolRiskV4,
    area: RepositoryAreaV4,
    access: ResourceAccessV4,
    arguments_schema: Value,
) -> Result<AuthorityToolDescriptorV4, V2ValidationError> {
    Ok(descriptor(
        tool_id,
        ExecutionAvailabilityV4::Blocked,
        effect_class,
        effect_scope,
        risk,
        ResourceConstraintV4::Repository { access, area },
        GIT_DEFAULT_MS,
        GIT_MAXIMUM_MS,
        VerificationV4::RepositoryStateReadBack,
        GIT_OUTPUT_BYTES,
        schema_for(tool_id, arguments_schema)?,
    ))
}

fn workspace_path(
    access: ResourceAccessV4,
    existence: TargetExistenceV4,
    allowed_kinds: &[WorkspaceObjectKindV4],
) -> ResourceConstraintV4 {
    ResourceConstraintV4::WorkspacePath {
        access,
        existence,
        allowed_kinds: allowed_kinds.to_vec(),
    }
}

fn schema_for(
    tool_id: AuthorityToolIdV4,
    arguments_schema: Value,
) -> Result<InvocationInputSchemaV4, V2ValidationError> {
    InvocationInputSchemaV4::new(json!({
        "type": "object",
        "properties": {
            "toolId": {"const": tool_id.as_str()},
            "arguments": arguments_schema
        },
        "required": ["toolId", "arguments"],
        "additionalProperties": false
    }))
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn string_array_schema(minimum: usize) -> Value {
    json!({
        "type":"array",
        "items":{"type":"string"},
        "minItems":minimum,
        "maxItems":256,
        "uniqueItems":true
    })
}

fn line_range_schema() -> Value {
    json!({
        "oneOf":[
            tagged_object_schema("whole", json!({}), &[]),
            tagged_object_schema(
                "lines",
                json!({
                    "startLine":{"type":"integer","minimum":1},
                    "endLine":{"type":"integer","minimum":1}
                }),
                &["startLine","endLine"]
            )
        ]
    })
}

fn page_range_schema() -> Value {
    json!({
        "oneOf":[
            tagged_object_schema("all", json!({}), &[]),
            tagged_object_schema(
                "range",
                json!({
                    "startPage":{"type":"integer","minimum":1},
                    "endPage":{"type":"integer","minimum":1}
                }),
                &["startPage","endPage"]
            )
        ]
    })
}

fn delete_schema() -> Value {
    json!({
        "oneOf":[
            tagged_object_schema("file", json!({"path":{"type":"string"}}), &["path"]),
            tagged_object_schema(
                "directoryTree",
                json!({"path":{"type":"string"}}),
                &["path"]
            )
        ]
    })
}

fn git_diff_scope_schema() -> Value {
    json!({
        "oneOf":[
            tagged_object_schema("repository", json!({}), &[]),
            tagged_object_schema(
                "paths",
                json!({"paths":string_array_schema(1)}),
                &["paths"]
            )
        ]
    })
}

fn edit_matcher_schema() -> Value {
    json!({
        "oneOf":[
            tagged_object_schema(
                "exactBlock",
                json!({"text":{"type":"string"}}),
                &["text"]
            ),
            tagged_object_schema(
                "contextBlock",
                json!({
                    "before":{"type":"string"},
                    "target":{"type":"string"},
                    "after":{"type":"string"}
                }),
                &["before","target","after"]
            ),
            tagged_object_schema(
                "lineRange",
                json!({
                    "startLine":{"type":"integer","minimum":1},
                    "endLine":{"type":"integer","minimum":1},
                    "precondition":{
                        "oneOf":[
                            tagged_object_schema(
                                "expectedFileDigest",
                                json!({"digest":{"type":"string"}}),
                                &["digest"]
                            ),
                            tagged_object_schema(
                                "expectedBeforeBlock",
                                json!({"text":{"type":"string"}}),
                                &["text"]
                            )
                        ]
                    }
                }),
                &["startLine","endLine","precondition"]
            )
        ]
    })
}

fn tagged_object_schema(kind: &str, fields: Value, required: &[&str]) -> Value {
    object_schema(
        json!({
            "kind":{"const":kind},
            "data":object_schema(fields, required)
        }),
        &["kind", "data"],
    )
}

#[derive(Debug, Error)]
pub enum InvocationNormalizationErrorV4 {
    #[error("arguments for `{tool_id}` do not match the canonical v4 input descriptor")]
    InvalidArguments { tool_id: &'static str },
    #[error("canonical invocation for `{tool_id}` contains an implicit or non-normalized value")]
    NotCanonical { tool_id: &'static str },
    #[error(transparent)]
    Validation(#[from] V2ValidationError),
}

fn invalid_arguments(tool_id: &'static str) -> InvocationNormalizationErrorV4 {
    InvocationNormalizationErrorV4::InvalidArguments { tool_id }
}

pub fn normalize_invocation_v4(
    tool_id: AuthorityToolIdV4,
    mut arguments: Value,
) -> Result<ToolInvocationInputV4, InvocationNormalizationErrorV4> {
    use AuthorityToolIdV4 as Tool;
    let fields = arguments
        .as_object_mut()
        .ok_or_else(|| invalid_arguments(tool_id.as_str()))?;
    let mut materialize = |name: &str, value: Value| {
        fields.entry(name.to_owned()).or_insert(value);
    };
    match tool_id {
        Tool::FsRead => materialize("range", json!({"kind":"whole","data":{}})),
        Tool::FsList => {
            materialize("depth", json!(2));
            materialize("includeHidden", json!(false));
        }
        Tool::FsGlob => {
            materialize("root", json!("."));
            materialize("maxResults", json!(500));
        }
        Tool::CodeGrep => {
            materialize("root", json!("."));
            materialize("include", json!([]));
            materialize("exclude", json!([]));
            materialize("strategy", json!("literal"));
            materialize("contextLines", json!(0));
            materialize("maxResults", json!(200));
        }
        Tool::FsCreate => materialize("executable", json!(false)),
        Tool::DocumentRead => materialize("pages", json!({"kind":"all","data":{}})),
        Tool::GitDiff => {
            materialize("scope", json!({"kind":"repository","data":{}}));
            materialize("staged", json!(false));
        }
        Tool::WebSearch => materialize("limit", json!(5)),
        Tool::WebFetch => materialize("maxBytes", json!(98_304)),
        _ => {}
    }
    let mut invocation = serde_json::from_value::<ToolInvocationInputV4>(json!({
        "toolId":tool_id,
        "arguments":arguments,
    }))
    .map_err(|_| invalid_arguments(tool_id.as_str()))?;
    match &mut invocation {
        ToolInvocationInputV4::FsRead { path, .. }
        | ToolInvocationInputV4::FsDiff { path, .. }
        | ToolInvocationInputV4::FsCreate { path, .. }
        | ToolInvocationInputV4::FsWrite { path, .. }
        | ToolInvocationInputV4::FsEdit { path, .. }
        | ToolInvocationInputV4::FsEnsureDirectory { path }
        | ToolInvocationInputV4::DocumentRead { path, .. } => {
            *path = normalize_workspace_path_v4(path, false)?;
        }
        ToolInvocationInputV4::FsList { path, .. } => {
            *path = normalize_workspace_path_v4(path, true)?;
        }
        ToolInvocationInputV4::FsGlob { root, .. } => {
            *root = normalize_workspace_path_v4(root, true)?;
        }
        ToolInvocationInputV4::CodeGrep {
            root,
            include,
            exclude,
            ..
        } => {
            *root = normalize_workspace_path_v4(root, true)?;
            *include = normalize_string_set(std::mem::take(include))?;
            *exclude = normalize_string_set(std::mem::take(exclude))?;
        }
        ToolInvocationInputV4::FsRename {
            source_path,
            destination_path,
        } => {
            *source_path = normalize_workspace_path_v4(source_path, false)?;
            *destination_path = normalize_workspace_path_v4(destination_path, false)?;
        }
        ToolInvocationInputV4::FsDelete(target) => {
            let path = match target {
                DeleteTargetV4::File { path } | DeleteTargetV4::DirectoryTree { path } => path,
            };
            *path = normalize_workspace_path_v4(path, false)?;
        }
        ToolInvocationInputV4::GitDiff {
            scope: GitDiffScopeV4::Paths { paths },
            ..
        } => {
            *paths = normalize_path_set(std::mem::take(paths))?;
        }
        ToolInvocationInputV4::GitStage { paths } | ToolInvocationInputV4::GitUnstage { paths } => {
            *paths = normalize_path_set(std::mem::take(paths))?;
        }
        _ => {}
    }
    invocation.validate()?;
    Ok(invocation)
}

pub fn validate_canonical_invocation_v4(
    invocation: &ToolInvocationInputV4,
) -> Result<(), InvocationNormalizationErrorV4> {
    invocation.validate()?;
    let encoded = serde_json::to_value(invocation)
        .map_err(|_| invalid_arguments(invocation.tool_id().as_str()))?;
    let arguments = encoded
        .as_object()
        .and_then(|value| value.get("arguments"))
        .cloned()
        .ok_or_else(|| invalid_arguments(invocation.tool_id().as_str()))?;
    let normalized = normalize_invocation_v4(invocation.tool_id(), arguments)?;
    if normalized != *invocation {
        return Err(InvocationNormalizationErrorV4::NotCanonical {
            tool_id: invocation.tool_id().as_str(),
        });
    }
    Ok(())
}

pub fn normalize_workspace_path_v4(
    value: &str,
    allow_dot: bool,
) -> Result<String, InvocationNormalizationErrorV4> {
    if value.trim().is_empty()
        || value.contains('\0')
        || value.contains('\\')
        || value.starts_with('/')
        || value.as_bytes().get(1) == Some(&b':')
    {
        return Err(invalid_arguments("workspace-path"));
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        if part.is_empty() || part == ".." {
            return Err(invalid_arguments("workspace-path"));
        }
        if part != "." {
            parts.push(part.nfc().collect::<String>());
        }
    }
    let normalized = if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    };
    if normalized == "." && !allow_dot {
        return Err(invalid_arguments("workspace-path"));
    }
    Ok(normalized)
}

/// Normalizes a resolver-produced absolute path for Kernel-private digesting.
///
/// This is deliberately separate from caller-facing relative path
/// normalization. The caller must first obtain the value from the platform
/// filesystem resolver; this helper only materializes separators and NFC.
pub fn normalize_canonical_platform_path_v4(
    platform: PlatformV2,
    value: &str,
) -> Result<String, InvocationNormalizationErrorV4> {
    if value.is_empty() || value.contains('\0') {
        return Err(invalid_arguments("canonical-platform-path"));
    }
    let materialized = match platform {
        PlatformV2::Windows => value.replace('\\', "/"),
        PlatformV2::Macos | PlatformV2::Linux => value.to_owned(),
    };
    let prefix_len = match platform {
        PlatformV2::Macos | PlatformV2::Linux if materialized.starts_with('/') => 1,
        PlatformV2::Windows
            if materialized.as_bytes().get(1) == Some(&b':')
                && materialized.as_bytes().get(2) == Some(&b'/')
                && materialized
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphabetic) =>
        {
            3
        }
        PlatformV2::Windows if materialized.starts_with("//") => 2,
        _ => {
            return Err(invalid_arguments("canonical-platform-path"));
        }
    };
    let mut components = Vec::new();
    for component in materialized[prefix_len..].split('/') {
        if component.is_empty() {
            continue;
        }
        if component == "." || component == ".." {
            return Err(invalid_arguments("canonical-platform-path"));
        }
        components.push(component.nfc().collect::<String>());
    }
    let prefix = &materialized[..prefix_len];
    let normalized = if components.is_empty() {
        prefix.to_owned()
    } else if prefix.ends_with('/') {
        format!("{prefix}{}", components.join("/"))
    } else {
        format!("{prefix}/{}", components.join("/"))
    };
    Ok(normalized)
}

fn normalize_path_set(paths: Vec<String>) -> Result<Vec<String>, InvocationNormalizationErrorV4> {
    if paths.is_empty() || paths.len() > 256 {
        return Err(invalid_arguments("workspace-path-list"));
    }
    let mut normalized = paths
        .iter()
        .map(|path| normalize_workspace_path_v4(path, false))
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

fn normalize_string_set(
    mut values: Vec<String>,
) -> Result<Vec<String>, InvocationNormalizationErrorV4> {
    if values.len() > 256
        || values
            .iter()
            .any(|value| value.trim().is_empty() || value.contains('\0'))
    {
        return Err(invalid_arguments("string-list"));
    }
    values.sort();
    values.dedup();
    Ok(values)
}
