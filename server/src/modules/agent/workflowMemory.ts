import type { AgentEvent, AgentWorkflowStage } from '@deepcode/protocol';

export type WorkflowAnswerObligationId =
  | 'identity'
  | 'toolComponentSummary'
  | 'tempFileLifecycleResult';

export interface WorkflowAnswerObligation {
  id: WorkflowAnswerObligationId;
  description: string;
  status: 'pending' | 'satisfied';
  satisfiedByStage?: AgentWorkflowStage;
}

export interface WorkflowMemorySegment {
  kind: 'reasoning' | 'say' | 'plan' | 'observe' | 'final';
  content: string;
}

interface TempFileLifecycleState {
  required: boolean;
  workspaceListed: boolean;
  created: boolean;
  readBack: boolean;
  cleanupRequested: boolean;
  cleaned: boolean;
}

export interface WorkflowStageMemory {
  answerObligations: WorkflowAnswerObligation[];
  stageSummaries: Partial<Record<AgentWorkflowStage, string>>;
  executedTools: string[];
  toolResults: string[];
  pendingSteps: string[];
  blockedReason?: string;
  tempFileLifecycle: TempFileLifecycleState;
}

const TEMP_FILE_PATTERN = /(?:^|[/\\\s])_agent_tmp_[^/\\\s'"]*/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function preview(value: unknown, limit = 180): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function summarize(text: string, limit = 360): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function obligation(
  id: WorkflowAnswerObligationId,
  description: string
): WorkflowAnswerObligation {
  return { id, description, status: 'pending' };
}

function hasIdentityRequest(content: string): boolean {
  return /身份|你是谁|你的身份|identity|who are you/i.test(content);
}

function hasToolComponentSummaryRequest(content: string): boolean {
  return /功能组件|所有.*组件|action\s*type|工具组件|可用.*工具/i.test(content);
}

function hasTempFileLifecycleRequest(content: string): boolean {
  return /临时文件|读写.*删除|新建.*读.*删|创建.*读取.*删除|temp(?:orary)? file/i.test(content);
}

function markSatisfied(
  memory: WorkflowStageMemory,
  id: WorkflowAnswerObligationId,
  stage: AgentWorkflowStage
): void {
  const item = memory.answerObligations.find((entry) => entry.id === id);
  if (!item || item.status === 'satisfied') return;
  item.status = 'satisfied';
  item.satisfiedByStage = stage;
}

function toolCallFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.toolCall) ? payload.toolCall : payload;
}

function toolArgumentsFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const toolCall = toolCallFromPayload(payload);
  return isRecord(toolCall.arguments) ? toolCall.arguments : {};
}

function outputFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload.output) ? payload.output : {};
}

function toolNameFromPayload(payload: Record<string, unknown>): string {
  const toolCall = toolCallFromPayload(payload);
  return preview(payload.toolName ?? payload.name ?? toolCall.name ?? 'tool', 120);
}

function pathFromRecord(record: Record<string, unknown>): string {
  return typeof record.path === 'string' ? record.path : '';
}

function commandFromRecord(record: Record<string, unknown>): string {
  return typeof record.command === 'string' ? record.command : '';
}

function isTempFilePath(value: string): boolean {
  return TEMP_FILE_PATTERN.test(value);
}

function recomputePendingSteps(memory: WorkflowStageMemory): void {
  const pending: string[] = [];
  if (memory.tempFileLifecycle.required) {
    if (!memory.tempFileLifecycle.workspaceListed) {
      pending.push('列出工作区根目录');
    }
    if (!memory.tempFileLifecycle.created) {
      pending.push('创建工作区相对路径 _agent_tmp_* 临时文件');
    }
    if (!memory.tempFileLifecycle.readBack) {
      pending.push('读取临时文件并验证内容');
    }
    if (!memory.tempFileLifecycle.cleaned) {
      pending.push('通过受控 shell.exec 精确删除临时文件并确认无残留');
    }
  }
  memory.pendingSteps = pending;
}

export function createWorkflowStageMemory(userContent: string): WorkflowStageMemory {
  const answerObligations: WorkflowAnswerObligation[] = [];
  if (hasIdentityRequest(userContent)) {
    answerObligations.push(obligation('identity', '在最终回复中回答 Agent 身份信息一次'));
  }
  if (hasToolComponentSummaryRequest(userContent)) {
    answerObligations.push(obligation('toolComponentSummary', '在最终回复中总结已测试的功能组件'));
  }
  if (hasTempFileLifecycleRequest(userContent)) {
    answerObligations.push(obligation('tempFileLifecycleResult', '在最终回复中报告临时文件创建、读取验证、删除结果'));
  }

  const memory: WorkflowStageMemory = {
    answerObligations,
    stageSummaries: {},
    executedTools: [],
    toolResults: [],
    pendingSteps: [],
    tempFileLifecycle: {
      required: hasTempFileLifecycleRequest(userContent),
      workspaceListed: false,
      created: false,
      readBack: false,
      cleanupRequested: false,
      cleaned: false,
    },
  };
  recomputePendingSteps(memory);
  return memory;
}

