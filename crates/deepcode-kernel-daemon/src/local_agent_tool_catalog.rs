use crate::local_agent_mcp::{McpRuntime, McpTool, McpToolBindingRequirement, McpToolEffectScope};
use crate::local_agent_product_tools::ProductTools;
use deepcode_first_party_tools::documents::{self, DocumentContext};
use deepcode_kernel_runtime::executors::{
    builtin_executors, web_search_availability, KernelExecutorConfig, KernelExecutorRegistry,
    KernelToolExecutionContext, KernelToolExecutionFailure, KernelToolExecutionOutcome,
    KernelToolExecutionResult, KernelToolInvocation, SecretProvider,
};
use deepcode_kernel_tools::{
    hash_bytes, KernelToolCatalogError, KernelToolRegistry, ToolAvailability, ToolEffectClass,
    ToolEffectScope, ToolInputIssue,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub(crate) struct ToolCatalogError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) input_issues: Option<Vec<ToolInputIssue>>,
}

impl ToolCatalogError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            input_issues: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CatalogEffectScope {
    LocalRead,
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
    Product(Arc<ProductTools>),
    Browser(Value),
    Document {
        python: Option<std::path::PathBuf>,
    },
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

struct ProductToolProvider(Arc<ProductTools>);

struct DocumentToolProvider {
    python: Option<std::path::PathBuf>,
}

impl ToolProvider for DocumentToolProvider {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError> {
        Ok(InstalledToolProvider {
            tools: vec![PendingToolContribution {
                origin: "coreBuiltin",
                provider_ref: "deepcode:documents".into(),
                plugin_uri: None,
                plugin_instance_ref: None,
                contribution_ref: "deepcode:documents/document.render".into(),
                binding_identity: format!("documents:{}", self.python.as_ref().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default()),
                name: "document.render".into(),
                description: "Create a polished document artifact in the workspace. Write complete HTML or Markdown, or render self-contained HTML to PDF with WeasyPrint. Read deepcode-documents via skill.read for templates and typography when needed. Output is a workspace mutation; the existing Plan and permission policy applies. PDF requires a configured Python environment with WeasyPrint. Source limit: 1 MiB; PDF limit: 32 MiB.".into(),
                input_schema: documents::input_schema(),
                effect_class: None,
                effect_scope: CatalogEffectScope::WorkspaceMutation,
                availability: ToolAvailability::Callable,
                logical_target: None,
                binding: ToolExecutorBinding::Document { python: self.python },
            }],
            dispose: Box::new(|| Ok(())),
        })
    }
}

impl ToolProvider for ProductToolProvider {
    fn install(self: Box<Self>) -> Result<InstalledToolProvider, ToolCatalogError> {
        let mut tools: Vec<_> = ProductTools::definitions()
            .into_iter()
            .map(
                |(name, description, input_schema)| PendingToolContribution {
                    origin: "coreBuiltin",
                    provider_ref: "deepcode:product".into(),
                    plugin_uri: None,
                    plugin_instance_ref: None,
                    contribution_ref: format!("deepcode:product/{name}"),
                    binding_identity: format!("product:{name}"),
                    name: name.into(),
                    description,
                    input_schema,
                    effect_class: Some(ToolEffectClass::Read),
                    effect_scope: CatalogEffectScope::LocalRead,
                    availability: ToolAvailability::Callable,
                    logical_target: None,
                    binding: ToolExecutorBinding::Product(Arc::clone(&self.0)),
                },
            )
            .collect();
        if let Some(binding) = self.0.browser_binding.as_ref() {
            let status = crate::browser_tools::call(binding, &json!({"action":"hostStatus"}));
            for (name, description, input_schema) in crate::browser_tools::definitions() {
                tools.push(PendingToolContribution {
                    origin: "coreBuiltin",
                    provider_ref: "deepcode:browser".into(),
                    plugin_uri: None,
                    plugin_instance_ref: None,
                    contribution_ref: format!("deepcode:browser/{name}"),
                    binding_identity: format!("browser:{binding}:{name}"),
                    name: name.into(),
                    description: match &status {
                        Ok(_) => description.into(),
                        Err(reason) => format!("{description} Currently unavailable: {reason}"),
                    },
                    input_schema,
                    effect_class: None,
                    effect_scope: if name == "browser.capture" {
                        CatalogEffectScope::WorkspaceMutation
                    } else {
                        CatalogEffectScope::External
                    },
                    availability: if status.is_ok() {
                        ToolAvailability::Callable
                    } else {
                        ToolAvailability::Blocked
                    },
                    logical_target: None,
                    binding: ToolExecutorBinding::Browser(binding.clone()),
                });
            }
        }
        Ok(InstalledToolProvider {
            tools,
            dispose: Box::new(|| Ok(())),
        })
    }
}

struct BuiltinToolProvider {
    registry: Arc<KernelToolRegistry>,
    executors: Arc<KernelExecutorRegistry>,
    binding_identity: String,
    web_search_availability: ToolAvailability,
    shell_tool: String,
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
        let shell_tool = executor_config
            .shell_program
            .as_ref()
            .map(|shell| shell.tool.clone())
            .unwrap_or_else(|| if cfg!(windows) { "powershell" } else { "bash" }.into());
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
            shell_tool,
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
                } else if matches!(descriptor.name.as_str(), "bash" | "powershell")
                    && descriptor.name != self.shell_tool
                {
                    ToolAvailability::Blocked
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
        product: Arc<ProductTools>,
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
            Box::new(DocumentToolProvider {
                python: product.document_python.clone(),
            }),
            Box::new(ProductToolProvider(product)),
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

    pub(crate) fn effect_scope(
        &self,
        input: &Value,
    ) -> Result<CatalogEffectScope, ToolCatalogError> {
        if let ToolExecutorBinding::Browser(host) = &self.entry().binding {
            let action = input["action"].as_str().unwrap_or("");
            let network = |url: &str| {
                if url.starts_with("http://") || url.starts_with("https://") {
                    CatalogEffectScope::Network
                } else {
                    CatalogEffectScope::LocalRead
                }
            };
            match (self.tool_name(), action) {
                ("browser.page", "openSelf" | "list" | "status" | "close") => {
                    return Ok(CatalogEffectScope::LocalRead)
                }
                ("browser.page", "reload") => {
                    let page = crate::browser_tools::call(
                        host,
                        &json!({"action":"status","previewId":input["previewId"]}),
                    )
                    .map_err(|error| ToolCatalogError::new("native_browser_failed", error))?;
                    let url = page["url"].as_str().ok_or_else(|| {
                        ToolCatalogError::new(
                            "native_browser_page_invalid",
                            "Browser status is missing its URL",
                        )
                    })?;
                    return Ok(network(url));
                }
                ("browser.page", "act")
                    if matches!(input["operation"].as_str(), Some("inspect" | "scroll")) =>
                {
                    return Ok(CatalogEffectScope::LocalRead)
                }
                ("browser.page", "open" | "navigate") => {
                    return Ok(input["url"]
                        .as_str()
                        .map(network)
                        .unwrap_or(CatalogEffectScope::LocalRead))
                }
                ("browser.service", "list" | "status" | "stop") => {
                    return Ok(CatalogEffectScope::LocalRead)
                }
                _ => {}
            }
        }
        Ok(self.entry().effect_scope)
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
                .map_err(|error| {
                    let message = error.to_string();
                    match error {
                        KernelToolCatalogError::InvalidArguments { issues, .. } => {
                            ToolCatalogError {
                                code: "tool_input_invalid",
                                message,
                                input_issues: Some(issues),
                            }
                        }
                        _ => ToolCatalogError::new("tool_catalog_invalid", message),
                    }
                }),
            ToolExecutorBinding::Mcp(_) => Ok(raw_arguments),
            ToolExecutorBinding::Browser(_) => {
                browser_targets(self.tool_name(), &raw_arguments)?;
                Ok(raw_arguments)
            }
            ToolExecutorBinding::Document { .. } => {
                documents::logical_targets(&raw_arguments)
                    .map_err(|error| ToolCatalogError::new(error.code, error.message))?;
                Ok(raw_arguments)
            }
            ToolExecutorBinding::Product(_) => {
                product_logical_targets(self.tool_name(), &raw_arguments)?;
                Ok(raw_arguments)
            }
        }
    }

