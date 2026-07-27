import type { AgentEvent, AgentSessionResult, KernelToolCatalogSnapshot } from '@deepcode/protocol';
import type { CurrentTaskContext, TaskExecutionCursor } from '../../accepted-plan/index.js';
import type {
  ContextAssemblyInput,
  ContextAssemblyRecord,
  ContextAssemblyTaskLocalCompactRecord,
  ContextAssemblyResult,
  PromptCachePlan,
  ProjectMemoryMode,
  SessionMemoryDocument,
} from '../../context/index.js';
import {
  renderDynamicSessionMemoryHints,
  renderStableSessionMemoryHints,
} from '../../context/index.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ResourcePacket,
} from '../../context/types.js';
import type { RequirementRecord } from '../../requirement/types.js';
import {
  acceptedPlanSettledTaskIds,
  type AcceptedTaskPlanContext,
} from '../../accepted-plan/types.js';
import { dependencyFactsForTask } from '../../accepted-plan/TaskDependencyFacts.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { HookInput, HookResult } from '../hooks/index.js';
import type { DriverProviderTurnFrame, ModelContextBundle, ProviderTurnSnapshot, SessionDriverTaskResourceProgress, ToolIntentTemplate } from '../runFrame.js';
import { SessionDriverProviderRuntimeAccessor } from '../runFrame.js';
import { buildProviderTurnSnapshot } from './providerTurnSnapshot.js';
import { IntentSlotRegistry } from '../execution/intentSlot.js';
import { ProviderProfileRegistry } from '../../provider/ProviderProfileRegistry.js';
import type { UserAuthorityFrame } from './userAuthorityFrame.js';
import { latestExplicitUserContent } from './userAuthorityFrame.js';
import {
  preparePromptLedger,
  promptLedgerAuthorityFits,
} from '../../prompt/promptLedger.js';
import type { PromptLedgerState } from '../../prompt/promptLedger.js';
import { renderProviderTurnUserPrompt } from './providerTurnPromptRenderer.js';
import { stableHash } from '../../cache/canonicalizer.js';
import {
  buildProjectBootstrapSnapshot,
  renderProjectBootstrapSnapshot,
} from '../../prompt/projectBootstrap.js';
import type { AcceptedTaskReplanReason } from '../execution/artifactDraftReplanCoordinator.js';
import type { ActiveProviderContinuation } from '../pipelines/providerContinuationMessages.js';
import type { PendingProviderRetryAdmission } from '../pipelines/admittedProviderRequest.js';

export interface ProviderTurnContextState {
  sessionId: string;
  runId: string;
  workspaceScopeKey: string;
  userRequest: string;
  userAuthorityFrame: UserAuthorityFrame;
  promptLedger: PromptLedgerState;
  stateContract?: {
    stateId?: string;
    allowedProposals?: string[];
    toolCatalogSnapshot?: KernelToolCatalogSnapshot;
  };
  driverRequest?: {
    kind?: string;
    stateContract?: {
      toolCatalogSnapshot?: KernelToolCatalogSnapshot;
    };
  };
  memoryDocument?: SessionMemoryDocument;
  initialContext?: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  conversationRoots: ConversationResourceRoot[];
  currentTaskContext?: CurrentTaskContext;
  taskExecutionCursor?: TaskExecutionCursor;
  acceptedTaskPlan?: unknown;
  implementationBatch?: unknown;
  generatedArtifactEvidence: Map<string, unknown>;
  resourceRequestProgressByTask?: Map<string, SessionDriverTaskResourceProgress>;
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  taskLocalCompactRecords?: ContextAssemblyTaskLocalCompactRecord[];
  providerTurnFrame?: DriverProviderTurnFrame;
  modelContextBundle?: ModelContextBundle;
  semanticDirectiveErrorSummary?: string;
  taskPlanReplanReason?: AcceptedTaskReplanReason;
  activeProviderContinuation?: ActiveProviderContinuation;
  pendingProviderRetry?: PendingProviderRetryAdmission;
}

