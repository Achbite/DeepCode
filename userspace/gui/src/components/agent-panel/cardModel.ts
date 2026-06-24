import type { CardStatus } from './cardStatus';
import { normalizeCardStatus } from './cardStatus';

/**
 * cardModel：GUI 类型化卡片模型基座（B1 §12.2）。
 *
 * 目标是在 `AgentEvent.payload: unknown` 之上引入一层类型化卡片模型，
 * 由投影逐步把事件解析为判别联合（discriminated union），供各卡片组件消费，
 * 替代散落的 stringField 防御取值。本文件先定义类型与最小投影 helper，
 * 后续按 B1 §12.5 P3 逐卡迁移；不调用 Kernel、不裁决、不改事实。
 */

export type CardKind =
  | 'message'
  | 'thinking'
  | 'tool'
  | 'diff'
  | 'command'
  | 'search'
  | 'plan'
  | 'review'
  | 'permission'
  | 'requirement'
  | 'workMeta'
  | 'error';

export interface CardBase {
  card: CardKind;
  id: string;
  status: CardStatus;
  title: string;
}

/** 单个文件的差异片段。 */
export interface DiffFile {
  path: string;
  patch: string;
  truncated?: boolean;
}

export interface DiffCardModel extends CardBase {
  card: 'diff';
  files: DiffFile[];
  /** 聚合统计；缺省时由 DiffCard 从 patch 现算。 */
  totals?: { filesChanged: number; added: number; removed: number };
}

export interface ToolCardModel extends CardBase {
  card: 'tool';
  callId?: string;
  toolName: string;
  argsSummary?: string;
  durationMs?: number;
  output?: string;
  riskLevel?: string;
}

export interface WorkMetaCardModel extends CardBase {
  card: 'workMeta';
  stepCount: number;
  durationMs?: number;
}

export type CardModel =
  | DiffCardModel
  | ToolCardModel
  | WorkMetaCardModel;

// ---- 把 protocol AgentChangeSet 风格的 operations 投影为 DiffFile[] ----
export function diffFilesFromOperations(
  operations: ReadonlyArray<{ filePath?: string; path?: string; diff?: string; truncated?: boolean }>,
): DiffFile[] {
  const files: DiffFile[] = [];
  for (const op of operations) {
    const path = op.filePath ?? op.path;
    if (!path || typeof op.diff !== 'string' || !op.diff.trim()) continue;
    files.push({ path, patch: op.diff, truncated: op.truncated });
  }
  return files;
}

/**
 * ToolCardView：工具卡的类型化视图（P3 迁移，G1）。
 * 把 `tool_call/tool_result/permission_*` 事件的 `payload: unknown` 一次性解析为强类型字段，
 * 让 ToolCallBubble 不再散落 stringField 取值。不做 i18n、不裁决，纯数据投影。
 */
export interface ToolCardView {
  toolName: string;
  command?: string;
  path?: string;
  status: CardStatus;
  rawStatus?: string;
  output?: string;
  callId?: string;
  riskLevel?: string;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function nested(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return isRecordValue(record[key]) ? (record[key] as Record<string, unknown>) : undefined;
}

export function projectToolCard(event: { kind: string; payload: unknown }): ToolCardView {
  const payload = isRecordValue(event.payload) ? event.payload : {};
  const toolCall = nested(payload, 'toolCall');
  const args =
    nested(payload, 'arguments') ??
    (toolCall ? nested(toolCall, 'arguments') : undefined) ??
    nested(payload, 'input') ??
    nested(payload, 'argumentsPreview') ??
    nested(payload, 'output') ??
    payload;

  const toolName =
    stringField(payload, 'toolName') ??
    stringField(payload, 'name') ??
    (toolCall ? stringField(toolCall, 'name') : undefined) ??
    stringField(payload, 'actionType') ??
    'tool';

  const rawStatus =
    typeof payload.ok === 'boolean'
      ? payload.ok
        ? 'ok'
        : 'error'
      : stringField(payload, 'status') ?? stringField(payload, 'decision');

  const fallback: CardStatus =
    event.kind === 'tool_call' ? 'running' : event.kind === 'permission_request' ? 'waiting' : 'completed';

  const output = nested(payload, 'output');
  const outputText = [
    output ? stringField(output, 'stdout') : undefined,
    output ? stringField(output, 'stderr') : undefined,
    stringField(payload, 'error'),
    stringField(payload, 'summary'),
    stringField(payload, 'message'),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();

  return {
    toolName,
    command: stringField(args, 'command') ?? stringField(payload, 'command'),
    path: stringField(args, 'path') ?? stringField(args, 'cwd') ?? stringField(payload, 'path'),
    status: normalizeCardStatus(rawStatus, fallback),
    rawStatus,
    output: outputText || undefined,
    callId: stringField(payload, 'callId') ?? stringField(payload, 'id'),
    riskLevel: stringField(payload, 'riskLevel'),
  };
}