    pub(crate) fn binding_logical_targets(
        &self,
        arguments: &Value,
    ) -> Result<Option<Vec<String>>, ToolCatalogError> {
        match &self.entry().binding {
            ToolExecutorBinding::Builtin { .. } => Ok(None),
            ToolExecutorBinding::Browser(_) => {
                browser_targets(self.tool_name(), arguments).map(Some)
            }
            ToolExecutorBinding::Document { .. } => documents::logical_targets(arguments)
                .map(Some)
                .map_err(|error| ToolCatalogError::new(error.code, error.message)),
            ToolExecutorBinding::Product(_) => {
                product_logical_targets(self.tool_name(), arguments).map(Some)
            }
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
            ToolExecutorBinding::Browser(binding) => {
                let result = crate::browser_tools::execute(
                    binding,
                    self.tool_name(),
                    input,
                    &context,
                    invocation_id,
                );
                Ok(match result {
                    Ok(output) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Completed,
                        output,
                        error: None,
                    },
                    Err(message) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Failed,
                        output: Value::Null,
                        error: Some(KernelToolExecutionFailure {
                            code: "native_browser_failed".into(),
                            message,
                        }),
                    },
                })
            }
            ToolExecutorBinding::Document { python } => {
                let workspace_id = context.workspace_id.as_deref().ok_or_else(|| {
                    ToolCatalogError::new(
                        "workspace_binding_required",
                        "Document output requires a prepared workspace.",
                    )
                })?;
                let [target] = context.private_resolved_targets.as_slice() else {
                    return Err(ToolCatalogError::new(
                        "workspace_binding_invalid",
                        "Document output requires exactly one prepared destination.",
                    ));
                };
                let before = deepcode_kernel_runtime::executors::capture_file_change_side(
                    std::path::Path::new(target),
                    &context,
                    0,
                    "before",
                );
                let result = documents::render(
                    &input,
                    DocumentContext {
                        invocation_id,
                        workspace_id,
                        target: std::path::Path::new(target),
                        python: python.as_deref(),
                        cancelled: &|| context.cancellation.is_cancelled(),
                    },
                );
                Ok(match result {
                    Ok(mut output) => {
                        let archived = context.output_directory.as_ref().ok_or_else(|| {
                            ToolCatalogError::new(
                                "artifact_storage_unavailable",
                                "Document archive is unavailable.",
                            )
                        })?;
                        let filename =
                            std::path::Path::new(target).file_name().ok_or_else(|| {
                                ToolCatalogError::new(
                                    "artifact_target_invalid",
                                    "Document filename is missing.",
                                )
                            })?;
                        let archived = archived.join(filename);
                        std::fs::create_dir_all(archived.parent().expect("artifact parent"))
                            .and_then(|_| std::fs::copy(target, &archived))
                            .map_err(|error| {
                                ToolCatalogError::new("artifact_archive_failed", error.to_string())
                            })?;
                        output["artifacts"][0]["contentRef"] = json!(archived);
                        output["artifacts"][0]["contentMode"] = json!("fixed");
                        output["artifacts"][0]["uri"] =
                            json!(format!("artifact://artifact:{invocation_id}"));
                        let after = json!({"exists":true,"contentRef":archived,"sizeBytes":output["sizeBytes"]});
                        output["fileChanges"] =
                            json!([deepcode_kernel_runtime::executors::file_change_fact(
                                &context,
                                input["path"].as_str().expect("validated document path"),
                                before,
                                after
                            )
                            .map_err(|error| ToolCatalogError::new(
                                "file_change_failed",
                                error.to_string()
                            ))?]);
                        KernelToolExecutionResult {
                            invocation_id: invocation_id.into(),
                            outcome: KernelToolExecutionOutcome::Completed,
                            output,
                            error: None,
                        }
                    }
                    Err(error) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Failed,
                        output: Value::Null,
                        error: Some(KernelToolExecutionFailure {
                            code: error.code.into(),
                            message: error.message,
                        }),
                    },
                })
            }
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
                .or_else(|error| {
                    let (code, output) = match &error {
                        deepcode_kernel_abi::KernelError::Structured {
                            code,
                            stage,
                            details,
                            ..
                        } => (
                            (*code).to_string(),
                            json!({"stage": stage, "details": details}),
                        ),
                        _ => ("tool_execution_failed".to_string(), Value::Null),
                    };
                    Ok(KernelToolExecutionResult {
                        invocation_id: invocation_id.to_string(),
                        outcome: KernelToolExecutionOutcome::Failed,
                        output,
                        error: Some(KernelToolExecutionFailure {
                            code,
                            message: error.to_string(),
                        }),
                    })
                }),
            ToolExecutorBinding::Product(product) => {
                let result = product.call(self.tool_name(), input);
                Ok(match result {
                    Ok(output) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Completed,
                        output,
                        error: None,
                    },
                    Err(error) => KernelToolExecutionResult {
                        invocation_id: invocation_id.into(),
                        outcome: KernelToolExecutionOutcome::Failed,
                        output: Value::Null,
                        error: Some(KernelToolExecutionFailure {
                            code: error.code,
                            message: error.message,
                        }),
                    },
                })
            }
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

