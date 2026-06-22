import type { AgentEvent } from '@deepcode/protocol';
import type { UiLanguage } from '../i18n';

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
      action: language === 'zh-CN' ? '执行' : 'Run',
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
      action: language === 'zh-CN' ? '搜索' : 'Search',
      label: query,
      detail: stringValue(output, 'summary') ?? stringValue(payload, 'summary'),
      status,
    }];
  }

  return [{
    id: event.id,
    kind: 'tool',
    action: language === 'zh-CN' ? '工具' : 'Tool',
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
    (language === 'zh-CN' ? `资源 ${index + 1}` : `Resource ${index + 1}`);
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
    nodes !== undefined ? (language === 'zh-CN' ? `${nodes} 项` : `${nodes} entries`) : undefined,
    matches.length > 0 ? (language === 'zh-CN' ? `${matches.length} 处命中` : `${matches.length} matches`) : undefined,
    truncated ? (language === 'zh-CN' ? '已截断' : 'truncated') : undefined,
    summary,
  ].filter(Boolean);

  return {
    id: `${event.id}:resource:${index}`,
    kind: directory ? 'directory' : 'file',
    action: directory
      ? (language === 'zh-CN' ? '列出' : 'Listed')
      : (language === 'zh-CN' ? '读取' : 'Read'),
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
  if (items.length === 0) return fallbackTitle || (language === 'zh-CN' ? '工具证据' : 'Tool evidence');
  const commandCount = items.filter((item) => item.kind === 'command').length;
  if (commandCount > 0 && commandCount === items.length) {
    return language === 'zh-CN' ? `执行 ${commandCount} 条命令` : `Ran ${commandCount} command${commandCount === 1 ? '' : 's'}`;
  }
  const fileCount = items.filter((item) => item.kind === 'file').length;
  const directoryCount = items.filter((item) => item.kind === 'directory').length;
  if (fileCount > 0 && directoryCount === 0) {
    return language === 'zh-CN' ? `读取 ${fileCount} 个文件` : `Read ${fileCount} file${fileCount === 1 ? '' : 's'}`;
  }
  if (directoryCount > 0 && fileCount === 0) {
    return language === 'zh-CN' ? `列出 ${directoryCount} 个目录` : `Listed ${directoryCount} director${directoryCount === 1 ? 'y' : 'ies'}`;
  }
  if (fileCount + directoryCount > 0) {
    return language === 'zh-CN'
      ? `读取/列出 ${fileCount + directoryCount} 个资源`
      : `Resolved ${fileCount + directoryCount} resource${fileCount + directoryCount === 1 ? '' : 's'}`;
  }
  const toolCount = items.filter((item) => item.kind === 'tool').length;
  if (toolCount > 0 && toolCount === items.length) {
    if (items.length === 1) {
      const item = items[0];
      if (item.label === (language === 'zh-CN' ? '工具执行' : 'Tool execution')) {
        return item.label;
      }
      return language === 'zh-CN' ? `执行 ${item.label}` : `Run ${item.label}`;
    }
    return language === 'zh-CN' ? `工具操作 ${items.length} 项` : `${items.length} tool operations`;
  }
  return fallbackTitle || (language === 'zh-CN' ? `工具操作 ${items.length} 项` : `${items.length} tool operation${items.length === 1 ? '' : 's'}`);
}

function evidenceSummary(
  items: ToolEvidenceItem[],
  language: UiLanguage,
  fallbackSummary?: string
): string | undefined {
  if (items.length === 0) return fallbackSummary;
  const failed = items.filter((item) => item.status === 'failed').length;
  if (failed > 0) {
    return language === 'zh-CN' ? `${failed} 项失败` : `${failed} failed`;
  }
  const first = items[0];
  if (items.length === 1) return first.label;
  return language === 'zh-CN'
    ? `${first.label} 等 ${items.length} 项`
    : `${first.label} and ${items.length - 1} more`;
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
  return toolName === 'shell.exec' ||
    toolName === 'process.exec' ||
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
  if (toolName.includes('write')) return language === 'zh-CN' ? '写入' : 'Write';
  if (toolName.includes('delete')) return language === 'zh-CN' ? '删除' : 'Delete';
  if (toolName.includes('diff')) return language === 'zh-CN' ? '预览差异' : 'Preview diff';
  if (toolName.includes('search')) return language === 'zh-CN' ? '搜索' : 'Search';
  if (toolName.includes('list') || kind === 'directory') return language === 'zh-CN' ? '列出' : 'List';
  return language === 'zh-CN' ? '读取' : 'Read';
}

function pathDetail(output: Record<string, unknown> | undefined, language: UiLanguage): string | undefined {
  const parts = [
    numberValue(output, 'sizeBytes') !== undefined ? formatBytes(numberValue(output, 'sizeBytes') ?? 0) : undefined,
    booleanValue(output, 'truncated') ? (language === 'zh-CN' ? '已截断' : 'truncated') : undefined,
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
    exitCode !== undefined ? (language === 'zh-CN' ? `退出码 ${exitCode}` : `exit ${exitCode}`) : undefined,
    duration,
    cwd ? (language === 'zh-CN' ? `目录 ${cwd}` : `cwd ${cwd}`) : undefined,
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
    return language === 'zh-CN' ? '工具执行' : 'Tool execution';
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