export interface ProviderTurnContextInput {
  contextAssemblyId: string;
  contractId: string;
  inputContent: string;
  projectMemoryMode?: ProjectMemoryMode;
  interventionLevel?: ContextAssemblyInput['interventionLevel'];
  confirmedRequirement?: RequirementRecord;
  priorUserGuidance?: readonly {
    id: string;
    content: string;
  }[];
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
  toolCatalogSummary(state: State): string;
  memoryHints(state: State): string[];
  collectUserGuidanceEvents(events: AgentEvent[], runId: string): ContextAssemblyInput['userGuidance'];
  appendConsumedGuidance(input: {
    sessionId: string;
    result: AgentSessionResult;
    consumedIds: string[];
    runId: string;
    appliedAtProviderStage: string;
    userRequest: string;
    language: UserAuthorityFrame['effectiveLanguage'];
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
    errorSummary?: string;
    acceptedPlanActive: boolean;
    currentTaskContext?: CurrentTaskContext;
    resourcePackets: ResourcePacket[];
    generatedArtifactCount: number;
    toolIntentTemplates?: ToolIntentTemplate[];
    nextActionInstruction?: string;
  }): DriverProviderTurnFrame;
  runHook?(input: HookInput): Promise<HookResult[]>;
  createError?(code: string, message: string): Error;
}

export class ProviderTurnContextCoordinator<State extends ProviderTurnContextState> {
  private readonly intentSlots = new IntentSlotRegistry();
  private readonly profiles = new ProviderProfileRegistry();

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
    const acceptedExecution = Boolean(state.acceptedTaskPlan || state.currentTaskContext);
    const allowedProposals = providerVisibleAllowedProposals(kernelAllowedProposals, acceptedExecution);
    const profile = this.profiles.profile(acceptedExecution ? 'execution-v1' : 'planning-v1');
    if (acceptedExecution) this.assertAcceptedExecutionCatalog(state);
    const providerUserRequest = latestExplicitUserContent(state.userAuthorityFrame)
      || input.inputContent;
    const userGuidance = this.ports.collectUserGuidanceEvents(input.lastResult.events, state.runId);
    const toolCatalogSummary = acceptedExecution
      ? this.acceptedExecutionToolSummary(state)
      : this.ports.toolCatalogSummary(state);

