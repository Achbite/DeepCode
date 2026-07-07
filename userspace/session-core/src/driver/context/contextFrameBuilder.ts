import type {
  ProviderContextFrame,
  ProviderProjectionVisibility,
  ProviderRepairPolicy,
  DriverProviderTurnFrame,
  ProviderTurnMode,
  ToolIntentTemplate,
} from '../runFrame.js';
import type { CurrentTaskContext } from '../../accepted-plan/index.js';
import type { ContextAssemblyRecord } from '../../context/index.js';
import type { ResourcePacket } from '../../context/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';

export interface BuildProviderTurnContractInput {
  contractId: string;
  sessionId: string;
  runId: string;
  turnMode: ProviderTurnMode;
  allowedKinds: string[];
  requiredKind?: string;
  prompt: PromptEnvelope;
  contextAssembly?: ContextAssemblyRecord;
  userRequest: string;
  currentTask?: {
    taskId?: string;
    title?: string;
    goal?: string;
    targets?: string[];
  };
  resourceEvidenceRefs?: string[];
  accessSummary?: string;
  confirmedDecisionSummary?: string;
  errorSummary?: string;
  toolIntentTemplates?: ToolIntentTemplate[];
  repairPolicy?: ProviderRepairPolicy;
  projectionVisibility?: ProviderProjectionVisibility;
  nextActionInstruction: string;
}

export interface BuildSessionProviderTurnContractInput {
  contractId: string;
  sessionId: string;
  runId: string;
  turnMode?: ProviderTurnMode;
  allowedKinds: string[];
  requiredKind?: string;
  prompt: PromptEnvelope;
  contextAssembly?: ContextAssemblyRecord;
  userRequest: string;
  confirmedDecisionSummary?: string;
  errorSummary?: string;
  acceptedPlanActive?: boolean;
  currentTaskContext?: CurrentTaskContext;
  resourcePackets?: ResourcePacket[];
  generatedArtifactCount?: number;
  toolIntentTemplates?: ToolIntentTemplate[];
  repairPolicy?: ProviderRepairPolicy;
  projectionVisibility?: ProviderProjectionVisibility;
  nextActionInstruction?: string;
}

