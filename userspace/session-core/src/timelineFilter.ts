/**
 * P5 共享渲染过滤规则：消除 live/final 两套独立过滤实现的漂移隐患。
 *
 * live overlay 会先被转换为临时 AgentEvent，再走 narrative projection。
 * 本模块只保留结构化事实级过滤规则，确保 live 与 final 对同批事实的"是否显示"判定一致。
 */

// 不应单独成块的纯编排/调度生命周期事件 stage / kernelEvent.kind 集合。
// 注意：不含 work_unit.* 与 tool.* —— 它们携带文件/命令事实，由工具卡呈现。
const INTERNAL_ORCHESTRATION_STAGES = new Set<string>([
  'state.entered',
  'state.changed',
  'driver.request_produced',
  'proposal.reviewed',
  'proposal.accepted',
  'action_batch.accepted',
  'needProposal',
  'autonomy.transitioned',
  'message.appended',
]);

// 这些工具的 toolExecution 只是 Provider / native 内部前置步骤，其真正结果会以专属活动呈现
// （读 → resourceRead/resourceSearch，写 → editFile*），故在 live 时间线抑制其 toolExecution。
// 保留 process.exec/git/network/web 等无专属结果活动的 toolExecution。
const REDUNDANT_PRE_TOOL_EXECUTION = new Set<string>([
  'fs.read',
  'fs.list',
  'fs.diff',
  'code.search',
  'fs.write',
  'fs.patch',
  'fs.delete',
]);

// 元噪声活动 kind：providerThinking 只表示模型等待状态，不在主时间线重复成块。
const SUPPRESSED_ACTIVITY_KINDS = new Set<string>([
  'providerThinking',
]);

/**
 * 判断一个 workflow_stage 事件是否属于"纯编排生命周期"——final 路径调用此函数过滤。
 * 输入参数采用解构而非完整 AgentEvent，避免 session-core 引用 GUI 的运行时投影类型。
 */
export function isInternalOrchestrationStage(input: { stage?: string; kernelEventKind?: string }): boolean {
  if (input.stage && isProviderLifecycleStage(input.stage)) return true;
  if (input.stage && INTERNAL_ORCHESTRATION_STAGES.has(input.stage)) return true;
  if (input.kernelEventKind && INTERNAL_ORCHESTRATION_STAGES.has(input.kernelEventKind)) return true;
  return false;
}

function isProviderLifecycleStage(stage: string): boolean {
  return stage === 'provider_call' ||
    stage === 'accepted_plan_provider_call' ||
    stage.startsWith('provider_tool_resume_');
}

/**
 * 判断一个 AgentConversationActivity 是否属于"应隐藏的元噪声/冗余前置"——live 路径调用此函数过滤。
 * 接收 activity.kind 与可选 toolName；与 AgentConversationActivity 解耦，便于上游传入裁剪后的字段。
 */
export function isSuppressedActivityKind(kind: string): boolean {
  return SUPPRESSED_ACTIVITY_KINDS.has(kind);
}

export function isRedundantPreToolExecution(activityKind: string, toolName: string | undefined): boolean {
  return activityKind === 'toolExecution' && Boolean(toolName) && REDUNDANT_PRE_TOOL_EXECUTION.has(toolName!);
}

/**
 * 合并判定：用 activity.kind + activity.toolName 判断该活动是否应进入主时间线。
 * 返回 true 表示应该显示；false 表示应该过滤。
 */
export function isMainTimelineActivityShape(activity: { kind: string; toolName?: string }): boolean {
  if (isSuppressedActivityKind(activity.kind)) return false;
  if (isRedundantPreToolExecution(activity.kind, activity.toolName)) return false;
  return true;
}
