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

export interface ReviewContextRef {
  runId: string;
  reviewId: string;
  sourcePlanId?: string;
}

export interface ReviewActiveInteractionRef {
  kind: string;
  runId?: string;
}

export interface SessionReviewContext {
  sessionId: string;
  runId: string;
  reviewId: string;
  sourcePlanId?: string;
  summary: string;
  content: string;
  userPlan: string;
  continuations: unknown[];
  reviewExpectations: unknown[];
  expectedValidation: string;
  reviewGuide: string;
  facts: string[];
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

  reviewAlreadyResolved(events: unknown[], review: ReviewContextRef): boolean {
    return events.some((event) => {
      const record = objectRecord(event);
      if (record?.kind !== 'review_summary') return false;
      const payload = objectRecord(record.payload);
      if (!payload) return false;
      const status = stringValue(payload.status);
      if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
      return stringValue(payload.runId) === review.runId &&
        (stringValue(payload.reviewId) === review.reviewId || stringValue(payload.sourcePlanId) === review.sourcePlanId);
    });
  }

  isTerminalAcceptedPlan(events: unknown[], review: ReviewContextRef): boolean {
    for (const event of [...events].reverse()) {
      const record = objectRecord(event);
      if (record?.kind !== 'workflow_stage') continue;
      const payload = objectRecord(record.payload);
      if (!payload || stringValue(payload.stage) !== 'accepted_plan.batch_checkpoint') continue;
      if (stringValue(payload.runId) !== review.runId) continue;
      const planId = stringValue(payload.planId);
      if (review.sourcePlanId && planId && planId !== review.sourcePlanId) continue;
      const remaining = Array.isArray(payload.remainingTaskIds) ? payload.remainingTaskIds : [];
      const status = stringValue(payload.status);
      return status === 'completed' && remaining.length === 0;
    }
    return false;
  }

  findWaitingReview(
    events: Array<{ sessionId?: string; kind?: unknown; payload?: unknown }>,
    runId: string | undefined,
    active: ReviewActiveInteractionRef | null | undefined
  ): SessionReviewContext | null {
    if (!active || active.kind !== 'review' || (runId && active.runId !== runId)) {
      return null;
    }
    for (const event of [...events].reverse()) {
      if (event.kind !== 'review_summary') continue;
      const payload = objectRecord(event.payload);
      if (!payload || stringValue(payload.status) !== 'waitingUserReview') continue;
      const candidateRunId = stringValue(payload.runId);
      if (!candidateRunId || (runId && candidateRunId !== runId)) continue;
      return {
        sessionId: stringValue(event.sessionId) ?? '',
        runId: candidateRunId,
        reviewId: stringValue(payload.reviewId) ?? candidateRunId,
        sourcePlanId: stringValue(payload.sourcePlanId),
        summary: stringValue(payload.summary) ?? '',
        content: stringValue(payload.content) ?? '',
        userPlan: stringValue(payload.userPlan) ?? '',
        continuations: Array.isArray(payload.continuations) ? payload.continuations : [],
        reviewExpectations: Array.isArray(payload.reviewExpectations) ? payload.reviewExpectations : [],
        expectedValidation: stringValue(payload.expectedValidation) ?? '',
        reviewGuide: stringValue(payload.reviewGuide) ?? '',
        facts: Array.isArray(payload.facts) ? payload.facts.filter((item): item is string => typeof item === 'string') : [],
      };
    }
    return null;
  }

