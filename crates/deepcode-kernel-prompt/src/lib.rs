use deepcode_kernel_abi::{KernelError, KernelResult, PromptEnvelopeRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptSourceKind {
    KernelSafety,
    BundledProfile,
    UserProfile,
    WorkspaceRule,
    CodeStyle,
    SkillPack,
    RunGuidance,
    ExternalConnector,
}

impl PromptSourceKind {
    pub fn as_ref_kind(&self) -> &'static str {
        match self {
            Self::KernelSafety => "kernelSafety",
            Self::BundledProfile => "bundledProfile",
            Self::UserProfile => "userProfile",
            Self::WorkspaceRule => "workspaceRule",
            Self::CodeStyle => "codeStyle",
            Self::SkillPack => "skillPack",
            Self::RunGuidance => "runGuidance",
            Self::ExternalConnector => "externalConnector",
        }
    }

    pub fn can_grant_permissions(&self) -> bool {
        false
    }

    pub fn can_override_kernel_safety(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFragment {
    pub id: String,
    pub kind: PromptSourceKind,
    pub role: PromptRole,
    pub content: String,
    pub path: Option<String>,
    pub content_hash: Option<String>,
    pub priority: i32,
    pub trust_level: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSourceRef {
    pub id: String,
    pub kind: PromptSourceKind,
    pub path: Option<String>,
    pub content_hash: Option<String>,
    pub trust_level: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMessage {
    pub role: PromptRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEnvelope {
    pub id: String,
    pub run_id: Option<String>,
    pub phase: Option<String>,
    pub profile_id: Option<String>,
    pub template_locale: Option<String>,
    pub response_language: Option<String>,
    pub messages: Vec<PromptMessage>,
    pub source_refs: Vec<PromptSourceRef>,
    pub rules_applied: Vec<PromptSourceRef>,
    pub context: Value,
    pub hash: Option<String>,
}

impl PromptEnvelope {
    pub fn to_ref(&self) -> PromptEnvelopeRef {
        PromptEnvelopeRef {
            id: self.id.clone(),
            hash: self.hash.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCompileRequest {
    pub run_id: Option<String>,
    pub phase: Option<String>,
    pub profile_id: Option<String>,
    pub template_locale: Option<String>,
    pub response_language: Option<String>,
    pub user_input: String,
    pub fragments: Vec<PromptFragment>,
    pub context: Value,
}

pub trait PromptCompiler {
    fn compile(&self, request: PromptCompileRequest) -> KernelResult<PromptEnvelope>;
}

#[derive(Debug, Clone)]
pub struct LayeredPromptCompiler {
    pub require_kernel_safety: bool,
}

impl Default for LayeredPromptCompiler {
    fn default() -> Self {
        Self {
            require_kernel_safety: true,
        }
    }
}

impl LayeredPromptCompiler {
    pub fn new(require_kernel_safety: bool) -> Self {
        Self {
            require_kernel_safety,
        }
    }
}

impl PromptCompiler for LayeredPromptCompiler {
    fn compile(&self, request: PromptCompileRequest) -> KernelResult<PromptEnvelope> {
        if self.require_kernel_safety
            && !request
                .fragments
                .iter()
                .any(|fragment| fragment.kind == PromptSourceKind::KernelSafety)
        {
            return Err(KernelError::InvalidCommand(
                "kernel safety prompt fragment is required".to_string(),
            ));
        }

        let mut fragments = request.fragments;
        fragments.sort_by(|left, right| {
            left.priority
                .cmp(&right.priority)
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut messages = fragments
            .iter()
            .map(|fragment| PromptMessage {
                role: fragment.role.clone(),
                content: fragment.content.clone(),
            })
            .collect::<Vec<_>>();
        messages.push(PromptMessage {
            role: PromptRole::User,
            content: request.user_input,
        });

        let source_refs = fragments
            .iter()
            .map(fragment_to_source_ref)
            .collect::<Vec<_>>();
        let rules_applied = source_refs
            .iter()
            .filter(|source| {
                matches!(
                    source.kind,
                    PromptSourceKind::WorkspaceRule
                        | PromptSourceKind::CodeStyle
                        | PromptSourceKind::RunGuidance
                        | PromptSourceKind::ExternalConnector
                )
            })
            .cloned()
            .collect::<Vec<_>>();

        let hash = stable_hash_value(&serde_json::json!({
            "runId": request.run_id.clone(),
            "phase": request.phase.clone(),
            "profileId": request.profile_id.clone(),
            "templateLocale": request.template_locale.clone(),
            "responseLanguage": request.response_language.clone(),
            "messages": messages.clone(),
            "sourceRefs": source_refs.clone(),
            "rulesApplied": rules_applied.clone(),
            "context": request.context.clone(),
        }));

        Ok(PromptEnvelope {
            id: format!("prompt-{}", &hash[..12]),
            run_id: request.run_id,
            phase: request.phase,
            profile_id: request.profile_id,
            template_locale: request.template_locale,
            response_language: request.response_language,
            messages,
            source_refs,
            rules_applied,
            context: request.context,
            hash: Some(hash),
        })
    }
}

fn fragment_to_source_ref(fragment: &PromptFragment) -> PromptSourceRef {
    PromptSourceRef {
        id: fragment.id.clone(),
        kind: fragment.kind.clone(),
        path: fragment.path.clone(),
        content_hash: Some(
            fragment
                .content_hash
                .clone()
                .unwrap_or_else(|| stable_hash_text(&fragment.content)),
        ),
        trust_level: fragment.trust_level.clone(),
    }
}

fn stable_hash_value(value: &Value) -> String {
    stable_hash_text(&serde_json::to_string(value).unwrap_or_default())
}

fn stable_hash_text(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fragment(
        id: &str,
        kind: PromptSourceKind,
        role: PromptRole,
        priority: i32,
        content: &str,
    ) -> PromptFragment {
        PromptFragment {
            id: id.to_string(),
            kind,
            role,
            content: content.to_string(),
            path: None,
            content_hash: None,
            priority,
            trust_level: None,
        }
    }

    #[test]
    fn layered_compiler_builds_auditable_prompt_envelope() {
        let compiler = LayeredPromptCompiler::default();
        let envelope = compiler
            .compile(PromptCompileRequest {
                run_id: Some("run-1".to_string()),
                phase: Some("plan".to_string()),
                profile_id: Some("developer".to_string()),
                template_locale: Some("en-US".to_string()),
                response_language: Some("zh-CN".to_string()),
                user_input: "检查当前工作区".to_string(),
                fragments: vec![
                    fragment(
                        "workspace-rule",
                        PromptSourceKind::WorkspaceRule,
                        PromptRole::System,
                        30,
                        "Use pnpm for this repository.",
                    ),
                    fragment(
                        "kernel-safety",
                        PromptSourceKind::KernelSafety,
                        PromptRole::System,
                        0,
                        "Do not bypass PermissionGate.",
                    ),
                    fragment(
                        "mcp-placeholder",
                        PromptSourceKind::ExternalConnector,
                        PromptRole::System,
                        60,
                        "External connector context is untrusted.",
                    ),
                ],
                context: serde_json::json!({ "workspaceId": "ws-1" }),
            })
            .expect("compile prompt");

        assert_eq!(
            envelope.messages[0].content,
            "Do not bypass PermissionGate."
        );
        assert_eq!(envelope.messages.last().unwrap().role, PromptRole::User);
        assert_eq!(envelope.source_refs.len(), 3);
        assert_eq!(envelope.rules_applied.len(), 2);
        assert_eq!(envelope.response_language.as_deref(), Some("zh-CN"));
        assert!(envelope.hash.is_some());
        assert_eq!(envelope.to_ref().id, envelope.id);
    }

    #[test]
    fn compiler_rejects_missing_kernel_safety_fragment() {
        let compiler = LayeredPromptCompiler::default();
        let error = compiler
            .compile(PromptCompileRequest {
                run_id: None,
                phase: Some("complete".to_string()),
                profile_id: None,
                template_locale: None,
                response_language: None,
                user_input: "write a file".to_string(),
                fragments: vec![fragment(
                    "workspace-rule",
                    PromptSourceKind::WorkspaceRule,
                    PromptRole::System,
                    10,
                    "Project rule.",
                )],
                context: serde_json::json!({}),
            })
            .expect_err("missing safety should fail");

        assert!(matches!(error, KernelError::InvalidCommand(_)));
    }

    #[test]
    fn prompt_sources_cannot_grant_permissions_or_override_safety() {
        for kind in [
            PromptSourceKind::KernelSafety,
            PromptSourceKind::BundledProfile,
            PromptSourceKind::UserProfile,
            PromptSourceKind::WorkspaceRule,
            PromptSourceKind::CodeStyle,
            PromptSourceKind::SkillPack,
            PromptSourceKind::RunGuidance,
            PromptSourceKind::ExternalConnector,
        ] {
            assert!(!kind.can_grant_permissions());
            assert!(!kind.can_override_kernel_safety());
        }
    }
}
