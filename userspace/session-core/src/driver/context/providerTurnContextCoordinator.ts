import type { AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import type { CurrentTaskContext, TaskExecutionCursor } from '../../accepted-plan/index.js';
import type {
  ContextAssemblyInput,
  ContextAssemblyRecord,
  ContextAssemblyResult,
  PromptCachePlan,
  ProjectMemoryMode,
  SessionMemoryDocument,
} from '../../context/index.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ResourcePacket,
} from '../../context/types.js';
import type { RequirementRecord } from '../../requirement/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { HookInput, HookResult } from '../hooks/index.js';
import type { DriverProviderTurnFrame, ModelContextBundle, ProviderTurnSnapshot, ToolIntentTemplate } from '../runFrame.js';
import { SessionDriverProviderRuntimeAccessor } from '../runFrame.js';
import { buildProviderTurnSnapshot } from './providerTurnSnapshot.js';

export interface ProviderTurnContextState {
  sessionId: string;
  runId: string;
  userRequest: string;
  stateContract?: {
    stateId?: string;
    allowedProposals?: string[];
  };
  driverRequest?: {
    kind?: string;
  };
  memoryDocument?: SessionMemoryDocument;
  initialContext?: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  conversationRoots: ConversationResourceRoot[];
  currentTaskContext?: CurrentTaskContext;
  taskExecutionCursor?: TaskExecutionCursor;
  acceptedImplementationPlan?: unknown;
  implementationBatch?: unknown;
  generatedArtifactEvidence: Map<string, unknown>;
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  providerTurnFrame?: DriverProviderTurnFrame;
  modelContextBundle?: ModelContextBundle;
}

export interface ProviderTurnContextInput {
  contextAssemblyId: string;
  contractId: string;
  inputContent: string;
  projectMemoryMode?: ProjectMemoryMode;
  interventionLevel?: ContextAssemblyInput['interventionLevel'];
  confirmedRequirement?: RequirementRecord;
  lastResult: AgentSessionResult;
}

export interface ProviderTurnContextResult {
  prompt: PromptEnvelope;
  allowedProposals: string[];
  lastResult: AgentSessionResult;
  modelContextBundle: ModelContextBundle;
}

export interface ProviderTurnContextCoordinatorPorts<State extends ProviderTurnContextState> {
  now(): string;
  createId(prefix: string): string;
  assembleContext(input: ContextAssemblyInput): ContextAssemblyResult;
  allowedProposals(kernelAllowed: string[], state: State): string[];
  capabilityCatalogSummary(state: State): string;
  memoryHints(state: State): string[];
  collectUserGuidanceEvents(events: AgentEvent[], runId: string): ContextAssemblyInput['userGuidance'];
  appendConsumedGuidance(input: {
    sessionId: string;
    result: AgentSessionResult;
    consumedIds: string[];
    runId: string;
    appliedAtProviderStage: string;
    userRequest: string;
  }): Promise<AgentSessionResult>;
  buildProviderTurnContract(input: {
    contractId: string;
    sessionId: string;
    runId: string;
    allowedKinds: string[];
    prompt: PromptEnvelope;
    contextAssembly?: ContextAssemblyRecord;
    userRequest: string;
    confirmedDecisionSummary?: string;
    acceptedPlanActive: boolean;
    currentTaskContext?: CurrentTaskContext;
    resourcePackets: ResourcePacket[];
    generatedArtifactCount: number;
    toolIntentTemplates?: ToolIntentTemplate[];
    nextActionInstruction?: string;
  }): DriverProviderTurnFrame;
  runHook?(input: HookInput): Promise<HookResult[]>;
}

export class ProviderTurnContextCoordinator<State extends ProviderTurnContextState> {
  constructor(private readonly ports: ProviderTurnContextCoordinatorPorts<State>) {}

