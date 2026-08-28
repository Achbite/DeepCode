use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const CONVERSATION_COMMAND_VERSION: &str = "deepcode.command";
pub const SESSION_PROJECTION_VERSION: &str = "deepcode.session-projection";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationSessionRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReply {
    pub schema_version: String,
    pub command_id: String,
    pub session_id: String,
    pub status: String,
    pub revision: u64,
    pub error: Option<ConversationError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionProjection {
    pub schema_version: String,
    pub session_id: String,
    pub revision: u64,
    pub display: SessionDisplayProjection,
    pub workspace_bindings: Vec<WorkspaceBindingDisplay>,
    pub session_directory_indexes: Vec<WorkspaceBindingDisplay>,
    pub messages: Vec<ProjectionMessage>,
    pub narratives: Vec<NarrativeProjection>,
    pub assistant_draft: Option<AssistantDraftProjection>,
    pub pending_interaction: Option<InteractionProjection>,
    pub pending_approval: Option<ApprovalProjection>,
    pub pending_plan: Option<PendingPlanProjection>,
    pub todo_list: Option<TodoListProjection>,
    pub context_usage: Option<ContextUsageProjection>,
    pub context_compositions: Vec<ContextCompositionProjection>,
    pub token_usage: TokenUsageProjection,
    pub token_usage_history: Vec<TokenUsageRoundProjection>,
    pub run: Option<RunProjection>,
    pub activities: Vec<ActivityProjection>,
    pub artifacts: Vec<ArtifactProjection>,
    pub terminal_error: Option<ConversationError>,
}

impl SessionProjection {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SESSION_PROJECTION_VERSION || self.session_id.is_empty() {
            return Err("shared Session projection identity is invalid".to_string());
        }
        let mut workspace_ids = HashSet::new();
        if self.workspace_bindings.iter().any(|binding| {
            binding.workspace_id.is_empty()
                || binding.display_name.is_empty()
                || !workspace_ids.insert(binding.workspace_id.as_str())
        }) {
            return Err("shared Session projection workspace bindings are invalid".to_string());
        }
        let mut directory_index_ids = HashSet::new();
        if self.session_directory_indexes.iter().any(|binding| {
            binding.workspace_id.is_empty()
                || binding.display_name.is_empty()
                || !workspace_ids.contains(binding.workspace_id.as_str())
                || !directory_index_ids.insert(binding.workspace_id.as_str())
        }) {
            return Err("shared Session projection directory indexes are invalid".to_string());
        }
        if self.run.as_ref().is_some_and(|run| {
            let mut run_workspace_ids = HashSet::new();
            !is_run_status(&run.status)
                || run.workspace_bindings.iter().any(|binding| {
                    binding.workspace_id.is_empty()
                        || binding.display_name.is_empty()
                        || !run_workspace_ids.insert(binding.workspace_id.as_str())
                })
        }) {
            return Err("shared Session projection has an invalid run status".to_string());
        }
        if self.run.as_ref().is_some_and(|run| {
            run.waiting_reason
                .as_deref()
                .is_some_and(|reason| !matches!(reason, "approval" | "userInput" | "plan"))
                || (run.waiting_reason.is_some() && run.status != "waiting")
        }) {
            return Err("shared Session projection has an invalid waiting reason".to_string());
        }
        if self.assistant_draft.as_ref().is_some_and(|draft| {
            draft.run_id.is_empty()
                || draft.turn_id.is_empty()
                || self
                    .run
                    .as_ref()
                    .is_none_or(|run| run.run_id != draft.run_id)
        }) {
            return Err("shared Session projection has an invalid assistant draft".to_string());
        }
        if self.messages.iter().any(|message| {
            message.message_id.is_empty()
                || !matches!(
                    message.role.as_str(),
                    "user" | "assistant" | "tool" | "system"
                )
                || message.sequence == 0
                || message.sequence > self.revision
                || message
                    .feedback
                    .as_deref()
                    .is_some_and(|feedback| !matches!(feedback, "up" | "down"))
                || message.feedback.is_some() && message.role != "assistant"
        }) {
            return Err("shared Session projection has invalid messages".to_string());
        }
        if self
            .pending_interaction
            .as_ref()
            .is_some_and(|interaction| {
                !matches!(interaction.kind.as_str(), "question" | "confirmation")
                    || interaction.interaction_id.is_empty()
                    || interaction.run_id.is_empty()
            })
        {
            return Err("shared Session projection has an invalid interaction".to_string());
        }
        if self.pending_approval.as_ref().is_some_and(|approval| {
            approval.approval_id.is_empty()
                || approval.call_id.is_empty()
                || approval.run_id.is_empty()
                || approval.preview.summary.is_empty()
        }) {
            return Err("shared Session projection has an invalid approval".to_string());
        }
        if self.pending_plan.as_ref().is_some_and(|plan| {
            plan.plan_id.is_empty()
                || plan.run_id.is_empty()
                || plan.options.is_empty()
                || plan.response_mode != "optionOrFreeform"
                || !plan.ignore_allowed
        }) {
            return Err("shared Session projection has an invalid plan".to_string());
        }
        if self.todo_list.as_ref().is_some_and(|todo_list| {
            let mut ids = HashSet::new();
            todo_list.run_id.is_empty()
                || self
                    .run
                    .as_ref()
                    .is_none_or(|run| run.run_id != todo_list.run_id)
                || todo_list.items.len() > 12
                || todo_list.items.iter().any(|item| {
                    item.todo_id.is_empty()
                        || item.label.is_empty()
                        || !matches!(item.status.as_str(), "pending" | "inProgress" | "completed")
                        || !ids.insert(item.todo_id.as_str())
                })
        }) {
            return Err("shared Session projection has an invalid todo list".to_string());
        }
        if self.context_usage.as_ref().is_some_and(|usage| {
            usage.provider_request_id.is_empty()
                || usage.run_id.is_empty()
                || usage.sequence == 0
                || usage.sequence > self.revision
                || usage.updated_at.is_empty()
                || usage.context_window_tokens == 0
                || usage
                    .input_tokens
                    .checked_add(usage.output_tokens)
                    .is_none_or(|total| total > usage.context_window_tokens)
                || usage.cache_read_input_tokens.is_some()
                    != usage.cache_miss_input_tokens.is_some()
                || usage
                    .cache_read_input_tokens
                    .zip(usage.cache_miss_input_tokens)
                    .is_some_and(|(read, miss)| {
                        read.checked_add(miss)
                            .is_none_or(|sum| sum > usage.input_tokens)
                    })
        }) {
            return Err("shared Session projection has invalid context usage".to_string());
        }
        let mut provider_request_ids = HashSet::new();
        if self.context_compositions.iter().any(|receipt| {
            receipt.provider_request_id.is_empty()
                || receipt.run_id.is_empty()
                || receipt.sequence == 0
                || receipt.sequence > self.revision
                || receipt.created_at.is_empty()
                || !provider_request_ids.insert(receipt.provider_request_id.as_str())
                || !matches!(
                    receipt.response_constraint.as_str(),
                    "normal" | "answerOnly"
                )
                || invalid_context_composition_shape(receipt)
        }) || self
            .context_compositions
            .windows(2)
            .any(|pair| pair[0].sequence >= pair[1].sequence)
        {
            return Err(
                "shared Session projection has invalid context composition receipts".to_string(),
            );
        }
        if self.context_usage.as_ref().is_some_and(|usage| {
            !self.context_compositions.iter().any(|receipt| {
                receipt.provider_request_id == usage.provider_request_id
                    && receipt.run_id == usage.run_id
                    && receipt.sequence < usage.sequence
            })
        }) {
            return Err(
                "shared Session projection context usage has no exact request receipt".to_string(),
            );
        }
        if !valid_token_usage_fields(
            self.token_usage.provider_call_count,
            self.token_usage.input_tokens,
            self.token_usage.output_tokens,
            self.token_usage.cache_read_input_tokens,
            self.token_usage.cache_miss_input_tokens,
            self.token_usage.cache_reported_call_count,
        ) {
            return Err("shared Session projection has invalid cumulative token usage".to_string());
        }
        let mut usage_run_ids = HashSet::new();
        if self.token_usage_history.iter().any(|round| {
            round.run_id.is_empty()
                || round.input_message_id.is_empty()
                || round.title.is_empty()
                || round.sequence == 0
                || round.sequence > self.revision
                || round.started_at.is_empty()
                || !usage_run_ids.insert(round.run_id.as_str())
                || round.completed_at.is_some() != round.outcome.is_some()
                || round.outcome.as_deref().is_some_and(|outcome| {
                    !matches!(
                        outcome,
                        "completed" | "failed" | "cancelled" | "indeterminate"
                    )
                })
                || !valid_token_usage_fields(
                    round.provider_call_count,
                    round.input_tokens,
                    round.output_tokens,
                    round.cache_read_input_tokens,
                    round.cache_miss_input_tokens,
                    round.cache_reported_call_count,
                )
        }) || self
            .token_usage_history
            .windows(2)
            .any(|pair| pair[0].sequence < pair[1].sequence)
        {
            return Err("shared Session projection has invalid per-run token usage".to_string());
        }
        let mut activity_ids = HashSet::new();
        if self.activities.iter().any(|activity| {
            activity.activity_id.is_empty()
                || activity.label.is_empty()
                || activity.run_id.is_empty()
                || activity.sequence == 0
                || activity.sequence > self.revision
                || !activity_ids.insert(activity.activity_id.as_str())
                || !matches!(
                    activity.kind.as_str(),
                    "run" | "tool" | "approval" | "plan" | "interaction"
                )
                || !matches!(
                    activity.status.as_str(),
                    "active"
                        | "requested"
                        | "waiting"
                        | "completed"
                        | "denied"
                        | "failed"
                        | "cancelled"
                        | "indeterminate"
                )
                || activity.kind == "tool" && activity.call_id.as_deref().is_none_or(str::is_empty)
                || activity.kind != "tool" && activity.tool.is_some()
                || activity.tool.as_ref().is_some_and(|tool| {
                    tool.operation.is_empty()
                        || tool.resources.iter().any(|resource| {
                            resource.label.is_empty()
                                || match resource.kind.as_str() {
                                    "workspacePath" => {
                                        resource
                                            .workspace_id
                                            .as_deref()
                                            .is_none_or(|workspace_id| workspace_id.is_empty())
                                            || resource.logical_path.as_deref().is_none_or(|path| {
                                                !is_normalized_logical_path(path)
                                            })
                                            || resource.uri.is_some()
                                    }
                                    "url" => {
                                        resource.workspace_id.is_some()
                                            || resource.logical_path.is_some()
                                            || resource.uri.as_deref().is_none_or(|uri| {
                                                !uri.starts_with("http://")
                                                    && !uri.starts_with("https://")
                                            })
                                    }
                                    "logicalTarget" => {
                                        resource.workspace_id.is_some()
                                            || resource.logical_path.is_some()
                                            || resource.uri.is_some()
                                    }
                                    _ => true,
                                }
                        })
                })
        }) {
            return Err("shared Session projection has invalid canonical activities".to_string());
        }
        Ok(())
    }

    pub fn last_assistant_text(&self, after_message_count: usize) -> Option<&str> {
        self.messages
            .iter()
            .skip(after_message_count)
            .rev()
            .find(|message| message.role == "assistant")
            .map(|message| message.content.as_str())
    }
}