    const assembledContext = this.ports.assembleContext({
      contextAssemblyId: input.contextAssemblyId,
      workflowState: state.stateContract?.stateId ?? state.driverRequest?.kind ?? 'needProposal',
      allowedProposals,
      toolCatalogSummary,
      memoryDocument: acceptedExecution ? undefined : state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
      extraMemoryHints: this.ports.memoryHints(state),
      interventionLevel: input.interventionLevel,
      providerProfileSystemContract: profile.systemContract,
      userGuidance,
      userRequest: providerUserRequest,
      currentTaskGoal: state.currentTaskContext?.goal,
      currentTaskContext: state.currentTaskContext,
      taskCursor: state.taskExecutionCursor,
      taskLocalCompactRecords: state.taskLocalCompactRecords,
      currentTaskResourcePacketIds: state.currentTaskContext?.taskId
        ? state.resourceRequestProgressByTask?.get(state.currentTaskContext.taskId)?.packetIds
        : undefined,
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
      language: state.userAuthorityFrame.effectiveLanguage,
    });
    const taskTemplateHash = this.acceptedTaskTemplateHash(state);
    const epochScopeKey = acceptedExecution
      ? [
        'execution',
        state.runId,
        (state.acceptedTaskPlan as AcceptedTaskPlanContext | undefined)?.planId ?? 'missing-plan',
        state.currentTaskContext?.taskId ?? 'missing-task',
        taskTemplateHash ?? 'missing-template',
      ].join(':')
      : [
        'planning',
        profile.id,
        state.workspaceScopeKey,
        state.userAuthorityFrame.turnAuthority.taskId,
      ].join(':');
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
      errorSummary: state.semanticDirectiveErrorSummary,
      acceptedPlanActive: Boolean(state.acceptedTaskPlan),
      currentTaskContext: state.currentTaskContext,
      resourcePackets: state.resourcePackets,
      generatedArtifactCount: state.generatedArtifactEvidence.size,
      toolIntentTemplates: this.currentTaskToolIntentTemplates(state),
      nextActionInstruction: this.nextActionInstruction(state, input.confirmedRequirement, allowedProposals),
    });
    const continuationAuthorityChanged = Boolean(
      state.activeProviderContinuation
      && state.activeProviderContinuation.sourceLanguagePolicy.revision
        !== state.userAuthorityFrame.languagePolicy.revision
    );
    if (
      state.activeProviderContinuation
      && (
        state.semanticDirectiveErrorSummary
        || state.taskPlanReplanReason
        || continuationAuthorityChanged
      )
    ) {
      state.activeProviderContinuation = undefined;
    }
    if (state.taskPlanReplanReason || continuationAuthorityChanged) {
      state.pendingProviderRetry = undefined;
    }
    const promptLedger = preparePromptLedger({
      state: state.promptLedger,
      profileId: profile.id,
      epochScopeKey,
      taskTemplateHash,
      workspaceScopeKey: state.workspaceScopeKey,
      systemContent: prompt.stablePrefix,
      toolsHash: stableHash(`${profile.toolSchemaHash}\n${state.stateContract?.toolCatalogSnapshot?.catalogHash ?? ''}`),
      authority: state.userAuthorityFrame,
      requestFrame: this.requestFrame(state, input.confirmedRequirement, userGuidance),
      toolCatalogSnapshot: toolCatalogSummary,
      workspaceBootstrap: renderProjectBootstrapSnapshot(buildProjectBootstrapSnapshot({
        manifest: state.initialContext?.manifest ?? {
          id: 'missing-manifest',
          workspaceScopeKey: state.workspaceScopeKey,
          entries: [],
          budget: { maxEntries: 0, maxBytes: 0 },
          defaultDenyPatterns: [],
        },
        roots: state.conversationRoots,
        packets: state.resourcePackets,
      })),
      memorySnapshot: acceptedExecution ? undefined : this.memoryEpochSnapshot(state.memoryDocument),
      workflowDelta: this.promptLedgerWorkflowDelta(providerTurnFrame, profile.id),
      repairDelta: state.taskPlanReplanReason || state.semanticDirectiveErrorSummary
        ? this.compactSemanticRepairFrame(state, providerTurnFrame)
        : undefined,
      priorUserGuidance: input.priorUserGuidance,
      activeContinuationToolCallIds: state.activeProviderContinuation?.exchanges.map(
        (exchange) => exchange.toolCall.id
      ),
      now: this.ports.now(),
      createId: (prefix) => this.ports.createId(prefix),
      contextWindowTokens: assembledContext.contextAssembly.budgetPlan.contextWindowTokens,
      maxOutputTokens: assembledContext.contextAssembly.budgetPlan.maxOutputTokens,
    });
    if (!promptLedgerAuthorityFits(state.userAuthorityFrame, promptLedger.budget)) {
      throw this.error(
        'user_authority_input_exceeds_budget',
        'The exact user messages exceed the available Provider input budget and cannot be summarized by Session.'
      );
    }
    state.promptLedger = promptLedger.state;
    const providerTurnFrameWithMessages = {
      ...providerTurnFrame,
      providerMessages: promptLedger.messages,
      promptLedgerEpochId: promptLedger.epoch.epochId,
      promptLedgerEpochScopeKey: promptLedger.epoch.epochScopeKey,
      promptLedgerTaskTemplateHash: promptLedger.epoch.taskTemplateHash,
      promptLedgerCacheShapeReason: promptLedger.cacheShapeReason,
    };
    const snapshot = buildProviderTurnSnapshot(providerTurnFrameWithMessages);
    const hookTrace = await this.runContextAdmissionHook(providerTurnFrameWithMessages, snapshot);
    const providerTurnFrameWithSnapshot = {
      ...providerTurnFrameWithMessages,
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

  private requestFrame(
    state: State,
    requirement: RequirementRecord | undefined,
    guidance: ContextAssemblyInput['userGuidance']
  ): string {
    const task = state.currentTaskContext;
    const accepted = objectRecord(state.acceptedTaskPlan);
    return [
      'SessionRequestFrame:',
      `languageRevision=${state.userAuthorityFrame.languagePolicy.revision}`,
      `languagePolicyStatus=${state.userAuthorityFrame.languagePolicy.status}`,
      `hostLanguage=${state.userAuthorityFrame.languagePolicy.hostLanguage}`,
      state.userAuthorityFrame.languagePolicy.status === 'pending'
        ? ''
        : `responseLanguage=${state.userAuthorityFrame.effectiveLanguage}`,
      `autonomyMode=${state.userAuthorityFrame.autonomyMode}`,
      `runId=${state.runId}`,
      requirement ? `requirementId=${requirement.requirementId}; status=${requirement.status}` : '',
      accepted ? `acceptedPlanId=${stringValue(accepted.planId) ?? 'unknown'}` : '',
      task ? [
        `taskId=${task.taskId}`,
        `goal=${oneLine(task.goal ?? task.taskTitle ?? '', 500)}`,
        `tools=${(task.toolIds ?? []).join(',') || 'none'}`,
        `targets=${(task.targets ?? []).join(',') || 'none'}`,
      ].join('; ') : '',
      this.confirmedDecisionSummary(guidance, requirement)
        ? `acceptedDecisions=${this.confirmedDecisionSummary(guidance, requirement)}`
        : '',
      'TaskFrame constrains only the current execution target. It does not replace the authoritative user messages.',
    ].filter(Boolean).join('\n');
  }

  private memoryEpochSnapshot(document: SessionMemoryDocument | undefined): string | undefined {
    if (!document) return undefined;
    const sections = [
      ...renderStableSessionMemoryHints(document),
      ...renderDynamicSessionMemoryHints(document),
    ];
    return sections.length ? sections.join('\n') : undefined;
  }

  private promptLedgerWorkflowDelta(frame: DriverProviderTurnFrame, profileId: string): string {
    return renderProviderTurnUserPrompt('', {
      ...frame,
      contractId: `prompt-ledger:${profileId}:${frame.runId}`,
    });
  }

  private compactSemanticRepairFrame(
    state: State,
    frame: DriverProviderTurnFrame
  ): string {
    if (state.taskPlanReplanReason) {
      const reason = state.taskPlanReplanReason;
      return [
        'TaskPlanReplanDelta:',
        `errorCode=${reason.code}`,
        `previousPlanId=${reason.previousPlanId ?? 'unknown'}`,
        `previousTaskId=${reason.previousTaskId ?? 'unknown'}`,
        `reason=${oneLine(reason.message, 800)}`,
        'The accepted task exceeded the Kernel total artifact budget. Splitting the same bytes into smaller artifact chunks cannot resolve this condition.',
        'Call session.submit_task_plan exactly once with a revised task plan that divides the deliverable into smaller independently reviewable tasks. Do not submit artifact chunks or an actionBundle in this planning turn.',
      ].join('\n');
    }
    const slots = this.currentTaskToolIntentTemplates(state).map((slot) => ({
      slotId: slot.intentId,
      contentMode: objectRecord(slot.template)?.contentMode,
      targetRef: slot.targets[0],
    }));
    return [
      'SemanticDirectiveRepair:',
      `error=${oneLine(state.semanticDirectiveErrorSummary ?? 'unknown', 1200)}`,
      `currentSlots=${JSON.stringify(slots)}`,
      `allowedSemanticTools=${this.profiles.profileForFrame(frame).tools.map((tool) => tool.name).join(',')}`,
      'Call exactly one registered semantic tool. For artifact content, submit one logically coherent block through session.append_artifact_chunk. A small file may be complete in one call; split larger work by class, function, script, or configuration section without counting lines or bytes.',
      'Do not repeat completed chunks. Do not include the full prior prompt, ResourcePacket, or escaped source in one JSON string.',
    ].join('\n');
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

  private acceptedExecutionToolSummary(state: State): string {
    const task = state.currentTaskContext;
    if (!task) {
      return [
        'Accepted execution Session directive summary.',
        'currentTask=none',
        'No current task is active; use the registered diagnostic or task-outcome semantic tool.',
      ].join('\n');
    }
    const templates = this.currentTaskToolIntentTemplates(state)
      .map((template) => {
        const templateRecord = objectRecord(template.template);
        return [
          `slotId=${template.intentId}`,
          `operation=${template.operation}`,
          `targetRef=${template.targets[0] ?? 'none'}`,
          `contentMode=${stringValue(templateRecord?.contentMode) ?? 'none'}`,
          `evidenceRequirement=${stringValue(templateRecord?.evidenceRequirement) ?? 'none'}`,
        ].filter(Boolean).join(';');
      });
    const catalog = state.stateContract?.toolCatalogSnapshot
      ?? state.driverRequest?.stateContract?.toolCatalogSnapshot;
    const currentToolIds = new Set(task.toolIds ?? []);
    const currentTools = (catalog?.tools ?? [])
      .filter((tool) => currentToolIds.has(tool.toolId))
      .sort((left, right) => left.toolId.localeCompare(right.toolId));
    const foundToolIds = new Set(currentTools.map((tool) => tool.toolId));
    const currentToolContracts = currentTools.map((tool) => [
      `toolId=${tool.toolId}`,
      `executionMode=${tool.executionMode}`,
      `permissionMode=${tool.permissionMode}`,
      `risk=${tool.risk}`,
      `typedArgs=${JSON.stringify(tool.providerSchema ?? {})}`,
      `usageConstraints=${JSON.stringify(tool.usageConstraints ?? {})}`,
    ].join(';'));
    const missingToolIds = [...currentToolIds].filter((toolId) => !foundToolIds.has(toolId));
    const taskEvidenceRefs = task.taskId ? currentTaskEvidenceRefs(state, task.taskId) : [];
    const acceptedPlan = state.acceptedTaskPlan as AcceptedTaskPlanContext | undefined;
    const dependencyFacts = dependencyFactsForTask(
      acceptedPlan?.dependencyFacts ?? [],
      task.dependsOn ?? []
    );
    const dependencyTaskIdsWithFacts = new Set(dependencyFacts.map((fact) => fact.taskId));
    const missingDependencyFacts = (task.dependsOn ?? []).filter(
      (taskId) => !dependencyTaskIdsWithFacts.has(taskId)
    );
    if (missingDependencyFacts.length) {
      throw new Error(
        `accepted_task_dependency_facts_unavailable: current task ${task.taskId ?? 'unknown'} has no Kernel facts for ${missingDependencyFacts.join(', ')}`
      );
    }
    const acceptanceCriteria = (task.acceptanceCriteria ?? []).map((criterion, index) => ({
      criterionIndex: index + 1,
      criterion,
    }));
    return [
      'Accepted execution Session directive summary.',
      `currentTaskId=${task.taskId}`,
      currentToolContracts.length
        ? `currentTaskKernelTools=${currentToolContracts.join(' | ')}`
        : 'currentTaskKernelTools=none',
      missingToolIds.length
        ? `catalogMismatch=${missingToolIds.join(',')}; do not guess tool availability; report a diagnostic.`
        : '',
      `acceptanceCriteria=${JSON.stringify(acceptanceCriteria)}`,
      taskEvidenceRefs.length
        ? `currentTaskEvidenceRefs=${taskEvidenceRefs.join(',')}`
        : 'currentTaskEvidenceRefs=none; request fresh task-scoped resources before using session.submit_task_outcome.',
      dependencyFacts.length
        ? `declaredDependencyFacts=${JSON.stringify(dependencyFacts)}`
        : 'declaredDependencyFacts=none',
      templates.length ? `intentSlots=${templates.join(' | ')}` : 'intentSlots=none',
      templates.length
        ? 'Submit content only for the listed slot ids. Do not submit paths, Kernel tool identifiers, permission fields, or operations outside the current task.'
        : 'No artifact slot is available. Use request_resources, submit_task_outcome, request_decision, or report_diagnostic as appropriate; do not invent a completion tool.',
    ].filter(Boolean).join('\n');
  }

  private acceptedTaskTemplateHash(state: State): string | undefined {
    const task = state.currentTaskContext;
    if (!task) return undefined;
    const accepted = state.acceptedTaskPlan as AcceptedTaskPlanContext | undefined;
    const dependencyFacts = dependencyFactsForTask(
      accepted?.dependencyFacts ?? [],
      task.dependsOn ?? []
    );
    const operations = (accepted?.authorizationOperations ?? [])
      .filter((operation) => operation.sourceTaskId === task.taskId)
      .map((operation) => ({
        operationId: operation.operationId,
        toolId: operation.toolId,
        targets: operation.targets,
        dependsOn: operation.dependsOn,
        fixedArgs: operation.fixedArgs,
        argsTemplate: operation.argsTemplate,
      }));
    return stableHash(JSON.stringify({
      planId: accepted?.planId,
      authorizationContractHash: accepted?.authorizationContractHash,
      taskId: task.taskId,
      targets: task.targets,
      toolIds: task.toolIds,
      dependsOn: task.dependsOn,
      acceptanceCriteria: task.acceptanceCriteria,
      failureCriteria: task.failureCriteria,
      operations,
      dependencyFacts,
    }));
  }

  private assertAcceptedExecutionCatalog(state: State): void {
    const catalog = state.stateContract?.toolCatalogSnapshot
      ?? state.driverRequest?.stateContract?.toolCatalogSnapshot;
    if (!catalog?.catalogVersion || !Array.isArray(catalog.tools) || catalog.tools.length === 0) {
      throw this.error(
        'session_state_contract_unavailable',
        'Accepted task execution requires the current Kernel state contract and tool catalog before a Provider call.'
      );
    }
    const currentToolIds = state.currentTaskContext?.toolIds ?? [];
    const missing = currentToolIds
      .filter((toolId) => !catalog.tools.some((tool) => tool.toolId === toolId));
    if (missing.length > 0) {
      throw this.error(
        'accepted_task_tool_unavailable',
        `Accepted task references tools unavailable in the current Kernel catalog: ${missing.join(', ')}.`
      );
    }
    const nonExecutable = currentToolIds.flatMap((toolId) => {
      const tool = catalog.tools.find((candidate) => candidate.toolId === toolId);
      return tool && tool.executionMode !== 'execute' ? [tool] : [];
    });
    if (nonExecutable.length > 0) {
      throw this.error(
        'accepted_task_tool_unavailable',
        `Accepted task references non-executable Kernel tools: ${nonExecutable.map((tool) => `${tool.toolId}(${tool.executionMode})`).join(', ')}.`
      );
    }
    const acceptedPlan = state.acceptedTaskPlan as AcceptedTaskPlanContext | undefined;
    if (!acceptedPlan) return;
    if (
      !Array.isArray(acceptedPlan.tasks) ||
      acceptedPlan.taskLedger?.schemaVersion !== 'deepcode.session.task-ledger.v2' ||
      !Array.isArray(acceptedPlan.authorizationOperations)
    ) {
      throw this.error(
        'accepted_plan_authorization_contract_incompatible',
        'Accepted task state is missing the canonical task or authorization operation arrays.'
      );
    }
    const settled = new Set(acceptedPlanSettledTaskIds(acceptedPlan));
    const currentTask = acceptedPlan.tasks.find((task) => !settled.has(task.taskId));
    if (!currentTask) return;
    const currentOperations = acceptedPlan.authorizationOperations
      .filter((operation) => operation.sourceTaskId === currentTask.taskId && !operation.internal);
    if (currentOperations.length === 0) {
      throw this.error(
        'accepted_plan_authorization_contract_incompatible',
        `Accepted task ${currentTask.taskId} has no exact Kernel authorization operation.`
      );
    }
    const artifactOperations = currentOperations.filter((operation) =>
      ['fsCreate', 'fsWrite', 'fsEdit', 'fsDelete', 'fsRename', 'processExec'].includes(operation.operationKind)
    );
    const slots = this.intentSlots.currentTaskSlots(acceptedPlan);
    if (artifactOperations.length > 0 && slots.length !== artifactOperations.length) {
      throw this.error(
        'accepted_plan_authorization_contract_incompatible',
        `Accepted task ${currentTask.taskId} does not have one exact IntentSlot per Kernel authorization operation.`
      );
    }
  }

  private error(code: string, message: string): Error {
    return this.ports.createError?.(code, message) ?? new Error(`${code}: ${message}`);
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
    if (state.acceptedTaskPlan || state.currentTaskContext) return undefined;
    if (requirement?.status !== 'confirmed') return undefined;
    return [
      'state=ConfirmedRequirementContinuation',
      `confirmedRequirementId=${requirement.requirementId}`,
      `allowedOutputs=${allowedProposals.join(' | ') || 'none'}`,
      'The user has already resolved the previous decisionRequest. Do not repeat that intervention.',
      'Use the confirmed requirement and confirmed decision as the resolved current scope.',
      'Do not infer extra preserved/deleted/modified targets from memory or from ambiguous wording in the original request.',
      'Choose the narrowest valid next proposal from allowedOutputs.',
      'Keep visible reasoning/progress action-oriented: state the current action or proposal, not protocol, tool, permission, or evidence-policy deliberation.',
    ].join(' ');
  }

  private currentTaskToolIntentTemplates(state: State): ToolIntentTemplate[] {
    const acceptedPlan = state.acceptedTaskPlan as AcceptedTaskPlanContext | undefined;
    return this.intentSlots.currentTaskSlots(acceptedPlan).map((slot): ToolIntentTemplate => ({
      intentId: slot.slotId,
      label: 'IntentSlot',
      operation: slot.operation,
      targets: [slot.targetRef],
      evidencePolicy: slot.evidenceRequirement,
      template: {
        contentMode: slot.contentMode,
        evidenceRequirement: slot.evidenceRequirement,
        targetResourceKind: slot.targetResourceKind,
      },
    }));
  }
}

function currentTaskEvidenceRefs(state: ProviderTurnContextState, taskId: string): string[] {
  const packetIds = state.resourceRequestProgressByTask?.get(taskId)?.packetIds ?? [];
  const refs = new Set<string>();
  for (const packet of state.resourcePackets.filter((candidate) => packetIds.includes(candidate.id))) {
    const validItems = packet.items.filter((item) => (
      (item.status === 'provided' || item.status === 'resolved')
      && item.truncated !== true
      && item.rangeComplete !== false
    ));
    if (validItems.length > 0 && validItems.length === packet.items.length) refs.add(packet.id);
    for (const item of validItems) {
      refs.add(item.requestItemId);
      refs.add(item.manifestEntryId);
      if (item.contentHash) refs.add(item.contentHash);
      refs.add(`${packet.id}:${item.requestItemId}`);
    }
  }
  return [...refs].sort();
}

export function providerVisibleAllowedProposals(
  allowedProposals: readonly string[],
  acceptedExecution: boolean
): string[] {
  if (acceptedExecution) {
    return ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'];
  }
  const blocked = new Set(['actionBundle', 'reviewSummary']);
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

function oneLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 3))}...` : normalized;
}
