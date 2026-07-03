import type { LlmChatRequest } from '@deepcode/protocol';
import { stableHash } from '../../cache/canonicalizer.js';
import type { AcceptedImplementationPlanContext } from '../../accepted-plan/types.js';
import type { ResourcePacket } from '../../context/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';

export interface ReviewGeneratedArtifactEvidence {
  targetPath: string;
  content: string;
  contentHash: string;
  manifestEntryId: string;
  sourceBlockId?: string;
  actionId?: string;
  workUnitId?: string;
}

export interface StaticSyntaxReviewPacket {
  planId: string;
  files: Array<{
    targetPath: string;
    language?: string;
    content: string;
    contentHash?: string;
  }>;
}

export interface StaticSyntaxReviewAssemblerPorts {
  completedWorkUnitFacts(events: unknown[]): { actionIds: Set<string>; targets: Set<string> };
  batchActionRecords(batch: unknown): Record<string, unknown>[];
  actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string;
  actionFileTargetPath(action: { targetRef?: unknown; targetPath?: unknown; resourceScope?: unknown; args?: unknown }): string | undefined;
  normalizeAcceptedPlanTargetScope(target: string, accepted: AcceptedImplementationPlanContext): string;
  comparablePath(value: string): string;
  resourceTextForTarget(packets: ResourcePacket[], target: string): string | undefined;
}

export class ReviewAssembler {
  constructor(private readonly ports: StaticSyntaxReviewAssemblerPorts) {}

  staticSyntaxReviewPacket(input: {
    accepted: AcceptedImplementationPlanContext;
    batch: Record<string, unknown>;
    batchEvents: unknown[];
    generatedArtifactEvidence: Map<string, ReviewGeneratedArtifactEvidence>;
    resourcePackets: ResourcePacket[];
  }): StaticSyntaxReviewPacket {
    const { accepted, batch, batchEvents, generatedArtifactEvidence, resourcePackets } = input;
    const completed = this.ports.completedWorkUnitFacts(batchEvents);
    const targetPaths = new Set<string>();
    for (const action of this.ports.batchActionRecords(batch)) {
      const capability = this.ports.actionEffectiveCapability(action);
      if (capability !== 'fs.write' && capability !== 'fs.patch') continue;
      const actionId = stringValue(action.actionId) ?? stringValue(action.id);
      if (actionId && completed.actionIds.size && !completed.actionIds.has(actionId)) continue;
      const target = this.ports.actionFileTargetPath(action);
      if (target) targetPaths.add(this.ports.normalizeAcceptedPlanTargetScope(target, accepted));
    }
    for (const block of recordArray(batch.codeBlocks)) {
      const target = stringValue(block.targetPath) ?? stringValue(block.path);
      if (target) targetPaths.add(this.ports.normalizeAcceptedPlanTargetScope(target, accepted));
    }
    const files: StaticSyntaxReviewPacket['files'] = [];
    for (const target of targetPaths) {
      if (!isStaticSyntaxReviewTarget(target)) continue;
      const evidence = generatedArtifactEvidence.get(this.ports.comparablePath(target));
      const content = evidence?.content ?? this.ports.resourceTextForTarget(resourcePackets, target);
      if (!content) continue;
      files.push({
        targetPath: target,
        language: languageForPath(target),
        content,
        contentHash: evidence?.contentHash ?? stableHash(content),
      });
    }
    return {
      planId: accepted.planId,
      files,
    };
  }

  staticSyntaxReviewMessages(input: {
    prompt: PromptEnvelope;
    runId: string;
    accepted: AcceptedImplementationPlanContext;
    packet: StaticSyntaxReviewPacket;
  }): LlmChatRequest['messages'] {
    const { prompt, runId, accepted, packet } = input;
    const files = packet.files.map((file) => ({
      targetPath: file.targetPath,
      language: file.language,
      contentHash: file.contentHash,
      content: clip(file.content, 24_000),
    }));
    return [
      {
        role: 'system',
        content: [
          'You are the DeepCode static syntax/API review step before user Review.',
          'You are not a tool executor, permission judge, or Kernel fact source.',
          'Inspect only the provided generated or freshly resolved code files. Report likely syntax errors, missing declarations, inconsistent function signatures, or obvious API mismatches.',
          'Return exactly one JSON object shaped {"kind":"staticSyntaxReview","summary":"...","issues":[{"targetPath":"relative/file","severity":"error|warning","message":"...","lineHint?":number,"evidence?":"..."}]}.',
          'If no issue is visible, return issues:[]. Do not output Agent Protocol actionBundle, resourceRequest, markdown, or prose outside JSON.',
          `Parent stable prefix hash: ${stableHash(prompt.stablePrefix).slice(0, 16)}; runId=${runId}; planId=${accepted.planId}.`,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          'StaticSyntaxReviewPacket:',
          fenced(clip(JSON.stringify({
            planId: packet.planId,
            files,
          }, null, 2), 64_000)),
        ].join('\n\n'),
      },
    ];
  }

