import type { AcceptedTaskPlanContext } from '../accepted-plan/types.js';
import type { ProposalEnvelope, ProposalEnvelopeKind } from '../protocol/types.js';
import type { DriverProviderTurnFrame } from '../driver/runFrame.js';
import type { NativeToolCallProposal } from './providerStreamParts.js';
import { OperationIntentCompiler, type TaskArtifactDirective } from '../driver/execution/operationIntentCompiler.js';
import { ProviderProfileRegistry } from './ProviderProfileRegistry.js';
import { stableHash } from '../cache/canonicalizer.js';
import type {
  ConversationResourceRoot,
  ResourceManifest,
  ResourcePacket,
} from '../context/types.js';
import type {
  ConversationLanguage,
  KernelArtifactEditMatch,
  KernelToolCatalogSnapshot,
} from '@deepcode/protocol';

export interface SessionSemanticToolState {
  readonly sessionId: string;
  readonly runId: string;
  readonly providerTurnFrame?: DriverProviderTurnFrame;
  readonly acceptedTaskPlan?: AcceptedTaskPlanContext;
  readonly resourcePackets?: readonly ResourcePacket[];
  readonly manifest?: ResourceManifest;
  readonly conversationRoots?: readonly ConversationResourceRoot[];
  readonly stateContract?: {
    toolCatalogSnapshot?: KernelToolCatalogSnapshot;
    draftAdmissionPolicy?: { maxTotalUtf8Bytes?: number };
  };
  readonly driverRequest?: {
    stateContract?: {
      toolCatalogSnapshot?: KernelToolCatalogSnapshot;
      draftAdmissionPolicy?: { maxTotalUtf8Bytes?: number };
    };
  };
  readonly userAuthorityFrame?: {
    readonly effectiveLanguage?: ConversationLanguage;
    readonly languagePolicy?: {
      readonly status?: string;
    };
  };
}

export type SessionSemanticDirective =
  | { kind: 'proposal'; proposal: ProposalEnvelope }
  | {
      kind: 'taskOutcome';
      outcome: 'alreadySatisfied';
      summary: string;
      evidenceRefs: string[];
      acceptanceResults: Array<{
        criterionIndex: number;
        status: 'satisfied';
        evidenceRefs: string[];
      }>;
    }
  | {
      kind: 'artifactChunk';
      slotId: string;
      contentLines: string[];
      finalChunk: boolean;
      editMatch?: KernelArtifactEditMatch;
    }
  | {
      kind: 'artifactFinalize';
      summary: string;
      narration?: string;
    };

export class SessionSemanticDirectiveError extends Error {
  readonly code = 'session_semantic_directive_invalid';
  readonly argumentsHash: string;
  readonly repairKey: string;
  readonly causeCode: string;

  constructor(
    readonly toolName: string,
    readonly callId: string,
    argumentsValue: Record<string, unknown>,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SessionSemanticDirectiveError';
    this.argumentsHash = stableHash(JSON.stringify(argumentsValue));
    this.repairKey = semanticRepairKey(toolName, argumentsValue);
    this.causeCode = errorCode(cause);
  }
}

function errorCode(value: unknown): string {
  if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string') {
    return value.code;
  }
  return 'semantic_directive_invalid';
}

function semanticRepairKey(toolName: string, args: Record<string, unknown>): string {
  const slotId = stringValue(args.slotId);
  return slotId ? `${toolName}:${slotId}` : toolName;
}

export class SessionSemanticToolAdapter {
  constructor(
    private readonly profiles = new ProviderProfileRegistry(),
    private readonly compiler = new OperationIntentCompiler()
  ) {}

  directive(
    state: SessionSemanticToolState,
    toolCall: NativeToolCallProposal
  ): SessionSemanticDirective | null {
    const profile = this.profiles.profileForFrame(state.providerTurnFrame);
    if (!profile.tools.some((tool) => tool.name === toolCall.name)) return null;
    try {
      return this.admitRegisteredDirective(state, toolCall);
    } catch (error) {
      throw new SessionSemanticDirectiveError(toolCall.name, toolCall.callId, toolCall.arguments, error);
    }
  }

  deterministicCurrentTask(state: SessionSemanticToolState): ProposalEnvelope | undefined {
    return this.compiler.compileDeterministicDelete({
      sessionId: state.sessionId,
      runId: state.runId,
      acceptedPlan: state.acceptedTaskPlan,
    });
  }