  continuationRequest(review: SessionReviewContext): string {
    const continuations = this.continuationSummaries(review);
    return [
      'Continue planning the next reviewable Plan from the fact that the current batch Review was accepted.',
      'This is continuation planning after Review accept; it is not authorization to execute.',
      'The previous Plan and continuation expectations are intentContext only. Generated-file facts can only come from Kernel facts, ToolCompleted(ok=true), WorkUnitCompleted, or ResourcePacket.',
      review.content ? `Previous Review card content:\n${review.content}` : '',
      review.facts.length ? `Previous Kernel facts:\n${review.facts.join('\n')}` : 'Previous Kernel facts: the current Review recorded no reusable facts.',
      review.userPlan ? `Previous Plan intent:\n${review.userPlan}` : '',
      continuations.length ? `Continuation intents:\n${continuations.map((item) => `- ${item}`).join('\n')}` : 'Continuation intents: none were recorded.',
      [
        'Next proposal requirements:',
        '- If more edits require existing-code facts, request focused evidence first with resourceRequest kind="search" or file/range.',
        '- Then output a new detailed Agent Protocol v3 actionBundle.',
        '- actionBundle.actions must use actionId, toolId, args, and description. fs.write uses args.path/sourceBlockId; fs.patch uses args.path/replacementBlockId/patchSpec; fs.delete uses args.path/targetKind/recursive.',
        '- codeBlocks must use contentLines. Do not output commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large codeBlocks.content fields.',
        '- patch must include args.patchSpec.match.kind="exactBlock" and exact text from current ResourcePacket evidence.',
        '- fs.delete must use a concrete relative args.path. Confirmed directory delete must also set args.targetKind="directory" and args.recursive=true. Do not use codeBlocks/sourceBlockId, empty writes, fs.write as delete, wildcards, or workspace root.',
        '- The new Plan must wait for user confirmation. Do not assume execution already happened.',
      ].join('\n'),
    ].filter(Boolean).join('\n\n');
  }

  revisionRequest(review: SessionReviewContext, guidance?: string): string {
    const continuations = this.continuationSummaries(review);
    return [
      'Reinterpret the request from the user Review revision guidance and generate the next reviewable Plan.',
      'This is Review revise, not Review accept. Do not treat the user revision guidance as execution authorization.',
      'The previous Plan, Review guidance, and continuation expectations are intentContext only. Generated-file facts can only come from Kernel facts, ToolCompleted(ok=true), WorkUnitCompleted, or ResourcePacket.',
      guidance?.trim() ? `User Review revision guidance:\n${guidance.trim()}` : 'User Review revision guidance: the user requested additional work or changes for the current batch.',
      review.content ? `Previous Review card content:\n${review.content}` : '',
      review.facts.length ? `Previous Kernel facts:\n${review.facts.join('\n')}` : 'Previous Kernel facts: the current Review recorded no reusable facts.',
      review.userPlan ? `Previous Plan intent:\n${review.userPlan}` : '',
      continuations.length ? `Previous continuation intent:\n${continuations.map((item) => `- ${item}`).join('\n')}` : '',
      [
        'Next proposal requirements:',
        '- If more edits require existing-code facts, request focused evidence first with resourceRequest kind="search" or file/range, such as build scripts, entry source files, headers, tests, or container configuration.',
        '- Then output a new detailed Agent Protocol v3 actionBundle.',
        '- actionBundle.actions must use actionId, toolId, args, and description. fs.write uses args.path/sourceBlockId; fs.patch uses args.path/replacementBlockId/patchSpec; fs.delete uses args.path/targetKind/recursive.',
        '- codeBlocks must use contentLines. Do not output commandBlocks, capability, permissionLabels, accessScopes, resourceScope, or large codeBlocks.content fields.',
        '- patch must include args.patchSpec.match.kind="exactBlock" and exact text from current ResourcePacket evidence.',
        '- fs.delete must use a concrete relative args.path. Confirmed directory delete must also set args.targetKind="directory" and args.recursive=true. Do not use codeBlocks/sourceBlockId, empty writes, fs.write as delete, wildcards, or workspace root.',
        '- The new Plan waits for user confirmation. Do not assume execution already happened.',
      ].join('\n'),
    ].filter(Boolean).join('\n\n');
  }

  continuationSummaries(review: { continuations: unknown[] }): string[] {
    return review.continuations.map((item) => this.continuationSummary(item)).filter(Boolean);
  }

  continuationSummary(value: unknown): string {
    const record = objectRecord(value);
    return stringValue(record?.title) ?? stringValue(record?.description) ?? stringValue(record?.id) ?? clipJson(value, 160);
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