  normalizeStaticSyntaxIssues(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) return [];
    return value.map((item, index) => {
      const record = objectRecord(item) ?? {};
      return {
        targetPath: stringValue(record.targetPath) ?? stringValue(record.path) ?? 'unknown',
        severity: stringValue(record.severity) ?? 'warning',
        message: stringValue(record.message) ?? stringValue(record.summary) ?? `Static review issue ${index + 1}`,
        ...(typeof record.lineHint === 'number' ? { lineHint: record.lineHint } : {}),
        ...(stringValue(record.evidence) ? { evidence: stringValue(record.evidence) } : {}),
      };
    }).filter((item) => stringValue(item.message));
  }

  staticSyntaxReviewFactLines(kernelEvents: unknown[]): string[] {
    return kernelEvents.flatMap((event) => {
      const record = objectRecord(event);
      if (record?.kind !== 'accepted_plan.static_syntax_review') return [];
      const status = stringValue(record.status) ?? 'completed';
      const summary = stringValue(record.summary) ?? 'Static syntax review completed.';
      const issues = Array.isArray(record.issues) ? record.issues : [];
      const lines = [`- Static syntax review ${status}：${summary}`];
      for (const issue of issues.slice(0, 8)) {
        const item = objectRecord(issue) ?? {};
        const target = stringValue(item.targetPath) ?? 'unknown';
        const severity = stringValue(item.severity) ?? 'warning';
        const message = stringValue(item.message) ?? 'issue';
        lines.push(`  - \`${target}\` ${severity}: ${message}`);
      }
      if (issues.length > 8) lines.push(`  - 另有 ${issues.length - 8} 个静态审查问题未展开。`);
      return lines;
    });
  }

  reviewFactLines(kernelEvents: unknown[]): string[] {
    const facts = this.findReviewFacts(kernelEvents);
    if (facts) {
      const lines: string[] = [];
      const completed = Array.isArray(facts.completedWorkUnits) ? facts.completedWorkUnits : [];
      const failed = Array.isArray(facts.failedWorkUnits) ? facts.failedWorkUnits : [];
      const blocked = Array.isArray(facts.blockedWorkUnits) ? facts.blockedWorkUnits : [];
      const tools = Array.isArray(facts.toolResults) ? facts.toolResults : [];
      for (const item of completed) {
        const record = objectRecord(item);
        lines.push(`- \`${stringValue(record?.workUnitId) ?? 'work-unit'}\` completed${record?.output ? `：${clipJson(record.output, 180)}` : ''}`);
      }
      for (const item of failed) {
        const record = objectRecord(item);
        const error = objectRecord(record?.error);
        lines.push(`- \`${stringValue(record?.workUnitId) ?? 'work-unit'}\` failed：${stringValue(error?.message) ?? 'unknown error'}`);
      }
      for (const item of blocked) {
        const record = objectRecord(item);
        lines.push(`- \`${stringValue(record?.workUnitId) ?? 'work-unit'}\` blocked：${stringValue(record?.reason) ?? 'blocked'}`);
      }
      for (const item of tools) {
        const record = objectRecord(item);
        const error = objectRecord(record?.error);
        const status = record?.ok === true ? 'ok' : 'error';
        const detail = stringValue(error?.message) ?? (record?.output ? clipJson(record.output, 180) : 'no output');
        lines.push(`- \`${stringValue(record?.toolName) ?? 'tool'}\` ${status}：${detail}`);
      }
      return lines;
    }
    return kernelEvents.flatMap((event) => {
      const record = objectRecord(event);
      if (!record) return [];
      const kind = stringValue(record.kind);
      if (kind === 'work_unit.completed') {
        return [`- \`${stringValue(record.workUnitId) ?? 'work-unit'}\` completed${record.output ? `：${clipJson(record.output, 180)}` : ''}`];
      }
      if (kind === 'work_unit.failed') {
        const error = objectRecord(record.error);
        return [`- \`${stringValue(record.workUnitId) ?? 'work-unit'}\` failed：${stringValue(error?.message) ?? 'unknown error'}`];
      }
      if (kind === 'work_unit.blocked') {
        return [`- \`${stringValue(record.workUnitId) ?? 'work-unit'}\` blocked：${stringValue(record.reason) ?? 'blocked'}`];
      }
      if (kind === 'tool.completed') {
        const error = objectRecord(record.error);
        const status = record.ok === true ? 'ok' : 'error';
        const detail = stringValue(error?.message) ?? (record.output ? clipJson(record.output, 180) : 'no output');
        return [`- \`${stringValue(record.toolName) ?? 'tool'}\` ${status}：${detail}`];
      }
      return [];
    });
  }

  findReviewFacts(kernelEvents: unknown[]): Record<string, unknown> | undefined {
    for (const event of [...kernelEvents].reverse()) {
      const record = objectRecord(event);
      if (record?.kind !== 'review.facts_produced') continue;
      return objectRecord(record.facts) ?? undefined;
    }
    return undefined;
  }
}

function isStaticSyntaxReviewTarget(path: string): boolean {
  return /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|swift|cs)$/i.test(path);
}

function languageForPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(lower)) return 'cpp';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.java')) return 'java';
  return undefined;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}

function clipJson(value: unknown, max: number): string {
  try {
    return clip(JSON.stringify(value), max);
  } catch {
    return String(value).slice(0, max);
  }
}

function fenced(value: string): string {
  return `\`\`\`\n${value}\n\`\`\``;
}