export class ContextFrameBuilder {
  buildProviderTurnContract(input: BuildProviderTurnContractInput): DriverProviderTurnFrame {
    const frames: ProviderContextFrame[] = [
      {
        kind: 'SystemContract',
        source: 'system',
        trust: 'contract',
        use: 'Stable operating rules already rendered in the prompt envelope.',
        summary: 'System-level provider contract.',
      },
      {
        kind: 'ProtocolContract',
        source: 'protocol',
        trust: 'contract',
        use: 'Defines the allowed structured proposal kinds for this turn.',
        summary: `Allowed kinds: ${input.allowedKinds.join(', ')}`,
      },
      {
        kind: 'MemoryPlaceholder',
        source: 'memory',
        trust: 'compressedReference',
        use: 'Reference only; not an execution fact, permission grant, or patch evidence.',
        summary: this.memorySummary(input.contextAssembly),
      },
      {
        kind: 'DynamicDialogue',
        source: 'user',
        trust: 'userConfirmedFact',
        use: 'Current dynamic user turn and dialogue-local instructions.',
        summary: input.userRequest,
      },
    ];

    if (input.confirmedDecisionSummary) {
      frames.push({
        kind: 'ConfirmedDecision',
        source: 'decision',
        trust: 'userConfirmedFact',
        use: 'A user-confirmed choice that may constrain the current turn.',
        summary: input.confirmedDecisionSummary,
      });
    }

    if (input.currentTask) {
      frames.push({
        kind: 'TaskFrame',
        source: 'session',
        trust: 'sessionInstruction',
        use: 'Current task cursor. Do not plan unrelated tasks from this frame.',
        summary: input.currentTask.goal ?? input.currentTask.title ?? input.currentTask.taskId,
        data: input.currentTask,
      });
    }

    frames.push({
      kind: 'ResourceEvidence',
      source: 'kernel',
      trust: 'kernelObservedFact',
      use: 'Read/list/search facts available to the provider. Exact edits still require matching evidence.',
      refs: input.resourceEvidenceRefs,
      summary: this.resourceEvidenceSummary(input.contextAssembly),
    });

    frames.push({
      kind: 'AccessIndex',
      source: 'derived',
      trust: 'derivedObservedFact',
      use: 'Index of already accessed resources; not a permission grant or exact patch evidence.',
      summary: input.accessSummary ?? this.accessIndexSummary(input.contextAssembly),
    });

    frames.push({
      kind: 'HookContext',
      source: 'session',
      trust: 'sessionInstruction',
      use: 'Observer hook state for this provider turn. Hooks cannot change prompt, tools, Kernel facts, or projection facts.',
      summary: 'Hook observer mode is enabled for developer trace only.',
    });

    frames.push({
      kind: 'ProviderStepSummary',
      source: 'session',
      trust: 'sessionInstruction',
      use: 'Summarizes this provider step without adding execution facts.',
      summary: this.providerStepSummary(input),
    });

    if (input.errorSummary) {
      frames.push({
        kind: 'ErrorContext',
        source: 'error',
        trust: 'diagnostic',
        use: 'Use this to repair the current turn without changing task scope.',
        summary: input.errorSummary,
      });
    }

    const nextActionInstruction: ProviderContextFrame = {
      kind: 'NextActionInstruction',
      source: 'session',
      trust: 'sessionInstruction',
      use: 'Highest-priority dynamic instruction for this provider call.',
      summary: input.nextActionInstruction,
    };
    frames.push(nextActionInstruction);

    return {
      schemaVersion: 'deepcode.session.provider-turn-contract.v1',
      contractId: input.contractId,
      sessionId: input.sessionId,
      runId: input.runId,
      turnMode: input.turnMode,
      allowedKinds: [...input.allowedKinds],
      requiredKind: input.requiredKind,
      frames,
      toolIntentTemplates: input.toolIntentTemplates ?? [],
      repairPolicy: input.repairPolicy ?? 'sameKindOnly',
      projectionVisibility: input.projectionVisibility ?? 'traceOnly',
      nextActionInstruction,
      prompt: input.prompt,
      contextAssembly: input.contextAssembly,
    };
  }

  buildSessionProviderTurnContract(input: BuildSessionProviderTurnContractInput): DriverProviderTurnFrame {
    return this.buildProviderTurnContract({
      contractId: input.contractId,
      sessionId: input.sessionId,
      runId: input.runId,
      turnMode: input.turnMode ?? this.turnMode(input.acceptedPlanActive, input.currentTaskContext, input.allowedKinds),
      allowedKinds: input.allowedKinds,
      requiredKind: input.requiredKind,
      prompt: input.prompt,
      contextAssembly: input.contextAssembly,
      userRequest: input.userRequest,
      confirmedDecisionSummary: input.confirmedDecisionSummary,
      errorSummary: input.errorSummary,
      currentTask: this.currentTask(input.currentTaskContext),
      resourceEvidenceRefs: (input.resourcePackets ?? []).map((packet) => packet.id),
      accessSummary: this.accessSummary(input),
      toolIntentTemplates: input.toolIntentTemplates,
      repairPolicy: input.repairPolicy,
      projectionVisibility: input.projectionVisibility,
      nextActionInstruction:
        input.nextActionInstruction ??
        this.nextActionInstruction(input.acceptedPlanActive, input.currentTaskContext, input.allowedKinds),
    });
  }

  private memorySummary(contextAssembly: ContextAssemblyRecord | undefined): string {
    if (!contextAssembly) return 'No context assembly metadata is available for this turn.';
    return [
      `memorySourceEvents=${contextAssembly.memorySourceEventCount}`,
      `projectMode=${contextAssembly.projectMemoryMode ?? 'unspecified'}`,
      `providerVisibleTokens=${contextAssembly.providerVisibleTokenEstimate}`,
    ].join('; ');
  }