fn invalid_context_composition_shape(receipt: &ContextCompositionProjection) -> bool {
    invalid_context_messages(&receipt.messages)
        || invalid_context_items(&receipt.workspace_bindings)
        || invalid_context_items(&receipt.tools)
        || invalid_context_partitions(&receipt.partitions)
}

fn invalid_context_partitions(partitions: &[ContextCompositionPartitionProjection]) -> bool {
    const ORDER: [&str; 7] = [
        "instructions",
        "sessionControls",
        "tools",
        "workspaceBindings",
        "contextProviders",
        "journalMessages",
        "messageAttachments",
    ];
    if partitions.len() != ORDER.len()
        || partitions
            .iter()
            .zip(ORDER)
            .any(|(partition, kind)| partition.kind != kind)
        || partitions
            .iter()
            .all(|partition| partition.request_shape_units == 0)
    {
        return true;
    }
    let has_estimates = partitions[0].estimated_input_tokens.is_some();
    partitions.iter().any(|partition| {
        partition.estimated_input_tokens.is_some() != has_estimates
            || partition.token_source.is_some() != has_estimates
            || partition
                .token_source
                .as_deref()
                .is_some_and(|source| source != "sessionEstimated")
    })
}

fn invalid_context_messages(messages: &[ContextCompositionMessage]) -> bool {
    let mut contribution_ids = HashSet::new();
    let mut call_ids = HashSet::new();
    for (message_index, message) in messages.iter().enumerate() {
        if message.message_index != message_index as u64
            || message.contribution_id.is_empty()
            || !contribution_ids.insert(message.contribution_id.as_str())
            || !matches!(
                message.contribution_kind.as_str(),
                "instructions"
                    | "workspaceBindings"
                    | "sessionControls"
                    | "journalMessages"
                    | "contextProviders"
            )
            || message.label.is_empty()
            || !matches!(
                message.role.as_str(),
                "system" | "user" | "assistant" | "tool"
            )
            || invalid_context_items(&message.attachments)
            || message.role != "user" && !message.attachments.is_empty()
        {
            return true;
        }
        let mut result_count = 0usize;
        for (block_index, block) in message.blocks.iter().enumerate() {
            let invalid = match block {
                ContextCompositionMessageBlock::Text {
                    block_index: actual,
                } => *actual != block_index as u64 || message.role == "tool",
                ContextCompositionMessageBlock::Reasoning {
                    block_index: actual,
                } => *actual != block_index as u64 || message.role != "assistant",
                ContextCompositionMessageBlock::ToolCall {
                    block_index: actual,
                    call_id,
                    tool_name,
                } => {
                    *actual != block_index as u64
                        || message.role != "assistant"
                        || call_id.is_empty()
                        || tool_name.is_empty()
                        || !call_ids.insert(call_id.as_str())
                }
                ContextCompositionMessageBlock::ToolResult {
                    block_index: actual,
                    result_for_call_id,
                } => {
                    result_count += 1;
                    *actual != block_index as u64
                        || message.role != "tool"
                        || result_for_call_id.is_empty()
                        || !call_ids.contains(result_for_call_id.as_str())
                }
            };
            if invalid {
                return true;
            }
        }
        if message.role == "tool" && (message.blocks.len() != 1 || result_count != 1) {
            return true;
        }
    }
    false
}

