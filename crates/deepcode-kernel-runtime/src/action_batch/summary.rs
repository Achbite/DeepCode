use deepcode_kernel_abi::{
    KernelAction, KernelActionBatch, KernelActionBatchSummary, KernelActionSummary,
    KernelContentBlock, KernelContentBlockSummary,
};

pub(super) fn summarize_action_batch(batch: &KernelActionBatch) -> KernelActionBatchSummary {
    KernelActionBatchSummary {
        plan_id: batch.plan_id.clone(),
        action_bundle_id: batch.action_bundle.id.clone(),
        goal: batch.action_bundle.goal.clone(),
        action_count: batch.action_bundle.actions.len(),
        actions: batch
            .action_bundle
            .actions
            .iter()
            .map(summarize_action)
            .collect(),
        content_blocks: batch
            .content_blocks
            .iter()
            .map(summarize_content_block)
            .collect(),
    }
}

pub(super) fn summarize_action(action: &KernelAction) -> KernelActionSummary {
    KernelActionSummary {
        action_id: action.action_id.clone(),
        tool_id: action.tool_id.clone(),
        description: action.description.clone(),
        args: action.args.clone(),
        depends_on: action.depends_on.clone(),
    }
}

pub(super) fn summarize_content_block(block: &KernelContentBlock) -> KernelContentBlockSummary {
    let content = block.content_lines.join("\n");
    KernelContentBlockSummary {
        block_id: block.block_id.clone(),
        target_path: block.target_path.clone(),
        language: block.language.clone(),
        operation: block.operation,
        content_bytes: content.len(),
        content_hash: deepcode_kernel_tools::hash_bytes(content.as_bytes()),
    }
}

pub(crate) fn safe_work_unit_segment(value: &str) -> String {
    let mut out = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(80).collect::<String>()
}