  compileArtifacts(input: {
    state: SessionSemanticToolState;
    callId: string;
    directive: TaskArtifactDirective;
  }): ProposalEnvelope {
    return this.compiler.compileArtifacts({
      sessionId: input.state.sessionId,
      runId: input.state.runId,
      callId: input.callId,
      acceptedPlan: input.state.acceptedTaskPlan,
      directive: input.directive,
    });
  }

  private admitRegisteredDirective(
    state: SessionSemanticToolState,
    toolCall: NativeToolCallProposal
  ): SessionSemanticDirective | null {
    const args = toolCall.arguments;
    if (toolCall.name === 'session.request_resources') {
      return this.proposalDirective(this.envelope(state, toolCall, 'resourceRequest', resourcePayload(state, toolCall.callId, args)));
    }
    if (toolCall.name === 'session.request_decision') {
      return this.proposalDirective(this.envelope(state, toolCall, 'decisionRequest', decisionPayload(toolCall.callId, args)));
    }
    if (toolCall.name === 'session.submit_plan') {
      const proposal = this.envelope(state, toolCall, 'taskPlan', planPayload(toolCall.callId, args));
      return this.proposalDirective(proposal);
    }
    if (toolCall.name === 'session.submit_answer') {
      return this.proposalDirective(this.envelope(state, toolCall, 'answer', answerPayload(args)));
    }
    if (toolCall.name === 'session.report_diagnostic') {
      return this.proposalDirective(this.envelope(state, toolCall, 'diagnostic', diagnosticPayload(toolCall.callId, args)));
    }
    if (toolCall.name === 'session.submit_task_outcome') {
      return taskOutcomeDirective(args);
    }
    if (toolCall.name === 'session.append_artifact_chunk') {
      const contentLines = optionalStringArray(args.contentLines);
      if (!contentLines) throw new Error('session.append_artifact_chunk.contentLines must be a string array.');
      if (typeof args.finalChunk !== 'boolean') {
        throw new Error('session.append_artifact_chunk.finalChunk must be a boolean.');
      }
      return {
        kind: 'artifactChunk',
        slotId: requiredString(args.slotId, 'session.append_artifact_chunk.slotId'),
        contentLines,
        finalChunk: args.finalChunk,
        editMatch: parseArtifactEditMatch(args.editMatch),
      };
    }
    if (toolCall.name === 'session.finalize_task_artifacts') {
      return {
        kind: 'artifactFinalize',
        summary: requiredString(args.summary, 'session.finalize_task_artifacts.summary'),
        narration: stringValue(args.narration),
      };
    }
    return null;
  }

  private proposalDirective(proposal: ProposalEnvelope): SessionSemanticDirective {
    return { kind: 'proposal', proposal };
  }

  private envelope(
    state: SessionSemanticToolState,
    toolCall: NativeToolCallProposal,
    kind: ProposalEnvelopeKind,
    payload: unknown
  ): ProposalEnvelope {
    return {
      schemaVersion: 'deepcode.agent.protocol.v4',
      proposalId: `proposal-${toolCall.callId}`,
      runId: state.runId,
      sessionId: state.sessionId,
      source: 'llm',
      kind,
      responseLanguage: conversationLanguage(toolCall.arguments.responseLanguage)
        ?? conversationLanguage(state.userAuthorityFrame?.effectiveLanguage),
      narration: stringValue(toolCall.arguments.narration),
      payload,
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    };
  }
}

function taskOutcomeDirective(args: Record<string, unknown>): Extract<SessionSemanticDirective, { kind: 'taskOutcome' }> {
  if (args.outcome !== 'alreadySatisfied') {
    throw new Error('session.submit_task_outcome.outcome must be alreadySatisfied.');
  }
  const acceptanceResults = arrayRecords(args.acceptanceResults).map((result, index) => {
    const criterionIndex = positiveInteger(result.criterionIndex);
    if (!criterionIndex) {
      throw new Error(`session.submit_task_outcome.acceptanceResults[${index}].criterionIndex must be a positive integer.`);
    }
    if (result.status !== 'satisfied') {
      throw new Error(`session.submit_task_outcome.acceptanceResults[${index}].status must be satisfied.`);
    }
    return {
      criterionIndex,
      status: 'satisfied' as const,
      evidenceRefs: requiredStringArray(
        result.evidenceRefs,
        `session.submit_task_outcome.acceptanceResults[${index}].evidenceRefs`
      ),
    };
  });
  return {
    kind: 'taskOutcome',
    outcome: 'alreadySatisfied',
    summary: requiredString(args.summary, 'session.submit_task_outcome.summary'),
    evidenceRefs: requiredStringArray(args.evidenceRefs, 'session.submit_task_outcome.evidenceRefs'),
    acceptanceResults,
  };
}