fn invalid_context_items(items: &[ContextCompositionItem]) -> bool {
    let mut item_ids = HashSet::new();
    items.iter().any(|item| {
        item.item_id.is_empty() || item.label.is_empty() || !item_ids.insert(item.item_id.as_str())
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDisplayProjection {
    pub title: String,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBindingDisplay {
    pub workspace_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionMessage {
    pub message_id: String,
    pub role: String,
    pub content: String,
    pub attachments: Vec<MessageAttachmentProjection>,
    pub feedback: Option<String>,
    pub sequence: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachmentProjection {
    pub attachment_id: String,
    pub name: String,
    pub media_type: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeProjection {
    pub narrative_id: String,
    pub run_id: String,
    pub content: String,
    pub sequence: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantDraftProjection {
    pub run_id: String,
    pub turn_id: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionProjection {
    pub interaction_id: String,
    pub run_id: String,
    pub kind: String,
    pub prompt: String,
    pub options: Option<Vec<InteractionOption>>,
    pub allow_freeform: bool,
    pub sequence: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPreview {
    pub summary: String,
    pub effects: Vec<String>,
    pub logical_targets: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalProjection {
    pub approval_id: String,
    pub run_id: String,
    pub call_id: String,
    pub preview: EffectPreview,
    pub sequence: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOptionProjection {
    pub option_id: String,
    pub label: String,
    pub description: Option<String>,
    pub operations_display: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPlanProjection {
    pub plan_id: String,
    pub run_id: String,
    pub prompt: String,
    pub options: Vec<PlanOptionProjection>,
    pub response_mode: String,
    pub ignore_allowed: bool,
    pub sequence: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoListProjection {
    pub run_id: String,
    pub items: Vec<TodoItem>,
    pub sequence: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub todo_id: String,
    pub label: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextUsageProjection {
    pub provider_request_id: String,
    pub run_id: String,
    pub sequence: u64,
    pub updated_at: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub context_window_tokens: u64,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_miss_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsageProjection {
    pub provider_call_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_miss_input_tokens: u64,
    pub cache_reported_call_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsageRoundProjection {
    pub run_id: String,
    pub input_message_id: String,
    pub title: String,
    pub sequence: u64,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub outcome: Option<String>,
    pub provider_call_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_miss_input_tokens: u64,
    pub cache_reported_call_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionProjection {
    pub provider_request_id: String,
    pub run_id: String,
    pub response_constraint: String,
    pub messages: Vec<ContextCompositionMessage>,
    pub workspace_bindings: Vec<ContextCompositionItem>,
    pub tools: Vec<ContextCompositionItem>,
    pub partitions: Vec<ContextCompositionPartitionProjection>,
    pub sequence: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionPartitionProjection {
    pub kind: String,
    pub item_count: u64,
    pub request_shape_units: u64,
    pub estimated_input_tokens: Option<u64>,
    pub token_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionMessage {
    pub message_index: u64,
    pub contribution_id: String,
    pub contribution_kind: String,
    pub label: String,
    pub role: String,
    pub blocks: Vec<ContextCompositionMessageBlock>,
    pub attachments: Vec<ContextCompositionItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ContextCompositionMessageBlock {
    Text {
        block_index: u64,
    },
    Reasoning {
        block_index: u64,
    },
    ToolCall {
        block_index: u64,
        call_id: String,
        tool_name: String,
    },
    ToolResult {
        block_index: u64,
        result_for_call_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionItem {
    pub item_id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProjection {
    pub run_id: String,
    pub profile_id: Option<String>,
    pub waiting_reason: Option<String>,
    pub workspace_bindings: Vec<WorkspaceBindingDisplay>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityProjection {
    pub activity_id: String,
    pub kind: String,
    pub status: String,
    pub label: String,
    pub run_id: String,
    pub call_id: Option<String>,
    pub sequence: u64,
    pub tool: Option<ToolActivityProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivityProjection {
    pub operation: String,
    pub resources: Vec<ActivityResourceProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityResourceProjection {
    pub kind: String,
    pub label: String,
    pub workspace_id: Option<String>,
    pub logical_path: Option<String>,
    pub uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactProjection {
    pub artifact_id: String,
    pub label: String,
    pub workspace_id: Option<String>,
    pub logical_path: Option<String>,
    pub uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationResourceReadRequest<'a> {
    pub workspace_id: &'a str,
    pub logical_path: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachConversationDirectoryIndexRequest<'a> {
    pub path: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationResourceReadResult {
    pub workspace_id: String,
    pub logical_path: String,
    pub content: String,
    pub size_bytes: u64,
    pub start_line: u64,
    pub end_line: u64,
}

pub fn message_command(session_id: &str, command_id: &str, text: &str) -> Value {
    message_command_with_profile(session_id, command_id, text, None)
}

pub fn directory_index_attach_command(
    session_id: &str,
    command_id: &str,
    binding: &WorkspaceBindingDisplay,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "session.directory-index.attach",
        "commandId": command_id,
        "sessionId": session_id,
        "workspaceBinding": binding,
    })
}

pub fn directory_index_detach_command(
    session_id: &str,
    command_id: &str,
    workspace_id: &str,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "session.directory-index.detach",
        "commandId": command_id,
        "sessionId": session_id,
        "workspaceId": workspace_id,
    })
}

pub fn message_command_with_profile(
    session_id: &str,
    command_id: &str,
    text: &str,
    profile_id: Option<&str>,
) -> Value {
    let mut command = json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "message.submit",
        "commandId": command_id,
        "sessionId": session_id,
        "text": text,
    });
    if let Some(profile_id) = profile_id {
        command["profileId"] = json!(profile_id);
    }
    command
}

pub fn profile_selection_command(
    session_id: &str,
    command_id: &str,
    run_id: &str,
    profile_id: &str,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "run.profile.select",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": run_id,
        "profileId": profile_id,
    })
}

pub fn cancel_command(session_id: &str, command_id: &str, run_id: &str) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "run.cancel",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": run_id,
    })
}

pub fn interaction_response_command(
    session_id: &str,
    command_id: &str,
    interaction: &InteractionProjection,
    response: &str,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "interaction.respond",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": interaction.run_id,
        "interactionId": interaction.interaction_id,
        "response": response,
    })
}

pub fn approval_response_command(
    session_id: &str,
    command_id: &str,
    approval: &ApprovalProjection,
    decision: &str,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "approval.respond",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": approval.run_id,
        "callId": approval.call_id,
        "approvalId": approval.approval_id,
        "decision": decision,
    })
}

pub fn plan_select_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
    option_id: &str,
) -> Value {
    plan_response_command(
        session_id,
        command_id,
        plan,
        json!({
            "kind": "select",
            "optionId": option_id,
        }),
    )
}

pub fn plan_feedback_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
    text: &str,
) -> Value {
    plan_response_command(
        session_id,
        command_id,
        plan,
        json!({
            "kind": "feedback",
            "text": text,
        }),
    )
}

pub fn plan_ignore_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
) -> Value {
    plan_response_command(session_id, command_id, plan, json!({ "kind": "ignore" }))
}

fn plan_response_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
    response: Value,
) -> Value {
    json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "plan.respond",
        "commandId": command_id,
        "sessionId": session_id,
        "runId": plan.run_id,
        "planId": plan.plan_id,
        "response": response,
    })
}

pub fn is_terminal_run_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "cancelled" | "indeterminate"
    )
}

fn is_run_status(status: &str) -> bool {
    matches!(
        status,
        "running" | "waiting" | "completed" | "failed" | "cancelled" | "indeterminate"
    )
}

fn valid_token_usage_fields(
    provider_call_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_miss_input_tokens: u64,
    cache_reported_call_count: u64,
) -> bool {
    cache_reported_call_count <= provider_call_count
        && input_tokens.checked_add(output_tokens).is_some()
        && cache_read_input_tokens
            .checked_add(cache_miss_input_tokens)
            .is_some_and(|sum| sum <= input_tokens)
}

fn is_normalized_logical_path(value: &str) -> bool {
    value == "."
        || (!value.is_empty()
            && !value.starts_with('/')
            && !value.ends_with('/')
            && value
                .split('/')
                .all(|segment| !segment.is_empty() && segment != "." && segment != ".."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projection_value() -> Value {
        json!({
            "schemaVersion": SESSION_PROJECTION_VERSION,
            "sessionId": "session:test",
            "revision": 8,
            "display": { "title": "测试" },
            "workspaceBindings": [{
                "workspaceId": "workspace:test",
                "displayName": "Test"
            }],
            "sessionDirectoryIndexes": [],
            "messages": [
                {
                    "messageId": "message:input",
                    "role": "user",
                    "content": "分析项目",
                    "attachments": [],
                    "feedback": null,
                    "sequence": 1,
                    "createdAt": "2026-08-25T00:00:00.000Z"
                },
                {
                    "messageId": "message:answer",
                    "role": "assistant",
                    "content": "分析完成",
                    "attachments": [],
                    "feedback": "up",
                    "sequence": 8,
                    "createdAt": "2026-08-25T00:00:07.000Z"
                }
            ],
            "narratives": [],
            "assistantDraft": null,
            "pendingInteraction": null,
            "pendingApproval": null,
            "pendingPlan": null,
            "todoList": {
                "runId": "run:test",
                "items": [{ "todoId": "read", "label": "读取入口", "status": "completed" }],
                "sequence": 3,
                "updatedAt": "2026-08-25T00:00:00.000Z"
            },
            "contextUsage": {
                "providerRequestId": "provider-request:test",
                "runId": "run:test",
                "sequence": 5,
                "updatedAt": "2026-08-25T00:00:04.000Z",
                "inputTokens": 80,
                "outputTokens": 10,
                "contextWindowTokens": 1000,
                "cacheReadInputTokens": 50,
                "cacheMissInputTokens": 30
            },
            "contextCompositions": [{
                "providerRequestId": "provider-request:test",
                "runId": "run:test",
                "responseConstraint": "normal",
                "messages": [{
                    "messageIndex": 0,
                    "contributionId": "instruction:agent",
                    "contributionKind": "instructions",
                    "label": "deepcode.coding-agent",
                    "role": "system",
                    "blocks": [{ "blockIndex": 0, "kind": "text" }],
                    "attachments": []
                }],
                "workspaceBindings": [{ "itemId": "workspace:test", "label": "Test" }],
                "tools": [{ "itemId": "fs.read", "label": "fs.read" }],
                "partitions": [
                    { "kind": "instructions", "itemCount": 1, "requestShapeUnits": 30,
                      "estimatedInputTokens": 30, "tokenSource": "sessionEstimated" },
                    { "kind": "sessionControls", "itemCount": 4, "requestShapeUnits": 20,
                      "estimatedInputTokens": 20, "tokenSource": "sessionEstimated" },
                    { "kind": "tools", "itemCount": 1, "requestShapeUnits": 10,
                      "estimatedInputTokens": 10, "tokenSource": "sessionEstimated" },
                    { "kind": "workspaceBindings", "itemCount": 1, "requestShapeUnits": 8,
                      "estimatedInputTokens": 8, "tokenSource": "sessionEstimated" },
                    { "kind": "contextProviders", "itemCount": 0, "requestShapeUnits": 0,
                      "estimatedInputTokens": 0, "tokenSource": "sessionEstimated" },
                    { "kind": "journalMessages", "itemCount": 1, "requestShapeUnits": 10,
                      "estimatedInputTokens": 10, "tokenSource": "sessionEstimated" },
                    { "kind": "messageAttachments", "itemCount": 0, "requestShapeUnits": 2,
                      "estimatedInputTokens": 2, "tokenSource": "sessionEstimated" }
                ],
                "sequence": 4,
                "createdAt": "2026-08-25T00:00:03.000Z"
            }],
            "tokenUsage": {
                "providerCallCount": 1,
                "inputTokens": 80,
                "outputTokens": 10,
                "cacheReadInputTokens": 50,
                "cacheMissInputTokens": 30,
                "cacheReportedCallCount": 1
            },
            "tokenUsageHistory": [{
                "runId": "run:test",
                "inputMessageId": "message:input",
                "title": "分析项目",
                "sequence": 2,
                "startedAt": "2026-08-25T00:00:01.000Z",
                "completedAt": "2026-08-25T00:00:06.000Z",
                "outcome": "completed",
                "providerCallCount": 1,
                "inputTokens": 80,
                "outputTokens": 10,
                "cacheReadInputTokens": 50,
                "cacheMissInputTokens": 30,
                "cacheReportedCallCount": 1
            }],
            "run": {
                "runId": "run:test",
                "status": "completed",
                "workspaceBindings": [{
                    "workspaceId": "workspace:test",
                    "displayName": "Test"
                }]
            },
            "activities": [{
                "activityId": "tool:read",
                "kind": "tool",
                "status": "completed",
                "label": "fs.read",
                "runId": "run:test",
                "callId": "call:read",
                "sequence": 6,
                "tool": {
                    "operation": "fs.read",
                    "resources": [{
                        "kind": "workspacePath",
                        "label": "README.md",
                        "workspaceId": "workspace:test",
                        "logicalPath": "README.md"
                    }]
                }
            }],
            "artifacts": [],
            "terminalError": null
        })
    }

    #[test]
    fn validates_todo_usage_and_canonical_activity_resources() {
        let projection: SessionProjection =
            serde_json::from_value(projection_value()).expect("projection decodes");
        assert_eq!(projection.validate(), Ok(()));
        assert_eq!(projection.messages[1].feedback.as_deref(), Some("up"));
        assert_eq!(projection.context_compositions.len(), 1);
        assert_eq!(projection.token_usage_history.len(), 1);
    }

    #[test]
    fn rejects_non_normalized_workspace_activity_resource() {
        let mut value = projection_value();
        value["activities"][0]["tool"]["resources"][0]["logicalPath"] = json!("../secret");
        let projection: SessionProjection =
            serde_json::from_value(value).expect("projection decodes");
        assert!(projection.validate().is_err());
    }

    #[test]
    fn rejects_context_usage_without_its_exact_request_receipt() {
        let mut value = projection_value();
        value["contextUsage"]["providerRequestId"] = json!("provider-request:other");
        let projection: SessionProjection =
            serde_json::from_value(value).expect("projection decodes");
        assert!(projection.validate().is_err());
    }

    #[test]
    fn rejects_removed_or_partial_context_receipt_shapes() {
        let mut mixed = projection_value();
        mixed["contextCompositions"][0]["unknownField"] = json!([]);
        assert!(serde_json::from_value::<SessionProjection>(mixed).is_err());

        let mut partial = projection_value();
        partial["contextCompositions"][0]
            .as_object_mut()
            .expect("receipt object")
            .remove("tools");
        assert!(serde_json::from_value::<SessionProjection>(partial).is_err());
    }

    #[test]
    fn rejects_context_message_order_that_differs_from_provider_request() {
        let mut value = projection_value();
        value["contextCompositions"][0]["messages"][0]["messageIndex"] = json!(1);
        let projection: SessionProjection =
            serde_json::from_value(value).expect("projection decodes");
        assert!(projection.validate().is_err());
    }

    #[test]
    fn rejects_reordered_or_partially_estimated_context_partitions() {
        let mut reordered = projection_value();
        reordered["contextCompositions"][0]["partitions"][0]["kind"] = json!("tools");
        let projection: SessionProjection =
            serde_json::from_value(reordered).expect("reordered partitions decode");
        assert!(projection.validate().is_err());

        let mut partial = projection_value();
        partial["contextCompositions"][0]["partitions"][1]
            .as_object_mut()
            .expect("partition object")
            .remove("estimatedInputTokens");
        let projection: SessionProjection =
            serde_json::from_value(partial).expect("partial estimates decode");
        assert!(projection.validate().is_err());
    }

    #[test]
    fn rejects_unknown_projection_fields_instead_of_dropping_them() {
        let mut value = projection_value();
        value["futureFact"] = json!(true);
        assert!(serde_json::from_value::<SessionProjection>(value).is_err());
    }
}
