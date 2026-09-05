use crate::local_agent_mcp::{McpRuntime, McpTool, McpToolBindingRequirement, McpToolEffectScope};
use deepcode_kernel_runtime::executors::{
    builtin_executors, web_search_availability, KernelExecutorConfig, KernelExecutorRegistry,
    KernelToolExecutionContext, KernelToolExecutionFailure, KernelToolExecutionOutcome,
    KernelToolExecutionResult, KernelToolInvocation, SecretProvider,
};
use deepcode_kernel_tools::{
    hash_bytes, KernelToolRegistry, ToolAvailability, ToolEffectClass, ToolEffectScope,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub(crate) struct ToolCatalogError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ToolCatalogError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CatalogEffectScope {
    WorkspaceRead,
    WorkspaceMutation,
    Process,
    Network,
    External,
}

#[derive(Clone)]
enum ToolExecutorBinding {
    Builtin {
        registry: Arc<KernelToolRegistry>,
        executors: Arc<KernelExecutorRegistry>,
    },
    Mcp(Box<McpTool>),
}

struct PendingToolContribution {
    origin: &'static str,
    provider_ref: String,
    plugin_uri: Option<String>,
    plugin_instance_ref: Option<String>,
    contribution_ref: String,
    binding_identity: String,
    name: String,
    description: String,
    input_schema: Value,
    effect_class: Option<ToolEffectClass>,
    effect_scope: CatalogEffectScope,
    availability: ToolAvailability,
    logical_target: Option<String>,
    binding: ToolExecutorBinding,
}

type ExactDisposer = Box<dyn FnOnce() -> Result<(), ToolCatalogError> + Send>;

struct InstalledToolProvider {
    tools: Vec<PendingToolContribution>,
    dispose: ExactDisposer,
}

trait ToolProvider: Send {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError>;
}

struct BuiltinToolProvider {
    registry: Arc<KernelToolRegistry>,
    executors: Arc<KernelExecutorRegistry>,
    binding_identity: String,
    web_search_availability: ToolAvailability,
}

impl BuiltinToolProvider {
    fn prepare(
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
        enable_web_search: bool,
    ) -> Result<Self, ToolCatalogError> {
        let binding_identity = builtin_binding_identity(&executor_config)?;
        let web_search_availability = if enable_web_search {
            web_search_availability(&executor_config)
        } else {
            ToolAvailability::Blocked
        };
        let registry = Arc::new(KernelToolRegistry::new());
        let executors = Arc::new(KernelExecutorRegistry::from_executors(builtin_executors(
            registry.as_ref(),
            executor_config,
            secret_provider,
        )));
        Ok(Self {
            registry,
            executors,
            binding_identity,
            web_search_availability,
        })
    }
}

impl ToolProvider for BuiltinToolProvider {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError> {
        let tools = self
            .registry
            .descriptors()
            .map(|descriptor| PendingToolContribution {
                origin: "coreBuiltin",
                provider_ref: "tool-provider:core-builtin".to_string(),
                plugin_uri: None,
                plugin_instance_ref: None,
                contribution_ref: format!("tool-contribution:builtin:{}", descriptor.name),
                binding_identity: self.binding_identity.clone(),
                name: descriptor.name.clone(),
                description: descriptor.description.clone(),
                input_schema: descriptor.input_schema.clone(),
                effect_class: Some(descriptor.effect_class),
                effect_scope: match descriptor.effect_scope {
                    ToolEffectScope::WorkspaceRead => CatalogEffectScope::WorkspaceRead,
                    ToolEffectScope::WorkspaceWrite => CatalogEffectScope::WorkspaceMutation,
                    ToolEffectScope::NetworkRead => CatalogEffectScope::Network,
                    ToolEffectScope::Process => CatalogEffectScope::Process,
                },
                availability: if descriptor.name == "web.search" {
                    self.web_search_availability
                } else {
                    descriptor.availability
                },
                logical_target: None,
                binding: ToolExecutorBinding::Builtin {
                    registry: Arc::clone(&self.registry),
                    executors: Arc::clone(&self.executors),
                },
            })
            .collect();
        Ok(InstalledToolProvider {
            tools,
            dispose: Box::new(|| Ok(())),
        })
    }
}

struct McpToolProvider {
    runtime: McpRuntime,
}

impl McpToolProvider {
    fn prepare(runtime: McpRuntime) -> Result<Self, ToolCatalogError> {
        Ok(Self { runtime })
    }
}

impl ToolProvider for McpToolProvider {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError> {
        let tools = self
            .runtime
            .tools()
            .map(|tool| {
                let binding_requirement = match &tool.binding_requirement {
                    McpToolBindingRequirement::None => "none".to_string(),
                    McpToolBindingRequirement::WorkspacePath { argument } => {
                        format!("workspacePath:{argument}")
                    }
                };
                let stable_binding_identity = format!(
                    "mcp-binding:{}",
                    hash_bytes(
                        format!(
                            "{}\n{}\n{}\n{}",
                            tool.plugin_instance_ref,
                            tool.public_name,
                            tool.target,
                            binding_requirement,
                        )
                        .as_bytes(),
                    )
                );
                PendingToolContribution {
                    origin: "extension",
                    provider_ref: tool.provider_ref.clone(),
                    plugin_uri: Some(tool.plugin_uri.clone()),
                    plugin_instance_ref: Some(tool.plugin_instance_ref.clone()),
                    contribution_ref: tool.contribution_ref.clone(),
                    binding_identity: stable_binding_identity,
                    name: tool.public_name.clone(),
                    description: tool.description.clone(),
                    input_schema: tool.input_schema.clone(),
                    effect_class: None,
                    effect_scope: match tool.effect_scope {
                        McpToolEffectScope::WorkspaceRead => CatalogEffectScope::WorkspaceRead,
                        McpToolEffectScope::Network => CatalogEffectScope::Network,
                        McpToolEffectScope::External => CatalogEffectScope::External,
                    },
                    availability: ToolAvailability::Callable,
                    logical_target: Some(tool.target.clone()),
                    binding: ToolExecutorBinding::Mcp(Box::new(tool.clone())),
                }
            })
            .collect();
        let runtime = self.runtime.clone();
        Ok(InstalledToolProvider {
            tools,
            dispose: Box::new(move || {
                runtime
                    .shutdown()
                    .map_err(|error| ToolCatalogError::new(error.code, error.message))
            }),
        })
    }
}

struct CatalogResources {
    disposers: Mutex<Option<Vec<ExactDisposer>>>,
}

impl CatalogResources {
    fn new(disposers: Vec<ExactDisposer>) -> Self {
        Self {
            disposers: Mutex::new(Some(disposers)),
        }
    }

    fn dispose(&self) -> Result<(), ToolCatalogError> {
        let mut guard = self.disposers.lock().map_err(|_| {
            ToolCatalogError::new(
                "tool_provider_disposer_lock_failed",
                "ToolProvider disposer 状态锁已损坏。",
            )
        })?;
        let Some(disposers) = guard.take() else {
            return Ok(());
        };
        drop(guard);

        let mut errors = Vec::new();
        for dispose in disposers.into_iter().rev() {
            if let Err(error) = dispose() {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            let message = errors
                .iter()
                .map(|error| format!("{}: {}", error.code, error.message))
                .collect::<Vec<_>>()
                .join("；");
            Err(ToolCatalogError::new(
                "tool_provider_dispose_failed",
                message,
            ))
        }
    }
}

impl Drop for CatalogResources {
    fn drop(&mut self) {
        let _ = self.dispose();
    }
}

struct CatalogToolEntry {
    origin: &'static str,
    provider_ref: String,
    plugin_uri: Option<String>,
    plugin_instance_ref: Option<String>,
    contribution_ref: String,
    binding_ref: String,
    name: String,
    description: String,
    input_schema: Value,
    effect_class: Option<ToolEffectClass>,
    effect_scope: CatalogEffectScope,
    availability: ToolAvailability,
    logical_target: Option<String>,
    binding: ToolExecutorBinding,
}

pub(crate) struct ToolCatalogSnapshot {
    extension_generation_ref: String,
    snapshot_ref: String,
    tools: BTreeMap<String, CatalogToolEntry>,
    bindings: BTreeMap<String, String>,
    resources: CatalogResources,
    active_attempts: AtomicUsize,
}

impl ToolCatalogSnapshot {
    pub(crate) fn prepare(
        extension_generation_ref: &str,
        kernel_runtime_generation_key: &str,
        executor_config: KernelExecutorConfig,
        secret_provider: Arc<dyn SecretProvider>,
        mcp: McpRuntime,
        enable_web_search: bool,
    ) -> Result<Arc<Self>, ToolCatalogError> {
        validate_ref("extensionGenerationRef", extension_generation_ref)?;
        validate_ref("kernelRuntimeGenerationKey", kernel_runtime_generation_key)?;
        let providers: Vec<Box<dyn ToolProvider>> = vec![
            Box::new(BuiltinToolProvider::prepare(
                executor_config,
                secret_provider,
                enable_web_search,
            )?),
            Box::new(McpToolProvider::prepare(mcp)?),
        ];
        Self::from_providers(
            extension_generation_ref,
            kernel_runtime_generation_key,
            providers,
        )
    }

    fn from_providers(
        extension_generation_ref: &str,
        kernel_runtime_generation_key: &str,
        providers: Vec<Box<dyn ToolProvider>>,
    ) -> Result<Arc<Self>, ToolCatalogError> {
        let mut contributions = BTreeMap::new();
        let mut disposers = Vec::new();
        for provider in providers {
            let installed = match provider.install() {
                Ok(installed) => installed,
                Err(error) => {
                    dispose_all(disposers);
                    return Err(error);
                }
            };
            for contribution in installed.tools {
                if contributions
                    .insert(contribution.name.clone(), contribution)
                    .is_some()
                {
                    dispose_all(disposers);
                    let _ = (installed.dispose)();
                    return Err(ToolCatalogError::new(
                        "tool_catalog_name_conflict",
                        "多个 ToolProvider 注册了相同 canonical tool name。",
                    ));
                }
            }
            disposers.push(installed.dispose);
        }

        let shape = Value::Array(
            contributions
                .values()
                .map(|tool| {
                    json!({
                        "origin": tool.origin,
                        "providerRef": tool.provider_ref,
                        "pluginUri": tool.plugin_uri,
                        "pluginInstanceRef": tool.plugin_instance_ref,
                        "contributionRef": tool.contribution_ref,
                        "bindingIdentity": tool.binding_identity,
                        "logicalTarget": tool.logical_target,
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.input_schema,
                        "possibleEffects": possible_effects(tool.effect_class, tool.effect_scope),
                        "availability": availability_name(tool.availability),
                    })
                })
                .collect(),
        );
        let encoded = match serde_json::to_vec(&json!({
            "extensionGenerationRef": extension_generation_ref,
            "kernelRuntimeGenerationKey": kernel_runtime_generation_key,
            "tools": shape,
        })) {
            Ok(encoded) => encoded,
            Err(error) => {
                dispose_all(disposers);
                return Err(ToolCatalogError::new(
                    "tool_catalog_encode_failed",
                    error.to_string(),
                ));
            }
        };
        let snapshot_ref = format!("kernel-catalog:{}", hash_bytes(&encoded));

        let mut tools = BTreeMap::new();
        let mut bindings = BTreeMap::new();
        for (_, contribution) in contributions {
            let binding_ref = format!(
                "tool-binding:{}",
                hash_bytes(
                    format!(
                        "{}\n{}\n{}",
                        snapshot_ref, contribution.contribution_ref, contribution.name
                    )
                    .as_bytes()
                )
            );
            bindings.insert(binding_ref.clone(), contribution.name.clone());
            tools.insert(
                contribution.name.clone(),
                CatalogToolEntry {
                    origin: contribution.origin,
                    provider_ref: contribution.provider_ref,
                    plugin_uri: contribution.plugin_uri,
                    plugin_instance_ref: contribution.plugin_instance_ref,
                    contribution_ref: contribution.contribution_ref,
                    binding_ref,
                    name: contribution.name,
                    description: contribution.description,
                    input_schema: contribution.input_schema,
                    effect_class: contribution.effect_class,
                    effect_scope: contribution.effect_scope,
                    availability: contribution.availability,
                    logical_target: contribution.logical_target,
                    binding: contribution.binding,
                },
            );
        }

        Ok(Arc::new(Self {
            extension_generation_ref: extension_generation_ref.to_string(),
            snapshot_ref,
            tools,
            bindings,
            resources: CatalogResources::new(disposers),
            active_attempts: AtomicUsize::new(0),
        }))
    }

    pub(crate) fn extension_generation_ref(&self) -> &str {
        &self.extension_generation_ref
    }

    pub(crate) fn snapshot_ref(&self) -> &str {
        &self.snapshot_ref
    }

    pub(crate) fn provider_view(&self) -> Value {
        Value::Array(
            self.tools
                .values()
                .map(|tool| {
                    let mut view = json!({
                        "toolBindingRef": tool.binding_ref,
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.input_schema,
                        "possibleEffects": possible_effects(tool.effect_class, tool.effect_scope),
                        "availability": availability_name(tool.availability),
                        "origin": tool.origin,
                    });
                    if let Some(plugin_uri) = &tool.plugin_uri {
                        view["pluginUri"] = json!(plugin_uri);
                    }
                    view
                })
                .collect(),
        )
    }

    pub(crate) fn binding(
        self: &Arc<Self>,
        binding_ref: &str,
        tool_name: &str,
    ) -> Result<PreparedCatalogBinding, ToolCatalogError> {
        let bound_name = self.bindings.get(binding_ref).ok_or_else(|| {
            ToolCatalogError::new(
                "tool_binding_not_found",
                "toolBindingRef 不属于当前 Kernel catalog snapshot。",
            )
        })?;
        if bound_name != tool_name {
            return Err(ToolCatalogError::new(
                "tool_binding_identity_mismatch",
                "toolBindingRef 与 canonical tool name 不一致。",
            ));
        }
        Ok(PreparedCatalogBinding {
            snapshot: Arc::clone(self),
            binding_ref: binding_ref.to_string(),
        })
    }

    pub(crate) fn active_attempts(&self) -> usize {
        self.active_attempts.load(Ordering::Acquire)
    }

    pub(crate) fn dispose(&self) -> Result<(), ToolCatalogError> {
        if self.active_attempts() != 0 {
            return Err(ToolCatalogError::new(
                "tool_catalog_generation_busy",
                "Kernel catalog generation 仍有物理 attempt lease。",
            ));
        }
        self.resources.dispose()
    }
}

#[derive(Clone)]
pub(crate) struct PreparedCatalogBinding {
    snapshot: Arc<ToolCatalogSnapshot>,
    binding_ref: String,
}

impl PreparedCatalogBinding {
    fn entry(&self) -> &CatalogToolEntry {
        let name = self
            .snapshot
            .bindings
            .get(&self.binding_ref)
            .expect("prepared binding belongs to snapshot");
        self.snapshot
            .tools
            .get(name)
            .expect("prepared binding names a catalog entry")
    }

    pub(crate) fn binding_ref(&self) -> &str {
        &self.binding_ref
    }

    pub(crate) fn extension_generation_ref(&self) -> &str {
        self.snapshot.extension_generation_ref()
    }

    pub(crate) fn snapshot_ref(&self) -> &str {
        self.snapshot.snapshot_ref()
    }

    pub(crate) fn contribution_ref(&self) -> &str {
        &self.entry().contribution_ref
    }

    pub(crate) fn origin(&self) -> &str {
        self.entry().origin
    }

    pub(crate) fn provider_ref(&self) -> &str {
        &self.entry().provider_ref
    }

    pub(crate) fn plugin_instance_ref(&self) -> Option<&str> {
        self.entry().plugin_instance_ref.as_deref()
    }

    pub(crate) fn tool_name(&self) -> &str {
        &self.entry().name
    }

    pub(crate) fn effect_scope(&self) -> CatalogEffectScope {
        self.entry().effect_scope
    }

    pub(crate) fn availability(&self) -> ToolAvailability {
        self.entry().availability
    }

    pub(crate) fn logical_target(&self) -> Option<&str> {
        self.entry().logical_target.as_deref()
    }

    pub(crate) fn canonicalize(&self, raw_arguments: Value) -> Result<Value, ToolCatalogError> {
        match &self.entry().binding {
            ToolExecutorBinding::Builtin { registry, .. } => registry
                .canonicalize(self.tool_name(), raw_arguments)
                .map(|invocation| invocation.arguments)
                .map_err(|error| ToolCatalogError::new("tool_input_invalid", error.to_string())),
            ToolExecutorBinding::Mcp(_) => Ok(raw_arguments),
        }
    }

    pub(crate) fn binding_logical_targets(
        &self,
        arguments: &Value,
    ) -> Result<Option<Vec<String>>, ToolCatalogError> {
        match &self.entry().binding {
            ToolExecutorBinding::Builtin { .. } => Ok(None),
            ToolExecutorBinding::Mcp(tool) => tool
                .logical_targets(arguments)
                .map(Some)
                .map_err(|error| ToolCatalogError::new(error.code, error.message)),
        }
    }

    pub(crate) fn invoke(
        &self,
        invocation_id: &str,
        input: Value,
        context: KernelToolExecutionContext,
    ) -> Result<KernelToolExecutionResult, ToolCatalogError> {
        match &self.entry().binding {
            ToolExecutorBinding::Builtin { executors, .. } => executors
                .invoke(
                    self.tool_name(),
                    KernelToolInvocation {
                        id: invocation_id.to_string(),
                        tool_id: self.tool_name().to_string(),
                        input,
                    },
                    context,
                )
                .map_err(|error| ToolCatalogError::new("tool_execution_failed", error.to_string())),
            ToolExecutorBinding::Mcp(tool) => tool
                .call(input, &context)
                .map(|result| {
                    let crate::local_agent_mcp::McpToolCallResult { output, failure } = result;
                    match failure {
                        Some(failure) => KernelToolExecutionResult {
                            invocation_id: invocation_id.to_string(),
                            outcome: KernelToolExecutionOutcome::Failed,
                            output,
                            error: Some(KernelToolExecutionFailure {
                                code: failure.code,
                                message: failure.message,
                            }),
                        },
                        None => KernelToolExecutionResult {
                            invocation_id: invocation_id.to_string(),
                            outcome: KernelToolExecutionOutcome::Completed,
                            output,
                            error: None,
                        },
                    }
                })
                .map_err(|error| ToolCatalogError::new(error.code, error.message)),
        }
    }

    pub(crate) fn begin_attempt(&self) -> PhysicalAttemptLease {
        self.snapshot.active_attempts.fetch_add(1, Ordering::AcqRel);
        PhysicalAttemptLease {
            snapshot: Arc::clone(&self.snapshot),
        }
    }
}

pub(crate) struct PhysicalAttemptLease {
    snapshot: Arc<ToolCatalogSnapshot>,
}

impl Drop for PhysicalAttemptLease {
    fn drop(&mut self) {
        let previous = self.snapshot.active_attempts.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "physical attempt lease underflow");
    }
}

fn possible_effects(
    effect_class: Option<ToolEffectClass>,
    scope: CatalogEffectScope,
) -> Vec<&'static str> {
    match scope {
        CatalogEffectScope::WorkspaceRead => vec!["workspaceRead"],
        CatalogEffectScope::WorkspaceMutation => vec!["workspaceMutation"],
        CatalogEffectScope::Process => vec!["process", "workspaceMutation", "external"],
        CatalogEffectScope::Network => match effect_class {
            Some(ToolEffectClass::Mutation) => vec!["network", "external"],
            _ => vec!["network"],
        },
        CatalogEffectScope::External => vec!["external"],
    }
}