  private resourceEvidenceSummary(contextAssembly: ContextAssemblyRecord | undefined): string {
    if (!contextAssembly) return 'No resource evidence has been assembled for this turn.';
    return [
      `resourcePackets=${contextAssembly.resourcePacketCount}`,
      `resourceBlocks=${contextAssembly.resourceBlocks.length}`,
      `tailCount=${contextAssembly.resourceEvidenceTailCount}`,
    ].join('; ');
  }

  private accessIndexSummary(contextAssembly: ContextAssemblyRecord | undefined): string {
    if (!contextAssembly) return 'No access index is available for this turn.';
    return [
      `resourceBlocks=${contextAssembly.resourceBlocks.length}`,
      `full=${contextAssembly.resourceRetentionCounts.full ?? 0}`,
      `summary=${contextAssembly.resourceRetentionCounts.summary ?? 0}`,
      `handleOnly=${contextAssembly.resourceRetentionCounts.handleOnly ?? 0}`,
    ].join('; ');
  }

  private providerStepSummary(input: BuildProviderTurnContractInput): string {
    return [
      `turnMode=${input.turnMode}`,
      `allowedKinds=${input.allowedKinds.join(', ') || 'none'}`,
      `requiredKind=${input.requiredKind ?? 'none'}`,
      `resourceRefs=${input.resourceEvidenceRefs?.length ?? 0}`,
      `toolIntents=${input.toolIntentTemplates?.length ?? 0}`,
    ].join('; ');
  }

  private turnMode(
    acceptedPlanActive: boolean | undefined,
    currentTaskContext: CurrentTaskContext | undefined,
    allowedKinds: string[]
  ): ProviderTurnMode {
    if (acceptedPlanActive || currentTaskContext) return 'acceptedTaskExecution';
    if (allowedKinds.length === 1 && allowedKinds[0] === 'decisionRequest') return 'requirementDecision';
    if (allowedKinds.length === 1 && allowedKinds[0] === 'answer') return 'reviewAnswer';
    return 'planning';
  }

  private currentTask(context: CurrentTaskContext | undefined): BuildProviderTurnContractInput['currentTask'] {
    if (!context) return undefined;
    return {
      taskId: context.taskId,
      title: context.taskTitle,
      goal: context.goal,
      targets: [...context.targets],
    };
  }

  private accessSummary(input: BuildSessionProviderTurnContractInput): string | undefined {
    const resourcePacketCount = input.resourcePackets?.length ?? 0;
    const generatedArtifactCount = input.generatedArtifactCount ?? 0;
    if (resourcePacketCount === 0 && generatedArtifactCount === 0) return undefined;
    return [
      `resourcePackets=${resourcePacketCount}`,
      `generatedArtifacts=${generatedArtifactCount}`,
      `currentTask=${input.currentTaskContext?.taskId ?? 'none'}`,
    ].join('; ');
  }

  private nextActionInstruction(
    acceptedPlanActive: boolean | undefined,
    currentTaskContext: CurrentTaskContext | undefined,
    allowedKinds: string[]
  ): string {
    if (acceptedPlanActive || currentTaskContext) {
      return [
        'Use the current task cursor only.',
        `Allowed proposal kinds: ${allowedKinds.join(', ')}.`,
        'If file changes are needed and evidence is sufficient, return an actionBundle for the current task.',
        'If evidence is missing, return a focused resourceRequest.',
        'If the current task needs targets or operations outside the accepted scope, return a decisionRequest.',
        'If the current task is already sufficiently satisfied and no Kernel action is needed, return taskOutcome with status="modelJudgedSufficient".',
      ].join(' ');
    }
    return [
      `Allowed proposal kinds: ${allowedKinds.join(', ')}.`,
      'Choose the proposal kind that matches the current user request and Kernel state contract.',
      'Do not infer execution facts or permissions from memory.',
    ].join(' ');
  }
}
