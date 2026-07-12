import type { AcceptedImplementationPlanContext } from '../accepted-plan/types.js';
import type { ProposalEnvelope, ProposalEnvelopeKind } from '../protocol/types.js';
import type { DriverProviderTurnFrame } from '../driver/runFrame.js';
import type { NativeToolCallProposal } from './providerStreamParts.js';
import { OperationIntentCompiler, type TaskArtifactDirective } from '../driver/execution/operationIntentCompiler.js';
import { ProviderProfileRegistry } from './ProviderProfileRegistry.js';
import { stableHash } from '../cache/canonicalizer.js';

export interface SessionSemanticToolState {
  readonly sessionId: string;
  readonly runId: string;
  readonly providerTurnFrame?: DriverProviderTurnFrame;
  readonly acceptedImplementationPlan?: AcceptedImplementationPlanContext;
}

export class SessionSemanticDirectiveError extends Error {
  readonly code = 'session_semantic_directive_invalid';
  readonly argumentsHash: string;

  constructor(
    readonly toolName: string,
    readonly callId: string,
    argumentsValue: Record<string, unknown>,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SessionSemanticDirectiveError';
    this.argumentsHash = stableHash(JSON.stringify(argumentsValue));
  }
}

export class SessionSemanticToolAdapter {
  constructor(
    private readonly profiles = new ProviderProfileRegistry(),
    private readonly compiler = new OperationIntentCompiler()
  ) {}

  proposal(
    state: SessionSemanticToolState,
    toolCall: NativeToolCallProposal
  ): ProposalEnvelope | null {
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
      acceptedPlan: state.acceptedImplementationPlan,
    });
  }

  private admitRegisteredDirective(
    state: SessionSemanticToolState,
    toolCall: NativeToolCallProposal
  ): ProposalEnvelope | null {
    const args = toolCall.arguments;
    if (toolCall.name === 'session.request_resources') {
      return this.envelope(state, toolCall, 'resourceRequest', resourcePayload(toolCall.callId, args));
    }
    if (toolCall.name === 'session.request_decision') {
      return this.envelope(state, toolCall, 'decisionRequest', decisionPayload(toolCall.callId, args));
    }
    if (toolCall.name === 'session.submit_plan') {
      return this.envelope(state, toolCall, 'taskPlan', planPayload(toolCall.callId, args));
    }
    if (toolCall.name === 'session.submit_answer') {
      return this.envelope(state, toolCall, 'answer', answerPayload(args));
    }
    if (toolCall.name === 'session.report_diagnostic') {
      return this.envelope(state, toolCall, 'diagnostic', diagnosticPayload(toolCall.callId, args));
    }
    if (toolCall.name === 'session.complete_current_task') {
      return this.envelope(
        state,
        toolCall,
        'taskOutcome',
        taskOutcomePayload(toolCall.callId, args, activeTaskId(state.acceptedImplementationPlan))
      );
    }
    if (toolCall.name === 'session.submit_task_artifacts') {
      return this.compiler.compileArtifacts({
        sessionId: state.sessionId,
        runId: state.runId,
        callId: toolCall.callId,
        acceptedPlan: state.acceptedImplementationPlan,
        directive: taskArtifactDirective(args),
      });
    }
    return null;
  }

  private envelope(
    state: SessionSemanticToolState,
    toolCall: NativeToolCallProposal,
    kind: ProposalEnvelopeKind,
    payload: unknown
  ): ProposalEnvelope {
    return {
      schemaVersion: 'deepcode.agent.protocol.v3',
      proposalId: `proposal-${toolCall.callId}`,
      runId: state.runId,
      sessionId: state.sessionId,
      source: 'llm',
      kind,
      narration: stringValue(toolCall.arguments.narration),
      payload,
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: kind === 'taskOutcome' ? stringArray(toolCall.arguments.evidenceRefs) : [],
    };
  }
}

function resourcePayload(callId: string, args: Record<string, unknown>): Record<string, unknown> {
  const requests = arrayRecords(args.requests);
  if (!requests.length) throw new Error('session.request_resources requires at least one request.');
  return {
    version: '1',
    id: `resource-${callId}`,
    reason: requiredString(args.reason, 'session.request_resources.reason'),
    items: requests.map((request, index) => {
      const intentKind = requiredString(request.kind, `session.request_resources.requests[${index}].kind`);
      const path = stringValue(request.path) ?? stringValue(request.targetRef);
      const query = stringValue(request.query);
      if (intentKind !== 'search' && !path) {
        throw new Error(`session.request_resources.requests[${index}] requires path or targetRef.`);
      }
      if (intentKind === 'search' && !query) {
        throw new Error(`session.request_resources.requests[${index}] requires query.`);
      }
      return {
        id: `resource-${callId}-${index + 1}`,
        kind: intentKind === 'directoryTree' ? 'directory' : intentKind === 'search' ? 'search' : 'file',
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
      const operation = requiredString(task.operation, `session.submit_plan.tasks[${index}].operation`);
      const targets = stringArray(task.targets);
      return {
        taskId: requiredString(task.taskId, `session.submit_plan.tasks[${index}].taskId`),
        title: requiredString(task.title, `session.submit_plan.tasks[${index}].title`),
        target: targets,
        capability: capabilityForOperation(operation),
        semanticOperation: operation,
        dependencies: [],
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

function taskOutcomePayload(
  callId: string,
  args: Record<string, unknown>,
  taskId: string | undefined
): Record<string, unknown> {
  if (!taskId) throw new Error('session.complete_current_task requires an active accepted task.');
  return {
    version: '1',
    id: `outcome-${callId}`,
    taskId,
    status: 'modelJudgedSufficient',
    reason: requiredString(args.reason, 'session.complete_current_task.reason'),
    evidenceRefs: stringArray(args.evidenceRefs),
  };
}

function taskArtifactDirective(args: Record<string, unknown>): TaskArtifactDirective {
  const artifacts = arrayRecords(args.artifacts);
  if (!artifacts.length) throw new Error('session.submit_task_artifacts.artifacts requires at least one artifact.');
  return {
    summary: requiredString(args.summary, 'session.submit_task_artifacts.summary'),
    narration: stringValue(args.narration),
    artifacts: artifacts.map((artifact, index) => ({
      slotId: requiredString(artifact.slotId, `session.submit_task_artifacts.artifacts[${index}].slotId`),
      contentLines: optionalStringArray(artifact.contentLines),
      matchText: stringValue(artifact.matchText),
      replacementLines: optionalStringArray(artifact.replacementLines),
      argv: optionalStringArray(artifact.argv),
      cwd: stringValue(artifact.cwd),
      timeoutMs: positiveInteger(artifact.timeoutMs),
    })),
  };
}

function activeTaskId(acceptedPlan: AcceptedImplementationPlanContext | undefined): string | undefined {
  if (!acceptedPlan) return undefined;
  const completed = new Set(acceptedPlan.completedTaskIds ?? []);
  return (acceptedPlan.tasks ?? []).find((task) => !completed.has(task.taskId))?.taskId;
}

function capabilityForOperation(operation: string): string {
  if (operation === 'createFile' || operation === 'replaceFile') return 'fs.write';
  if (operation === 'patchFile') return 'fs.patch';
  if (operation === 'deletePath') return 'fs.delete';
  if (operation === 'runProcess' || operation === 'verifyResult') return 'process.exec';
  if (operation === 'inspectResource') return 'fs.read';
  throw new Error(`session.submit_plan task operation is unsupported: ${operation}`);
}

function requiredString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`${field} must be a non-empty string.`);
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