fn availability_name(availability: ToolAvailability) -> &'static str {
    match availability {
        ToolAvailability::Callable => "callable",
        ToolAvailability::Blocked => "blocked",
    }
}

fn dispose_all(disposers: Vec<ExactDisposer>) {
    for dispose in disposers.into_iter().rev() {
        let _ = dispose();
    }
}

fn builtin_binding_identity(config: &KernelExecutorConfig) -> Result<String, ToolCatalogError> {
    let encoded = serde_json::to_vec(&json!({
        "webSearchEndpointTemplate": config.web_search_endpoint_template,
        "webSearchAuthHeaderName": config.web_search_auth_header_name,
        "webSearchAuthSecretRef": config.web_search_auth_secret_ref,
    }))
    .map_err(|error| ToolCatalogError::new("builtin_binding_encode_failed", error.to_string()))?;
    Ok(format!("builtin-binding:{}", hash_bytes(&encoded)))
}

fn validate_ref(field: &str, value: &str) -> Result<(), ToolCatalogError> {
    if value.is_empty() || value.len() > 192 || value.chars().any(char::is_control) {
        return Err(ToolCatalogError::new(
            "tool_catalog_identity_invalid",
            format!("{field} 不是有效标识。"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_runtime::executors::EmptySecretProvider;

    #[test]
    fn default_builtin_provider_exposes_the_seven_basic_tools_and_blocks_web_search() {
        let provider = BuiltinToolProvider::prepare(
            KernelExecutorConfig::default(),
            Arc::new(EmptySecretProvider),
            true,
        )
        .expect("prepare builtin provider");
        let installed = Box::new(provider)
            .install()
            .expect("install builtin provider");
        let mut names = installed
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();

        assert_eq!(
            names,
            [
                "bash",
                "fs.delete",
                "fs.edit",
                "fs.read",
                "fs.write",
                "web.fetch",
                "web.search",
            ]
        );
        for tool in &installed.tools {
            assert!(tool.input_schema["properties"].get("workspaceId").is_none());
        }
        assert_eq!(
            installed
                .tools
                .iter()
                .find(|tool| tool.name == "web.search")
                .expect("web.search contribution")
                .availability,
            ToolAvailability::Blocked
        );
        (installed.dispose)().expect("dispose builtin provider");
    }

    #[test]
    fn web_search_is_callable_with_brave_secret_ref_or_explicit_endpoint() {
        for executor_config in [
            KernelExecutorConfig {
                web_search_endpoint_template: String::new(),
                web_search_auth_header_name: "Authorization".to_string(),
                web_search_auth_secret_ref: "local-secret:brave".to_string(),
            },
            KernelExecutorConfig {
                web_search_endpoint_template: "https://search.example/v1?q={query}&limit={limit}"
                    .to_string(),
                web_search_auth_header_name: "Authorization".to_string(),
                web_search_auth_secret_ref: String::new(),
            },
        ] {
            let provider =
                BuiltinToolProvider::prepare(executor_config, Arc::new(EmptySecretProvider), true)
                    .expect("prepare builtin provider");
            let installed = Box::new(provider)
                .install()
                .expect("install builtin provider");
            assert_eq!(
                installed
                    .tools
                    .iter()
                    .find(|tool| tool.name == "web.search")
                    .expect("web.search contribution")
                    .availability,
                ToolAvailability::Callable
            );
            (installed.dispose)().expect("dispose builtin provider");
        }
    }

    #[test]
    fn run_owner_can_disable_kernel_search_before_catalog_snapshot_is_built() {
        let provider = BuiltinToolProvider::prepare(
            KernelExecutorConfig {
                web_search_endpoint_template: String::new(),
                web_search_auth_header_name: "X-Subscription-Token".to_string(),
                web_search_auth_secret_ref: "local-secret:brave".to_string(),
            },
            Arc::new(EmptySecretProvider),
            false,
        )
        .expect("prepare builtin provider");
        let installed = Box::new(provider)
            .install()
            .expect("install builtin provider");

        assert_eq!(
            installed
                .tools
                .iter()
                .find(|tool| tool.name == "web.search")
                .expect("web.search contribution")
                .availability,
            ToolAvailability::Blocked
        );
        (installed.dispose)().expect("dispose builtin provider");
    }
}