function parseArtifactEditMatch(value: unknown): KernelArtifactEditMatch | undefined {
  if (value === undefined) return undefined;
  const record = objectRecord(value);
  if (!record) throw new Error('session.append_artifact_chunk.editMatch must be an object.');
  const kind = requiredString(record.kind, 'session.append_artifact_chunk.editMatch.kind');
  if (kind === 'exactBlock') {
    return {
      kind,
      targetLines: requiredStringArray(record.targetLines, 'editMatch.targetLines'),
    };
  }
  if (kind === 'contextBlock') {
    return {
      kind,
      beforeLines: requiredStringArray(record.beforeLines, 'editMatch.beforeLines', true),
      targetLines: requiredStringArray(record.targetLines, 'editMatch.targetLines'),
      afterLines: requiredStringArray(record.afterLines, 'editMatch.afterLines', true),
    };
  }
  if (kind === 'lineRange') {
    const startLine = positiveInteger(record.startLine);
    const endLine = positiveInteger(record.endLine);
    if (!startLine || !endLine) throw new Error('editMatch startLine and endLine must be positive integers.');
    if (endLine < startLine) throw new Error('editMatch.endLine must be greater than or equal to startLine.');
    const expectedFileHash = stringValue(record.expectedFileHash);
    const expectedBeforeLines = optionalStringArray(record.expectedBeforeLines);
    if (!expectedFileHash && !expectedBeforeLines?.length) {
      throw new Error('lineRange editMatch requires expectedFileHash or expectedBeforeLines.');
    }
    return {
      kind,
      startLine,
      endLine,
      ...(expectedFileHash ? { expectedFileHash } : {}),
      ...(expectedBeforeLines?.length ? { expectedBeforeLines } : {}),
    };
  }
  throw new Error(`Unsupported editMatch kind ${kind}.`);
}

function resourcePayload(
  state: SessionSemanticToolState,
  callId: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const requests = arrayRecords(args.requests);
  if (!requests.length) throw new Error('session.request_resources requires at least one request.');
  const roots = state.conversationRoots ?? [];
  const deterministicRoot = roots.find((root) => root.primary) ?? (roots.length === 1 ? roots[0] : undefined);
  return {
    version: '1',
    id: `resource-${callId}`,
    reason: requiredString(args.reason, 'session.request_resources.reason'),
    items: requests.map((request, index) => {
      const intentKind = requiredString(request.kind, `session.request_resources.requests[${index}].kind`);
      const path = stringValue(request.path) ?? stringValue(request.targetRef);
      const requestedRootId = stringValue(request.rootId);
      const query = stringValue(request.query);
      if (intentKind !== 'search' && !path) {
        throw new Error(`session.request_resources.requests[${index}] requires path or targetRef.`);
      }
      if (intentKind === 'search' && !query) {
        throw new Error(`session.request_resources.requests[${index}] requires query.`);
      }
      if (state.manifest?.projectId && state.manifest.projectKind === 'folder' && path && isAbsolutePath(path)) {
        throw new Error(
          `session.request_resources.requests[${index}] must use rootId plus a root-relative path for a bound Project workspace.`
        );
      }
      if (!requestedRootId && !deterministicRoot && roots.length > 1) {
        throw new Error(`session.request_resources.requests[${index}] requires rootId when multiple roots are available.`);
      }
      return {
        id: `resource-${callId}-${index + 1}`,
        kind: intentKind === 'directoryTree' ? 'directory' : intentKind === 'search' ? 'search' : 'file',
        ...(requestedRootId ?? deterministicRoot?.rootId
          ? { rootId: requestedRootId ?? deterministicRoot?.rootId }
          : {}),
        ...(path ? { path } : {}),
        ...(query ? { query } : {}),
        ...(stringArray(request.include).length ? { include: stringArray(request.include) } : {}),
        ...(nonNegativeInteger(request.offsetBytes) !== undefined ? { offsetBytes: nonNegativeInteger(request.offsetBytes) } : {}),
        ...(positiveInteger(request.limitBytes) !== undefined ? { limitBytes: positiveInteger(request.limitBytes) } : {}),
        ...(nonNegativeInteger(request.contextLines) !== undefined ? { contextLines: nonNegativeInteger(request.contextLines) } : {}),
        ...(positiveInteger(request.maxResults) !== undefined ? { maxResults: positiveInteger(request.maxResults) } : {}),
        reason: requiredString(request.reason, `session.request_resources.requests[${index}].reason`),
      };
    }),
  };
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value);
}

