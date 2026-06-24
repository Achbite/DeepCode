import type { AgentEvent } from '@deepcode/protocol';
import { t, type UiLanguage } from '../i18n';

export type ToolEvidenceStatus = 'running' | 'completed' | 'failed' | 'waiting';
export type ToolEvidenceItemKind = 'file' | 'directory' | 'command' | 'search' | 'tool';

export interface ToolEvidenceItem {
  id: string;
  kind: ToolEvidenceItemKind;
  action: string;
  label: string;
  detail?: string;
  preview?: string;
  matches?: string[];
  status: ToolEvidenceStatus;
  exitCode?: number | null;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs?: number;
  truncated?: boolean;
}

export interface ToolEvidenceSummary {
  title: string;
  summary?: string;
  status: ToolEvidenceStatus;
  items: ToolEvidenceItem[];
}

interface FormatOptions {
  fallbackTitle?: string;
  fallbackSummary?: string;
}

export function formatToolEvidence(
  events: AgentEvent[],
  language: UiLanguage,
  options: FormatOptions = {}
): ToolEvidenceSummary {
  const resultCallIds = new Set(
    events
      .filter((event) => event.kind === 'tool_result')
      .map((event) => eventCallId(event))
      .filter((id): id is string => Boolean(id))
  );
  const items: ToolEvidenceItem[] = [];

  // 先收集 workflow_stage 携带的文件活动（editFileStarted/editFileCompleted/toolExecution 等），
  // 这些是 Kernel 执行文件读写时的真实事件来源，但不以 tool_call/tool_result 形态出现。
  items.push(...collectActivityItems(events, language));

  events.forEach((event) => {
    if (event.kind !== 'tool_call' && event.kind !== 'tool_result') return;
    if (event.kind === 'tool_call') {
      const callId = eventCallId(event);
      if (callId && resultCallIds.has(callId)) return;
    }
    items.push(...itemsForEvent(event, language));
  });

  const dedupedItems = dedupeItems(items);
  return {
    title: evidenceTitle(dedupedItems, language, options.fallbackTitle),
    summary: evidenceSummary(dedupedItems, language, options.fallbackSummary),
    status: aggregateStatus(dedupedItems),
    items: dedupedItems,
  };
}

