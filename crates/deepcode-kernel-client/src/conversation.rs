use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const CONVERSATION_COMMAND_VERSION: &str = "deepcode.command.v3";
pub const SESSION_PROJECTION_VERSION: &str = "deepcode.session-projection.v4";

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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCatalogProjection {
    pub revision: String,
    pub plugins: Vec<PluginCatalogItem>,
}

impl PluginCatalogProjection {
    pub fn validate(&self) -> Result<(), String> {
        if self.revision.is_empty() {
            return Err("plugin catalog revision is invalid".to_string());
        }
        let mut uris = HashSet::new();
        let mut activation_media_types = HashSet::new();
        if self.plugins.iter().any(|plugin| {
            !valid_plugin_uri(&plugin.uri)
                || plugin.display_name.trim().is_empty()
                || plugin.short_description.trim().is_empty()
                || plugin.activation_media_types.iter().any(|media_type| {
                    !valid_media_type(media_type)
                        || !activation_media_types.insert(media_type.as_str())
                })
                || !plugin.enabled
                || !plugin.available
                || !uris.insert(plugin.uri.as_str())
        }) {
            return Err("plugin catalog entries are invalid".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginCatalogItem {
    pub uri: String,
    pub display_name: String,
    pub short_description: String,
    pub icon_ref: Option<String>,
    pub activation_media_types: Vec<String>,
    pub enabled: bool,
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSelectionInput {
    pub selection_id: String,
    pub uri: String,
    pub label: String,
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
    pub timeline: Vec<SessionTimelineItem>,
    pub messages: Vec<ProjectionMessage>,
    pub narratives: Vec<NarrativeProjection>,
    pub assistant_draft: Option<AssistantDraftProjection>,
    pub pending_interaction: Option<InteractionProjection>,
    pub pending_approval: Option<ApprovalProjection>,
    pub plans: Vec<PlanProjection>,
    pub active_plan_ref: Option<PlanRef>,
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
            run.profile_id.is_empty()
                || !is_run_status(&run.status)
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
                || message.run_id.as_deref().is_some_and(str::is_empty)
                || message
                    .provider_request_id
                    .as_deref()
                    .is_some_and(str::is_empty)
                || if message.role == "assistant" {
                    message.run_id.is_none() || message.provider_request_id.is_none()
                } else {
                    message.provider_request_id.is_some()
                }
                || invalid_filesystem_references(&message.filesystem_references)
                || message.plugin_selections.iter().any(|selection| {
                    selection.selection_id.is_empty()
                        || !valid_plugin_uri(&selection.uri)
                        || selection.label.trim().is_empty()
                })
        }) {
            return Err("shared Session projection has invalid messages".to_string());
        }
        if self.narratives.iter().any(|narrative| {
            narrative.narrative_id.is_empty()
                || narrative.run_id.is_empty()
                || narrative.provider_request_id.is_empty()
                || narrative.sequence == 0
                || narrative.sequence > self.revision
                || narrative.created_at.is_empty()
        }) {
            return Err("shared Session projection has invalid narratives".to_string());
        }
        if self
            .pending_interaction
            .as_ref()
            .is_some_and(|interaction| {
                !matches!(interaction.kind.as_str(), "question" | "confirmation")
                    || interaction.interaction_id.is_empty()
                    || interaction.run_id.is_empty()
                    || interaction.call_id.is_empty()
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
        let mut plan_revisions = HashSet::new();
        if self.plans.iter().any(|plan| {
            !valid_plan_projection(plan)
                || !plan_revisions.insert((plan.plan_id.as_str(), plan.revision))
        }) {
            return Err("shared Session projection has an invalid plan".to_string());
        }
        if self.active_plan_ref.as_ref().is_some_and(|active| {
            active.plan_id.is_empty()
                || active.revision == 0
                || self.plans.iter().all(|plan| {
                    plan.plan_id != active.plan_id
                        || plan.revision != active.revision
                        || plan.status != "confirmed"
                })
        }) {
            return Err("shared Session projection has an invalid active plan".to_string());
        }
        if self.pending_plan.as_ref().is_some_and(|plan| {
            !valid_pending_plan_projection(plan)
                || self.plans.iter().all(|published| {
                    published.plan_id != plan.plan_id
                        || published.revision != plan.revision
                        || published.status != "published"
                })
        }) {
            return Err("shared Session projection has an invalid pending plan".to_string());
        }
        if self.todo_list.as_ref().is_some_and(|todo_list| {
            let mut ids = HashSet::new();
            let mut step_ids = HashSet::new();
            todo_list.source_plan_id.is_empty()
                || todo_list.source_plan_revision == 0
                || todo_list.items.is_empty()
                || todo_list.items.len() > 12
                || self.plans.iter().all(|plan| {
                    plan.plan_id != todo_list.source_plan_id
                        || plan.revision != todo_list.source_plan_revision
                })
                || todo_list.items.iter().any(|item| {
                    item.todo_id.is_empty()
                        || item.source_step_id.is_empty()
                        || item.label.is_empty()
                        || !matches!(item.status.as_str(), "pending" | "inProgress" | "completed")
                        || !ids.insert(item.todo_id.as_str())
                        || !step_ids.insert(item.source_step_id.as_str())
                })
        }) {
            return Err("shared Session projection has an invalid todo list".to_string());
        }
        if self.context_usage.as_ref().is_some_and(|usage| {
            usage.provider_request_id.is_empty()
                || usage.provider_runtime_ref.is_empty()
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
                            .is_none_or(|sum| sum != usage.input_tokens)
                    })
        }) {
            return Err("shared Session projection has invalid context usage".to_string());
        }
        let mut provider_request_ids = HashSet::new();
        if self.context_compositions.iter().any(|receipt| {
            receipt.provider_request_id.is_empty()
                || receipt.run_id.is_empty()
                || !matches!(receipt.purpose.as_str(), "agent" | "contextCompaction")
                || receipt.sequence == 0
                || receipt.sequence > self.revision
                || receipt.created_at.is_empty()
                || !provider_request_ids.insert(receipt.provider_request_id.as_str())
                || !matches!(
                    receipt.response_constraint.as_str(),
                    "normal" | "toolRequired" | "answerOnly"
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
            self.token_usage.reported_call_count,
            self.token_usage.input_tokens,
            self.token_usage.output_tokens,
            self.token_usage.cache_read_input_tokens,
            self.token_usage.cache_miss_input_tokens,
            self.token_usage.cache_available,
            self.token_usage.cache_complete,
            self.token_usage.cache_hit_ratio,
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
                    round.reported_call_count,
                    round.input_tokens,
                    round.output_tokens,
                    round.cache_read_input_tokens,
                    round.cache_miss_input_tokens,
                    round.cache_available,
                    round.cache_complete,
                    round.cache_hit_ratio,
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
                        || tool.shell.as_ref().is_some_and(|shell| {
                            tool.operation != "bash"
                                || shell.command.trim().is_empty()
                                || !is_normalized_logical_path(&shell.cwd)
                                || !matches!(shell.execution_scope.as_str(), "workspace" | "host")
                                || shell.result.as_ref().is_some_and(|result| {
                                    !valid_shell_execution_environment(&result.environment)
                                        || result.environment.execution_scope
                                            != shell.execution_scope
                                        || result.environment.terminal != shell.terminal
                                        || result.success
                                            && (result.timed_out || result.exit_code != Some(0))
                                })
                        })
                        || tool.operation == "bash"
                            && (tool.shell.is_none()
                                || tool.shell.as_ref().is_some_and(|shell| {
                                    match activity.status.as_str() {
                                        "completed" => shell.result.is_none(),
                                        "failed" => false,
                                        _ => shell.result.is_some(),
                                    }
                                }))
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
        let mut timeline_ids = HashSet::new();
        let mut timeline_message_ids = HashSet::new();
        let mut timeline_narrative_ids = HashSet::new();
        let mut timeline_plan_refs = HashSet::new();
        let mut timeline_activity_ids = HashSet::new();
        if self.timeline.iter().any(|item| {
            if item.timeline_id().is_empty()
                || item.sequence() == 0
                || item.sequence() > self.revision
                || !timeline_ids.insert(item.timeline_id())
            {
                return true;
            }
            match item {
                SessionTimelineItem::Message { message_id, .. } => {
                    !timeline_message_ids.insert(message_id.as_str())
                        || self.messages.iter().all(|message| {
                            message.message_id != *message_id
                                || !matches!(message.role.as_str(), "user" | "assistant")
                        })
                }
                SessionTimelineItem::Narrative {
                    provider_request_id,
                    narrative_id,
                    ..
                } => {
                    provider_request_id.is_empty()
                        || !timeline_narrative_ids.insert(narrative_id.as_str())
                        || self.narratives.iter().all(|narrative| {
                            narrative.narrative_id != *narrative_id
                                || narrative.provider_request_id != *provider_request_id
                        })
                }
                SessionTimelineItem::Plan {
                    provider_request_id,
                    plan_id,
                    revision,
                    ..
                } => {
                    provider_request_id.is_empty()
                        || !timeline_plan_refs.insert((plan_id.as_str(), *revision))
                        || self
                            .plans
                            .iter()
                            .all(|plan| plan.plan_id != *plan_id || plan.revision != *revision)
                }
                SessionTimelineItem::ToolGroup {
                    provider_request_id,
                    activity_ids,
                    ..
                } => {
                    provider_request_id.is_empty()
                        || activity_ids.is_empty()
                        || activity_ids.iter().any(|activity_id| {
                            !timeline_activity_ids.insert(activity_id.as_str())
                                || self.activities.iter().all(|activity| {
                                    activity.activity_id != *activity_id || activity.kind != "tool"
                                })
                        })
                }
            }
        }) {
            return Err("shared Session projection has an invalid canonical timeline".to_string());
        }
        if timeline_message_ids.len()
            != self
                .messages
                .iter()
                .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
                .count()
            || timeline_narrative_ids.len() != self.narratives.len()
            || timeline_plan_refs.len() != self.plans.len()
            || timeline_activity_ids.len()
                != self
                    .activities
                    .iter()
                    .filter(|activity| activity.kind == "tool")
                    .count()
        {
            return Err("shared Session projection canonical timeline is incomplete".to_string());
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SessionTimelineItem {
    #[serde(rename = "message")]
    Message {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        sequence: u64,
        #[serde(rename = "messageId")]
        message_id: String,
    },
    #[serde(rename = "narrative")]
    Narrative {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        sequence: u64,
        #[serde(rename = "providerRequestId")]
        provider_request_id: String,
        #[serde(rename = "narrativeId")]
        narrative_id: String,
    },
    #[serde(rename = "plan")]
    Plan {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        sequence: u64,
        #[serde(rename = "providerRequestId")]
        provider_request_id: String,
        #[serde(rename = "planId")]
        plan_id: String,
        revision: u64,
    },
    #[serde(rename = "toolGroup")]
    ToolGroup {
        #[serde(rename = "timelineId")]
        timeline_id: String,
        sequence: u64,
        #[serde(rename = "providerRequestId")]
        provider_request_id: String,
        #[serde(rename = "activityIds")]
        activity_ids: Vec<String>,
    },
}

impl SessionTimelineItem {
    pub fn timeline_id(&self) -> &str {
        match self {
            Self::Message { timeline_id, .. }
            | Self::Narrative { timeline_id, .. }
            | Self::Plan { timeline_id, .. }
            | Self::ToolGroup { timeline_id, .. } => timeline_id,
        }
    }

    pub fn sequence(&self) -> u64 {
        match self {
            Self::Message { sequence, .. }
            | Self::Narrative { sequence, .. }
            | Self::Plan { sequence, .. }
            | Self::ToolGroup { sequence, .. } => *sequence,
        }
    }
}

fn invalid_context_composition_shape(receipt: &ContextCompositionProjection) -> bool {
    !valid_context_hash(&receipt.stable_core_hash)
        || !valid_context_hash(&receipt.base_tool_schema_hash)
        || !valid_context_hash(&receipt.selected_plugin_snapshot_hash)
        || invalid_context_messages(&receipt.messages)
        || invalid_context_items(&receipt.workspace_bindings)
        || invalid_context_tools(&receipt.tools)
        || invalid_context_partitions(&receipt.partitions)
}

fn valid_context_hash(value: &str) -> bool {
    value
        .strip_prefix("context-hash-v1:")
        .is_some_and(|suffix| {
            suffix.len() == 16 && suffix.chars().all(|value| value.is_ascii_hexdigit())
        })
}

fn invalid_context_partitions(partitions: &[ContextCompositionPartitionProjection]) -> bool {
    const ORDER: [&str; 7] = [
        "instructions",
        "sessionControls",
        "tools",
        "workspaceBindings",
        "contextProviders",
        "journalMessages",
        "filesystemReferences",
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
            || invalid_context_items(&message.filesystem_references)
            || message.role != "user" && !message.filesystem_references.is_empty()
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

pub(crate) fn invalid_filesystem_references(references: &[FilesystemReference]) -> bool {
    if references.len() > 8 {
        return true;
    }
    let mut reference_ids = HashSet::new();
    let mut targets = HashSet::new();
    references.iter().any(|reference| {
        reference.reference_id.is_empty()
            || reference.workspace_id.is_empty()
            || reference.display_name.is_empty()
            || !valid_logical_path(&reference.logical_path)
            || !reference_ids.insert(reference.reference_id.as_str())
            || !targets.insert((
                reference.workspace_id.as_str(),
                reference.logical_path.as_str(),
            ))
            || match reference.kind.as_str() {
                "directory" => {
                    reference.logical_path != "."
                        || reference.media_type.is_some()
                        || reference.byte_length.is_some()
                }
                "file" => {
                    reference.logical_path == "."
                        || reference
                            .media_type
                            .as_deref()
                            .is_none_or(|media_type| !valid_media_type(media_type))
                        || reference.byte_length.is_none()
                }
                _ => true,
            }
    })
}

fn valid_logical_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 4_096 || value.contains('\0') || value.contains('\\') {
        return false;
    }
    value == "."
        || !value.starts_with('/')
            && !value.ends_with('/')
            && value
                .split('/')
                .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

fn invalid_context_tools(tools: &[ContextCompositionTool]) -> bool {
    let mut item_ids = HashSet::new();
    let mut canonical_names = HashSet::new();
    let mut wire_names = HashSet::new();
    tools.iter().any(|tool| {
        tool.item_id.is_empty()
            || tool.label.is_empty()
            || tool.canonical_name.is_empty()
            || tool.wire_name.is_empty()
            || tool.item_id != tool.canonical_name
            || tool.label != tool.wire_name
            || !item_ids.insert(tool.item_id.as_str())
            || !canonical_names.insert(tool.canonical_name.as_str())
            || !wire_names.insert(tool.wire_name.as_str())
            || !matches!(
                tool.origin.as_str(),
                "coreBuiltin" | "extension" | "sessionControl"
            )
            || tool.availability != "callable"
            || if tool.origin == "extension" {
                tool.plugin_uri
                    .as_deref()
                    .is_none_or(|uri| !valid_plugin_uri(uri))
            } else {
                tool.plugin_uri.is_some()
            }
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDisplayProjection {
    pub creation_title: String,
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
    pub run_id: Option<String>,
    pub provider_request_id: Option<String>,
    pub role: String,
    pub content: String,
    pub filesystem_references: Vec<FilesystemReference>,
    pub plugin_selections: Vec<PluginSelectionInput>,
    pub feedback: Option<String>,
    pub sequence: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemReference {
    pub reference_id: String,
    pub workspace_id: String,
    pub logical_path: String,
    pub display_name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
}

impl<'de> Deserialize<'de> for FilesystemReference {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(
            tag = "kind",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        enum WireReference {
            File {
                reference_id: String,
                workspace_id: String,
                logical_path: String,
                display_name: String,
                media_type: String,
                byte_length: u64,
            },
            Directory {
                reference_id: String,
                workspace_id: String,
                logical_path: String,
                display_name: String,
            },
        }

        Ok(match WireReference::deserialize(deserializer)? {
            WireReference::File {
                reference_id,
                workspace_id,
                logical_path,
                display_name,
                media_type,
                byte_length,
            } => Self {
                reference_id,
                workspace_id,
                logical_path,
                display_name,
                kind: "file".to_string(),
                media_type: Some(media_type),
                byte_length: Some(byte_length),
            },
            WireReference::Directory {
                reference_id,
                workspace_id,
                logical_path,
                display_name,
            } => Self {
                reference_id,
                workspace_id,
                logical_path,
                display_name,
                kind: "directory".to_string(),
                media_type: None,
                byte_length: None,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrativeProjection {
    pub narrative_id: String,
    pub run_id: String,
    pub provider_request_id: String,
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
    pub call_id: String,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanOperation {
    pub workspace_id: String,
    pub operation: String,
    pub target: Option<String>,
    pub target_kind: Option<String>,
    pub command: Option<String>,
    pub workspace_mode: Option<String>,
    pub execution_scope: Option<String>,
    pub terminal: Option<PlanTerminalInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTerminalInput {
    pub stdin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionPlanStep {
    pub step_id: String,
    pub title: String,
    pub details: String,
    pub verification: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanProjection {
    pub plan_id: String,
    pub revision: u64,
    pub run_id: String,
    pub call_id: String,
    pub title: String,
    pub summary: String,
    pub steps: Vec<ExecutionPlanStep>,
    pub mutation_manifest: Vec<PlanOperation>,
    pub status: String,
    pub decision_id: Option<String>,
    pub sequence: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRef {
    pub plan_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingPlanProjection {
    pub plan_id: String,
    pub revision: u64,
    pub run_id: String,
    pub call_id: String,
    pub title: String,
    pub summary: String,
    pub steps: Vec<ExecutionPlanStep>,
    pub mutation_manifest: Vec<PlanOperation>,
    pub status: String,
    pub decision_id: Option<String>,
    pub response_mode: String,
    pub sequence: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoListProjection {
    pub source_plan_id: String,
    pub source_plan_revision: u64,
    pub items: Vec<TodoItem>,
    pub sequence: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub todo_id: String,
    pub source_step_id: String,
    pub label: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextUsageProjection {
    pub provider_request_id: String,
    pub provider_runtime_ref: String,
    pub run_id: String,
    pub sequence: u64,
    pub updated_at: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub context_window_tokens: u64,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_miss_input_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsageProjection {
    pub provider_call_count: u64,
    pub reported_call_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_miss_input_tokens: u64,
    pub cache_available: bool,
    pub cache_complete: bool,
    pub cache_hit_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
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
    pub reported_call_count: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_miss_input_tokens: u64,
    pub cache_available: bool,
    pub cache_complete: bool,
    pub cache_hit_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionProjection {
    pub provider_request_id: String,
    pub purpose: String,
    pub run_id: String,
    pub response_constraint: String,
    pub stable_core_hash: String,
    pub base_tool_schema_hash: String,
    pub selected_plugin_snapshot_hash: String,
    pub dynamic_instruction_bytes: u64,
    pub messages: Vec<ContextCompositionMessage>,
    pub workspace_bindings: Vec<ContextCompositionItem>,
    pub tools: Vec<ContextCompositionTool>,
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
    pub filesystem_references: Vec<ContextCompositionItem>,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextCompositionTool {
    pub item_id: String,
    pub label: String,
    pub canonical_name: String,
    pub wire_name: String,
    pub origin: String,
    pub availability: String,
    pub plugin_uri: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProjection {
    pub run_id: String,
    pub profile_id: String,
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
    pub shell: Option<ShellActivityProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellActivityProjection {
    pub command: String,
    pub cwd: String,
    pub execution_scope: String,
    pub terminal: bool,
    pub result: Option<ShellActivityResultProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellActivityResultProjection {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i64>,
    pub success: bool,
    pub timed_out: bool,
    pub truncated: bool,
    pub captured_bytes: u64,
    pub duration_ms: u64,
    pub environment: ShellExecutionEnvironmentProjection,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShellExecutionEnvironmentProjection {
    pub shell: String,
    pub interactive: bool,
    pub execution_scope: String,
    pub terminal: bool,
    pub path_source: String,
    pub write_scope: String,
    pub home_writable: bool,
    pub network_access: bool,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemReferencePathInput {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConversationFilesystemReferencesRequest {
    pub references: Vec<FilesystemReferencePathInput>,
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

pub fn message_command_with_profile_and_plugins(
    session_id: &str,
    command_id: &str,
    text: &str,
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    plugin_catalog_revision: &str,
    plugin_selections: &[PluginSelectionInput],
) -> Value {
    let mut command = message_command_with_profile(session_id, command_id, text, profile_id);
    if !filesystem_references.is_empty() {
        command["filesystemReferences"] = json!(filesystem_references);
    }
    if !plugin_selections.is_empty() {
        command["pluginCatalogRevision"] = json!(plugin_catalog_revision);
        command["pluginSelections"] = json!(plugin_selections);
    }
    command
}

pub fn focus_command(
    session_id: &str,
    command_id: &str,
    task: &str,
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    plugin_catalog_revision: &str,
    plugin_selections: &[PluginSelectionInput],
) -> Value {
    let mut command = json!({
        "schemaVersion": CONVERSATION_COMMAND_VERSION,
        "type": "context.focus",
        "commandId": command_id,
        "sessionId": session_id,
        "task": task,
    });
    if let Some(profile_id) = profile_id {
        command["profileId"] = json!(profile_id);
    }
    if !filesystem_references.is_empty() {
        command["filesystemReferences"] = json!(filesystem_references);
    }
    if !plugin_selections.is_empty() {
        command["pluginCatalogRevision"] = json!(plugin_catalog_revision);
        command["pluginSelections"] = json!(plugin_selections);
    }
    command
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

pub fn plan_confirm_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
) -> Value {
    plan_response_command(session_id, command_id, plan, json!({ "kind": "confirm" }))
}

pub fn plan_revision_command(
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
            "kind": "requestRevision",
            "text": text,
        }),
    )
}

pub fn plan_cancel_command(
    session_id: &str,
    command_id: &str,
    plan: &PendingPlanProjection,
) -> Value {
    plan_response_command(session_id, command_id, plan, json!({ "kind": "cancel" }))
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
        "revision": plan.revision,
        "response": response,
    })
}

fn valid_plan_projection(plan: &PlanProjection) -> bool {
    !plan.plan_id.is_empty()
        && plan.revision > 0
        && !plan.run_id.is_empty()
        && !plan.call_id.is_empty()
        && !plan.title.is_empty()
        && !plan.summary.is_empty()
        && !plan.steps.is_empty()
        && plan.steps.len() <= 12
        && matches!(
            plan.status.as_str(),
            "published"
                | "revisionRequested"
                | "confirmed"
                | "superseded"
                | "cancelled"
                | "completed"
                | "invalidated"
        )
        && plan.sequence > 0
        && !plan.created_at.is_empty()
        && !plan.updated_at.is_empty()
        && valid_plan_body(&plan.steps, &plan.mutation_manifest)
}

fn valid_pending_plan_projection(plan: &PendingPlanProjection) -> bool {
    !plan.plan_id.is_empty()
        && plan.revision > 0
        && !plan.run_id.is_empty()
        && !plan.call_id.is_empty()
        && !plan.title.is_empty()
        && !plan.summary.is_empty()
        && plan.status == "published"
        && plan.response_mode == "confirmReviseOrCancel"
        && plan.decision_id.is_none()
        && plan.sequence > 0
        && !plan.created_at.is_empty()
        && !plan.updated_at.is_empty()
        && valid_plan_body(&plan.steps, &plan.mutation_manifest)
}

fn valid_plan_body(steps: &[ExecutionPlanStep], operations: &[PlanOperation]) -> bool {
    let mut step_ids = HashSet::new();
    !steps.is_empty()
        && steps.len() <= 12
        && steps.iter().all(|step| {
            !step.step_id.is_empty()
                && !step.title.is_empty()
                && !step.details.is_empty()
                && step_ids.insert(step.step_id.as_str())
                && step.verification.as_ref().is_none_or(|items| {
                    items.len() <= 8 && items.iter().all(|item| !item.trim().is_empty())
                })
        })
        && operations.iter().all(|operation| {
            !operation.workspace_id.is_empty()
                && match operation.operation.as_str() {
                    "fs.delete" => {
                        matches!(
                            operation.target_kind.as_deref(),
                            Some("file" | "directoryTree")
                        ) && operation
                            .target
                            .as_deref()
                            .is_some_and(|target| !target.is_empty())
                            && operation.command.is_none()
                            && operation.workspace_mode.is_none()
                            && operation.execution_scope.is_none()
                            && operation.terminal.is_none()
                    }
                    "fs.write" | "fs.edit" => {
                        operation
                            .target
                            .as_deref()
                            .is_some_and(|target| !target.is_empty())
                            && operation.target_kind.is_none()
                            && operation.command.is_none()
                            && operation.workspace_mode.is_none()
                            && operation.execution_scope.is_none()
                            && operation.terminal.is_none()
                    }
                    "bash" => {
                        operation.target.is_none()
                            && operation.target_kind.is_none()
                            && operation
                                .command
                                .as_deref()
                                .is_some_and(|command| !command.is_empty())
                            && operation.workspace_mode.as_deref() == Some("write")
                            && matches!(
                                operation.execution_scope.as_deref(),
                                Some("workspace" | "host")
                            )
                            && operation
                                .terminal
                                .as_ref()
                                .is_none_or(|terminal| terminal.stdin.len() <= 65_536)
                    }
                    _ => false,
                }
        })
}

pub fn is_terminal_run_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "cancelled" | "indeterminate" | "releaseFailed"
    )
}

fn is_run_status(status: &str) -> bool {
    matches!(
        status,
        "running"
            | "waiting"
            | "releasing"
            | "releaseFailed"
            | "completed"
            | "failed"
            | "cancelled"
            | "indeterminate"
    )
}

fn valid_plugin_uri(value: &str) -> bool {
    let Some(identity) = value.strip_prefix("plugin://") else {
        return false;
    };
    let Some((name, source)) = identity.split_once('@') else {
        return false;
    };
    !name.is_empty()
        && !source.is_empty()
        && !name.contains('@')
        && name.chars().chain(source.chars()).all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
}

fn valid_media_type(value: &str) -> bool {
    let Some((kind, subtype)) = value.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && value.len() <= 128
        && kind.chars().chain(subtype.chars()).all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(
                    character,
                    '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'
                )
        })
}

fn valid_token_usage_fields(
    provider_call_count: u64,
    reported_call_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_miss_input_tokens: u64,
    cache_available: bool,
    cache_complete: bool,
    cache_hit_ratio: Option<f64>,
) -> bool {
    let Some(cache_population) = cache_read_input_tokens.checked_add(cache_miss_input_tokens)
    else {
        return false;
    };
    if reported_call_count > provider_call_count
        || input_tokens.checked_add(output_tokens).is_none()
        || cache_population > input_tokens
        || cache_available != (reported_call_count > 0)
        || cache_complete != (provider_call_count > 0 && reported_call_count == provider_call_count)
    {
        return false;
    }
    match (cache_population, cache_hit_ratio) {
        (0, None) => true,
        (0, Some(_)) | (_, None) => false,
        (_, Some(ratio)) => {
            let expected = cache_read_input_tokens as f64 / cache_population as f64;
            ratio.is_finite()
                && (0.0..=1.0).contains(&ratio)
                && (ratio - expected).abs() <= f64::EPSILON * 8.0
        }
    }
}

fn valid_shell_execution_environment(environment: &ShellExecutionEnvironmentProjection) -> bool {
    !environment.shell.trim().is_empty()
        && matches!(environment.execution_scope.as_str(), "workspace" | "host")
        && environment.interactive == environment.terminal
        && environment.path_source == "hostPlusStandardDeveloperPaths"
        && if environment.execution_scope == "host" {
            environment.write_scope == "hostUser"
                && environment.home_writable
                && environment.network_access
        } else {
            matches!(
                environment.write_scope.as_str(),
                "kernelTemporaryOnly" | "workspaceAndKernelTemporary"
            ) && !environment.home_writable
                && !environment.network_access
        }
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
        let mut value = json!({
            "schemaVersion": SESSION_PROJECTION_VERSION,
            "sessionId": "session:test",
            "revision": 8,
            "display": { "creationTitle": "测试" },
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
                    "filesystemReferences": [],
                    "pluginSelections": [],
                    "feedback": null,
                    "sequence": 1,
                    "createdAt": "2026-08-25T00:00:00.000Z"
                },
                {
                    "messageId": "message:answer",
                    "runId": "run:test",
                    "providerRequestId": "provider-request:test",
                    "role": "assistant",
                    "content": "分析完成",
                    "filesystemReferences": [],
                    "pluginSelections": [],
                    "feedback": "up",
                    "sequence": 8,
                    "createdAt": "2026-08-25T00:00:07.000Z"
                }
            ],
            "narratives": [],
            "assistantDraft": null,
            "pendingInteraction": null,
            "pendingApproval": null,
            "plans": [{
                "planId": "plan:test",
                "revision": 1,
                "runId": "run:test",
                "callId": "call:plan",
                "title": "分析项目",
                "summary": "读取入口并形成结论。",
                "steps": [{
                    "stepId": "step:read",
                    "title": "读取入口",
                    "details": "读取 README。"
                }],
                "mutationManifest": [],
                "status": "completed",
                "decisionId": "decision:plan",
                "sequence": 2,
                "createdAt": "2026-08-25T00:00:01.000Z",
                "updatedAt": "2026-08-25T00:00:06.000Z"
            }],
            "activePlanRef": null,
            "pendingPlan": null,
            "todoList": {
                "sourcePlanId": "plan:test",
                "sourcePlanRevision": 1,
                "items": [{
                    "todoId": "todo:read",
                    "sourceStepId": "step:read",
                    "label": "读取入口",
                    "status": "completed"
                }],
                "sequence": 3,
                "updatedAt": "2026-08-25T00:00:00.000Z"
            },
            "contextUsage": {
                "providerRequestId": "provider-request:test",
                "providerRuntimeRef": "provider-runtime:test",
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
                "purpose": "agent",
                "runId": "run:test",
                "responseConstraint": "normal",
                "stableCoreHash": "context-hash-v1:0000000000000001",
                "baseToolSchemaHash": "context-hash-v1:0000000000000002",
                "selectedPluginSnapshotHash": "context-hash-v1:0000000000000003",
                "dynamicInstructionBytes": 128,
                "messages": [{
                    "messageIndex": 0,
                    "contributionId": "instruction:agent",
                    "contributionKind": "instructions",
                    "label": "deepcode.coding-agent",
                    "role": "system",
                    "blocks": [{ "blockIndex": 0, "kind": "text" }],
                    "filesystemReferences": []
                }],
                "workspaceBindings": [{ "itemId": "workspace:test", "label": "Test" }],
                "tools": [{
                    "itemId": "fs.read",
                    "label": "fs_read",
                    "canonicalName": "fs.read",
                    "wireName": "fs_read",
                    "origin": "coreBuiltin",
                    "availability": "callable"
                }],
                "partitions": [
                    { "kind": "instructions", "itemCount": 1, "requestShapeUnits": 30,
                      "estimatedInputTokens": 30, "tokenSource": "sessionEstimated" },
                    { "kind": "sessionControls", "itemCount": 3, "requestShapeUnits": 20,
                      "estimatedInputTokens": 20, "tokenSource": "sessionEstimated" },
                    { "kind": "tools", "itemCount": 1, "requestShapeUnits": 10,
                      "estimatedInputTokens": 10, "tokenSource": "sessionEstimated" },
                    { "kind": "workspaceBindings", "itemCount": 1, "requestShapeUnits": 8,
                      "estimatedInputTokens": 8, "tokenSource": "sessionEstimated" },
                    { "kind": "contextProviders", "itemCount": 0, "requestShapeUnits": 0,
                      "estimatedInputTokens": 0, "tokenSource": "sessionEstimated" },
                    { "kind": "journalMessages", "itemCount": 1, "requestShapeUnits": 10,
                      "estimatedInputTokens": 10, "tokenSource": "sessionEstimated" },
                    { "kind": "filesystemReferences", "itemCount": 0, "requestShapeUnits": 2,
                      "estimatedInputTokens": 2, "tokenSource": "sessionEstimated" }
                ],
                "sequence": 4,
                "createdAt": "2026-08-25T00:00:03.000Z"
            }],
            "tokenUsage": {
                "providerCallCount": 1,
                "reportedCallCount": 1,
                "inputTokens": 80,
                "outputTokens": 10,
                "cacheReadInputTokens": 50,
                "cacheMissInputTokens": 30,
                "cacheAvailable": true,
                "cacheComplete": true,
                "cacheHitRatio": 0.625
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
                "reportedCallCount": 1,
                "inputTokens": 80,
                "outputTokens": 10,
                "cacheReadInputTokens": 50,
                "cacheMissInputTokens": 30,
                "cacheAvailable": true,
                "cacheComplete": true,
                "cacheHitRatio": 0.625
            }],
            "run": {
                "runId": "run:test",
                "profileId": "profile:test",
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
        });
        value["timeline"] = json!([
            {
                "kind": "message",
                "timelineId": "message:message:input",
                "sequence": 1,
                "messageId": "message:input"
            },
            {
                "kind": "plan",
                "timelineId": "provider-turn:provider-request:test:plan:call:plan",
                "sequence": 2,
                "providerRequestId": "provider-request:test",
                "planId": "plan:test",
                "revision": 1
            },
            {
                "kind": "toolGroup",
                "timelineId": "provider-turn:provider-request:test:tools",
                "sequence": 6,
                "providerRequestId": "provider-request:test",
                "activityIds": ["tool:read"]
            },
            {
                "kind": "message",
                "timelineId": "message:message:answer",
                "sequence": 8,
                "messageId": "message:answer"
            }
        ]);
        value
    }

    #[test]
    fn validates_shared_identity_cache_and_activity_facts() {
        let projection: SessionProjection =
            serde_json::from_value(projection_value()).expect("projection decodes");
        assert_eq!(projection.validate(), Ok(()));
        assert_eq!(
            projection.messages[1].provider_request_id.as_deref(),
            Some("provider-request:test")
        );
        assert_eq!(projection.token_usage.cache_hit_ratio, Some(0.625));
        assert!(projection.token_usage.cache_complete);
        assert_eq!(
            projection.activities[0].call_id.as_deref(),
            Some("call:read")
        );
    }

    #[test]
    fn directory_reference_command_omits_file_only_metadata() {
        let reference = FilesystemReference {
            reference_id: "reference:directory".to_string(),
            workspace_id: "workspace:directory".to_string(),
            logical_path: ".".to_string(),
            display_name: "Fixture directory".to_string(),
            kind: "directory".to_string(),
            media_type: None,
            byte_length: None,
        };
        let command = message_command_with_profile_and_plugins(
            "session:test",
            "command:test",
            "Inspect directory",
            None,
            &[reference],
            "plugin-catalog:test",
            &[],
        );
        let encoded = command["filesystemReferences"][0]
            .as_object()
            .expect("serialized directory reference");
        assert_eq!(encoded.len(), 5);
        assert!(!encoded.contains_key("mediaType"));
        assert!(!encoded.contains_key("byteLength"));
    }

    #[test]
    fn directory_reference_rejects_file_only_fields_even_when_null() {
        let result = serde_json::from_value::<FilesystemReference>(json!({
            "referenceId": "reference:directory",
            "workspaceId": "workspace:directory",
            "logicalPath": ".",
            "displayName": "Fixture directory",
            "kind": "directory",
            "mediaType": null,
            "byteLength": null,
        }));
        assert!(result.is_err());
    }

    #[test]
    fn validates_canonical_shell_command_and_result_projection() {
        let mut value = projection_value();
        value["activities"][0]["label"] = json!("bash");
        value["activities"][0]["tool"] = json!({
            "operation": "bash",
            "resources": [{
                "kind": "workspacePath",
                "label": ".",
                "workspaceId": "workspace:test",
                "logicalPath": "."
            }],
            "shell": {
                "command": "make build",
                "cwd": ".",
                "executionScope": "workspace",
                "terminal": false,
                "result": {
                    "stdout": "built\n",
                    "stderr": "",
                    "exitCode": 0,
                    "success": true,
                    "timedOut": false,
                    "truncated": false,
                    "capturedBytes": 6,
                    "durationMs": 420,
                    "environment": {
                        "shell": "/bin/sh",
                        "interactive": false,
                        "executionScope": "workspace",
                        "terminal": false,
                        "pathSource": "hostPlusStandardDeveloperPaths",
                        "writeScope": "workspaceAndKernelTemporary",
                        "homeWritable": false,
                        "networkAccess": false
                    }
                }
            }
        });
        let projection: SessionProjection =
            serde_json::from_value(value.clone()).expect("shell projection decodes");
        assert_eq!(projection.validate(), Ok(()));
        assert_eq!(
            projection.activities[0]
                .tool
                .as_ref()
                .and_then(|tool| tool.shell.as_ref())
                .map(|shell| shell.command.as_str()),
            Some("make build")
        );

        value["activities"][0]["tool"]["shell"]["result"]["environment"]["writeScope"] =
            json!("kernelTemporaryOnly");
        let read_projection: SessionProjection =
            serde_json::from_value(value.clone()).expect("read shell projection decodes");
        assert_eq!(read_projection.validate(), Ok(()));

        value["activities"][0]["tool"]["shell"]["executionScope"] = json!("host");
        value["activities"][0]["tool"]["shell"]["result"]["environment"]["executionScope"] =
            json!("host");
        value["activities"][0]["tool"]["shell"]["result"]["environment"]["writeScope"] =
            json!("hostUser");
        value["activities"][0]["tool"]["shell"]["result"]["environment"]["homeWritable"] =
            json!(true);
        value["activities"][0]["tool"]["shell"]["result"]["environment"]["networkAccess"] =
            json!(true);
        let host_projection: SessionProjection =
            serde_json::from_value(value.clone()).expect("host shell projection decodes");
        assert_eq!(host_projection.validate(), Ok(()));

        value["activities"][0]["tool"]["shell"]["result"]["environment"]["writeScope"] =
            json!("unexpectedScope");
        let invalid_projection: SessionProjection =
            serde_json::from_value(value).expect("invalid shell projection still decodes");
        assert!(invalid_projection.validate().is_err());
    }

    #[test]
    fn rejects_cache_aggregate_that_disagrees_with_counters() {
        let mut value = projection_value();
        value["tokenUsage"]["cacheHitRatio"] = json!(0.5);
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
}
