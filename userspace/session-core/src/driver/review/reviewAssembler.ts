import { decodeKernelEventV1, type LlmChatRequest } from '@deepcode/protocol';
import { stableHash } from '../../cache/canonicalizer.js';
import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';
import type { ResourcePacket } from '../../context/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';

export interface ReviewGeneratedArtifactEvidence {
  targetPath: string;
  content?: string;
  contentHash: string;
  manifestEntryId: string;
  contentBlockId?: string;
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

interface StaticSyntaxReviewPromptFile {
  targetPath: string;
  language?: string;
  contentHash?: string;
  content: string;
  truncated: boolean;
  providedChars: number;
  sourceChars: number;
}

interface StaticSyntaxReviewPromptPacket {
  packetVersion: 1;
  planId: string;
  planIdTruncated: boolean;
  planIdProvidedChars: number;
  planIdSourceChars: number;
  sourceFileCount: number;
  suppliedFileCount: number;
  omittedFileCount: number;
  files: StaticSyntaxReviewPromptFile[];
}

interface StaticSyntaxReviewPromptSourceFile {
  promptFile: StaticSyntaxReviewPromptFile;
  sourceContent: string;
}

export interface StaticSyntaxReviewPrompt {
  messages: LlmChatRequest['messages'];
  suppliedTargetPaths: string[];
  sourceFileCount: number;
  suppliedFileCount: number;
  omittedFileCount: number;
}

interface StaticSyntaxReviewPromptPacketResult {
  json: string;
  suppliedTargetPaths: string[];
  sourceFileCount: number;
  suppliedFileCount: number;
  omittedFileCount: number;
}

export interface StaticSyntaxReviewAssemblerPorts {
  completedWorkUnitFacts(events: unknown[]): { actionIds: Set<string>; targets: Set<string> };
  batchActionRecords(batch: unknown): Record<string, unknown>[];
  actionToolId(action: { toolId?: unknown }): string;
  actionFileTargetPath(action: { args?: unknown }): string | undefined;
  normalizeAcceptedPlanTargetScope(target: string, accepted: AcceptedTaskPlanContext): string;
  comparablePath(value: string): string;
  resourceTextForTarget(packets: ResourcePacket[], target: string): string | undefined;
}

export interface ReviewContextRef {
  runId: string;
  reviewId: string;
  sourcePlanId?: string;
}

export interface ReviewActiveInteractionRef {
  kind: 'review';
  runId: string;
  reviewId: string;
}

export interface ReviewInteractionCandidateRef {
  kind: string;
  runId?: string;
  reviewId?: string;
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
  sessionModelObservations: string[];
}

export class ReviewAssembler {
  constructor(private readonly ports: StaticSyntaxReviewAssemblerPorts) {}