fn browser_targets(name: &str, input: &Value) -> Result<Vec<String>, ToolCatalogError> {
    let text = |key: &str| {
        input[key]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ToolCatalogError::new("tool_input_invalid", format!("{key} is required"))
            })
    };
    let object = input.as_object().ok_or_else(|| {
        ToolCatalogError::new("tool_input_invalid", "Browser arguments must be an object.")
    })?;
    if name == "browser.service" {
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "action" | "serviceId" | "directory" | "command" | "args" | "url"
            )
        }) {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Unsupported service argument.",
            ));
        }
        let action = text("action")?;
        if !matches!(action, "start" | "stop" | "list" | "status") {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Unsupported service action.",
            ));
        }
        if action == "start" {
            text("command")?;
            text("directory")?;
            text("url")?;
            if !input["args"]
                .as_array()
                .is_some_and(|args| args.iter().all(Value::is_string))
            {
                return Err(ToolCatalogError::new(
                    "tool_input_invalid",
                    "args must be an array of strings.",
                ));
            }
        } else if action != "list" {
            text("serviceId")?;
        }
        return Ok(vec![format!(
            "browser:service:{}",
            input["serviceId"].as_str().unwrap_or(action)
        )]);
    }
    if name == "browser.capture" {
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "previewId" | "path"))
        {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Unsupported capture argument.",
            ));
        }
        text("previewId")?;
        let path = text("path")?;
        if !path.to_ascii_lowercase().ends_with(".png") {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "Screenshot path must end in .png.",
            ));
        }
        return Ok(vec![path.into()]);
    }
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "action"
                | "previewId"
                | "url"
                | "filePath"
                | "serviceId"
                | "operation"
                | "selector"
                | "text"
                | "x"
                | "y"
        )
    }) {
        return Err(ToolCatalogError::new(
            "tool_input_invalid",
            "Unsupported browser argument.",
        ));
    }
    let action = text("action")?;
    if !matches!(
        action,
        "open" | "openSelf" | "list" | "status" | "navigate" | "reload" | "act" | "close"
    ) {
        return Err(ToolCatalogError::new(
            "tool_input_invalid",
            "Unsupported browser action.",
        ));
    }
    if matches!(action, "open" | "navigate") && !input["serviceId"].is_string() {
        if input["filePath"].is_string() {
            text("filePath")?;
        } else {
            text("url")?;
        }
    }
    if !matches!(action, "open" | "openSelf" | "list") {
        text("previewId")?;
    }
    if action == "act" {
        let operation = text("operation")?;
        if matches!(operation, "click" | "type") {
            text("selector")?;
        }
        if operation == "type" && !input["text"].is_string() {
            return Err(ToolCatalogError::new(
                "tool_input_invalid",
                "text is required",
            ));
        }
    }
    Ok(vec![format!(
        "browser:{}",
        input["previewId"].as_str().unwrap_or("pages")
    )])
}

fn product_logical_targets(name: &str, input: &Value) -> Result<Vec<String>, ToolCatalogError> {
    let field = if name == "session.read" {
        "sessionId"
    } else {
        "name"
    };
    let id = input
        .get(field)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            ToolCatalogError::new("tool_input_invalid", format!("{field} is required"))
        })?;
    Ok(vec![if name == "session.read" {
        id.to_string()
    } else {
        format!("skill:{id}")
    }])
}

fn possible_effects(
    effect_class: Option<ToolEffectClass>,
    scope: CatalogEffectScope,
) -> Vec<&'static str> {
    match scope {
        CatalogEffectScope::LocalRead => vec!["localRead"],
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
        "cloudWebSearch": config.cloud_web_search,
        "shellProgram": config.shell_program,
        "wsl": config.wsl,
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
    fn default_builtin_provider_exposes_the_registered_basic_tools_and_blocks_web_search() {
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
                "powershell",
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
                ..Default::default()
            },
            KernelExecutorConfig {
                web_search_endpoint_template: "https://search.example/v1?q={query}&limit={limit}"
                    .to_string(),
                web_search_auth_header_name: "Authorization".to_string(),
                web_search_auth_secret_ref: String::new(),
                ..Default::default()
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
                ..Default::default()
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