function decisionPayload(callId: string, args: Record<string, unknown>): Record<string, unknown> {
  const question = requiredString(args.question, 'session.request_decision.question');
  const options = arrayRecords(args.options);
  if (options.length < 2 || options.length > 3) {
    throw new Error('session.request_decision.options must contain two or three choices.');
  }
  return {
    version: '1',
    id: `decision-${callId}`,
    question,
    reason: question,
    summary: stringValue(args.summary) ?? question,
    allowsFreeform: args.allowsFreeform !== false,
    options: options.map((option, index) => ({
      id: requiredString(option.id, `session.request_decision.options[${index}].id`),
      label: requiredString(option.label, `session.request_decision.options[${index}].label`),
      description: requiredString(option.description, `session.request_decision.options[${index}].description`),
      recommended: option.recommended === true,
    })),
  };
}

function planPayload(callId: string, args: Record<string, unknown>): Record<string, unknown> {
  const tasks = arrayRecords(args.tasks);
  if (!tasks.length) throw new Error('session.submit_plan.tasks requires at least one task.');
  return {
    version: '1',
    id: `plan-${callId}`,
    title: requiredString(args.title, 'session.submit_plan.title'),
    summary: requiredString(args.summary, 'session.submit_plan.summary'),
    tasks: tasks.map((task, index) => {
      const targets = stringArray(task.target);
      if (!Array.isArray(task.dependencies)) {
        throw new Error(`session.submit_plan.tasks[${index}].dependencies must be a string array.`);
      }
      return {
        taskId: requiredString(task.taskId, `session.submit_plan.tasks[${index}].taskId`),
        title: requiredString(task.title, `session.submit_plan.tasks[${index}].title`),
        target: targets,
        toolId: requiredString(task.toolId, `session.submit_plan.tasks[${index}].toolId`),
        dependencies: stringArray(task.dependencies),
        args: requiredObject(task.args, `session.submit_plan.tasks[${index}].args`),
        acceptanceCriteria: stringArray(task.acceptanceCriteria),
        failureCriteria: stringArray(task.failureCriteria),
      };
    }),
    risks: stringArray(args.risks),
    reviewCheckpoints: stringArray(args.reviewCheckpoints),
  };
}

function answerPayload(args: Record<string, unknown>): Record<string, unknown> {
  return {
    version: '1',
    format: 'markdown',
    content: requiredString(args.content, 'session.submit_answer.content'),
  };
}

function diagnosticPayload(callId: string, args: Record<string, unknown>): Record<string, unknown> {
  const severity = stringValue(args.severity);
  if (!severity || !['info', 'warning', 'error'].includes(severity)) {
    throw new Error('session.report_diagnostic.severity is invalid.');
  }
  return {
    version: '1',
    id: `diagnostic-${callId}`,
    severity,
    summary: requiredString(args.summary, 'session.report_diagnostic.summary'),
    ...(stringValue(args.details) ? { details: stringValue(args.details) } : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`${field} must be a non-empty string.`);
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function conversationLanguage(value: unknown): ProposalEnvelope['responseLanguage'] {
  return value === 'zh-CN' || value === 'en-US' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return [...value];
}

function requiredStringArray(value: unknown, field: string, allowEmpty = false): string[] {
  const result = optionalStringArray(value);
  if (!result || (!allowEmpty && result.length === 0)) {
    throw new Error(`${field} must be ${allowEmpty ? 'a' : 'a non-empty'} string array.`);
  }
  return result;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  const result = objectRecord(value);
  if (!result) throw new Error(`${field} must be an object.`);
  return result;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
