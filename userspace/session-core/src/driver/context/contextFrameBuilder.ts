import type {
  ProviderContextFrame,
  ProviderProjectionVisibility,
  ProviderRepairPolicy,
  DriverProviderTurnFrame,
  ProviderTurnMode,
  ToolIntentTemplate,
} from '../runFrame.js';
import type { CurrentTaskContext } from '../../accepted-plan/index.js';
import {
  resourceEvidenceAccessIndexLine,
  resourceEvidenceContentKindCounts,
  resourceEvidenceCurrentTaskCoverageLines,
} from '../../context/index.js';
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
    acceptanceCriteria?: string[];
    failureCriteria?: string[];
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
    const acceptedExecution = input.turnMode === 'acceptedTaskExecution';
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
        use: 'Defines the registered Session semantic tools for this provider profile.',
        summary: 'Use exactly one registered Session semantic tool for the next directive.',
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
        source: acceptedExecution ? 'session' : 'user',
        trust: acceptedExecution ? 'sessionInstruction' : 'userConfirmedFact',
        use: acceptedExecution
          ? 'Sanitized accepted-plan execution context; original user request is a source reference only.'
          : 'Current dynamic user turn and dialogue-local instructions.',
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
      `contentKinds=${resourceEvidenceContentKindCounts(contextAssembly.resourceBlocks) || 'none'}`,
      'resourceBlockDetails=see AccessIndex frame',
    ].join('; ');
  }

  private accessIndexSummary(contextAssembly: ContextAssemblyRecord | undefined): string {
    if (!contextAssembly) return 'No access index is available for this turn.';
    const lines = [
      `resourceBlocks=${contextAssembly.resourceBlocks.length}`,
      `full=${contextAssembly.resourceRetentionCounts.full ?? 0}`,
      `summary=${contextAssembly.resourceRetentionCounts.summary ?? 0}`,
      `handleOnly=${contextAssembly.resourceRetentionCounts.handleOnly ?? 0}`,
      `denied=${contextAssembly.resourceRetentionCounts.denied ?? 0}`,
      `error=${contextAssembly.resourceRetentionCounts.error ?? 0}`,
    ];
    lines.push(...contextAssembly.resourceBlocks.slice(-12).map((block) => resourceEvidenceAccessIndexLine(block)));
    return lines.join('\n');
  }

  private providerStepSummary(input: BuildProviderTurnContractInput): string {
    return [
      `turnMode=${input.turnMode}`,
      `resourceRefs=${input.resourceEvidenceRefs?.length ?? 0}`,
      `intentSlots=${input.toolIntentTemplates?.length ?? 0}`,
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
      acceptanceCriteria: [...(context.acceptanceCriteria ?? [])],
      failureCriteria: [...(context.failureCriteria ?? [])],
    };
  }

  private accessSummary(input: BuildSessionProviderTurnContractInput): string | undefined {
    const resourcePacketCount = input.resourcePackets?.length ?? 0;
    const generatedArtifactCount = input.generatedArtifactCount ?? 0;
    const resourceBlocks = input.contextAssembly?.resourceBlocks ?? [];
    if (resourcePacketCount === 0 && generatedArtifactCount === 0 && resourceBlocks.length === 0) return undefined;
    const lines = [
      `resourcePackets=${resourcePacketCount}`,
      `generatedArtifacts=${generatedArtifactCount}`,
      `currentTask=${input.currentTaskContext?.taskId ?? 'none'}`,
      `accessedResources=${resourceBlocks.length}`,
    ];
    lines.push(...resourceBlocks.slice(-12).map((block) => resourceEvidenceAccessIndexLine(block)));
    lines.push(...resourceEvidenceCurrentTaskCoverageLines(resourceBlocks, input.currentTaskContext?.targets ?? []));
    return lines.join('\n');
  }

  private nextActionInstruction(
    acceptedPlanActive: boolean | undefined,
    currentTaskContext: CurrentTaskContext | undefined,
    allowedKinds: string[]
  ): string {
    if (acceptedPlanActive || currentTaskContext) {
      return [
        'Use the current task cursor only.',
        'Use exactly one registered execution semantic tool.',
        'Use TaskFrame and IntentSlot values as the complete current-task boundary; do not import unrelated targets from the original user request, plan summary, memory, or later tasks.',
        'If every current IntentSlot has evidenceRequirement=none, submit the current artifacts directly; do not read the target or parent directory merely to confirm that the operation may begin.',
        'If generated content is needed and evidence is sufficient, append one logically coherent file or code section through session.append_artifact_chunk. Small files may use one call; larger files may use multiple class, function, script, or configuration-section calls. Do not count lines or bytes. Call session.finalize_task_artifacts only after all current slots are complete.',
        'If fresh task-scoped evidence proves every acceptance criterion is already satisfied, use session.submit_task_outcome instead of emitting empty artifacts or a diagnostic.',
        'If evidence is missing, call session.request_resources with a focused resource intent.',
        'If AccessIndex currentTaskEvidence reports covered=true for the current target, use that evidence instead of repeating the same resourceRequest; request only a different range/search when exact missing content would change the action.',
        'Session and Kernel handle execution scope and permission interrupts; do not submit permission fields.',
        'If neither a valid current-task action nor a fresh-evidence task outcome applies, call session.request_decision for a recoverable user choice or session.report_diagnostic for a terminal failure.',
        'Keep visible reasoning/progress action-oriented: state the current action or task outcome, not protocol, tool, permission, or evidence-policy deliberation.',
      ].join(' ');
    }
    return [
      'Use exactly one registered planning semantic tool.',
      'If ResourceEvidence or AccessIndex is enough to form a useful plan or answer, call session.submit_plan or session.submit_answer now.',
      'Call session.request_resources only for missing concrete evidence that would change the next directive.',
      'Call session.request_decision only when a blocking user choice prevents any valid plan; put reviewable assumptions in plan risks or review checkpoints.',
      'For delete or cleanup plans, target only paths visible in ResourceEvidence/AccessIndex or explicitly named by the current user or ConfirmedDecision.',
      'Decide from the current frames; do not re-audit protocol rules, permission gates, resource policy, or unrelated prior requirements in reasoning.',
      'Keep visible reasoning/progress action-oriented: state the current action or proposal, not protocol, tool, permission, or evidence-policy deliberation.',
      'Do not infer execution facts or permissions from memory.',
    ].join(' ');
  }

}