  async prepare(state: State, input: ProviderTurnContextInput): Promise<ProviderTurnContextResult> {
    const kernelAllowedProposals = this.ports.allowedProposals(state.stateContract?.allowedProposals ?? [
      'answer',
      'resourceRequest',
      'decisionRequest',
      'taskPlan',
      'actionBundle',
      'diagnostic',
    ], state);
    const acceptedExecution = Boolean(state.acceptedImplementationPlan || state.currentTaskContext);
    const allowedProposals = providerVisibleAllowedProposals(kernelAllowedProposals, acceptedExecution);
    const providerUserRequest = this.providerVisibleUserRequest(state, input.inputContent);
    const userGuidance = this.ports.collectUserGuidanceEvents(input.lastResult.events, state.runId);

    const assembledContext = this.ports.assembleContext({
      contextAssemblyId: input.contextAssemblyId,
      workflowState: state.stateContract?.stateId ?? state.driverRequest?.kind ?? 'needProposal',
      allowedProposals,
      capabilityCatalogSummary: this.ports.capabilityCatalogSummary(state),
      memoryDocument: acceptedExecution ? undefined : state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
      extraMemoryHints: this.ports.memoryHints(state),
      interventionLevel: input.interventionLevel,
      userGuidance,
      userRequest: providerUserRequest,
      currentTaskGoal: state.currentTaskContext?.goal,
      currentTaskContext: state.currentTaskContext,
      taskCursor: state.taskExecutionCursor,
      initialContext: state.initialContext,
      resourcePackets: state.resourcePackets,
      conversationRoots: state.conversationRoots,
      requirement: input.confirmedRequirement,
      auditOnly: {
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });

    const runtime = new SessionDriverProviderRuntimeAccessor(state);

    const lastResult = await this.ports.appendConsumedGuidance({
      sessionId: state.sessionId,
      result: input.lastResult,
      consumedIds: assembledContext.contextAssembly.consumedUserGuidanceIds ?? [],
      runId: state.runId,
      appliedAtProviderStage: 'provider_call',
      userRequest: state.userRequest,
    });
    const prompt = assembledContext.prompt;
    // ProviderTurnContract and PromptEnvelope must share one ContextAdmission assembly.
    const providerTurnFrame = this.ports.buildProviderTurnContract({
      contractId: input.contractId,
      sessionId: state.sessionId,
      runId: state.runId,
      allowedKinds: allowedProposals,
      prompt,
      contextAssembly: assembledContext.contextAssembly,
      userRequest: providerUserRequest,
      confirmedDecisionSummary: this.confirmedDecisionSummary(userGuidance, input.confirmedRequirement),
      acceptedPlanActive: Boolean(state.acceptedImplementationPlan),
      currentTaskContext: state.currentTaskContext,
      resourcePackets: state.resourcePackets,
      generatedArtifactCount: state.generatedArtifactEvidence.size,
      toolIntentTemplates: this.currentTaskToolIntentTemplates(state),
      nextActionInstruction: this.nextActionInstruction(state, input.confirmedRequirement, allowedProposals),
    });
    const snapshot = buildProviderTurnSnapshot(providerTurnFrame);
    const hookTrace = await this.runContextAdmissionHook(providerTurnFrame, snapshot);
    const providerTurnFrameWithSnapshot = {
      ...providerTurnFrame,
      snapshot,
      hookTrace,
    };
    const modelContextBundle = runtime.applyModelContext({
      prompt,
      cachePlan: assembledContext.cachePlan,
      contextAssembly: assembledContext.contextAssembly,
      providerTurnFrame: providerTurnFrameWithSnapshot,
      snapshot,
      hookTrace,
    });

    return {
      prompt,
      allowedProposals,
      lastResult,
      modelContextBundle,
    };
  }

  private async runContextAdmissionHook(
    frame: DriverProviderTurnFrame,
    snapshot: ProviderTurnSnapshot
  ): Promise<HookResult[]> {
    return this.ports.runHook?.({
      point: 'contextAdmission.after',
      sessionId: frame.sessionId,
      runId: frame.runId,
      contractId: frame.contractId,
      turnMode: frame.turnMode,
      allowedKinds: frame.allowedKinds,
      snapshot,
    }) ?? [];
  }

  private providerVisibleUserRequest(state: State, inputContent: string): string {
    if (!state.acceptedImplementationPlan) return inputContent;
    const accepted = objectRecord(state.acceptedImplementationPlan);
    const planId = stringValue(accepted?.planId) ?? 'unknown';
    const title = stringValue(accepted?.title);
    const summary = stringValue(accepted?.summary);
    const currentTask = objectRecord(state.currentTaskContext);
    const taskId = stringValue(currentTask?.taskId) ?? 'none';
    const taskTitle = stringValue(currentTask?.taskTitle);
    const targets = stringArray(currentTask?.targets);
    const completedCount = Array.isArray(accepted?.completedTaskIds) ? accepted.completedTaskIds.length : 0;
    const taskCount = Array.isArray(accepted?.tasks) ? accepted.tasks.length : 0;
    return [
      'Accepted execution sanitized context.',
      'ConfirmedPlan is active. The original user request is retained by Session as a source reference and is not re-expanded in this execution turn.',
      `ConfirmedPlan: planId=${planId}${title ? `; title=${oneLine(title, 240)}` : ''}${summary ? `; summary=${oneLine(summary, 360)}` : ''}`,
      `TaskLedger: completedByKernelFacts=${completedCount}; totalTasks=${taskCount}`,
      `CurrentTaskFrame: taskId=${taskId}${taskTitle ? `; title=${oneLine(taskTitle, 240)}` : ''}${targets.length ? `; targets=${targets.join(', ')}` : ''}`,
      'Use TaskFrame, ResourceEvidence, AccessIndex, ErrorContext, and NextActionInstruction as the execution authority for this turn.',
    ].join('\n');
  }

  private confirmedDecisionSummary(
    guidance: ContextAssemblyInput['userGuidance'],
    requirement: RequirementRecord | undefined
  ): string | undefined {
    const lines = (guidance ?? [])
      .filter((item) => item.source === 'decision' || item.source === 'review' || item.checkpointKind === 'permission')
      .slice(-6)
      .map((item) => `id=${item.id}; source=${item.source}; checkpoint=${item.checkpointKind}; content=${oneLine(item.content, 500)}`);
    if (requirement?.status === 'confirmed') {
      lines.push(`requirementId=${requirement.requirementId}; status=confirmed`);
    }
    return lines.length ? lines.join('\n') : undefined;
  }

  private nextActionInstruction(
    state: State,
    requirement: RequirementRecord | undefined,
    allowedProposals: string[]
  ): string | undefined {
    if (state.acceptedImplementationPlan || state.currentTaskContext) return undefined;
    if (requirement?.status !== 'confirmed') return undefined;
    return [
      'state=ConfirmedRequirementContinuation',
      `confirmedRequirementId=${requirement.requirementId}`,
      `allowedOutputs=${allowedProposals.join(' | ') || 'none'}`,
      'The user has already resolved the previous decisionRequest. Do not repeat that intervention.',
      'Use the confirmed requirement and confirmed decision as the resolved current scope.',
      'Do not infer extra preserved/deleted/modified targets from memory or from ambiguous wording in the original request.',
      'Choose the narrowest valid next proposal from allowedOutputs.',
    ].join(' ');
  }

  private currentTaskToolIntentTemplates(state: State): ToolIntentTemplate[] {
    const currentTaskId = state.currentTaskContext?.taskId;
    if (!state.currentTaskContext) return [];
    const accepted = objectRecord(state.acceptedImplementationPlan);
    const grantTemplates = arrayRecords(accepted?.exactOperationGrants)
      .filter((grant) => {
        const sourceTaskId = stringValue(grant.sourceTaskId);
        return !currentTaskId || !sourceTaskId || sourceTaskId === currentTaskId;
      })
      .map((grant, index): ToolIntentTemplate | undefined => {
        const targetPath = stringValue(grant.targetRefPath) ?? stringValue(grant.targetPath);
        const capability = stringValue(grant.capability);
        const operation = stringValue(grant.operation) ?? capability;
        if (!targetPath || !operation) return undefined;
        const targetResourceKind = stringValue(grant.targetResourceKind);
        const recursive = grant.recursive === true;
        const args: Record<string, unknown> = { path: targetPath };
        if (operation === 'fs.delete' || capability === 'fs.delete') {
          args.targetKind = targetResourceKind === 'directory' ? 'directory' : 'file';
          args.recursive = args.targetKind === 'directory' || recursive;
        }
        return {
          intentId: `current-task-template-${index + 1}`,
          label: 'currentTaskActionTemplates',
          operation,
          targets: [targetPath],
          evidencePolicy: operation === 'fs.patch'
            ? 'Use ResourceEvidence exact text or request focused evidence before patching.'
            : 'Use only this current task template unless a decisionRequest expands scope.',
          template: {
            toolId: capability ?? operation,
            args,
          },
        };
      })
      .filter((template): template is ToolIntentTemplate => Boolean(template));
    if (grantTemplates.length) return grantTemplates;
    const targets = state.currentTaskContext.targets ?? [];
    const capabilities = state.currentTaskContext.capabilities ?? [];
    return capabilities.map((capability, index): ToolIntentTemplate => ({
      intentId: `current-task-template-${index + 1}`,
      label: 'currentTaskActionTemplates',
      operation: capability,
      targets,
      evidencePolicy: capability === 'fs.patch'
        ? 'Use ResourceEvidence exact text or request focused evidence before patching.'
        : 'Use only current task targets unless a decisionRequest expands scope.',
    }));
  }
}

export function providerVisibleAllowedProposals(
  allowedProposals: readonly string[],
  acceptedExecution: boolean
): string[] {
  const blocked = acceptedExecution
    ? new Set(['taskPlan', 'implementationPlan', 'reviewSummary'])
    : new Set(['actionBundle', 'taskOutcome', 'implementationPlan', 'reviewSummary']);
  return [...new Set(allowedProposals)].filter((kind) => !blocked.has(kind));
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(objectRecord(item)))
    : [];
}

function oneLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 3))}...` : normalized;
}
