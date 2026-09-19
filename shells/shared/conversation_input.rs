//! Input decisions shared by the CLI and TUI; Session remains the command owner.
use crate::i18n::Language;
use deepcode_kernel_client::{
    approval_response_command, focus_command, interaction_response_command,
    message_command_with_profile_and_plugins, plan_confirm_command, plan_revision_command,
    FilesystemReference, InteractionProjection, PluginSelectionInput, SessionProjection,
};
use serde_json::json;

pub fn contextual_input_command(
    language: Language,
    projection: &SessionProjection,
    text: &str,
    command_id: &str,
    profile_id: Option<&str>,
    filesystem_references: &[FilesystemReference],
    catalog_revision: &str,
    selections: &[PluginSelectionInput],
) -> Result<serde_json::Value, String> {
    let original_text = text;
    let text = text.trim();
    if text.is_empty() {
        return Err(language.text("tui.emptyInput").to_string());
    }
    if text == "/reply" || text.starts_with("/reply ") {
        let response = text.strip_prefix("/reply").unwrap().trim();
        if response.is_empty() {
            return Err(language.text("tui.replyUsage").to_string());
        }
        if !selections.is_empty() || !filesystem_references.is_empty() {
            return Err(language.text("tui.replyReferencesUnsupported").to_string());
        }
        if let Some(approval) = projection.pending_approval.as_ref() {
            let decision = approval_decision_for_input(language, response)?;
            if decision == "allow-run"
                && approval.preview.authorization_scope.as_deref() != Some("runHostShell")
            {
                return Err(language.text("tui.runAuthorizationUnavailable").into());
            }
            return Ok(approval_response_command(
                &projection.session_id,
                command_id,
                approval,
                decision,
            ));
        }
        if let Some(plan) = projection.pending_plan.as_ref() {
            if is_plan_confirmation_input(response) {
                return Ok(plan_confirm_command(
                    &projection.session_id,
                    command_id,
                    plan,
                ));
            }
            return Ok(plan_revision_command(
                &projection.session_id,
                command_id,
                plan,
                response,
            ));
        }
        if let Some(interaction) = projection.pending_interaction.as_ref() {
            let response = interaction_response_for_input(interaction, response);
            return Ok(interaction_response_command(
                &projection.session_id,
                command_id,
                interaction,
                &response,
            ));
        }
        return Err(language.text("tui.noPendingReply").to_string());
    }
    let profile_id = if projection
        .run
        .as_ref()
        .is_some_and(|run| matches!(run.status.as_str(), "running" | "waiting"))
    {
        None
    } else {
        profile_id
    };
    if let Some(task) = text.strip_prefix("/focus") {
        if !task.is_empty() && !task.chars().next().is_some_and(char::is_whitespace) {
            return Err(language.text("tui.focusSeparator").to_string());
        }
        let task = task.trim();
        if task.is_empty() {
            return Err(language.text("tui.focusRequired").to_string());
        }
        return Ok(focus_command(
            &projection.session_id,
            command_id,
            task,
            profile_id,
            filesystem_references,
            catalog_revision,
            selections,
        ));
    }
    if text.starts_with('/') {
        return Err(language.format("tui.unknownInputCommand", &[format!("{}", text)]));
    }
    let mut command = message_command_with_profile_and_plugins(
        &projection.session_id,
        command_id,
        original_text,
        profile_id,
        filesystem_references,
        catalog_revision,
        selections,
    );
    if let Some(run) = projection
        .run
        .as_ref()
        .filter(|run| matches!(run.status.as_str(), "running" | "waiting"))
    {
        command["runId"] = json!(run.run_id);
    }
    Ok(command)
}

fn approval_decision_for_input(language: Language, input: &str) -> Result<&'static str, String> {
    match input.trim().to_lowercase().as_str() {
        "1" | "allow" | "允许" | "同意" => Ok("allow"),
        "2" | "deny" | "拒绝" | "不同意" => Ok("deny"),
        "3" | "allow-run" | "允许本轮" => Ok("allow-run"),
        _ => Err(language.text("tui.approvalReplyRequired").to_string()),
    }
}

fn interaction_response_for_input(interaction: &InteractionProjection, input: &str) -> String {
    input
        .parse::<usize>()
        .ok()
        .and_then(|index| index.checked_sub(1))
        .and_then(|index| interaction.options.as_ref()?.get(index))
        .map(|option| option.label.clone())
        .unwrap_or_else(|| input.to_string())
}

fn is_plan_confirmation_input(input: &str) -> bool {
    matches!(
        input.trim().to_ascii_lowercase().as_str(),
        "1" | "y" | "yes" | "confirm"
    ) || matches!(input.trim(), "确认" | "同意")
}