export function formatDurationMs(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

// ---- workflow_stage 文件活动识别 ----
// Kernel 执行文件读写时以 workflow_stage(activity=editFileStarted/toolExecution/editFileCompleted)
// 形态出现，而非 tool_call/tool_result；此处把同一目标的活动合并为单条读写证据。
const FILE_ACTIVITY_KINDS = new Set([
  'editFileStarted',
  'editFileCompleted',
  'editFileFailed',
  'toolExecution',
  'resourceRead',
  'resourceSearch',
]);

function activityRecord(event: AgentEvent): Record<string, unknown> | undefined {
  const payload = record(event.payload);
  return payload ? record(payload.activity) : undefined;
}

function pickActivityTarget(targets: string[]): string | undefined {
  if (targets.length === 0) return undefined;
  // 优先取相对路径（排除 UNC \\、盘符 X:\、\\?\ 前缀与 POSIX 绝对路径）
  const relative = targets.find(
    (value) =>
      !/^\\\\/.test(value) &&
      !/^[a-zA-Z]:[\\/]/.test(value) &&
      !value.startsWith('\\\\?\\') &&
      !value.startsWith('/'),
  );
  return readablePath(relative ?? targets[0]);
}

function activityStatusOf(activityKind: string): ToolEvidenceStatus {
  if (activityKind === 'editFileStarted') return 'running';
  if (activityKind === 'editFileFailed') return 'failed';
  return 'completed';
}

function mergeActivityStatus(prev: ToolEvidenceStatus, next: ToolEvidenceStatus): ToolEvidenceStatus {
  const rank: Record<ToolEvidenceStatus, number> = { waiting: 0, running: 1, completed: 2, failed: 3 };
  return rank[next] > rank[prev] ? next : prev;
}

function activityItemKind(toolName: string | undefined): ToolEvidenceItemKind {
  if (!toolName) return 'file';
  if (toolName.includes('search')) return 'search';
  if (toolName.includes('list')) return 'directory';
  if (toolName === 'process.exec' || toolName.includes('exec')) return 'command';
  return 'file';
}

function activityActionLabel(
  activityKind: string,
  toolName: string | undefined,
  language: UiLanguage,
): string {
  const name = toolName ?? '';
  if (name.includes('write') || activityKind === 'editFileStarted' || activityKind === 'editFileCompleted' || activityKind === 'editFileFailed') {
    return t(language, 'agent.toolEvidence.action.write');
  }
  if (name.includes('delete')) return t(language, 'agent.toolEvidence.action.delete');
  if (name.includes('search') || activityKind === 'resourceSearch') return t(language, 'agent.toolEvidence.action.search');
  if (name.includes('list')) return t(language, 'agent.toolEvidence.action.list');
  if (name.includes('read') || activityKind === 'resourceRead') return t(language, 'agent.toolEvidence.action.read');
  return t(language, 'agent.toolEvidence.action.tool');
}

function collectActivityItems(events: AgentEvent[], language: UiLanguage): ToolEvidenceItem[] {
  const byKey = new Map<string, ToolEvidenceItem>();
  for (const event of events) {
    if (event.kind !== 'workflow_stage' && event.kind !== 'workflow_decision') continue;
    const activity = activityRecord(event);
    if (!activity) continue;
    const activityKind = stringValue(activity, 'kind');
    if (!activityKind || !FILE_ACTIVITY_KINDS.has(activityKind)) continue;

    const targets = Array.isArray(activity.targets)
      ? activity.targets.filter((value): value is string => typeof value === 'string')
      : [];
    const toolName = stringValue(activity, 'toolName');
    const label = pickActivityTarget(targets) ?? stringValue(activity, 'title') ?? toolName ?? 'operation';
    const itemKind = activityItemKind(toolName);
    const key = `${itemKind}:${label}`;
    const status = activityStatusOf(activityKind);

    const existing = byKey.get(key);
    if (existing) {
      existing.status = mergeActivityStatus(existing.status, status);
      if (toolName && !existing.detail) existing.detail = toolName;
      if (toolName && (toolName.includes('write') || toolName.includes('delete'))) {
        existing.action = activityActionLabel(activityKind, toolName, language);
      }
      continue;
    }
    byKey.set(key, {
      id: `${event.id}:activity`,
      kind: itemKind,
      action: activityActionLabel(activityKind, toolName, language),
      label,
      detail: toolName,
      status,
    });
  }
  return [...byKey.values()];
}

function itemsForEvent(event: AgentEvent, language: UiLanguage): ToolEvidenceItem[] {
  const payload = record(event.payload);
  const output = payload ? record(payload.output) : undefined;
  const args = payload ? (record(payload.arguments) ?? record(payload.input)) : undefined;
  const toolName = toolNameForEvent(event);
  const status = statusForEvent(event);

  const resourceItems = output && Array.isArray(output.items)
    ? output.items.filter(isRecord)
    : [];
  if (resourceItems.length > 0) {
    return resourceItems.map((item, index) => resourceItem(event, item, index, language, status));
  }

  if (isShellTool(toolName, output, args)) {
    const command = stringValue(output, 'command') ?? stringValue(args, 'command') ?? stringValue(payload, 'command') ?? toolName;
    const exitCode = numberValue(output, 'exitCode');
    const stdout = stringValue(output, 'stdout');
    const stderr = stringValue(output, 'stderr');
    const error = stringValue(output, 'error') ?? stringValue(payload, 'error');
    const durationMs = numberValue(output, 'durationMs');
    return [{
      id: `${event.id}:command`,
      kind: 'command',
      action: t(language, 'agent.toolEvidence.action.run'),
      label: command,
      detail: commandDetail(output, args, language),
      status: exitCode !== undefined && exitCode !== 0 ? 'failed' : status,
      exitCode,
      cwd: stringValue(output, 'cwd') ?? stringValue(args, 'cwd'),
      stdout,
      stderr,
      error,
      durationMs,
      truncated: booleanValue(output, 'truncated') ?? booleanValue(payload, 'truncated'),
    }];
  }

  const path = pathFor(payload, output, args);
  if (path) {
    const kind = pathKind(toolName, output);
    return [{
      id: `${event.id}:path`,
      kind,
      action: toolAction(toolName, kind, language),
      label: path,
      detail: pathDetail(output, language),
      status,
      error: stringValue(payload, 'error') ?? stringValue(output, 'error'),
      truncated: booleanValue(output, 'truncated') ?? booleanValue(payload, 'truncated'),
    }];
  }

  const query = stringValue(args, 'query') ?? stringValue(output, 'query');
  if (query) {
    return [{
      id: `${event.id}:search`,
      kind: 'search',
      action: t(language, 'agent.toolEvidence.action.search'),
      label: query,
      detail: stringValue(output, 'summary') ?? stringValue(payload, 'summary'),
      status,
    }];
  }

  return [{
    id: event.id,
    kind: 'tool',
    action: t(language, 'agent.toolEvidence.action.tool'),
    label: displayToolName(toolName, language),
    detail: readableToolDetail(toolName, payload),
    status,
    error: stringValue(payload, 'error'),
  }];
}

function resourceItem(
  event: AgentEvent,
  item: Record<string, unknown>,
  index: number,
  language: UiLanguage,
  status: ToolEvidenceStatus
): ToolEvidenceItem {
  const path = readablePath(stringValue(item, 'path')) ??
    readablePath(stringValue(item, 'absolutePath')) ??
    t(language, 'agent.toolEvidence.resourceLabel', { index: index + 1 });
  const resolvedKind = stringValue(item, 'resolvedKind') ?? stringValue(item, 'contentKind') ?? '';
  const directory = resolvedKind.includes('directory') || resolvedKind.includes('tree');
  const truncated = booleanValue(item, 'truncated');
  const sizeBytes = numberValue(item, 'returnedBytes') ??
    numberValue(item, 'originalBytes') ??
    numberValue(item, 'sizeBytes');
  const nodes = Array.isArray(item.nodes) ? item.nodes.length : undefined;
  const matches = readableMatches(item);
  const summary = readableSummary(item);
  const preview = readablePreview(item, matches.length > 0);
  const detailParts = [
    sizeBytes !== undefined ? formatBytes(sizeBytes) : undefined,
    nodes !== undefined ? t(language, 'agent.toolEvidence.entries', { count: nodes }) : undefined,
    matches.length > 0 ? t(language, 'agent.toolEvidence.matches', { count: matches.length }) : undefined,
    truncated ? t(language, 'common.truncated') : undefined,
    summary,
  ].filter(Boolean);

  return {
    id: `${event.id}:resource:${index}`,
    kind: directory ? 'directory' : 'file',
    action: directory
      ? t(language, 'agent.toolEvidence.action.listed')
      : t(language, 'agent.toolEvidence.action.read'),
    label: path,
    detail: detailParts.join(' · ') || undefined,
    preview,
    matches,
    status,
    truncated,
  };
}

function evidenceTitle(
  items: ToolEvidenceItem[],
  language: UiLanguage,
  fallbackTitle?: string
): string {
  if (items.length === 0) return fallbackTitle || t(language, 'agent.toolEvidence.title.empty');
  const commandCount = items.filter((item) => item.kind === 'command').length;
  if (commandCount > 0 && commandCount === items.length) {
    return t(language, 'agent.toolEvidence.title.commands', { count: commandCount });
  }
  const fileCount = items.filter((item) => item.kind === 'file').length;
  const directoryCount = items.filter((item) => item.kind === 'directory').length;
  if (fileCount > 0 && directoryCount === 0) {
    return t(language, 'agent.toolEvidence.title.files', { count: fileCount });
  }
  if (directoryCount > 0 && fileCount === 0) {
    return t(language, 'agent.toolEvidence.title.directories', { count: directoryCount });
  }
  if (fileCount + directoryCount > 0) {
    return t(language, 'agent.toolEvidence.title.resources', { count: fileCount + directoryCount });
  }
  const toolCount = items.filter((item) => item.kind === 'tool').length;
  if (toolCount > 0 && toolCount === items.length) {
    if (items.length === 1) {
      const item = items[0];
      if (item.label === t(language, 'agent.toolEvidence.toolExecution')) {
        return item.label;
      }
      return t(language, 'agent.toolEvidence.title.runLabel', { label: item.label });
    }
    return t(language, 'agent.toolEvidence.title.toolOperations', { count: items.length });
  }
  return fallbackTitle || t(language, 'agent.toolEvidence.title.operations', { count: items.length });
}

function evidenceSummary(
  items: ToolEvidenceItem[],
  language: UiLanguage,
  fallbackSummary?: string
): string | undefined {
  if (items.length === 0) return fallbackSummary;
  const failed = items.filter((item) => item.status === 'failed').length;
  if (failed > 0) {
    return t(language, 'agent.toolEvidence.summary.failed', { count: failed });
  }
  const first = items[0];
  if (items.length === 1) return first.label;
  return t(language, 'agent.toolEvidence.summary.firstAndMore', {
    label: first.label,
    count: items.length,
    more: items.length - 1,
  });
}

function aggregateStatus(items: ToolEvidenceItem[]): ToolEvidenceStatus {
  if (items.some((item) => item.status === 'failed')) return 'failed';
  if (items.some((item) => item.status === 'running')) return 'running';
  if (items.some((item) => item.status === 'waiting')) return 'waiting';
  return 'completed';
}

function dedupeItems(items: ToolEvidenceItem[]): ToolEvidenceItem[] {
  const seen = new Set<string>();
  const deduped: ToolEvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.action}:${item.label}:${item.exitCode ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function toolNameForEvent(event: AgentEvent): string {
  const payload = record(event.payload);
  const toolCall = payload ? record(payload.toolCall) : undefined;
  return stringValue(payload, 'toolName') ??
    stringValue(payload, 'name') ??
    stringValue(toolCall, 'name') ??
    stringValue(payload, 'actionType') ??
    'tool';
}

function eventCallId(event: AgentEvent): string | undefined {
  const payload = record(event.payload);
  return stringValue(payload, 'callId') ?? stringValue(payload, 'id');
}

function statusForEvent(event: AgentEvent): ToolEvidenceStatus {
  const payload = record(event.payload);
  if (!payload) return event.kind === 'tool_call' ? 'running' : 'completed';
  if (typeof payload.ok === 'boolean') return payload.ok ? 'completed' : 'failed';
  const status = stringValue(payload, 'status');
  if (status === 'error' || status === 'failed' || status === 'denied') return 'failed';
  if (status === 'running' || status === 'started') return 'running';
  if (status === 'waiting' || status === 'pending') return 'waiting';
  return event.kind === 'tool_call' ? 'running' : 'completed';
}

function isShellTool(
  toolName: string,
  output?: Record<string, unknown>,
  args?: Record<string, unknown>
): boolean {
  return toolName === 'process.exec' ||
    Boolean(stringValue(output, 'command') ?? stringValue(args, 'command'));
}

function pathFor(
  payload?: Record<string, unknown>,
  output?: Record<string, unknown>,
  args?: Record<string, unknown>
): string | undefined {
  const keys = ['path', 'filePath', 'targetPath', 'absolutePath'];
  for (const source of [output, args, payload]) {
    if (!source) continue;
    for (const key of keys) {
      const value = stringValue(source, key);
      const path = readablePath(value);
      if (path) return path;
    }
  }
  return undefined;
}

function pathKind(toolName: string, output?: Record<string, unknown>): ToolEvidenceItemKind {
  const kind = stringValue(output, 'kind') ?? stringValue(output, 'resolvedKind') ?? stringValue(output, 'contentKind') ?? '';
  if (toolName.includes('list') || kind.includes('directory') || kind.includes('tree')) return 'directory';
  return 'file';
}

function toolAction(toolName: string, kind: ToolEvidenceItemKind, language: UiLanguage): string {
  if (toolName.includes('write')) return t(language, 'agent.toolEvidence.action.write');
  if (toolName.includes('delete')) return t(language, 'agent.toolEvidence.action.delete');
  if (toolName.includes('diff')) return t(language, 'agent.toolEvidence.action.previewDiff');
  if (toolName.includes('search')) return t(language, 'agent.toolEvidence.action.search');
  if (toolName.includes('list') || kind === 'directory') return t(language, 'agent.toolEvidence.action.list');
  return t(language, 'agent.toolEvidence.action.read');
}

function pathDetail(output: Record<string, unknown> | undefined, language: UiLanguage): string | undefined {
  const parts = [
    numberValue(output, 'sizeBytes') !== undefined ? formatBytes(numberValue(output, 'sizeBytes') ?? 0) : undefined,
    booleanValue(output, 'truncated') ? t(language, 'common.truncated') : undefined,
    stringValue(output, 'summary'),
  ].filter(Boolean);
  return parts.join(' · ') || undefined;
}

function commandDetail(
  output: Record<string, unknown> | undefined,
  args: Record<string, unknown> | undefined,
  language: UiLanguage
): string | undefined {
  const exitCode = numberValue(output, 'exitCode');
  const duration = formatDurationMs(numberValue(output, 'durationMs'));
  const cwd = stringValue(output, 'cwd') ?? stringValue(args, 'cwd');
  const parts = [
    exitCode !== undefined ? t(language, 'agent.toolEvidence.exitCode', { code: exitCode }) : undefined,
    duration,
    cwd ? t(language, 'agent.toolEvidence.cwd', { cwd }) : undefined,
  ].filter(Boolean);
  return parts.join(' · ') || undefined;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function readableSummary(item: Record<string, unknown>): string | undefined {
  return clipInline(stringValue(item, 'contentSummary') ?? stringValue(item, 'summary'), 180);
}

function readablePreview(item: Record<string, unknown>, hasMatches: boolean): string | undefined {
  if (hasMatches) return undefined;
  const content = stringValue(item, 'promptContent') ?? stringValue(item, 'preview');
  return clipBlock(content, 900);
}

function readableMatches(item: Record<string, unknown>): string[] {
  const matches = Array.isArray(item.matches) ? item.matches.filter(isRecord) : [];
  return matches
    .map((match, index) => {
      const path = readablePath(stringValue(match, 'path')) ?? readablePath(stringValue(match, 'filePath'));
      const line = numberValue(match, 'line') ?? numberValue(match, 'lineNumber');
      const preview = clipInline(stringValue(match, 'preview') ?? stringValue(match, 'text'), 220);
      const location = [
        path,
        line !== undefined ? `:${line}` : undefined,
      ].filter(Boolean).join('');
      const label = location || `match ${index + 1}`;
      return preview ? `${label} ${preview}` : label;
    })
    .filter((value) => value.trim().length > 0)
    .slice(0, 8);
}

function readablePath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || isInternalDisplayToken(normalized)) return undefined;
  return normalized;
}

function readableToolDetail(
  toolName: string,
  payload: Record<string, unknown> | undefined
): string | undefined {
  if (isInternalDisplayToken(toolName)) return undefined;
  return clipInline(stringValue(payload, 'summary') ?? stringValue(payload, 'message'), 180);
}

function isInternalDisplayToken(value: string): boolean {
  return /^(native-call|attachment|work-unit|resource-request|resource-item|kernel-activity)[_-]/i.test(value) ||
    /^turn-[a-z_]+-/i.test(value);
}

function displayToolName(toolName: string, language: UiLanguage): string {
  const normalized = toolName.replace(/__/g, '.').trim();
  if (!normalized || isInternalDisplayToken(normalized)) {
    return t(language, 'agent.toolEvidence.toolExecution');
  }
  return normalized;
}

function clipInline(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function clipBlock(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function stringValue(recordValue: unknown, key: string): string | undefined {
  if (!isRecord(recordValue)) return undefined;
  const value = recordValue[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(recordValue: unknown, key: string): number | undefined {
  if (!isRecord(recordValue)) return undefined;
  const value = recordValue[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(recordValue: unknown, key: string): boolean | undefined {
  if (!isRecord(recordValue)) return undefined;
  const value = recordValue[key];
  return typeof value === 'boolean' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