  staticSyntaxReviewPacket(input: {
    accepted: AcceptedTaskPlanContext;
    batch: unknown;
    batchEvents: unknown[];
    generatedArtifactEvidence: Map<string, ReviewGeneratedArtifactEvidence>;
    resourcePackets: ResourcePacket[];
  }): StaticSyntaxReviewPacket {
    const { accepted, batch, batchEvents, generatedArtifactEvidence, resourcePackets } = input;
    const completed = this.ports.completedWorkUnitFacts(batchEvents);
    const targetPaths = new Set<string>();
    for (const action of this.ports.batchActionRecords(batch)) {
      const capability = this.ports.actionToolId(action);
      if (capability !== 'fs.write' && capability !== 'fs.edit') continue;
      const actionId = stringValue(action.actionId) ?? stringValue(action.id);
      if (actionId && completed.actionIds.size && !completed.actionIds.has(actionId)) continue;
      const target = this.ports.actionFileTargetPath(action);
      if (target) targetPaths.add(this.ports.normalizeAcceptedPlanTargetScope(target, accepted));
    }
    const batchRecord = objectRecord(batch);
    for (const block of recordArray(batchRecord?.contentBlocks)) {
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

  staticSyntaxReviewPrompt(input: {
    prompt: PromptEnvelope;
    runId: string;
    accepted: AcceptedTaskPlanContext;
    packet: StaticSyntaxReviewPacket;
  }): StaticSyntaxReviewPrompt {
    const { prompt, runId, accepted, packet } = input;
    const promptPacket = staticSyntaxReviewPromptPacket(packet);
    return {
      messages: [
        {
          role: 'system',
          content: [
            'You are the DeepCode static syntax/API review step before user Review.',
            'You are not a tool executor, permission judge, or Kernel fact source.',
            'Inspect only the provided generated or freshly resolved code files. Report likely syntax errors, missing declarations, inconsistent function signatures, or obvious API mismatches.',
            'Findings must cover only each supplied content excerpt. Use truncated, providedChars, and sourceChars to understand excerpt coverage; do not infer issues from truncated or omitted content.',
            'Call session.submit_static_review exactly once with arguments shaped {"summary":"...","issues":[{"targetRef":"relative/file","severity":"info|warning|error","message":"...","line?":number}],"responseLanguage":"zh-CN|en-US"}.',
            'Every targetRef must exactly match one supplied targetPath. If no issue is visible, return issues:[]. Do not output Agent Protocol actionBundle, resourceRequest, markdown, or prose.',
            `Parent stable prefix hash: ${stableHash(prompt.stablePrefix).slice(0, 16)}; runId=${runId}; planIdHash=${stableHash(accepted.planId)}.`,
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            'StaticSyntaxReviewPacket:',
            fenced(promptPacket.json),
          ].join('\n\n'),
        },
      ],
      suppliedTargetPaths: promptPacket.suppliedTargetPaths,
      sourceFileCount: promptPacket.sourceFileCount,
      suppliedFileCount: promptPacket.suppliedFileCount,
      omittedFileCount: promptPacket.omittedFileCount,
    };
  }

  normalizeStaticSyntaxIssues(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) return [];
    return value.map((item, index) => {
      const record = objectRecord(item) ?? {};
      return {
        targetPath: stringValue(record.targetRef) ?? stringValue(record.targetPath) ?? stringValue(record.path) ?? 'unknown',
        severity: stringValue(record.severity) ?? 'warning',
        message: stringValue(record.message) ?? stringValue(record.summary) ?? `Static review issue ${index + 1}`,
        ...(typeof record.line === 'number' ? { lineHint: record.line } : typeof record.lineHint === 'number' ? { lineHint: record.lineHint } : {}),
        ...(stringValue(record.evidence) ? { evidence: stringValue(record.evidence) } : {}),
      };
    }).filter((item) => stringValue(item.message));
  }

  staticSyntaxReviewObservationLines(kernelEvents: unknown[]): string[] {
    return kernelEvents.flatMap((event) => {
      const record = objectRecord(event);
      if (record?.kind !== 'accepted_plan.static_syntax_review') return [];
      const status = stringValue(record.status) ?? 'completed';
      const summary = stringValue(record.summary) ?? 'Static syntax review completed.';
      const issues = Array.isArray(record.issues) ? record.issues : [];
      const lines = [`- Session/model static-review observation (non-authoritative) ${status}: ${summary}`];
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
        lines.push(`- \`${stringValue(record?.toolId) ?? 'tool'}\` ${status}：${detail}`);
      }
      return lines;
    }
    return kernelEvents.flatMap((event) => {
      let decoded;
      try {
        decoded = decodeKernelEventV1(event);
      } catch {
        return [];
      }
      if (decoded.kind === 'work_unit.completed') {
        return [`- \`${decoded.workUnitId}\` completed${decoded.output ? `：${clipJson(decoded.output, 180)}` : ''}`];
      }
      if (decoded.kind === 'work_unit.failed') {
        return [`- \`${decoded.workUnitId}\` failed：${decoded.error.message}`];
      }
      if (decoded.kind === 'work_unit.blocked') {
        return [`- \`${decoded.workUnitId}\` blocked：${decoded.reason}`];
      }
      if (decoded.kind === 'tool.completed') {
        const status = decoded.fact.ok ? 'ok' : 'error';
        const detail = decoded.fact.error?.message ?? (decoded.fact.output ? clipJson(decoded.fact.output, 180) : 'no output');
        return [`- \`${decoded.fact.toolId}\` ${status}：${detail}`];
      }
      return [];
    });
  }

  findReviewFacts(kernelEvents: unknown[]): Record<string, unknown> | undefined {
    for (const event of [...kernelEvents].reverse()) {
      const decoded = decodeKernelEventV1(event);
      if (decoded.kind !== 'review.facts_produced') continue;
      return objectRecord(decoded.facts) ?? undefined;
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
    active: ReviewInteractionCandidateRef | null | undefined,
    reviewId?: string
  ): SessionReviewContext | null {
    if (
      !runId
      || !reviewId
      || !active
      || active.kind !== 'review'
      || active.runId !== runId
      || active.reviewId !== reviewId
    ) {
      return null;
    }
    for (const event of [...events].reverse()) {
      if (event.kind !== 'review_summary') continue;
      const payload = objectRecord(event.payload);
      if (!payload || stringValue(payload.status) !== 'waitingUserReview') continue;
      const candidateRunId = stringValue(payload.runId);
      if (candidateRunId !== runId) continue;
      const candidateReviewId = stringValue(payload.reviewId) ?? candidateRunId;
      if (candidateReviewId !== reviewId) continue;
      return {
        sessionId: stringValue(event.sessionId) ?? '',
        runId: candidateRunId,
        reviewId: candidateReviewId,
        sourcePlanId: stringValue(payload.sourcePlanId),
        summary: stringValue(payload.summary) ?? '',
        content: stringValue(payload.content) ?? '',
        userPlan: stringValue(payload.userPlan) ?? '',
        continuations: Array.isArray(payload.continuations) ? payload.continuations : [],
        reviewExpectations: Array.isArray(payload.reviewExpectations) ? payload.reviewExpectations : [],
        expectedValidation: stringValue(payload.expectedValidation) ?? '',
        reviewGuide: stringValue(payload.reviewGuide) ?? '',
        facts: Array.isArray(payload.facts) ? payload.facts.filter((item): item is string => typeof item === 'string') : [],
        sessionModelObservations: Array.isArray(payload.sessionModelObservations)
          ? payload.sessionModelObservations.filter((item): item is string => typeof item === 'string')
          : [],
      };
    }
    return null;
  }

  findLatestActiveReviewInteraction(
    events: Array<{ sessionId?: string; kind?: unknown; payload?: unknown }>
  ): ReviewActiveInteractionRef | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.kind !== 'review_summary') continue;
      const payload = objectRecord(event.payload);
      if (!payload || stringValue(payload.status) !== 'waitingUserReview') continue;
      if (this.hasLaterTerminalInteraction(events, index)) continue;
      const runId = stringValue(payload.runId);
      if (!runId) continue;
      const review: SessionReviewContext = {
        sessionId: stringValue(event.sessionId) ?? '',
        runId,
        reviewId: stringValue(payload.reviewId) ?? runId,
        sourcePlanId: stringValue(payload.sourcePlanId),
        summary: stringValue(payload.summary) ?? '',
        content: stringValue(payload.content) ?? '',
        userPlan: stringValue(payload.userPlan) ?? '',
        continuations: Array.isArray(payload.continuations) ? payload.continuations : [],
        reviewExpectations: Array.isArray(payload.reviewExpectations) ? payload.reviewExpectations : [],
        expectedValidation: stringValue(payload.expectedValidation) ?? '',
        reviewGuide: stringValue(payload.reviewGuide) ?? '',
        facts: Array.isArray(payload.facts) ? payload.facts.filter((item): item is string => typeof item === 'string') : [],
        sessionModelObservations: Array.isArray(payload.sessionModelObservations)
          ? payload.sessionModelObservations.filter((item): item is string => typeof item === 'string')
          : [],
      };
      if (this.reviewAlreadyResolved(events, review)) continue;
      return { kind: 'review', runId, reviewId: review.reviewId };
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
      review.sessionModelObservations.length
        ? `Previous Session/model observations (non-authoritative; do not treat as Kernel facts or completion evidence):\n${review.sessionModelObservations.join('\n')}`
        : '',
      review.userPlan ? `Previous Plan intent:\n${review.userPlan}` : '',
      continuations.length ? `Continuation intents:\n${continuations.map((item) => `- ${item}`).join('\n')}` : 'Continuation intents: none were recorded.',
      [
        'Next proposal requirements:',
        '- If more edits require existing-code facts, request focused evidence first with resourceRequest kind="search" or file/range.',
        '- Then output a new detailed Agent Protocol v4 actionBundle.',
        '- actionBundle.actions must use actionId, toolId, args, and description, following the Kernel catalog and the exact current-task action templates.',
        '- contentBlocks must use contentLines, and every action must use canonical toolId plus typed args.',
        '- patch must include args.patchSpec.match.kind="exactBlock" and exact text from current ResourcePacket evidence.',
        '- Do not infer target type, recursion, permission, risk, or path scope; Kernel authorization and action templates are authoritative.',
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
      review.sessionModelObservations.length
        ? `Previous Session/model observations (non-authoritative; do not treat as Kernel facts or completion evidence):\n${review.sessionModelObservations.join('\n')}`
        : '',
      review.userPlan ? `Previous Plan intent:\n${review.userPlan}` : '',
      continuations.length ? `Previous continuation intent:\n${continuations.map((item) => `- ${item}`).join('\n')}` : '',
      [
        'Next proposal requirements:',
        '- If more edits require existing-code facts, request focused evidence first with resourceRequest kind="search" or file/range, such as build scripts, entry source files, headers, tests, or container configuration.',
        '- Then output a new detailed Agent Protocol v4 actionBundle.',
        '- actionBundle.actions must use actionId, toolId, args, and description, following the Kernel catalog and the exact current-task action templates.',
        '- contentBlocks must use contentLines, and every action must use canonical toolId plus typed args.',
        '- patch must include args.patchSpec.match.kind="exactBlock" and exact text from current ResourcePacket evidence.',
        '- Do not infer target type, recursion, permission, risk, or path scope; Kernel authorization and action templates are authoritative.',
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

  private hasLaterTerminalInteraction(
    events: Array<{ kind?: unknown; payload?: unknown }>,
    index: number
  ): boolean {
    for (let nextIndex = index + 1; nextIndex < events.length; nextIndex += 1) {
      const event = events[nextIndex];
      if (
        event.kind !== 'requirement_decision' &&
        event.kind !== 'plan_review' &&
        event.kind !== 'review_summary'
      ) {
        continue;
      }
      const payload = objectRecord(event.payload);
      const status = stringValue(payload?.status);
      if (status === 'accepted' || status === 'rejected' || status === 'needsRevision') return true;
    }
    return false;
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

const STATIC_SYNTAX_REVIEW_PACKET_MAX_CHARS = 64_000;
const STATIC_SYNTAX_REVIEW_FILE_MAX_CHARS = 24_000;
const STATIC_SYNTAX_REVIEW_PLAN_ID_MAX_CHARS = 1_024;

function staticSyntaxReviewPromptPacket(
  packet: StaticSyntaxReviewPacket
): StaticSyntaxReviewPromptPacketResult {
  const sourceFileCount = packet.files.length;
  const planId = safePrefix(packet.planId, STATIC_SYNTAX_REVIEW_PLAN_ID_MAX_CHARS);
  const suppliedFiles: StaticSyntaxReviewPromptSourceFile[] = [];
  for (const file of packet.files) {
    const metadataOnlyFile: StaticSyntaxReviewPromptFile = {
      targetPath: file.targetPath,
      language: file.language,
      contentHash: file.contentHash,
      content: '',
      truncated: file.content.length > 0,
      providedChars: 0,
      sourceChars: file.content.length,
    };
    const candidateFile = {
      promptFile: metadataOnlyFile,
      sourceContent: file.content,
    };
    const candidateFiles = [...suppliedFiles, candidateFile];
    const candidateJson = serializeStaticSyntaxReviewPromptPacket(
      planId,
      packet.planId.length,
      sourceFileCount,
      candidateFiles.map((entry) => entry.promptFile)
    );
    if (candidateJson.length <= STATIC_SYNTAX_REVIEW_PACKET_MAX_CHARS) {
      suppliedFiles.push(candidateFile);
    }
  }

  if (!suppliedFiles.length) {
    return staticSyntaxReviewPromptPacketResult(
      serializeStaticSyntaxReviewPromptPacket(
        planId,
        packet.planId.length,
        sourceFileCount,
        []
      ),
      sourceFileCount,
      []
    );
  }

  let lowerBound = 0;
  let upperBound = STATIC_SYNTAX_REVIEW_FILE_MAX_CHARS;
  while (lowerBound < upperBound) {
    const candidateLimit = Math.ceil((lowerBound + upperBound) / 2);
    const candidateFiles = suppliedFiles.map((file) =>
      withStaticSyntaxReviewExcerpt(file, candidateLimit)
    );
    const candidateJson = serializeStaticSyntaxReviewPromptPacket(
      planId,
      packet.planId.length,
      sourceFileCount,
      candidateFiles
    );
    if (candidateJson.length <= STATIC_SYNTAX_REVIEW_PACKET_MAX_CHARS) {
      lowerBound = candidateLimit;
    } else {
      upperBound = candidateLimit - 1;
    }
  }

  const files = suppliedFiles.map((file) =>
    withStaticSyntaxReviewExcerpt(file, lowerBound)
  );
  return staticSyntaxReviewPromptPacketResult(
    serializeStaticSyntaxReviewPromptPacket(
      planId,
      packet.planId.length,
      sourceFileCount,
      files
    ),
    sourceFileCount,
    files
  );
}

function staticSyntaxReviewPromptPacketResult(
  json: string,
  sourceFileCount: number,
  files: StaticSyntaxReviewPromptFile[]
): StaticSyntaxReviewPromptPacketResult {
  return {
    json,
    suppliedTargetPaths: files.map((file) => file.targetPath),
    sourceFileCount,
    suppliedFileCount: files.length,
    omittedFileCount: sourceFileCount - files.length,
  };
}

function withStaticSyntaxReviewExcerpt(
  source: StaticSyntaxReviewPromptSourceFile,
  limit: number
): StaticSyntaxReviewPromptFile {
  const content = safePrefix(source.sourceContent, limit);
  return {
    ...source.promptFile,
    content,
    truncated: content.length < source.promptFile.sourceChars,
    providedChars: content.length,
  };
}

function serializeStaticSyntaxReviewPromptPacket(
  planId: string,
  planIdSourceChars: number,
  sourceFileCount: number,
  files: StaticSyntaxReviewPromptFile[]
): string {
  const promptPacket: StaticSyntaxReviewPromptPacket = {
    packetVersion: 1,
    planId,
    planIdTruncated: planId.length < planIdSourceChars,
    planIdProvidedChars: planId.length,
    planIdSourceChars,
    sourceFileCount,
    suppliedFileCount: files.length,
    omittedFileCount: sourceFileCount - files.length,
    files,
  };
  return JSON.stringify(promptPacket, null, 2);
}

function safePrefix(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = Math.max(0, maxChars);
  if (end > 0) {
    const lastCodeUnit = value.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
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