export function updateWorkflowStageMemoryFromSegments(
  memory: WorkflowStageMemory,
  stage: AgentWorkflowStage,
  segments: WorkflowMemorySegment[]
): void {
  const visibleText = segments
    .filter((segment) => segment.kind !== 'reasoning')
    .map((segment) => segment.content)
    .filter(Boolean)
    .join('\n');
  if (visibleText.trim()) {
    memory.stageSummaries[stage] = summarize(visibleText);
  }

  for (const segment of segments) {
    const content = segment.content;
    if (/我是\s*\*\*?DeepCode Agent|我是\s+DeepCode Agent|DeepCode Agent.*本地/i.test(content)) {
      markSatisfied(memory, 'identity', stage);
    }
    if (segment.kind === 'final' && /fs\.read|fs\.list|fs\.write|shell\.exec|code\.search/.test(content)) {
      markSatisfied(memory, 'toolComponentSummary', stage);
    }
    if (
      segment.kind === 'final' &&
      /临时文件/.test(content) &&
      /创建|写入/.test(content) &&
      /读取/.test(content) &&
      /删除|清理/.test(content)
    ) {
      markSatisfied(memory, 'tempFileLifecycleResult', stage);
    }
  }
}

export function updateWorkflowStageMemoryFromToolEvents(
  memory: WorkflowStageMemory,
  events: AgentEvent[]
): void {
  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    const payload = event.payload;
    if (event.kind === 'tool_call') {
      const name = toolNameFromPayload(payload);
      const args = toolArgumentsFromPayload(payload);
      const path = pathFromRecord(args);
      const command = commandFromRecord(args);
      memory.executedTools.push(`${name}${path ? ` ${path}` : ''}${command ? ` ${preview(command, 120)}` : ''}`);
      if (name === 'shell.exec' && isTempFilePath(command) && /\brm\b|del\b|Remove-Item/i.test(command)) {
        memory.tempFileLifecycle.cleanupRequested = true;
      }
      continue;
    }

    if (event.kind === 'tool_result') {
      const name = toolNameFromPayload(payload);
      const ok = payload.ok === true;
      const status = ok ? 'ok' : preview(payload.status ?? 'error', 80);
      const output = outputFromPayload(payload);
      const path = pathFromRecord(output);
      const error = typeof payload.error === 'string' ? payload.error : '';
      memory.toolResults.push(`${name} ${status}${path ? ` ${path}` : ''}${error ? ` ${preview(error, 140)}` : ''}`);

      if (!ok) {
        memory.blockedReason = error || `${name} 执行失败`;
        continue;
      }
      if (name === 'fs.list') memory.tempFileLifecycle.workspaceListed = true;
      if (name === 'fs.write' && isTempFilePath(path)) memory.tempFileLifecycle.created = true;
      if (name === 'fs.read' && isTempFilePath(path)) memory.tempFileLifecycle.readBack = true;
      if (name === 'shell.exec' && memory.tempFileLifecycle.cleanupRequested) {
        memory.tempFileLifecycle.cleaned = true;
      }
      continue;
    }

    if (event.kind === 'permission_request') {
      memory.blockedReason = `等待 ${toolNameFromPayload(payload)} 权限确认`;
    }
  }
  recomputePendingSteps(memory);
}

export function formatWorkflowStageMemory(memory: WorkflowStageMemory): string {
  const lines: string[] = [
    '[Structured workflow memory]',
    'Use this structured state instead of repeating prior assistant prose.',
    'Do not repeat satisfied answer obligations in later user-visible messages.',
    'Current tool catalog does not include fs.delete; temp cleanup must use exact workspace-scoped shell.exec when approved.',
  ];

  if (memory.answerObligations.length > 0) {
    lines.push('Answer obligations:');
    for (const item of memory.answerObligations) {
      lines.push(`- ${item.id}: ${item.status}${item.satisfiedByStage ? ` by ${item.satisfiedByStage}` : ''}; ${item.description}`);
    }
  }

  const stageEntries = Object.entries(memory.stageSummaries);
  if (stageEntries.length > 0) {
    lines.push('Stage summaries:');
    for (const [stage, summary] of stageEntries) {
      lines.push(`- ${stage}: ${summary}`);
    }
  }

  if (memory.executedTools.length > 0) {
    lines.push('Executed tools:');
    for (const item of memory.executedTools.slice(-12)) lines.push(`- ${item}`);
  }
  if (memory.toolResults.length > 0) {
    lines.push('Tool results:');
    for (const item of memory.toolResults.slice(-12)) lines.push(`- ${item}`);
  }
  if (memory.pendingSteps.length > 0) {
    lines.push('Pending critical steps:');
    for (const item of memory.pendingSteps) lines.push(`- ${item}`);
  }
  if (memory.blockedReason) {
    lines.push(`Blocked reason: ${memory.blockedReason}`);
  }
  return lines.join('\n');
}

export function pendingCriticalWorkflowSummary(memory: WorkflowStageMemory): string | undefined {
  if (memory.pendingSteps.length === 0) return undefined;
  if (!memory.tempFileLifecycle.required) return undefined;
  return `测试未完成：${memory.pendingSteps.join('、')}。当前不能报告临时文件读写删除已成功。`;
}

export function guardFinalAnswerForPendingObligations(
  memory: WorkflowStageMemory,
  candidate: string
): string {
  const pendingSummary = pendingCriticalWorkflowSummary(memory);
  if (!pendingSummary) return candidate;

  const identity = memory.answerObligations.some(
    (item) => item.id === 'identity' && item.status === 'pending'
  )
    ? '我是 DeepCode Agent，一个运行在本地并受权限门控约束的编码代理。'
    : '';
  const blocked = memory.blockedReason ? `阻塞原因：${memory.blockedReason}。` : '';
  return [identity, pendingSummary, blocked, '需要继续执行剩余工具步骤，或等待权限确认后再进入最终复核。']
    .filter(Boolean)
    .join('\n\n');
}
