import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentStreamPartFrame,
  AgentWorkspaceBinding,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatStreamEvent,
  LlmChatResult,
  ProjectionDelta,
  ToolCall,
  ToolDefinition,
} from '@deepcode/protocol';
import { listDefaultAgentTools } from '@deepcode/protocol';
import { parseProposalEnvelope } from '../agent-plan/protocolV3.js';
import { stableHash } from '../cache/canonicalizer.js';
import {
  AgentPlanParseError,
  type ActionBundleDraft,
  type ProposalEnvelope,
  type ResourceRequestDraft,
} from '../agent-plan/types.js';
import type {
  InitialContextPacket,
  ConversationResourceRoot,
  ProjectWorkingDirectory,
  ResourceManifest,
  ResourceManifestEntry,
  ResourcePacket,
  ResourcePacketItem,
} from '../context/types.js';
import {
  assembleContext,
  buildSessionMemoryDocument,
  collectUserGuidanceEvents,
  type ContextAssemblyRecord,
  type PromptCachePlan,
  type SessionMemoryDocument,
  type UserGuidanceEvent,
} from '../context/index.js';
import type { PromptEnvelope } from '../prompt/types.js';
import type { RequirementChecklist, RequirementRecord } from '../requirement/types.js';
import type { TranscriptEntry } from '../transcript.js';
import { buildSessionTaskGraph, type SessionTaskGraph } from '../workflow/index.js';
import type { DriverRequestRef, KernelStateContractRef } from './types.js';

export interface SessionDriverLoopPorts {
  appendEvents(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  appendTranscript?: (sessionId: string, entry: TranscriptEntry) => Promise<void>;
  kernelCommand(request: KernelCommandEnvelope): Promise<KernelReply>;
  llmChat(request: LlmChatRequest): Promise<ApiResponse<LlmChatResult>>;
  llmChatStream?: (
    request: LlmChatRequest,
    onEvent: (event: LlmChatStreamEvent) => void | Promise<void>
  ) => Promise<ApiResponse<LlmChatResult>>;
  onProjectionDelta?: (delta: ProjectionDelta) => void | Promise<void>;
  now?: () => string;
  createId?: (prefix: string) => string;
}

export interface SessionDriverLoopInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  appendUserMessage?: boolean;
  confirmedRequirement?: RequirementRecord;
  requirementConfirmationMode?: RequirementConfirmationMode;
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
  resumeResourcePackets?: boolean;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
}

export type RequirementConfirmationMode = 'auto' | 'always' | 'off';
export type ReviewContinuationMode = 'auto' | 'ask' | 'off';
export type InterventionLevel = 'low' | 'medium' | 'high';

export interface SessionDecisionResolverInput {
  sessionId: string;
  kind: 'requirement' | 'plan' | 'review' | 'permission' | 'boundary';
  decision: 'accept' | 'reject' | 'revise';
  guidance?: string;
  runId?: string;
  targetId?: string;
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: ReviewContinuationMode;
  interventionLevel?: InterventionLevel;
}

interface SessionDriverLoopRunState {
  sessionId: string;
  runId: string;
  userRequest: string;
  phase: SessionTurnPhase;
  workspaceScopeKey: string;
  stateContract?: KernelStateContractRef;
  driverRequest?: DriverRequestRef;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  initialContext: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  memoryDocument: SessionMemoryDocument;
  memoryHints: string[];
  taskGraph: SessionTaskGraph;
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  implementationBatch: ImplementationBatchContext;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  resourceRequestRepairAttempted: boolean;
  planReviewRepairAttempted: boolean;
  acceptedPlanScopeRepairAttempted: boolean;
  terminalGuidanceRevisionAttempted: boolean;
  activeTurn?: ActiveTurnState;
}

type SessionTurnPhase =
  | 'context_reading'
  | 'provider_proposing'
  | 'waiting_plan_review'
  | 'waiting_permission'
  | 'executing_accepted_plan'
  | 'executing'
  | 'waiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface DecisionOwnerRef {
  kind: 'requirement' | 'plan' | 'review' | 'permission';
  runId: string;
  targetId?: string;
  planId?: string;
  requirementId?: string;
  reviewId?: string;
  permissionId?: string;
}

interface ImplementationBatchContext {
  batchIndex: number;
  recentPlanSummaries: string[];
  continuationSummaries: string[];
}

interface AcceptedImplementationPlanTaskContext {
  taskId: string;
  title?: string;
  capability?: string;
  targets: string[];
}

interface AcceptedImplementationPlanExecutionRoot {
  attachment: AgentContextAttachment;
  ref: string;
  source: 'projectWorkingDirectory' | 'workspaceBinding' | 'recentAttachment';
}

interface AcceptedImplementationPlanContext {
  planId: string;
  runId: string;
  title?: string;
  summary?: string;
  tasks: AcceptedImplementationPlanTaskContext[];
  capabilities: string[];
  targetScopes: string[];
  executionRoot?: AcceptedImplementationPlanExecutionRoot;
  interventionLevel?: InterventionLevel;
  batchIndex: number;
  completedTaskIds: string[];
  rawPlan: Record<string, unknown>;
}

interface AcceptedPlanBatchValidationResult {
  ok: boolean;
  reasons: string[];
}

interface AcceptedPlanTargetScope {
  raw: string;
  normalized: string;
}

interface AcceptedPlanBatchProgress {
  actionIds: string[];
  targetPaths: string[];
  workUnitIds: string[];
  newlyCompletedTaskIds: string[];
  completedTaskIds: string[];
  remainingTaskIds: string[];
}

interface ResourceManifestBuildResult {
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
}

interface ResourceRequestResolution {
  manifest: ResourceManifest;
  unresolved: string[];
  ambiguous: string[];
  availableRoots: ConversationResourceRoot[];
}

interface ActiveTurnState {
  turnId: string;
  seq: number;
  stage: string;
  providerCallId?: string;
  partFrameParser?: ProviderPartFrameParser;
}

interface NativeToolCallProposal {
  callId: string;
  index: number;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}

interface ProviderToolCallBufferItem {
  callId?: string;
  name?: string;
  argumentsText: string;
}

interface LlmTurnResult {
  result: LlmChatResult;
  content: string;
  reasoning: string;
  toolCalls: NativeToolCallProposal[];
}

type NativeToolHandlingResult =
  | { kind: 'resume'; toolMessages: LlmChatRequest['messages'] }
  | { kind: 'proposal'; proposal: ProposalEnvelope };

const RESOURCE_BUDGET_REQUIREMENT_PREFIX = 'resource-budget';
const MAX_DERIVED_MANIFEST_ENTRIES = 240;
const RESOURCE_MANIFEST_MAX_BYTES = 512 * 1024;
const MAX_ACTION_BUNDLE_ACTIONS = 6;
const MAX_ACTION_BUNDLE_CODE_BLOCKS = 4;
const MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES = 12 * 1024;
const MAX_ACTION_BUNDLE_CODE_BLOCK_BYTES = 6 * 1024;
const NATIVE_TOOL_RESULT_MAX_CHARS = 12 * 1024;
const SIDE_EFFECT_CAPABILITIES = new Set([
  'workspace.write',
  'workspace.create',
  'workspace.delete',
  'workspace.rename',
  'process.exec',
  'network.egress',
  'git.write',
  'git.push',
  'config.modify',
  'browser.control',
  'provider.egress',
]);

export class SessionDriverLoop {
  constructor(private readonly ports: SessionDriverLoopPorts) {}

  async resolveDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    if (input.kind === 'requirement') return this.resolveRequirementDecision(input);
    if (input.kind === 'plan') return this.resolvePlanDecision(input);
    if (input.kind === 'permission') return this.resolvePermissionDecision(input);
    if (input.kind === 'review') return this.resolveReviewDecision(input);
    return this.append(input.sessionId, [
      finalDiagnosticEvent(
        input.sessionId,
        `当前决策类型 ${input.kind} 尚未接入 Session DecisionResolver。`,
        this.ts(),
        this.id('decision-unsupported')
      ),
    ]);
  }

  async runUserTurn(input: SessionDriverLoopInput): Promise<AgentSessionResult> {
    const sessionId = input.sessionId;
    let lastResult = input.appendUserMessage === false
      ? await this.append(sessionId, [])
      : await this.append(sessionId, [
        this.event(sessionId, 'user_msg', {
          content: input.content,
          attachments: input.attachments ?? [],
          channel: 'user',
          visibility: 'conversation',
        }),
      ]);

    const kernelAttachments = kernelRunAttachments(input);
    const runReply = await this.kernel({
      command: {
        kind: 'runCreate',
        requestId: this.id('run-create'),
        sessionId,
        input: {
          text: input.content,
          attachments: kernelAttachments,
        },
        workspaceBinding: input.workspaceBinding,
        profileRef: input.profileId ? { id: input.profileId, kind: 'llm' } : undefined,
        workflowRef: input.workflow ? { id: input.workflow } : undefined,
        runOverrides: undefined,
      },
    });
    lastResult = await this.appendProjectedKernelEvents(sessionId, runReply);
    const runId = firstString(runReply.events, 'runId') ?? this.id('run');
    const stateContract = findStateContract(runReply.events);
    const driverRequest = findDriverRequest(runReply.events);

    const manifestBuild = createManifest(input, this.id('resource-manifest'));
    const acceptedImplementationPlan = input.acceptedImplementationPlan;
    const implementationBatch = buildImplementationBatchContext(input.existingEvents ?? []);
    if (acceptedImplementationPlan) {
      implementationBatch.batchIndex = acceptedImplementationPlan.batchIndex;
    }
    const memoryDocument = buildSessionMemoryDocument(input.existingEvents ?? []);
    const restoredResourcePackets = input.resumeResourcePackets
      ? recentResourcePackets(input.existingEvents ?? [])
      : [];
    const state: SessionDriverLoopRunState = {
      sessionId,
      runId,
      userRequest: input.content,
      phase: 'context_reading',
      workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
      stateContract,
      driverRequest,
      manifest: manifestBuild.manifest,
      conversationRoots: manifestBuild.conversationRoots,
      initialContext: {
        id: this.id('initial-context'),
        workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
        manifest: manifestBuild.manifest,
      },
      resourcePackets: [...restoredResourcePackets],
      memoryDocument,
      memoryHints: implementationBatchHints(implementationBatch, acceptedImplementationPlan),
      taskGraph: buildSessionTaskGraph({
        sessionId,
        runId,
        events: input.existingEvents ?? [],
        stateContract,
        driverRequest,
      }),
      implementationBatch,
      acceptedImplementationPlan,
      resourceRequestRepairAttempted: false,
      planReviewRepairAttempted: false,
      acceptedPlanScopeRepairAttempted: false,
      terminalGuidanceRevisionAttempted: false,
    };

    if (state.manifest.entries.length > 0 && !input.resumeResourcePackets) {
      const packet = await this.resolveResources(state, state.manifest);
      state.resourcePackets.push(packet);
      addDiscoveredManifestEntries(state.manifest, packet);
      lastResult = await this.append(sessionId, [resourcePacketEvent(sessionId, packet, this.ts(), this.id('resource-context'))]);
    }

    if (shouldRequestRequirementConfirmation(input, state)) {
      try {
        const event = await this.buildRequirementConfirmation(input, state);
        state.phase = 'waiting_plan_review';
        const payload = objectRecord(event.payload) ?? {};
        return this.append(sessionId, [
          event,
          sessionRunStateEvent({
            sessionId,
            runId: state.runId,
            phase: 'waiting_plan_review',
            reason: 'requirement',
            decisionOwner: {
              kind: 'requirement',
              runId: state.runId,
              targetId: stringValue(payload.requirementId),
              requirementId: stringValue(payload.requirementId),
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-requirement'),
          }),
        ]);
      } catch (error) {
        const message = error instanceof SessionDriverLoopError ? error.message : String(error);
        return this.append(sessionId, [
          finalDiagnosticEvent(
            sessionId,
            `需求理解确认生成失败：${message}`,
            this.ts(),
            this.id('requirement-confirmation-failed')
          ),
        ]);
      }
    }

    while (true) {
      state.taskGraph = buildSessionTaskGraph({
        sessionId,
        runId: state.runId,
        events: lastResult.events,
        stateContract: state.stateContract,
        driverRequest: state.driverRequest,
      });
      const assembledContext = assembleContext({
        contextAssemblyId: this.id('context-assembly'),
        workflowState: state.stateContract?.stateId ?? state.driverRequest?.kind ?? 'needProposal',
        allowedProposals: state.stateContract?.allowedProposals ?? [
          'answer',
          'resourceRequest',
          'decisionRequest',
          'actionBundle',
          'diagnostic',
        ],
        capabilityCatalogSummary: (state.stateContract?.capabilityProjection ?? []).join('\n'),
        memoryDocument: state.memoryDocument,
        extraMemoryHints: implementationBatchHints(state.implementationBatch, state.acceptedImplementationPlan),
        interventionLevel: input.interventionLevel,
        userGuidance: collectUserGuidanceEvents(lastResult.events, state.runId),
        userRequest: input.content,
        initialContext: state.initialContext,
        resourcePackets: state.resourcePackets,
        conversationRoots: state.conversationRoots,
        requirement: input.confirmedRequirement,
        auditOnly: {
          runId: state.runId,
          sessionId,
        },
      });
      state.cachePlan = assembledContext.cachePlan;
      state.contextAssembly = assembledContext.contextAssembly;
      lastResult = await this.appendConsumedUserGuidanceEvents(sessionId, lastResult, state.contextAssembly, state.runId);
      const prompt = assembledContext.prompt;
      state.phase = 'provider_proposing';
      let proposal: ProposalEnvelope;
      try {
        proposal = await this.callProviderAndParse(input, state, prompt);
      } catch (error) {
        if (error instanceof SessionDriverLoopError) {
          return this.append(sessionId, [
            finalDiagnosticEvent(
              sessionId,
              error.message,
              this.ts(),
              this.id(error.code)
            ),
          ]);
        }
        throw error;
      }
      const narration = proposalNarrationEvent(sessionId, proposal, this.ts(), this.id('progress-model-narration'));
      if (narration) {
        lastResult = await this.append(sessionId, [narration]);
      }
      if (proposal.kind === 'answer') {
        const revised = await this.maybeReviseTerminalAnswerWithGuidance(input, state, proposal);
        if (revised) return revised;
        return this.append(sessionId, [answerEvent(sessionId, proposal, this.ts(), this.id('answer'))]);
      }
      if (proposal.kind === 'decisionRequest') {
        const requirement = requirementRecordFromProposal(proposal, input, state, this.ts());
        const confirmation = requirementConfirmationEvent({
            sessionId,
            runId: state.runId,
            requirement,
            proposal,
            originalUserRequest: input.content,
            attachments: input.attachments ?? [],
            ts: this.ts(),
            id: this.id('decision-request'),
          });
        state.phase = 'waiting_plan_review';
        return this.append(sessionId, [
          confirmation,
          sessionRunStateEvent({
            sessionId,
            runId: state.runId,
            phase: 'waiting_plan_review',
            reason: 'requirement',
            decisionOwner: {
              kind: 'requirement',
              runId: state.runId,
              targetId: requirement.requirementId,
              requirementId: requirement.requirementId,
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-requirement'),
          }),
        ]);
      }
      if (proposal.kind === 'diagnostic') {
        const diagnostic = objectRecord(proposal.payload) ?? {};
        const summary = stringValue(diagnostic.summary)
          ?? stringValue(diagnostic.details)
          ?? '模型返回诊断信息，未生成计划或执行队列。';
        return this.append(sessionId, [
          finalDiagnosticEvent(sessionId, summary, this.ts(), this.id('diagnostic')),
        ]);
      }
      if (proposal.kind === 'implementationPlan') {
        const planId = stringValue(objectRecord(proposal.payload)?.id) ?? proposal.proposalId;
        state.phase = 'waiting_plan_review';
        return this.append(sessionId, [
          implementationPlanCardEvent(state, proposal, this.ts(), this.id('implementation-plan')),
          sessionRunStateEvent({
            sessionId,
            runId: state.runId,
            phase: 'waiting_plan_review',
            reason: 'plan_review',
            decisionOwner: {
              kind: 'plan',
              runId: state.runId,
              targetId: planId,
              planId,
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-plan'),
          }),
        ]);
      }
      if (proposal.kind === 'resourceRequest') {
        let subset = manifestForResourceRequest(state.manifest, proposal.payload as ResourceRequestDraft, state.conversationRoots);
        if (!subset.manifest.entries.length) {
          if (!state.resourceRequestRepairAttempted) {
            state.resourceRequestRepairAttempted = true;
            try {
              const repaired = await this.repairResourceRequest(input, state, prompt, proposal, subset);
              if (repaired.kind === 'answer') {
                return this.append(sessionId, [answerEvent(sessionId, repaired, this.ts(), this.id('answer'))]);
              }
              if (repaired.kind === 'resourceRequest') {
                subset = manifestForResourceRequest(state.manifest, repaired.payload as ResourceRequestDraft, state.conversationRoots);
              } else if (repaired.kind === 'actionBundle') {
                return this.submitActionProposal(input, state, prompt, repaired, lastResult);
              } else {
                return this.submitNonExecutableProposal(state, repaired, lastResult);
              }
            } catch (error) {
              const message = error instanceof SessionDriverLoopError ? error.message : String(error);
              return this.append(sessionId, [
                finalDiagnosticEvent(
                  sessionId,
                  `模型请求的资源无法在附件或项目目录中定位，且 repair 失败：${message}`,
                  this.ts(),
                  this.id('resource-repair-failed')
                ),
              ]);
            }
          }
        }
        if (!subset.manifest.entries.length) {
          return this.append(sessionId, [
            finalDiagnosticEvent(
              sessionId,
              resourceResolutionDiagnostic(subset),
              this.ts(),
              this.id('resource-invalid')
            ),
          ]);
        }
        const packet = await this.resolveResources(state, subset.manifest);
        state.resourcePackets.push(packet);
        addDiscoveredManifestEntries(state.manifest, packet);
        lastResult = await this.append(sessionId, [resourcePacketEvent(sessionId, packet, this.ts(), this.id('resource-context'))]);
        continue;
      }
      if (proposal.kind === 'actionBundle') {
        return this.submitActionProposal(input, state, prompt, proposal, lastResult);
      }
      return this.submitNonExecutableProposal(state, proposal, lastResult);
    }

    return lastResult;
  }

  private async resolveRequirementDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const requirementId = input.targetId;
    const confirmation = findRequirementConfirmation(events, input.runId, requirementId);
    if (!confirmation) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/requirement_decision_noop', '该需求确认已处理或已过期。', this.ts(), this.id('requirement-noop'), {
          runId: input.runId,
          requirementId,
          decision: input.decision,
        }),
      ]);
    }

    const decisionEvent = requirementDecisionEvent(input.sessionId, confirmation, input.decision, input.guidance, this.ts(), this.id('requirement-decision'));
    let result = await this.append(input.sessionId, [decisionEvent]);
    if (input.decision === 'reject') {
      const payload = objectRecord(decisionEvent.payload) ?? {};
      const runId = stringValue(payload.runId) ?? input.runId ?? 'run-unknown';
      const resolvedRequirementId = stringValue(payload.requirementId) ?? requirementId;
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'cancelled',
          status: 'cancelled',
          reason: 'requirement',
          decisionOwner: {
            kind: 'requirement',
            runId,
            targetId: resolvedRequirementId,
            requirementId: resolvedRequirementId,
          },
          ts: this.ts(),
          id: this.id('session-run-cancelled-requirement'),
        }),
      ]) ?? result;
    }
    if (isResourceBudgetConfirmation(confirmation)) {
      const originalRequest = requirementOriginalRequest(confirmation);
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: input.decision === 'revise' && input.guidance
          ? `${originalRequest}\n\n用户对只读资源预算后的补充意见：${input.guidance}\n\n如果用户要求基于当前内容回答，请优先使用已有 ResourcePacket 收口；如果用户缩小范围且关键事实仍不足，可以在追加预算内继续按需读取。`
          : originalRequest,
        attachments: requirementAttachments(confirmation),
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        interventionLevel: input.interventionLevel,
        resumeResourcePackets: true,
      });
    }

    const originalRequest = requirementOriginalRequest(confirmation);
    const next = await this.runUserTurn({
      sessionId: input.sessionId,
      content: input.decision === 'revise' && input.guidance
        ? `${originalRequest}\n\n用户修订意见：${input.guidance}`
        : originalRequest,
      attachments: requirementAttachments(confirmation),
      existingEvents: result.events,
      workspaceBinding: input.workspaceBinding,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      confirmedRequirement: input.decision === 'accept' ? requirementRecordFromEvent(confirmation, 'confirmed') : undefined,
      requirementConfirmationMode: input.decision === 'revise' ? 'always' : 'off',
      interventionLevel: input.interventionLevel,
    });

    if (input.decision !== 'accept') return next;
    const plan = latestExecutablePlan(next.events, input.runId);
    if (!plan || !planAutoExecutableAfterRequirement(plan)) return next;
    return this.resolvePlanDecision({
      ...input,
      kind: 'plan',
      decision: 'accept',
      targetId: plan.planId,
      runId: plan.runId,
      existingEvents: next.events,
    });
  }

  private async resolvePlanDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const active = findActiveDriverInteraction(events);
    const activePlanMatches = active?.kind === 'plan' &&
      active.runId === input.runId &&
      (!input.targetId || active.planId === input.targetId || Boolean(findPlanCard(events, input.runId, input.targetId)));
    if (!activePlanMatches) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/plan_accept_noop', '该计划已处理或已过期，没有再次提交执行。', this.ts(), this.id('plan-noop'), {
          runId: input.runId,
          planId: input.targetId,
          decision: input.decision,
          visibility: 'debug',
        }),
      ]);
    }
    const plan = findPlanCard(events, input.runId, input.targetId);
    if (!plan || planAlreadyResolved(events, plan)) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/plan_accept_noop', '该计划已处理或已过期，没有再次提交执行。', this.ts(), this.id('plan-noop'), {
          runId: input.runId,
          planId: input.targetId,
          decision: input.decision,
          visibility: 'debug',
        }),
      ]);
    }

    if (input.decision !== 'accept') {
      const status = input.decision === 'revise' ? 'needsRevision' : 'rejected';
      let result = await this.append(input.sessionId, [
        planReviewDecisionEvent(input.sessionId, plan, status, input.guidance, this.ts(), this.id('plan-decision')),
      ]);
      if (input.decision === 'reject') {
        result = await this.append(input.sessionId, [
          sessionRunStateEvent({
            sessionId: input.sessionId,
            runId: plan.runId,
            phase: 'cancelled',
            status: 'cancelled',
            reason: 'plan_review',
            decisionOwner: {
              kind: 'plan',
              runId: plan.runId,
              targetId: plan.planId,
              planId: plan.planId,
            },
            ts: this.ts(),
            id: this.id('session-run-cancelled-plan'),
          }),
        ]) ?? result;
      }
      return result;
    }

    let result = await this.append(input.sessionId, [
      planReviewDecisionEvent(input.sessionId, plan, 'accepted', '用户已确认计划，准备进入执行。', this.ts(), this.id('plan-accepted')),
    ]);
    if (plan.implementationPlan) {
      const executionRoot = acceptedPlanExecutionRootFromDecision(input, result.events);
      const acceptedPlan = acceptedImplementationPlanContext(plan, input.interventionLevel, executionRoot);
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: implementationPlanExecutionRequest(plan, acceptedPlan, input.guidance),
        attachments: acceptedPlan.executionRoot ? [acceptedPlan.executionRoot.attachment] : [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        acceptedImplementationPlan: acceptedPlan,
      });
    }
    const decisionReply = await this.kernel({
      command: {
        kind: 'userDecisionSubmit',
        requestId: this.id('user-decision-plan'),
        runId: plan.runId,
        sessionId: input.sessionId,
        decision: {
          decisionId: this.id('decision-plan'),
          decisionKind: 'plan',
          targetId: plan.planId,
          payload: {
            decision: input.decision,
            guidance: input.guidance,
          },
        },
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);

    const grantEvents: unknown[] = [];
    for (const grant of temporaryGrantsForPlan(plan)) {
      const grantReply = await this.kernel({
        command: {
          kind: 'permissionGrantTemporary',
          requestId: this.id('plan-temp-grant'),
          runId: plan.runId,
          grant,
        },
      });
      grantEvents.push(...(grantReply.events ?? []));
    }
    if (grantEvents.length) {
      result = await this.appendProjectedKernelEvents(input.sessionId, { ok: true, events: grantEvents });
    }

    const batchReply = await this.kernel({
      command: {
        kind: 'actionBatchSubmit',
        requestId: this.id('action-batch-submit'),
        runId: plan.runId,
        sessionId: input.sessionId,
        batch: {
          planId: plan.planId,
          actionBundle: plan.actionBundle,
          codeBlocks: plan.codeBlocks,
          commandBlocks: plan.commandBlocks,
        },
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, batchReply);
    if (!actionBatchReadyForReview(batchReply.events ?? [])) {
      if (kernelEventsContainPermissionRequest(batchReply.events ?? [])) {
        const permissionId = permissionIdFromKernelEvents(batchReply.events ?? []);
        return this.append(input.sessionId, [
          sessionRunStateEvent({
            sessionId: input.sessionId,
            runId: plan.runId,
            phase: 'waiting_permission',
            reason: 'permission',
            decisionOwner: {
              kind: 'permission',
              runId: plan.runId,
              targetId: permissionId,
              permissionId,
              planId: plan.planId,
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-permission'),
          }),
        ]) ?? result;
      }
      return result;
    }
    const factsReply = await this.kernel({
      command: {
        kind: 'reviewFactsGet',
        requestId: this.id('review-facts-get'),
        runId: plan.runId,
        sessionId: input.sessionId,
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, factsReply);
    const review = reviewSummaryEvent(
      input.sessionId,
      plan,
      [...(batchReply.events ?? []), ...(factsReply.events ?? [])],
      this.ts(),
      this.id('review-summary')
    );
    const reviewPayload = objectRecord(review.payload) ?? {};
    return this.append(input.sessionId, [
      review,
      sessionRunStateEvent({
        sessionId: input.sessionId,
        runId: plan.runId,
        phase: 'waiting_review',
        reason: 'review',
        decisionOwner: {
          kind: 'review',
          runId: plan.runId,
          targetId: stringValue(reviewPayload.reviewId) ?? plan.runId,
          reviewId: stringValue(reviewPayload.reviewId) ?? plan.runId,
          planId: plan.planId,
        },
        ts: this.ts(),
        id: this.id('session-run-waiting-review'),
      }),
    ]) ?? result;
  }

  private async resolvePermissionDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const pending = findPendingPermissionContext(events, input.targetId);
    if (!pending) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/permission_accept_noop', '该权限请求已处理或已过期，没有重复执行。', this.ts(), this.id('permission-noop'), {
          runId: input.runId,
          permissionId: input.targetId,
          decision: input.decision,
        }),
      ]);
    }
    const decisionReply = await this.kernel({
      command: {
        kind: 'permissionResolve',
        requestId: this.id('permission-resolve'),
        permissionId: pending.id,
        decision: input.decision === 'accept' ? 'accept' : 'reject',
      },
    });
    let result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);
    if (input.decision === 'reject') {
      const runId = pending.runId ?? input.runId ?? runIdFromKernelEvents(decisionReply.events ?? []) ?? 'run-unknown';
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId,
          phase: 'cancelled',
          status: 'cancelled',
          reason: 'permission',
          decisionOwner: {
            kind: 'permission',
            runId,
            targetId: pending.id,
            permissionId: pending.id,
            planId: pending.planId,
          },
          ts: this.ts(),
          id: this.id('session-run-cancelled-permission'),
        }),
      ]) ?? result;
    }
    if (!actionBatchReadyForReview(decisionReply.events ?? [])) {
      if (kernelEventsContainPermissionRequest(decisionReply.events ?? [])) {
        const runId = pending.runId ?? input.runId ?? runIdFromKernelEvents(decisionReply.events ?? []) ?? 'run-unknown';
        const permissionId = permissionIdFromKernelEvents(decisionReply.events ?? []);
        return this.append(input.sessionId, [
          sessionRunStateEvent({
            sessionId: input.sessionId,
            runId,
            phase: 'waiting_permission',
            reason: 'permission',
            decisionOwner: {
              kind: 'permission',
              runId,
              targetId: permissionId,
              permissionId,
              planId: pending.planId,
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-permission'),
          }),
        ]) ?? result;
      }
      return result;
    }

    const runId = pending.runId ?? input.runId ?? runIdFromKernelEvents(decisionReply.events ?? []);
    if (!runId) return result;
    const plan = findPlanCard(result.events, runId, pending.planId);
    if (!plan) return result;

    const factsReply = await this.kernel({
      command: {
        kind: 'reviewFactsGet',
        requestId: this.id('review-facts-get'),
        runId,
        sessionId: input.sessionId,
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, factsReply);
    const review = reviewSummaryEvent(
        input.sessionId,
        plan,
        [...(decisionReply.events ?? []), ...(factsReply.events ?? [])],
        this.ts(),
        this.id('review-summary')
      );
    const reviewPayload = objectRecord(review.payload) ?? {};
    return this.append(input.sessionId, [
      review,
      sessionRunStateEvent({
        sessionId: input.sessionId,
        runId,
        phase: 'waiting_review',
        reason: 'review',
        decisionOwner: {
          kind: 'review',
          runId,
          targetId: stringValue(reviewPayload.reviewId) ?? runId,
          reviewId: stringValue(reviewPayload.reviewId) ?? runId,
          planId: plan.planId,
        },
        ts: this.ts(),
        id: this.id('session-run-waiting-review'),
      }),
    ]) ?? result;
  }

  private async resolveReviewDecision(input: SessionDecisionResolverInput): Promise<AgentSessionResult> {
    const events = input.existingEvents ?? [];
    const review = findWaitingReview(events, input.runId);
    if (!review || reviewAlreadyResolved(events, review)) {
      return this.append(input.sessionId, [
        traceEvent(input.sessionId, 'trace/review_accept_noop', '该 Review 已处理或已过期，没有重复推进任务。', this.ts(), this.id('review-noop'), {
          runId: input.runId,
          decision: input.decision,
        }),
      ]);
    }

    if (input.decision === 'reject') {
      let result = await this.append(input.sessionId, [
        reviewDecisionEvent(input.sessionId, review, 'rejected', input.guidance ?? '用户已忽略当前 Review，本轮会话已中止。', false, this.ts(), this.id('review-rejected')),
      ]);
      const decisionReply = await this.kernel({
        command: {
          kind: 'userDecisionSubmit',
          requestId: this.id('user-decision-review'),
          runId: review.runId,
          sessionId: input.sessionId,
          decision: {
            decisionId: this.id('decision-review'),
            decisionKind: 'review',
            targetId: review.reviewId,
            payload: {
              decision: input.decision,
              guidance: input.guidance,
              continuationRequested: false,
              revisionRequested: false,
              ignored: true,
            },
          },
        },
      });
      result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);
      return this.append(input.sessionId, [
        sessionRunStateEvent({
          sessionId: input.sessionId,
          runId: review.runId,
          phase: 'cancelled',
          status: 'cancelled',
          reason: 'review',
          decisionOwner: {
            kind: 'review',
            runId: review.runId,
            targetId: review.reviewId,
            reviewId: review.reviewId,
            planId: review.sourcePlanId,
          },
          ts: this.ts(),
          id: this.id('session-run-cancelled-review'),
        }),
      ]) ?? result;
    }

    if (input.decision !== 'accept') {
      let result = await this.append(input.sessionId, [
        reviewDecisionEvent(input.sessionId, review, 'needsRevision', input.guidance ?? '用户要求补充或修改。', false, this.ts(), this.id('review-revise')),
      ]);
      const decisionReply = await this.kernel({
        command: {
          kind: 'userDecisionSubmit',
          requestId: this.id('user-decision-review'),
          runId: review.runId,
          sessionId: input.sessionId,
          decision: {
            decisionId: this.id('decision-review'),
            decisionKind: 'review',
            targetId: review.reviewId,
            payload: {
              decision: input.decision,
              guidance: input.guidance,
              continuationRequested: true,
              revisionRequested: true,
            },
          },
        },
      });
      result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: reviewRevisionRequest(review, input.guidance),
        attachments: [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        interventionLevel: input.interventionLevel,
      });
    }

    const terminalAcceptedPlan = reviewIsTerminalAcceptedPlan(events, review);
    const accepted = reviewDecisionEvent(input.sessionId, review, 'accepted', acceptedReviewContent(review, terminalAcceptedPlan), false, this.ts(), this.id('review-accepted'));
    let result = await this.append(input.sessionId, [accepted]);
    const decisionReply = await this.kernel({
      command: {
        kind: 'userDecisionSubmit',
        requestId: this.id('user-decision-review'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decisionId: this.id('decision-review'),
          decisionKind: 'review',
          targetId: review.reviewId,
          payload: {
            decision: input.decision,
            guidance: input.guidance,
            continuationRequested: false,
            continuationRecorded: review.continuations.length > 0,
          },
        },
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, decisionReply);
    const gateReply = await this.kernel({
      command: {
        kind: 'reviewGateEvaluate',
        requestId: this.id('review-gate-evaluate'),
        runId: review.runId,
        sessionId: input.sessionId,
        decision: {
          decision: input.decision,
          guidance: input.guidance,
        },
      },
    });
    result = await this.appendProjectedKernelEvents(input.sessionId, gateReply) ?? result;

    const continuationMode = input.reviewContinuationMode ?? 'auto';
    if (terminalAcceptedPlan || !review.continuations.length || continuationMode === 'off') {
      if (kernelReviewGateStatus(gateReply.events) === 'accepted') {
        result = await this.append(input.sessionId, [
          sessionRunStateEvent({
            sessionId: input.sessionId,
            runId: review.runId,
            phase: 'completed',
            status: 'completed',
            reason: 'review',
            decisionOwner: {
              kind: 'review',
              runId: review.runId,
              targetId: review.reviewId,
              reviewId: review.reviewId,
              planId: review.sourcePlanId,
            },
            ts: this.ts(),
            id: this.id('session-run-completed-review'),
          }),
        ]) ?? result;
      }
      return result;
    }
    if (continuationMode === 'ask') {
      return this.append(input.sessionId, [
        continuationDecisionPromptEvent(input.sessionId, review, this.ts(), this.id('review-continuation-choice')),
      ]) ?? result;
    }
    return this.runUserTurn({
      sessionId: input.sessionId,
      content: reviewContinuationRequest(review),
      attachments: [],
      existingEvents: result.events,
      workspaceBinding: input.workspaceBinding,
      projectWorkingDirectory: input.projectWorkingDirectory,
      profileId: input.profileId,
      workflow: input.workflow,
      appendUserMessage: false,
      requirementConfirmationMode: 'off',
      reviewContinuationMode: continuationMode,
      interventionLevel: input.interventionLevel,
    });
  }

  private async buildRequirementConfirmation(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState
  ): Promise<AgentEvent> {
    const assembledContext = assembleContext({
      contextAssemblyId: this.id('context-assembly'),
      workflowState: 'needDecisionRequest',
      allowedProposals: ['decisionRequest'],
      capabilityCatalogSummary: (state.stateContract?.capabilityProjection ?? []).join('\n'),
      memoryDocument: state.memoryDocument,
      extraMemoryHints: state.memoryHints,
      interventionLevel: input.interventionLevel,
      userGuidance: collectUserGuidanceEvents(input.existingEvents ?? [], state.runId),
      userOverlay: [
        'Before proposing side-effect work, request user intervention only if a concrete decision is needed.',
        'Return kind="decisionRequest" only.',
        'Provide 2-3 clear options with one recommended option and impact descriptions.',
        'Do not output actionBundle yet.',
      ].join('\n'),
      userRequest: input.content,
      initialContext: state.initialContext,
      resourcePackets: state.resourcePackets,
      conversationRoots: state.conversationRoots,
      auditOnly: {
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });
    state.cachePlan = assembledContext.cachePlan;
    state.contextAssembly = assembledContext.contextAssembly;
    const prompt = assembledContext.prompt;
    const proposal = await this.callProviderAndParse(input, state, prompt);
    if (proposal.kind !== 'decisionRequest') {
      throw new SessionDriverLoopError(
        'decision_request_expected',
        `Expected decisionRequest before side-effect planning, got ${proposal.kind}.`
      );
    }
    const requirement = requirementRecordFromProposal(proposal, input, state, this.ts());
    return requirementConfirmationEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      requirement,
      proposal,
      originalUserRequest: input.content,
      attachments: input.attachments ?? [],
      ts: this.ts(),
      id: this.id('requirement-confirmation'),
    });
  }

  private async maybeReviseTerminalAnswerWithGuidance(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    draftAnswer: ProposalEnvelope
  ): Promise<AgentSessionResult | null> {
    if (state.terminalGuidanceRevisionAttempted) return null;
    state.terminalGuidanceRevisionAttempted = true;

    let result = await this.append(state.sessionId, []);
    const guidance = collectQueuedUserGuidanceEvents(result.events, state.runId);
    if (guidance.length === 0) return null;

    result = await this.append(state.sessionId, [
      guidanceRevisionTransitionEvent(
        state.sessionId,
        state.runId,
        guidance.map((item) => item.id),
        input.content,
        this.ts(),
        this.id('guidance-revision-transition')
      ),
    ]);
    state.taskGraph = buildSessionTaskGraph({
      sessionId: state.sessionId,
      runId: state.runId,
      events: result.events,
      stateContract: state.stateContract,
      driverRequest: state.driverRequest,
    });
    const assembledContext = assembleContext({
      contextAssemblyId: this.id('context-assembly-guidance-revision'),
      workflowState: 'guidanceRevision',
      allowedProposals: ['answer'],
      capabilityCatalogSummary: (state.stateContract?.capabilityProjection ?? []).join('\n'),
      memoryDocument: state.memoryDocument,
      extraMemoryHints: implementationBatchHints(state.implementationBatch),
      interventionLevel: input.interventionLevel,
      userOverlay: guidanceRevisionOverlay(input.content, draftAnswer, guidance),
      userGuidance: guidance,
      userRequest: input.content,
      initialContext: state.initialContext,
      resourcePackets: state.resourcePackets,
      conversationRoots: state.conversationRoots,
      requirement: input.confirmedRequirement,
      auditOnly: {
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });
    state.cachePlan = assembledContext.cachePlan;
    state.contextAssembly = assembledContext.contextAssembly;
    result = await this.appendConsumedUserGuidanceEvents(
      state.sessionId,
      result,
      state.contextAssembly,
      state.runId,
      'guidance_revision'
    );

    let revised: ProposalEnvelope;
    try {
      const raw = await this.llm(input.profileId, state, 'guidance_revision', [
        { role: 'system', content: assembledContext.prompt.stablePrefix },
        { role: 'user', content: assembledContext.prompt.dynamicSuffix },
      ]);
      revised = parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
      if (revised.kind !== 'answer') {
        throw new SessionDriverLoopError(
          'guidance_revision_non_answer',
          `Guidance revision expected answer, got ${revised.kind}.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.append(state.sessionId, [
        guidanceRevisionDiagnosticEvent(
          state.sessionId,
          `用户引导合并失败，已回退到初版回复：${message}`,
          this.ts(),
          this.id('guidance-revision-failed')
        ),
      ]);
      return this.append(state.sessionId, [
        answerEvent(state.sessionId, draftAnswer, this.ts(), this.id('answer'), {
          guidanceRevisionFailed: true,
          appliedGuidanceIds: guidance.map((item) => item.id),
          replacesDraftProposalId: draftAnswer.proposalId,
        }),
      ]);
    }

    const narration = answerNarrationEvent(state.sessionId, revised, this.ts(), this.id('guidance-revision-narration'));
    if (narration) {
      result = await this.append(state.sessionId, [narration]);
    }
    return this.append(state.sessionId, [
      answerEvent(state.sessionId, revised, this.ts(), this.id('answer'), {
        guidanceRevision: true,
        appliedGuidanceIds: guidance.map((item) => item.id),
        replacesDraftProposalId: draftAnswer.proposalId,
      }),
    ]);
  }

  private async callProviderAndParse(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope
  ): Promise<ProposalEnvelope> {
    let raw: string;
    try {
      const providerResult = await this.callProviderWithNativeTools(input, state, prompt, [
        { role: 'system', content: prompt.stablePrefix },
        { role: 'user', content: prompt.dynamicSuffix },
      ]);
      if (typeof providerResult !== 'string') return providerResult;
      raw = providerResult;
    } catch (error) {
      if (error instanceof SessionDriverLoopError
        && error.code === 'llm_empty_response'
        && shouldAttemptActionBundleCompactionRepair(state)) {
        await this.append(state.sessionId, [
          thinkingEvent(
            state.sessionId,
            '模型没有返回有效 JSON，Session 正在要求其缩小为下一批可审查 actionBundle。',
            this.ts(),
            this.id('action-bundle-compaction-repair')
          ),
        ]);
        const repairedRaw = await this.llm(
          input.profileId,
          state,
          'action_bundle_compaction_repair',
          actionBundleCompactionRepairMessages(prompt, state, 'LLM provider returned an empty response before emitting a JSON proposal.', '')
        );
        try {
          return parseAndValidateProposal({
            raw: repairedRaw,
            runId: state.runId,
            sessionId: state.sessionId,
            source: 'llm',
          });
        } catch (repairError) {
          throw new SessionDriverLoopError(
            'agent_protocol_repair_failed',
            `模型空响应 repair 后仍无法解析：${normalizeParseError(repairError).message}`
          );
        }
      }
      throw error;
    }
    try {
      return parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      const parseError = normalizeParseError(error);
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          `模型输出需要按 Agent Protocol v3 修复：${parseError.message}`,
          this.ts(),
          this.id('protocol-repair')
        ),
      ]);
      const repairStage = parseError.code === 'action_bundle_budget_exceeded'
        ? 'action_bundle_budget_repair'
        : 'protocol_repair';
      const repairPrompt = parseError.code === 'action_bundle_budget_exceeded'
        ? actionBundleCompactionRepairMessages(prompt, state, parseError.message, raw)
        : repairMessages(prompt, state, raw, parseError);
      const repairedRaw = await this.llm(input.profileId, state, repairStage, repairPrompt);
      try {
        return parseAndValidateProposal({
          raw: repairedRaw,
          runId: state.runId,
          sessionId: state.sessionId,
          source: 'llm',
        });
      } catch (repairError) {
        throw new SessionDriverLoopError(
          'agent_protocol_repair_failed',
          `模型输出不符合 Agent Protocol v3，repair 后仍无法解析：${normalizeParseError(repairError).message}`
        );
      }
    }
  }

  private async callProviderWithNativeTools(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    messages: LlmChatRequest['messages']
  ): Promise<string | ProposalEnvelope> {
    let currentMessages = [...messages];
    for (let round = 0; ; round += 1) {
      const stage = round === 0 ? 'provider_call' : `provider_tool_resume_${round}`;
      const turn = await this.llmTurn(input.profileId, state, stage, currentMessages, {
        responseFormat: { type: 'json_object' },
        tools: nativeProviderToolsForState(state),
      });
      if (turn.toolCalls.length === 0) return turn.content;

      const handled = await this.handleNativeToolCalls(input, state, prompt, turn, round);
      if (handled.kind === 'proposal') return handled.proposal;

      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant',
          content: turn.content,
          reasoningContent: turn.reasoning || undefined,
          toolCalls: turn.toolCalls.map(nativeToolCallToProtocol),
        },
        ...handled.toolMessages,
      ];
      const guidanceMessages = await this.consumeQueuedGuidanceForProviderResume(state, stage);
      currentMessages.push(...guidanceMessages);
    }
  }

  private async handleNativeToolCalls(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    turn: LlmTurnResult,
    round: number
  ): Promise<NativeToolHandlingResult> {
    const language = visibleLanguageForRequest(state.userRequest);
    const narration = turn.content.trim();
    if (narration) {
      await this.append(state.sessionId, [
        this.event(state.sessionId, 'assistant_msg', {
          content: narration,
          channel: 'progress',
          source: 'llm',
          visibility: 'conversation',
          presentation: 'body',
          runId: state.runId,
        }),
      ]);
    } else {
      await this.emitProjectionDelta(state, {
        type: 'stage_delta',
        stage: `native_tool_round_${round + 1}`,
        status: 'running',
        channel: 'progress',
        source: 'session',
        summary: 'native_tool_checkpoint',
        payload: {
          visibility: 'task',
          nativeToolRound: round,
          toolCallCount: turn.toolCalls.length,
          resourcePacketCount: state.resourcePackets.length,
        },
      });
    }
    const unsupportedOrSideEffect = turn.toolCalls.find((toolCall) => !canResolveNativeToolReadOnly(toolCall));
    if (unsupportedOrSideEffect) {
      const repaired = await this.repairSideEffectNativeTool(input, state, prompt, unsupportedOrSideEffect, turn);
      return {
        kind: 'proposal',
        proposal: repaired,
      };
    }

    const toolMessages: LlmChatRequest['messages'] = [];
    for (const toolCall of turn.toolCalls) {
      await this.emitProjectionDelta(state, {
        type: 'tool_call_delta',
        stage: 'native_tool_call',
        status: 'running',
        channel: 'tool',
        source: 'session',
        itemId: toolCall.callId,
        summary: nativeToolResolveRunningSummary(toolCall.name, language),
        payload: {
          callId: toolCall.callId,
          name: toolCall.name,
          arguments: toolCall.arguments,
          nativeToolRound: round,
        },
      });
      const packet = await this.resolveNativeReadToolCall(state, toolCall);
      state.resourcePackets.push(packet);
      addDiscoveredManifestEntries(state.manifest, packet);
      await this.append(state.sessionId, [
        resourcePacketEvent(state.sessionId, packet, this.ts(), this.id('native-resource-context')),
      ]);
      await this.emitProjectionDelta(state, {
        type: 'resource_delta',
        stage: 'native_tool_resource_resolve',
        status: 'completed',
        channel: 'resource',
        source: 'kernel',
        itemId: toolCall.callId,
        summary: nativeToolResolveCompletedSummary(toolCall.name, language),
        payload: {
          callId: toolCall.callId,
          packetId: packet.id,
          itemCount: packet.items.length,
          nativeToolRound: round,
          resourcePacketCount: state.resourcePackets.length,
        },
      });
      toolMessages.push({
        role: 'tool',
        toolCallId: toolCall.callId,
        content: clipJson(nativeToolResultFromPacket(toolCall, packet), NATIVE_TOOL_RESULT_MAX_CHARS),
      });
    }
    return { kind: 'resume', toolMessages };
  }

  private async resolveNativeReadToolCall(
    state: SessionDriverLoopRunState,
    toolCall: NativeToolCallProposal
  ): Promise<ResourcePacket> {
    const manifest = nativeReadToolManifest(state, toolCall);
    return this.resolveResources(state, manifest);
  }

  private async repairSideEffectNativeTool(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    toolCall: NativeToolCallProposal,
    turn: LlmTurnResult
  ): Promise<ProposalEnvelope> {
    await this.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'native_tool_side_effect_blocked',
      status: 'failed',
      channel: 'progress',
      source: 'session',
      summary: 'side_effect_native_tool_blocked',
      payload: {
        visibility: 'task',
        callId: toolCall.callId,
        name: toolCall.name,
      },
    });
    const raw = await this.llm(
      input.profileId,
      state,
      'native_tool_side_effect_repair',
      sideEffectNativeToolRepairMessages(prompt, state, toolCall, turn)
    );
    try {
      return parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'native_tool_side_effect_repair_failed',
        `Provider requested side-effect native tool ${toolCall.name}; repair failed: ${normalizeParseError(error).message}`
      );
    }
  }

  private async consumeQueuedGuidanceForProviderResume(
    state: SessionDriverLoopRunState,
    stage: string
  ): Promise<LlmChatRequest['messages']> {
    const current = await this.append(state.sessionId, []);
    const guidance = collectQueuedUserGuidanceEvents(current.events, state.runId);
    if (guidance.length === 0) return [];
    const language = visibleLanguageForRequest(state.userRequest);
    const events = guidance.map((item) => {
      const payload: Record<string, unknown> = {
        title: 'User guidance',
        summary: userGuidanceConsumedSummary(language),
        status: 'consumed',
        guidanceId: item.id,
        targetRunId: state.runId,
        targetInteractionKind: 'runningRunGuidance',
        effectiveCheckpoint: 'nextProviderCall',
        checkpointKind: 'userGuidance',
        appliedAtProviderStage: stage,
        source: 'session',
        channel: 'progress',
        visibility: 'conversation',
        presentation: 'body',
      };
      return this.event(state.sessionId, 'user_guidance', payload);
    });
    await this.append(state.sessionId, events);
    return [{
      role: 'user',
      content: [
        'User guidance received before the provider resume. Apply it to the next response or tool decision without starting a parallel run:',
        ...guidance.map((item) => `- ${item.id}: ${clip(item.content, 1200)}`),
      ].join('\n'),
    }];
  }

  private async repairResourceRequest(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    resolution: ResourceRequestResolution
  ): Promise<ProposalEnvelope> {
    const raw = await this.llm(input.profileId, state, 'resource_request_repair', resourceRequestRepairMessages(prompt, state, proposal, resolution));
    try {
      return parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'agent_protocol_repair_failed',
        `模型资源请求 repair 后仍无法解析：${normalizeParseError(error).message}`
      );
    }
  }

  private async resolveResources(
    state: SessionDriverLoopRunState,
    manifest: ResourceManifest
  ): Promise<ResourcePacket> {
    const reply = await this.kernel({
      command: {
        kind: 'resourceResolve',
        requestId: this.id('resource-resolve'),
        runId: state.runId,
        sessionId: state.sessionId,
        request: { manifest },
      },
    });
    const packet = findResourcePacket(reply.events);
    if (!packet) {
      throw new SessionDriverLoopError('resource_packet_missing', 'Kernel ResourceResolve did not produce a ResourcePacket.');
    }
    return packet;
  }

  private async submitActionProposal(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const actionBundle = readActionBundle(proposal);
    if (actionBundle && state.acceptedImplementationPlan) {
      return this.submitAcceptedPlanActionProposal(input, state, prompt, proposal, fallback);
    }
    const proposalReply = await this.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.id('proposal-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal,
      },
    });
    if (!actionBundle) return await this.appendProjectedKernelEvents(state.sessionId, proposalReply) ?? fallback;
    const reviewReport = findPlanReviewReport(proposalReply.events);
    await this.appendProviderTrace(state, 'plan_review_report', {
      proposalId: proposal.proposalId,
      report: reviewReport,
      events: proposalReply.events,
    });
    if (!reviewReport) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          'Kernel 未返回 actionBundle 的 proposal.reviewed 事件，Session 不会展示可确认计划。',
          this.ts(),
          this.id('plan-review-missing')
        ),
      ]);
    }
    if (reviewReport && planReviewNeedsRepair(reviewReport) && !state.planReviewRepairAttempted) {
      state.planReviewRepairAttempted = true;
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          'Kernel PlanReview 要求补充计划证据，Session 正在进行一次受控 repair。',
          this.ts(),
          this.id('plan-review-repair')
        ),
      ]);
      let repaired: ProposalEnvelope;
      try {
        repaired = await this.repairPlanReview(input, state, prompt, proposal, reviewReport);
      } catch (error) {
        const message = error instanceof SessionDriverLoopError ? error.message : String(error);
        return this.append(state.sessionId, [
          finalDiagnosticEvent(
            state.sessionId,
            `计划需要修订，但模型 repair 失败：${message}`,
            this.ts(),
            this.id('plan-review-repair-failed')
          ),
        ]);
      }
      if (repaired.kind === 'actionBundle') {
        return this.submitActionProposal(input, state, prompt, repaired, fallback);
      }
      if (repaired.kind === 'answer') {
        return this.append(state.sessionId, [answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]);
      }
      return this.submitNonExecutableProposal(state, repaired, fallback);
    }
    let result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply);
    if (planReviewDenied(reviewReport)) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          `Kernel 拒绝该计划：${planReviewDiagnosticSummary(reviewReport)}`,
          this.ts(),
          this.id('plan-review-denied')
        ),
      ]);
    }
    const planCard = actionBundlePlanCardEvent(state, proposal, reviewReport, this.ts(), this.id('plan-card'));
    const planId = stringValue(objectRecord(planCard.payload)?.planId) ?? proposal.proposalId;
    state.phase = 'waiting_plan_review';
    result = await this.append(state.sessionId, [
      planCard,
      sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_plan_review',
        reason: 'plan_review',
        decisionOwner: {
          kind: 'plan',
          runId: state.runId,
          targetId: planId,
          planId,
        },
        ts: this.ts(),
        id: this.id('session-run-waiting-plan'),
      }),
    ]);
    return result ?? fallback;
  }

  private async submitAcceptedPlanActionProposal(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const accepted = state.acceptedImplementationPlan;
    const actionBundle = readActionBundle(proposal);
    if (!accepted || !actionBundle) return fallback;

    const validation = validateAcceptedImplementationPlanActionBundle(accepted, proposal, state.resourcePackets);
    if (!validation.ok) {
      if (!state.acceptedPlanScopeRepairAttempted) {
        state.acceptedPlanScopeRepairAttempted = true;
        await this.append(state.sessionId, [
          thinkingEvent(
            state.sessionId,
            '当前自动执行批次超出已确认计划范围，Session 正在要求模型按 accepted implementationPlan 重新拆分一次。',
            this.ts(),
            this.id('accepted-plan-scope-repair')
          ),
        ]);
        try {
          const repaired = await this.repairAcceptedPlanScope(input, state, prompt, proposal, validation);
          if (repaired.kind === 'actionBundle') {
            return this.submitAcceptedPlanActionProposal(input, state, prompt, repaired, fallback);
          }
          if (repaired.kind === 'resourceRequest') {
            const subset = manifestForResourceRequest(state.manifest, repaired.payload as ResourceRequestDraft, state.conversationRoots);
            if (!subset.manifest.entries.length) {
              return this.append(state.sessionId, [
                finalDiagnosticEvent(
                  state.sessionId,
                  `自动执行批次需要补充资源证据，但 repair 后的 resourceRequest 无法定位：${resourceResolutionDiagnostic(subset)}`,
                  this.ts(),
                  this.id('accepted-plan-scope-repair-resource-invalid')
                ),
              ]);
            }
            const packet = await this.resolveResources(state, subset.manifest);
            state.resourcePackets.push(packet);
            addDiscoveredManifestEntries(state.manifest, packet);
            const result = await this.append(state.sessionId, [
              resourcePacketEvent(state.sessionId, packet, this.ts(), this.id('accepted-plan-repair-resource-context')),
            ]) ?? fallback;
            return this.runUserTurn({
              sessionId: input.sessionId,
              content: implementationPlanExecutionRequest(
                acceptedPlanExecutionContext(state, proposal, {}),
                accepted,
                'Session 已补充当前修改所需的只读 search/read 证据；请基于 ResourcePacket 输出同一 accepted implementationPlan 范围内的下一批 actionBundle。'
              ),
              attachments: accepted.executionRoot ? [accepted.executionRoot.attachment] : [],
              existingEvents: result.events,
              workspaceBinding: input.workspaceBinding,
              projectWorkingDirectory: input.projectWorkingDirectory,
              profileId: input.profileId,
              workflow: input.workflow,
              appendUserMessage: false,
              requirementConfirmationMode: 'off',
              reviewContinuationMode: input.reviewContinuationMode,
              interventionLevel: input.interventionLevel,
              resumeResourcePackets: true,
              acceptedImplementationPlan: accepted,
            });
          }
          if (repaired.kind === 'decisionRequest') {
            const requirement = requirementRecordFromProposal(repaired, input, state, this.ts());
            const confirmation = requirementConfirmationEvent({
              sessionId: state.sessionId,
              runId: state.runId,
              requirement,
              proposal: repaired,
              originalUserRequest: input.content,
              attachments: input.attachments ?? [],
              ts: this.ts(),
              id: this.id('accepted-plan-scope-repair-decision'),
            });
            state.phase = 'waiting_plan_review';
            return this.append(state.sessionId, [
              confirmation,
              sessionRunStateEvent({
                sessionId: state.sessionId,
                runId: state.runId,
                phase: 'waiting_plan_review',
                reason: 'requirement',
                decisionOwner: {
                  kind: 'requirement',
                  runId: state.runId,
                  targetId: requirement.requirementId,
                  requirementId: requirement.requirementId,
                },
                ts: this.ts(),
                id: this.id('session-run-waiting-accepted-plan-repair-decision'),
              }),
            ]);
          }
          if (repaired.kind === 'implementationPlan') {
            const planId = stringValue(objectRecord(repaired.payload)?.id) ?? repaired.proposalId;
            state.phase = 'waiting_plan_review';
            return this.append(state.sessionId, [
              implementationPlanCardEvent(state, repaired, this.ts(), this.id('accepted-plan-scope-repair-plan')),
              sessionRunStateEvent({
                sessionId: state.sessionId,
                runId: state.runId,
                phase: 'waiting_plan_review',
                reason: 'plan_review',
                decisionOwner: {
                  kind: 'plan',
                  runId: state.runId,
                  targetId: planId,
                  planId,
                },
                ts: this.ts(),
                id: this.id('session-run-waiting-accepted-plan-repair-plan'),
              }),
            ]);
          }
          return this.submitNonExecutableProposal(state, repaired, fallback);
        } catch (error) {
          const message = error instanceof SessionDriverLoopError ? error.message : String(error);
          return this.append(state.sessionId, [
            finalDiagnosticEvent(
              state.sessionId,
              `自动执行批次越界，且模型 repair 失败：${message}`,
              this.ts(),
              this.id('accepted-plan-scope-repair-failed')
            ),
          ]);
        }
      }
      return this.appendAcceptedPlanBatchOutOfScope(input, state, proposal, validation);
    }

    state.phase = 'executing_accepted_plan';
    let result = await this.append(state.sessionId, [
      sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'executing_accepted_plan',
        status: 'running',
        reason: 'accepted_plan_execution',
        decisionOwner: {
          kind: 'plan',
          runId: state.runId,
          targetId: accepted.planId,
          planId: accepted.planId,
        },
        ts: this.ts(),
        id: this.id('session-run-accepted-plan-execution'),
      }),
    ]) ?? fallback;

    const proposalReply = await this.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.id('proposal-submit-accepted-plan'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal,
      },
    });
    const reviewReport = findPlanReviewReport(proposalReply.events);
    await this.appendProviderTrace(state, 'accepted_plan_batch_review_report', {
      acceptedPlanId: accepted.planId,
      proposalId: proposal.proposalId,
      report: reviewReport,
      events: proposalReply.events,
    });
    if (!reviewReport) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          'Kernel 未返回 accepted-plan actionBundle 的 proposal.reviewed 事件，Session 不会自动执行该批次。',
          this.ts(),
          this.id('accepted-plan-review-missing')
        ),
      ]);
    }
    if (reviewReport && planReviewNeedsRepair(reviewReport) && !state.planReviewRepairAttempted) {
      state.planReviewRepairAttempted = true;
      await this.append(state.sessionId, [
        thinkingEvent(
          state.sessionId,
          'Kernel PlanReview 要求补充当前自动执行批次的证据，Session 正在进行一次受控 repair。',
          this.ts(),
          this.id('accepted-plan-review-repair')
        ),
      ]);
      let repaired: ProposalEnvelope;
      try {
        repaired = await this.repairPlanReview(input, state, prompt, proposal, reviewReport);
      } catch (error) {
        const message = error instanceof SessionDriverLoopError ? error.message : String(error);
        return this.append(state.sessionId, [
          finalDiagnosticEvent(
            state.sessionId,
            `自动执行批次需要修订，但模型 repair 失败：${message}`,
            this.ts(),
            this.id('accepted-plan-review-repair-failed')
          ),
        ]);
      }
      if (repaired.kind === 'actionBundle') {
        return this.submitAcceptedPlanActionProposal(input, state, prompt, repaired, fallback);
      }
      if (repaired.kind === 'answer') {
        return this.append(state.sessionId, [answerEvent(state.sessionId, repaired, this.ts(), this.id('answer'))]);
      }
      return this.submitNonExecutableProposal(state, repaired, fallback);
    }

    result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply) ?? result;
    if (planReviewDenied(reviewReport)) {
      return this.append(state.sessionId, [
        finalDiagnosticEvent(
          state.sessionId,
          `Kernel 拒绝该自动执行批次：${planReviewDiagnosticSummary(reviewReport)}`,
          this.ts(),
          this.id('accepted-plan-review-denied')
        ),
      ]);
    }
    if (reviewReport.status === 'needsRevision') {
      return this.appendAcceptedPlanBatchOutOfScope(input, state, proposal, {
        ok: false,
        reasons: [`Kernel PlanReview 要求修订当前批次：${planReviewDiagnosticSummary(reviewReport)}`],
      });
    }

    const autoGrantBlockers = nonAcceptedPlanPermissionGaps(reviewReport, accepted);
    if (autoGrantBlockers.length) {
      return this.appendAcceptedPlanBatchOutOfScope(input, state, proposal, {
        ok: false,
        reasons: autoGrantBlockers.map((capability) => `当前批次需要额外权限 ${capability}，不属于 accepted implementationPlan 自动执行范围。`),
      });
    }

    const plan = acceptedPlanExecutionContext(state, proposal, reviewReport);
    const grantEvents: unknown[] = [];
    for (const grant of temporaryGrantsForPlan(plan)) {
      const grantReply = await this.kernel({
        command: {
          kind: 'permissionGrantTemporary',
          requestId: this.id('accepted-plan-temp-grant'),
          runId: state.runId,
          grant,
        },
      });
      grantEvents.push(...(grantReply.events ?? []));
    }
    if (grantEvents.length) {
      result = await this.appendProjectedKernelEvents(state.sessionId, { ok: true, events: grantEvents }) ?? result;
    }

    const batchReply = await this.kernel({
      command: {
        kind: 'actionBatchSubmit',
        requestId: this.id('accepted-plan-action-batch-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        batch: {
          planId: accepted.planId,
          actionBundle: plan.actionBundle,
          codeBlocks: plan.codeBlocks,
          commandBlocks: plan.commandBlocks,
        },
      },
    });
    result = await this.appendProjectedKernelEvents(state.sessionId, batchReply) ?? result;
    if (!actionBatchReadyForReview(batchReply.events ?? [])) {
      if (kernelEventsContainPermissionRequest(batchReply.events ?? [])) {
        const permissionId = permissionIdFromKernelEvents(batchReply.events ?? []);
        return this.append(state.sessionId, [
          sessionRunStateEvent({
            sessionId: state.sessionId,
            runId: state.runId,
            phase: 'waiting_permission',
            reason: 'permission',
            decisionOwner: {
              kind: 'permission',
              runId: state.runId,
              targetId: permissionId,
              permissionId,
              planId: accepted.planId,
            },
            ts: this.ts(),
            id: this.id('session-run-waiting-permission'),
          }),
        ]) ?? result;
      }
      return result;
    }
    const batchProgress = acceptedPlanBatchProgress(accepted, proposal, batchReply.events ?? []);
    const nextAccepted = acceptedPlanAfterBatch(accepted, batchProgress.completedTaskIds);
    result = await this.append(state.sessionId, [
      acceptedPlanBatchCheckpointEvent(
        state.sessionId,
        state.runId,
        accepted,
        proposal,
        batchReply.events ?? [],
        batchProgress,
        this.ts(),
        this.id('accepted-plan-batch-checkpoint')
      ),
    ]) ?? result;

    if (!actionBatchHasFailureOrBlocker(batchReply.events ?? []) && !acceptedPlanComplete(nextAccepted)) {
      return this.runUserTurn({
        sessionId: input.sessionId,
        content: implementationPlanExecutionRequest(
          { ...acceptedPlanExecutionContext(state, proposal, reviewReport), implementationPlan: accepted.rawPlan },
          nextAccepted
        ),
        attachments: nextAccepted.executionRoot ? [nextAccepted.executionRoot.attachment] : [],
        existingEvents: result.events,
        workspaceBinding: input.workspaceBinding,
        projectWorkingDirectory: input.projectWorkingDirectory,
        profileId: input.profileId,
        workflow: input.workflow,
        appendUserMessage: false,
        requirementConfirmationMode: 'off',
        reviewContinuationMode: input.reviewContinuationMode,
        interventionLevel: input.interventionLevel,
        resumeResourcePackets: true,
        acceptedImplementationPlan: nextAccepted,
      });
    }

    const factsReply = await this.kernel({
      command: {
        kind: 'reviewFactsGet',
        requestId: this.id('accepted-plan-review-facts-get'),
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });
    result = await this.appendProjectedKernelEvents(state.sessionId, factsReply) ?? result;
    const review = reviewSummaryEvent(
      state.sessionId,
      plan,
      [...(batchReply.events ?? []), ...(factsReply.events ?? [])],
      this.ts(),
      this.id('review-summary')
    );
    const reviewPayload = objectRecord(review.payload) ?? {};
    return this.append(state.sessionId, [
      review,
      sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_review',
        reason: 'review',
        decisionOwner: {
          kind: 'review',
          runId: state.runId,
          targetId: stringValue(reviewPayload.reviewId) ?? state.runId,
          reviewId: stringValue(reviewPayload.reviewId) ?? state.runId,
          planId: accepted.planId,
        },
        ts: this.ts(),
        id: this.id('session-run-waiting-review'),
      }),
    ]) ?? result;
  }

  private async appendAcceptedPlanBatchOutOfScope(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    proposal: ProposalEnvelope,
    validation: AcceptedPlanBatchValidationResult
  ): Promise<AgentSessionResult> {
    const decisionProposal = acceptedPlanOutOfScopeDecisionProposal(state, proposal, validation, this.id('accepted-plan-scope-decision'));
    const requirement = requirementRecordFromProposal(decisionProposal, input, state, this.ts());
    const confirmation = requirementConfirmationEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      requirement,
      proposal: decisionProposal,
      originalUserRequest: input.content,
      attachments: input.attachments ?? [],
      ts: this.ts(),
      id: this.id('accepted-plan-scope-confirmation'),
    });
    state.phase = 'waiting_plan_review';
    return this.append(state.sessionId, [
      confirmation,
      sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_plan_review',
        reason: 'requirement',
        decisionOwner: {
          kind: 'requirement',
          runId: state.runId,
          targetId: requirement.requirementId,
          requirementId: requirement.requirementId,
        },
        ts: this.ts(),
        id: this.id('session-run-waiting-accepted-plan-scope'),
      }),
    ]);
  }

  private async repairPlanReview(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    report: Record<string, unknown>
  ): Promise<ProposalEnvelope> {
    const raw = await this.llm(input.profileId, state, 'plan_review_repair', planReviewRepairMessages(prompt, state, proposal, report));
    try {
      return parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'agent_protocol_repair_failed',
        `模型计划 repair 后仍无法解析：${normalizeParseError(error).message}`
      );
    }
  }

  private async repairAcceptedPlanScope(
    input: SessionDriverLoopInput,
    state: SessionDriverLoopRunState,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    validation: AcceptedPlanBatchValidationResult
  ): Promise<ProposalEnvelope> {
    const raw = await this.llm(input.profileId, state, 'accepted_plan_scope_repair', acceptedPlanScopeRepairMessages(prompt, state, proposal, validation));
    try {
      return parseAndValidateProposal({
        raw,
        runId: state.runId,
        sessionId: state.sessionId,
        source: 'llm',
      });
    } catch (error) {
      throw new SessionDriverLoopError(
        'accepted_plan_scope_repair_failed',
        `模型 accepted-plan scope repair 后仍无法解析：${normalizeParseError(error).message}`
      );
    }
  }

  private async submitNonExecutableProposal(
    state: SessionDriverLoopRunState,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const proposalReply = await this.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.id('proposal-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal,
      },
    });
    const result = await this.appendProjectedKernelEvents(state.sessionId, proposalReply);
    return result ?? fallback;
  }

  private async llm(
    profileId: string | undefined,
    state: SessionDriverLoopRunState,
    stage: string,
    messages: LlmChatRequest['messages']
  ): Promise<string> {
    const turn = await this.llmTurn(profileId, state, stage, messages, {
      responseFormat: { type: 'json_object' },
    });
    if (!turn.content.trim()) {
      throw new SessionDriverLoopError('llm_empty_response', 'LLM provider returned an empty response.');
    }
    return turn.content;
  }

  private async llmTurn(
    profileId: string | undefined,
    state: SessionDriverLoopRunState,
    stage: string,
    messages: LlmChatRequest['messages'],
    options: Pick<LlmChatRequest, 'responseFormat' | 'tools'> = {}
  ): Promise<LlmTurnResult> {
    await this.append(state.sessionId, [
      thinkingEvent(
        state.sessionId,
        providerStageSummary(stage, 'request', visibleLanguageForRequest(state.userRequest)),
        this.ts(),
        this.id(`thinking-${stage}`)
      ),
    ]);
    await this.appendProviderTrace(state, `${stage}.request`, {
      profileId,
      messages,
      cachePlan: state.cachePlan,
      contextAssembly: state.contextAssembly,
      taskGraph: state.taskGraph,
    });
    await this.emitProjectionDelta(state, {
      type: 'active_turn',
      stage,
      status: this.ports.llmChatStream ? 'streaming' : 'running',
      channel: 'progress',
      source: 'session',
      summary: providerStageSummary(stage, 'request', visibleLanguageForRequest(state.userRequest)),
    });
    const request: LlmChatRequest = {
      profileId,
      messages,
      responseFormat: options.responseFormat,
      tools: options.tools,
      stream: Boolean(this.ports.llmChatStream),
      providerOptions: {
        deepcode: {
          cachePlan: state.cachePlan,
          taskGraph: state.taskGraph,
        },
      },
    };
    const toolCallBuffer = new ProviderToolCallBuffer();
    const result = this.ports.llmChatStream
      ? await this.ports.llmChatStream(request, async (event) => {
        await this.handleLlmStreamEvent(state, stage, event, toolCallBuffer);
      })
      : await this.ports.llmChat(request);
    if (!result.ok || !result.data) {
      await this.emitProjectionDelta(state, {
        type: 'error',
        stage,
        status: 'failed',
        channel: 'progress',
        source: 'provider',
        summary: result.message ?? result.error ?? 'LLM provider request failed.',
      });
      throw new SessionDriverLoopError(
        'llm_chat_failed',
        result.message ?? result.error ?? 'LLM provider request failed.'
      );
    }
    const cacheEvent = cacheTelemetryEvent(
      state.sessionId,
      profileId,
      state,
      stage,
      result.data,
      this.ts(),
      this.id(`cache-${stage}`)
    );
    if (cacheEvent) {
      await this.append(state.sessionId, [cacheEvent]);
    }
    await this.appendProviderTrace(state, `${stage}.response`, result.data);
    const reasoning = collectReasoning(result.data);
    if (reasoning.trim()) {
      await this.append(state.sessionId, [
        reasoningEvent(state.sessionId, reasoning, this.ts(), this.id(`reasoning-${stage}`)),
      ]);
    } else {
      await this.append(state.sessionId, [
        thinkingEvent(
            state.sessionId,
            providerStageSummary(stage, 'response', visibleLanguageForRequest(state.userRequest)),
            this.ts(),
            this.id(`thinking-${stage}-response`)
        ),
      ]);
    }
    await this.emitProjectionDelta(state, {
      type: 'active_turn',
      stage,
      status: 'completed',
      channel: 'progress',
      source: 'provider',
      summary: providerStageSummary(stage, 'response', visibleLanguageForRequest(state.userRequest)),
    });
    const content = stripProviderPartFrames(result.data.assistantMessage?.content
      ?? result.data.chunks
        .filter((chunk) => chunk.type === 'delta' && typeof chunk.content === 'string')
        .map((chunk) => chunk.content)
        .join(''));
    const toolCalls = collectNativeToolCalls(result.data, toolCallBuffer);
    if (!content.trim() && toolCalls.length === 0) {
      throw new SessionDriverLoopError('llm_empty_response', 'LLM provider returned an empty response.');
    }
    return {
      result: result.data,
      content,
      reasoning,
      toolCalls,
    };
  }

  private async handleLlmStreamEvent(
    state: SessionDriverLoopRunState,
    stage: string,
    event: LlmChatStreamEvent,
    toolCallBuffer: ProviderToolCallBuffer
  ): Promise<void> {
    const chunk = event.chunk;
    if (event.type === 'provider_delta' && chunk?.content) {
      const frames = this.consumeProviderPartFrames(state, stage, chunk.content);
      for (const frame of frames) {
        await this.submitProviderPartFrame(state, stage, frame);
      }
      if (providerStageExposesAssistantDelta(stage)) {
        await this.emitProjectionDelta(state, {
          type: 'assistant_delta',
          stage,
          status: 'streaming',
          channel: 'final',
          source: 'provider',
          itemId: chunk.callId,
          delta: chunk.content,
          payload: chunk.rawProvider,
        });
      }
      return;
    }
    if (event.type === 'provider_reasoning_delta' && chunk?.content) {
      await this.emitProjectionDelta(state, {
        type: 'reasoning_delta',
        stage,
        status: 'streaming',
        channel: 'reasoning',
        source: 'provider',
        itemId: chunk.callId,
        delta: chunk.content,
        payload: chunk.rawProvider,
      });
      return;
    }
    if (event.type === 'provider_tool_call_delta' && chunk) {
      const language = visibleLanguageForRequest(state.userRequest);
      toolCallBuffer.addChunk(chunk);
      await this.emitProjectionDelta(state, {
        type: 'tool_call_delta',
        stage,
        status: 'streaming',
        channel: 'tool',
        source: 'provider',
        itemId: chunk.callId ?? String(chunk.index ?? 0),
        delta: chunk.toolCallDelta?.argumentsDelta,
        summary: chunk.toolCallDelta?.name
          ? providerToolCallPreparingSummary(chunk.toolCallDelta.name, language)
          : providerToolCallStreamingSummary(language),
        payload: {
          index: chunk.index,
          callId: chunk.callId,
          finishReason: chunk.finishReason,
          toolCallDelta: chunk.toolCallDelta,
          rawProvider: chunk.rawProvider,
        },
      });
      return;
    }
    if (event.type === 'provider_usage') {
      await this.emitProjectionDelta(state, {
        type: 'stage_delta',
        stage,
        status: 'running',
        channel: 'progress',
        source: 'provider',
        summary: providerUsageSummary(visibleLanguageForRequest(state.userRequest)),
        payload: event.usage ?? chunk?.usage,
      });
      return;
    }
    if (event.type === 'provider_error') {
      await this.emitProjectionDelta(state, {
        type: 'error',
        stage,
        status: 'failed',
        channel: 'progress',
        source: 'provider',
        summary: event.error ?? chunk?.error ?? 'Provider stream error.',
        payload: event.rawProvider ?? chunk?.rawProvider,
      });
    }
  }

  private async emitProjectionDelta(
    state: SessionDriverLoopRunState,
    delta: Omit<ProjectionDelta, 'sessionId' | 'runId' | 'turnId' | 'seq'>
  ): Promise<void> {
    if (!this.ports.onProjectionDelta) return;
    const activeTurn = state.activeTurn ?? {
      turnId: this.id('active-turn'),
      seq: 0,
      stage: delta.stage ?? 'provider_call',
    };
    activeTurn.seq += 1;
    activeTurn.stage = delta.stage ?? activeTurn.stage;
    state.activeTurn = activeTurn;
    await this.ports.onProjectionDelta({
      ...delta,
      sessionId: state.sessionId,
      runId: state.runId,
      turnId: activeTurn.turnId,
      seq: activeTurn.seq,
    });
  }

  private consumeProviderPartFrames(
    state: SessionDriverLoopRunState,
    stage: string,
    content: string
  ): AgentStreamPartFrame[] {
    const activeTurn = state.activeTurn ?? {
      turnId: this.id('active-turn'),
      seq: 0,
      stage,
    };
    activeTurn.partFrameParser ??= new ProviderPartFrameParser();
    state.activeTurn = activeTurn;
    return activeTurn.partFrameParser.push(content);
  }

  private async submitProviderPartFrame(
    state: SessionDriverLoopRunState,
    stage: string,
    frame: AgentStreamPartFrame
  ): Promise<void> {
    await this.emitProjectionDelta(state, {
      type: 'part_delta',
      stage,
      status: 'streaming',
      channel: frame.partKind === 'thinkingDelta' ? 'reasoning' : 'draft',
      source: 'session',
      itemId: frame.frameId ?? frame.draftId,
      delta: frame.chunk,
      summary: frame.summary ?? `Provider stream part: ${frame.partKind}`,
      payload: frame,
    });

    const reply = await this.ports.kernelCommand({
      requestId: this.id('draft-ledger-submit'),
      command: {
        kind: 'draftLedgerSubmit',
        requestId: this.id('draft-ledger'),
        runId: state.runId,
        sessionId: state.sessionId,
        frame: {
          ...frame,
          runId: frame.runId ?? state.runId,
        },
      },
    });
    if (!reply.ok) {
      await this.emitProjectionDelta(state, {
        type: 'error',
        stage,
        status: 'failed',
        channel: 'draft',
        source: 'kernel',
        itemId: frame.frameId ?? frame.draftId,
        summary: reply.error?.message ?? 'Kernel draft ledger rejected provider stream part.',
        payload: reply.error,
      });
      return;
    }
    for (const event of reply.events) {
      const record = objectRecord(event);
      await this.emitProjectionDelta(state, {
        type: 'draft_delta',
        stage,
        status: 'streaming',
        channel: 'draft',
        source: 'kernel',
        itemId: stringValue(record?.draftId) ?? frame.draftId,
        summary: stringValue(record?.summary) ?? stringValue(objectRecord(record?.draft)?.summary),
        payload: event,
      });
    }
  }

  private async appendProviderTrace(
    state: SessionDriverLoopRunState,
    stage: string,
    payload: unknown
  ): Promise<void> {
    await this.ports.appendTranscript?.(state.sessionId, {
      type: 'metadata',
      uuid: this.id(`provider-trace-${stage}`),
      sessionId: state.sessionId,
      kind: 'provider_trace',
      payload: {
        stage,
        runId: state.runId,
        payload: archiveProviderTracePayload(stage, payload),
      },
      createdAt: this.ts(),
    });
  }

  private async kernel(request: KernelCommandEnvelope): Promise<KernelReply> {
    const reply = await this.ports.kernelCommand(request);
    if (!reply.ok) {
      throw new SessionDriverLoopError(
        reply.error?.code ?? 'kernel_command_failed',
        reply.error?.message ?? 'Kernel command failed.'
      );
    }
    return reply;
  }

  private async append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult> {
    return this.ports.appendEvents(sessionId, events);
  }

  private async appendConsumedUserGuidanceEvents(
    sessionId: string,
    result: AgentSessionResult,
    contextAssembly: ContextAssemblyRecord | undefined,
    runId: string,
    appliedAtProviderStage = 'provider_call'
  ): Promise<AgentSessionResult> {
    const consumedIds = contextAssembly?.consumedUserGuidanceIds ?? [];
    if (consumedIds.length === 0) return result;

    const alreadyConsumed = new Set<string>();
    const queuedGuidance = new Map<string, AgentEvent>();
    for (const event of result.events) {
      if (event.kind !== 'user_guidance') continue;
      const payload = objectRecord(event.payload);
      if (!payload) continue;
      const guidanceId = stringValue(payload.guidanceId) ?? event.id;
      if (stringValue(payload.status) === 'consumed') {
        alreadyConsumed.add(guidanceId);
      } else {
        queuedGuidance.set(guidanceId, event);
      }
    }

    const events: AgentEvent[] = [];
    for (const guidanceId of consumedIds) {
      if (alreadyConsumed.has(guidanceId)) continue;
      const source = queuedGuidance.get(guidanceId);
      if (!source) continue;
      const payload = objectRecord(source.payload) ?? {};
      events.push({
        id: this.id('user-guidance-consumed'),
        sessionId,
        ts: this.ts(),
        kind: 'user_guidance',
        payload: {
          title: 'User guidance',
          summary: '用户引导已进入下一次 provider prompt。',
          status: 'consumed',
          guidanceId,
          targetRunId: stringValue(payload.targetRunId) ?? stringValue(payload.runId) ?? runId,
          targetInteractionKind: stringValue(payload.targetInteractionKind) ?? 'runningRunGuidance',
          effectiveCheckpoint: 'nextProviderCall',
          checkpointKind: 'userGuidance',
          appliedAtProviderStage,
          source: 'session',
          channel: 'progress',
          visibility: 'conversation',
          presentation: 'body',
        },
      });
    }

    return events.length > 0 ? this.append(sessionId, events) : result;
  }

  private async appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult> {
    const events = (reply.events ?? []).map((event) => projectKernelEvent(sessionId, event, this.ts(), this.id('kernel')));
    if (events.length === 0) {
      return this.ports.appendEvents(sessionId, []);
    }
    return this.append(sessionId, events);
  }

  private event(sessionId: string, kind: AgentEvent['kind'], payload: unknown): AgentEvent {
    return {
      id: this.id(kind),
      sessionId,
      ts: this.ts(),
      kind,
      payload,
    };
  }

  private id(prefix: string): string {
    return this.ports.createId?.(prefix) ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private ts(): string {
    return this.ports.now?.() ?? new Date().toISOString();
  }
}

export class SessionDriverLoopError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionDriverLoopError';
  }
}

class ProviderPartFrameParser {
  private buffer = '';

  push(content: string): AgentStreamPartFrame[] {
    this.buffer = `${this.buffer}${content}`;
    if (this.buffer.length > 512 * 1024) {
      this.buffer = this.buffer.slice(-256 * 1024);
    }
    return [
      ...this.consumeNdjsonFrames(),
      ...this.consumeTaggedFrames(),
    ];
  }

  private consumeTaggedFrames(): AgentStreamPartFrame[] {
    const frames: AgentStreamPartFrame[] = [];
    const startTag = '<deepcode-part>';
    const endTag = '</deepcode-part>';
    while (true) {
      const start = this.buffer.indexOf(startTag);
      if (start < 0) {
        if (this.buffer.length > startTag.length) {
          this.buffer = this.buffer.slice(-(startTag.length - 1));
        }
        break;
      }
      const payloadStart = start + startTag.length;
      const end = this.buffer.indexOf(endTag, payloadStart);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.slice(start);
        break;
      }
      const raw = this.buffer.slice(payloadStart, end);
      this.buffer = this.buffer.slice(end + endTag.length);
      const frame = parseProviderPartFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private consumeNdjsonFrames(): AgentStreamPartFrame[] {
    const frames: AgentStreamPartFrame[] = [];
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      if (!line.includes('"deepcode.agent.stream.part.v1"')) break;
      this.buffer = this.buffer.slice(newline + 1);
      const frame = parseProviderPartFrame(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

class ProviderToolCallBuffer {
  private readonly items = new Map<number, ProviderToolCallBufferItem>();

  addChunk(chunk: LlmChatResult['chunks'][number]): void {
    if (chunk.toolCall) {
      const index = typeof chunk.index === 'number' ? chunk.index : this.items.size;
      this.items.set(index, {
        callId: chunk.toolCall.id,
        name: normalizeProviderToolName(chunk.toolCall.name),
        argumentsText: typeof chunk.toolCall.arguments === 'string'
          ? chunk.toolCall.arguments
          : JSON.stringify(chunk.toolCall.arguments ?? {}),
      });
      return;
    }
    const delta = chunk.toolCallDelta;
    if (!delta && !chunk.callId) return;
    const index = typeof delta?.index === 'number'
      ? delta.index
      : typeof chunk.index === 'number'
        ? chunk.index
        : 0;
    const item = this.items.get(index) ?? { argumentsText: '' };
    item.callId = delta?.id ?? chunk.callId ?? item.callId;
    item.name = delta?.name ? normalizeProviderToolName(delta.name) : item.name;
    item.argumentsText += delta?.argumentsDelta ?? '';
    this.items.set(index, item);
  }

  toToolCalls(): NativeToolCallProposal[] {
    return [...this.items.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, item]) => ({
        callId: item.callId ?? `tool-call-${index}`,
        index,
        name: normalizeProviderToolName(item.name ?? 'unknown'),
        arguments: parseNativeToolArguments(item.argumentsText, item.name ?? 'unknown'),
        rawArguments: item.argumentsText,
      }));
  }
}

function collectNativeToolCalls(
  result: LlmChatResult,
  buffer: ProviderToolCallBuffer
): NativeToolCallProposal[] {
  const output = new Map<string, NativeToolCallProposal>();
  const add = (toolCall: ToolCall, index: number) => {
    const callId = toolCall.id || `tool-call-${index}`;
    output.set(callId, {
      callId,
      index,
      name: normalizeProviderToolName(toolCall.name),
      arguments: normalizeNativeToolArguments(toolCall.arguments, toolCall.name),
      rawArguments: typeof toolCall.arguments === 'string' ? toolCall.arguments : undefined,
    });
  };
  result.assistantMessage?.toolCalls?.forEach(add);
  result.chunks.forEach((chunk, index) => {
    if (chunk.toolCall) add(chunk.toolCall, typeof chunk.index === 'number' ? chunk.index : index);
  });
  for (const toolCall of buffer.toToolCalls()) {
    output.set(toolCall.callId, toolCall);
  }
  return [...output.values()].sort((left, right) => left.index - right.index);
}

function nativeToolCallToProtocol(toolCall: NativeToolCallProposal): ToolCall {
  return {
    id: toolCall.callId,
    name: toolCall.name,
    arguments: toolCall.arguments,
  };
}

function nativeProviderToolsForState(state: SessionDriverLoopRunState): ToolDefinition[] {
  const allowed = state.stateContract?.allowedProposals ?? state.driverRequest?.stateContract?.allowedProposals ?? [];
  const allowResources = allowed.length === 0 || allowed.includes('resourceRequest') || allowed.includes('answer');
  const names = new Set<string>();
  if (allowResources) {
    names.add('fs.read');
    names.add('fs.list');
  }
  if (names.size === 0) return [];
  return listDefaultAgentTools('askBeforeWrite').filter((tool) => names.has(tool.name));
}

function canResolveNativeToolReadOnly(toolCall: NativeToolCallProposal): boolean {
  return toolCall.name === 'fs.read' || toolCall.name === 'fs.list';
}

function nativeReadToolManifest(
  state: SessionDriverLoopRunState,
  toolCall: NativeToolCallProposal
): ResourceManifest {
  const requestedPath = stringValue(toolCall.arguments.path)
    ?? stringValue(toolCall.arguments.resourceRef)
    ?? '.';
  const itemId = `native-${sanitizeId(toolCall.callId)}`;
  const kind: ResourceManifestEntry['kind'] = toolCall.name === 'fs.list' ? 'directory' : 'file';
  const synthesized = synthesizeManifestEntryForPath(
    state.manifest,
    state.conversationRoots,
    itemId,
    requestedPath,
    stringValue(toolCall.arguments.rootId),
    `Provider-native ${toolCall.name} request normalized by Session.`
  );
  const baseEntry: ResourceManifestEntry = synthesized.kind === 'entry'
    ? { ...synthesized.entry, kind }
    : {
        id: itemId,
        kind,
        label: `${toolCall.name} ${requestedPath}`,
        resourceRef: requestedPath,
        readPolicy: 'autoRead',
        reason: `Provider-native ${toolCall.name} request normalized by Session.`,
      };
  const offsetBytes = normalizedNonNegativeInteger(toolCall.arguments.offsetBytes);
  const limitBytes = normalizedPositiveInteger(toolCall.arguments.limitBytes);
  const entry: ResourceManifestEntry = {
    ...baseEntry,
    id: itemId,
    ...(typeof offsetBytes === 'number' ? { offsetBytes } : {}),
    ...(typeof limitBytes === 'number' ? { limitBytes } : {}),
  };
  return {
    ...state.manifest,
    id: `${state.manifest.id}-${itemId}`,
    entries: [entry],
  };
}

function nativeToolResultFromPacket(
  toolCall: NativeToolCallProposal,
  packet: ResourcePacket
): Record<string, unknown> {
  return {
    callId: toolCall.callId,
    toolName: toolCall.name,
    ok: packet.items.every((item) => item.status !== 'error' && item.status !== 'denied'),
    packetId: packet.id,
    items: packet.items.map((item) => ({
      manifestEntryId: item.manifestEntryId,
      status: item.status,
      path: item.path,
      absolutePath: item.absolutePath,
      contentKind: item.contentKind,
      contentSummary: item.contentSummary,
      content: item.promptContent ? clip(item.promptContent, 9000) : undefined,
      truncated: item.truncated,
      originalBytes: item.originalBytes,
      returnedBytes: item.returnedBytes,
      denialReason: item.denialReason,
    })),
  };
}

function providerStageExposesAssistantDelta(stage: string): boolean {
  return stage === 'answer_stream' || stage === 'review_final';
}

function parseNativeToolArguments(raw: string, toolName: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return normalizeNativeToolArguments(parsed, toolName);
  } catch (error) {
    throw new SessionDriverLoopError(
      'native_tool_arguments_invalid',
      `Provider-native tool call ${toolName} returned invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeNativeToolArguments(value: unknown, toolName: string): Record<string, unknown> {
  if (typeof value === 'string') return parseNativeToolArguments(value, toolName);
  const record = objectRecord(value);
  if (!record) {
    throw new SessionDriverLoopError(
      'native_tool_arguments_invalid',
      `Provider-native tool call ${toolName} arguments must be a JSON object.`
    );
  }
  return record;
}

function normalizeProviderToolName(name: string): string {
  return name.replace(/__/g, '.');
}

function createManifest(input: SessionDriverLoopInput, id: string): ResourceManifestBuildResult {
  const entries: ResourceManifestEntry[] = [];
  const conversationRoots: ConversationResourceRoot[] = [];
  const seenEntryRefs = new Set<string>();
  const seenRootRefs = new Set<string>();
  const primaryRootRef = primaryConversationRootRef(input);

  const addAttachment = (
    attachment: AgentContextAttachment,
    index: number,
    source: ConversationResourceRoot['source'],
    reason: string,
    addToManifest = true
  ) => {
    if (attachment.kind !== 'file' && attachment.kind !== 'directory') return;
    const resourceRef = attachment.absolutePath ?? attachment.path;
    if (!resourceRef) return;
    const refKey = comparablePath(resourceRef);
    if (!addToManifest && seenRootRefs.has(refKey)) return;
    if (addToManifest && seenEntryRefs.has(refKey) && seenRootRefs.has(refKey)) return;
    const entry: ResourceManifestEntry = {
      id: manifestEntryId(attachment, index, source),
      kind: attachment.kind,
      label: `${attachment.kind === 'directory' ? 'Directory' : 'File'} ${attachment.path || resourceRef}`,
      resourceRef,
      readPolicy: 'autoRead',
      reason,
    };
    if (addToManifest && !seenEntryRefs.has(refKey)) {
      seenEntryRefs.add(refKey);
      entries.push(entry);
    }
    if (attachment.kind === 'directory' && !seenRootRefs.has(refKey)) {
      seenRootRefs.add(refKey);
      conversationRoots.push({
        rootId: entry.id,
        kind: 'directory',
        label: entry.label,
        displayPath: attachment.path || resourceRef,
        absolutePath: attachment.absolutePath ?? (isAbsolutePath(resourceRef) ? resourceRef : undefined),
        source,
        primary: comparablePath(resourceRef) === primaryRootRef,
      });
    }
  };

  (input.attachments ?? []).forEach((attachment, index) => {
    addAttachment(
      attachment,
      index,
      attachment.scope === 'session' ? 'sessionAttachment' : 'currentAttachment',
      'Explicit user attachment for the current user turn.'
    );
  });

  recentAttachmentFacts(input.existingEvents ?? []).forEach((attachment, index) => {
    addAttachment(
      attachment,
      index,
      'recentAttachment',
      'Recent explicit user attachment selected from session projection.',
      false
    );
  });

  if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
    const workingDirectory = input.projectWorkingDirectory;
    const resourceRef = workingDirectory.absolutePath ?? workingDirectory.displayPath;
    const refKey = comparablePath(resourceRef);
    if (!seenRootRefs.has(refKey)) {
      seenRootRefs.add(refKey);
      conversationRoots.push({
        ...workingDirectory,
        rootId: workingDirectory.rootId || `project-root-${sanitizeId(workingDirectory.displayPath)}`,
        kind: 'directory',
        absolutePath: workingDirectory.absolutePath ?? (isAbsolutePath(resourceRef) ? resourceRef : undefined),
        primary: comparablePath(resourceRef) === primaryRootRef,
      });
    }
  }

  if (input.workspaceBinding?.openPath) {
    const resourceRef = input.workspaceBinding.openPath;
    const refKey = comparablePath(resourceRef);
    if (!seenRootRefs.has(refKey)) {
      seenRootRefs.add(refKey);
      conversationRoots.push({
        rootId: `editor-workspace-${sanitizeId(resourceRef)}`,
        kind: 'directory',
        label: `Editor workspace ${resourceRef}`,
        displayPath: resourceRef,
        absolutePath: resourceRef,
        source: 'workspaceBinding',
        primary: comparablePath(resourceRef) === primaryRootRef,
      });
    }
  }

  const workspaceScopeKey = [
    input.workspaceBinding?.workspaceId,
    input.workspaceBinding?.workspaceHash,
    input.workspaceBinding?.openPath,
    input.workspaceBinding?.activeFolderId,
  ].filter(Boolean).join(':') || `session:${input.sessionId}:${conversationRoots[0]?.rootId ?? 'no-root'}`;
  return {
    manifest: {
      id,
      workspaceScopeKey,
      workspaceId: input.workspaceBinding?.workspaceId,
      entries,
      budget: {
        maxEntries: Math.max(MAX_DERIVED_MANIFEST_ENTRIES, entries.length),
        maxBytes: RESOURCE_MANIFEST_MAX_BYTES,
      },
      defaultDenyPatterns: [],
    },
    conversationRoots,
  };
}

function kernelRunAttachments(input: SessionDriverLoopInput): AgentContextAttachment[] {
  if (input.acceptedImplementationPlan?.executionRoot) {
    return uniqueAttachments([input.acceptedImplementationPlan.executionRoot.attachment]);
  }
  const attachments = uniqueAttachments(input.attachments ?? []);
  if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
    const workingDirectory = input.projectWorkingDirectory;
    attachments.push({
      kind: 'directory',
      path: workingDirectory.displayPath,
      absolutePath: workingDirectory.absolutePath,
      source: 'userSelected',
      scope: 'session',
      rootId: workingDirectory.rootId,
    } as AgentContextAttachment);
  }
  const directoryAttachments = attachments.filter((attachment) => attachment.kind === 'directory');
  if (directoryAttachments.length === 0) {
    const recentDirectories = uniqueAttachments(recentAttachmentFacts(input.existingEvents ?? []))
      .filter((attachment) => attachment.kind === 'directory');
    if (recentDirectories.length === 1) {
      attachments.push({
        ...recentDirectories[0],
        scope: recentDirectories[0].scope ?? 'session',
      });
    }
  }
  return uniqueAttachments(attachments);
}

function primaryConversationRootRef(input: SessionDriverLoopInput): string | undefined {
  if (input.acceptedImplementationPlan?.executionRoot?.ref) {
    return comparablePath(input.acceptedImplementationPlan.executionRoot.ref);
  }
  const currentDirectories = (input.attachments ?? [])
    .filter((attachment) => attachment.kind === 'directory')
    .map((attachment) => attachment.absolutePath ?? attachment.path)
    .filter((value): value is string => Boolean(value && value.trim()));
  if (currentDirectories.length === 1) return comparablePath(currentDirectories[0]);
  if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
    return comparablePath(input.projectWorkingDirectory.absolutePath ?? input.projectWorkingDirectory.displayPath);
  }
  const recentDirectories = recentAttachmentFacts(input.existingEvents ?? [])
    .filter((attachment) => attachment.kind === 'directory')
    .map((attachment) => attachment.absolutePath ?? attachment.path)
    .filter((value): value is string => Boolean(value && value.trim()));
  const unique = [...new Set(recentDirectories.map(comparablePath))];
  return unique.length === 1 ? unique[0] : undefined;
}

function uniqueAttachments(attachments: AgentContextAttachment[]): AgentContextAttachment[] {
  const output: AgentContextAttachment[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    const ref = attachment.absolutePath ?? attachment.path;
    if (!ref) continue;
    const key = `${attachment.kind}:${comparablePath(ref)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(attachment);
  }
  return output;
}

function manifestEntryId(
  attachment: AgentContextAttachment,
  index: number,
  source: ConversationResourceRoot['source']
): string {
  const base = (attachment.path || attachment.absolutePath || `attachment-${index}`)
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  const prefix = source === 'recentAttachment' ? 'recent-attachment' : 'attachment';
  return `${prefix}-${index}-${base || 'resource'}`;
}

function recentAttachmentFacts(events: AgentEvent[]): AgentContextAttachment[] {
  const output: AgentContextAttachment[] = [];
  for (const event of [...events].reverse()) {
    if (output.length >= 16) break;
    if (event.kind !== 'user_msg') continue;
    const payload = objectRecord(event.payload);
    const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
    for (const item of attachments) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const attachment = item as AgentContextAttachment;
      if (attachment.kind !== 'file' && attachment.kind !== 'directory') continue;
      if (!attachment.path && !attachment.absolutePath) continue;
      output.push(attachment);
      if (output.length >= 16) break;
    }
  }
  return output;
}

function buildImplementationBatchContext(events: AgentEvent[]): ImplementationBatchContext {
  const recentPlanSummaries: string[] = [];
  const continuationSummaries: string[] = [];
  let planCount = 0;
  for (const event of events.slice(-48)) {
    if (event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload);
    if (!payload) continue;
    planCount += 1;
    const summary = typeof payload.summary === 'string'
      ? payload.summary
      : typeof payload.content === 'string'
        ? payload.content
        : '';
    if (summary.trim()) recentPlanSummaries.push(clip(summary.trim(), 240));
    const actionBundle = objectRecord(payload.actionBundle);
    const continuations = concreteContinuationExpectations(actionBundle?.continuationExpectations);
    for (const continuation of continuations) {
      const record = objectRecord(continuation);
      const title = typeof record?.title === 'string' ? record.title.trim() : '';
      const scope = Array.isArray(record?.resourceScope)
        ? record.resourceScope.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).join(', ')
        : '';
      const text = [title, scope ? `scope=${scope}` : ''].filter(Boolean).join(' ');
      if (text) continuationSummaries.push(clip(text, 240));
    }
  }
  return {
    batchIndex: planCount + 1,
    recentPlanSummaries: recentPlanSummaries.slice(-3),
    continuationSummaries: continuationSummaries.slice(-6),
  };
}

function concreteContinuationExpectations(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => continuationHasConcreteScope(item));
}

function continuationHasConcreteScope(item: unknown): boolean {
  const record = objectRecord(item);
  if (!record) return false;
  const scopes = [
    ...stringArrayValue(record.targetPath),
    ...stringArrayValue(record.resourceScope),
  ];
  return scopes.some((scope) => Boolean(concreteFileOperationTarget(scope)));
}

function implementationBatchHints(
  context: ImplementationBatchContext,
  acceptedPlan?: AcceptedImplementationPlanContext
): string[] {
  const hints = [
    `Implementation batch context: nextBatchIndex=${context.batchIndex}. Generate only the next reviewable batch when proposing side-effect actions.`,
    'Context boundary: plan cards and continuation expectations are intent only; they are not evidence that files exist or were modified.',
    'Authoritative generated-file facts come only from ResourcePacket contents, ToolCompleted(ok=true), or WorkUnitCompleted facts.',
  ];
  if (acceptedPlan) {
    const currentTask = acceptedPlan.tasks[Math.max(0, acceptedPlan.batchIndex - 1)];
    hints.push(
      `Accepted implementationPlan active: planId=${acceptedPlan.planId}; batchIndex=${acceptedPlan.batchIndex}; completedTasks=${acceptedPlan.completedTaskIds.length}/${acceptedPlan.tasks.length}. Automatic execution is allowed for related batches whose targets and capabilities stay inside the accepted plan.`,
      currentTask
        ? `Current accepted implementationPlan task: taskId=${currentTask.taskId}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; capability=${currentTask.capability ?? 'none'}.`
        : 'Current accepted implementationPlan task could not be inferred from batchIndex; keep the next batch minimal and in scope.',
      `Accepted implementationPlan capabilities: ${acceptedPlan.capabilities.length ? acceptedPlan.capabilities.join(', ') : 'none'}.`,
      `Accepted implementationPlan target scopes: ${acceptedPlan.targetScopes.length ? acceptedPlan.targetScopes.join(', ') : 'none'}.`,
      acceptedPlan.executionRoot
        ? `Accepted implementationPlan primary root: ${acceptedPlan.executionRoot.ref}. All actionBundle targetPath/codeBlock paths must be relative to this root and must not include the root directory name.`
        : 'Accepted implementationPlan primary root is not explicit; use relative target paths from the authorized workspace root only.',
      'Do not ask the user to reconfirm routine implementation batches already covered by the accepted implementationPlan. If new targets, capabilities, or material technical choices are needed, return decisionRequest or implementationPlan revision instead of an out-of-scope actionBundle.'
    );
  }
  if (context.recentPlanSummaries.length) {
    hints.push(`Recent implementation batch plans (intent only, not execution facts): ${context.recentPlanSummaries.join(' | ')}`);
  }
  if (context.continuationSummaries.length) {
    hints.push(`Pending continuation expectations (intent only, not files already created): ${context.continuationSummaries.join(' | ')}`);
  }
  return hints;
}

function manifestForResourceRequest(
  manifest: ResourceManifest,
  request: ResourceRequestDraft,
  roots: ConversationResourceRoot[]
): ResourceRequestResolution {
  const entries: ResourceManifestEntry[] = [];
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const ambiguous: string[] = [];

  const pushEntry = (entry: ResourceManifestEntry, item?: ResourceRequestDraft['items'][number]) => {
    const ranged = item ? resourceEntryWithRange(entry, item) : entry;
    if (seen.has(ranged.id)) return;
    seen.add(ranged.id);
    entries.push(ranged);
  };

  for (const item of request.items ?? []) {
    const searchQuery = item.query?.trim();
    if (item.kind === 'search' || searchQuery) {
      const synthesized = synthesizeManifestEntryForSearch(roots, item);
      if (synthesized.kind === 'entry') {
        manifest.entries.push(synthesized.entry);
        pushEntry(synthesized.entry, item);
        continue;
      }
      if (synthesized.kind === 'ambiguous') {
        ambiguous.push(`${item.id} (${synthesized.reason})`);
        continue;
      }
      unresolved.push(`${item.id} (${synthesized.reason})`);
      continue;
    }

    const exactId = item.manifestEntryId?.trim();
    if (exactId) {
      const exact = manifest.entries.find((entry) => entry.id === exactId);
      if (exact) {
        pushEntry(exact, item);
        continue;
      }
    }

    const pathCandidate = item.path?.trim() || item.manifestEntryId?.trim();
    if (!pathCandidate) {
      unresolved.push(item.id);
      continue;
    }

    const existing = findExistingEntryByPath(manifest, pathCandidate, roots);
    if (existing) {
      pushEntry(existing, item);
      continue;
    }

    const synthesized = synthesizeManifestEntryForPath(manifest, roots, item.id, pathCandidate, item.rootId, item.reason);
    if (synthesized.kind === 'entry') {
      const entry = resourceEntryWithRange(synthesized.entry, item);
      manifest.entries.push(synthesized.entry);
      pushEntry(entry);
      continue;
    }
    if (synthesized.kind === 'ambiguous') {
      ambiguous.push(`${pathCandidate} (${synthesized.reason})`);
      continue;
    }
    unresolved.push(`${pathCandidate} (${synthesized.reason})`);
  }

  return {
    manifest: {
      ...manifest,
      id: `${manifest.id}-request-${sanitizeId(request.id ?? 'resource-request')}`,
      entries,
    },
    unresolved,
    ambiguous,
    availableRoots: roots,
  };
}

function resourceEntryWithRange(entry: ResourceManifestEntry, item: ResourceRequestDraft['items'][number]): ResourceManifestEntry {
  const offsetBytes = normalizedNonNegativeInteger(item.offsetBytes);
  const limitBytes = normalizedPositiveInteger(item.limitBytes);
  if (typeof offsetBytes !== 'number' && typeof limitBytes !== 'number') return entry;
  const rangeId = [
    entry.id,
    'range',
    typeof offsetBytes === 'number' ? offsetBytes : 0,
    typeof limitBytes === 'number' ? limitBytes : 'default',
  ].join(':');
  return {
    ...entry,
    id: rangeId,
    ...(typeof offsetBytes === 'number' ? { offsetBytes } : {}),
    ...(typeof limitBytes === 'number' ? { limitBytes } : {}),
    reason: `${entry.reason} Range request: offsetBytes=${offsetBytes ?? 0}, limitBytes=${limitBytes ?? 'default'}.`,
  };
}

function normalizedNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

function normalizedPositiveInteger(value: unknown): number | undefined {
  const integer = normalizedNonNegativeInteger(value);
  return typeof integer === 'number' && integer > 0 ? integer : undefined;
}

type SynthesizedManifestEntryResult =
  | { kind: 'entry'; entry: ResourceManifestEntry }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unresolved'; reason: string };

function findExistingEntryByPath(
  manifest: ResourceManifest,
  requestedPath: string,
  roots: ConversationResourceRoot[]
): ResourceManifestEntry | undefined {
  const exact = manifest.entries.find((entry) => comparablePath(entry.resourceRef) === comparablePath(requestedPath));
  if (exact) return exact;
  const resolved = resolveRequestPath(requestedPath, undefined, roots);
  if (resolved.kind !== 'resolved') return undefined;
  const ref = joinFsPath(resolved.root.absolutePath ?? resolved.root.displayPath, resolved.relativePath);
  return manifest.entries.find((entry) => comparablePath(entry.resourceRef) === comparablePath(ref));
}

function synthesizeManifestEntryForPath(
  manifest: ResourceManifest,
  roots: ConversationResourceRoot[],
  itemId: string,
  requestedPath: string,
  rootId: string | undefined,
  reason: string
): SynthesizedManifestEntryResult {
  const resolved = resolveRequestPath(requestedPath, rootId, roots);
  if (resolved.kind !== 'resolved') return resolved;
  const resourceRef = joinFsPath(resolved.root.absolutePath ?? resolved.root.displayPath, resolved.relativePath);
  const existing = manifest.entries.find((entry) => comparablePath(entry.resourceRef) === comparablePath(resourceRef));
  if (existing) return { kind: 'entry', entry: existing };
  const entry: ResourceManifestEntry = {
    id: `path-${sanitizeId(resolved.root.rootId)}-${sanitizeId(resolved.relativePath || itemId)}`,
    kind: 'resource',
    label: `Resource ${resolved.root.displayPath}/${resolved.relativePath}`,
    resourceRef,
    readPolicy: 'autoRead',
    reason: reason || `Requested path under conversation root ${resolved.root.rootId}.`,
  };
  return { kind: 'entry', entry };
}

function synthesizeManifestEntryForSearch(
  roots: ConversationResourceRoot[],
  item: ResourceRequestDraft['items'][number]
): SynthesizedManifestEntryResult {
  const query = item.query?.trim();
  if (!query) return { kind: 'unresolved', reason: 'search request requires query' };
  const root = searchRootForRequest(item.rootId, roots);
  if (root.kind !== 'resolved') return root;
  const include = stringArrayValue(item.include);
  const contextLines = normalizedNonNegativeInteger(item.contextLines);
  const maxResults = normalizedPositiveInteger(item.maxResults);
  const resourceRef = root.root.absolutePath ?? root.root.displayPath;
  return {
    kind: 'entry',
    entry: {
      id: `search-${sanitizeId(root.root.rootId)}-${sanitizeId(item.id)}`,
      kind: 'search',
      label: `Search ${query}`,
      resourceRef,
      readPolicy: 'autoRead',
      reason: item.reason || `Search under conversation root ${root.root.rootId}.`,
      query,
      ...(include.length ? { include } : {}),
      ...(typeof contextLines === 'number' ? { contextLines } : {}),
      ...(typeof maxResults === 'number' ? { maxResults } : {}),
    },
  };
}

function searchRootForRequest(
  rootId: string | undefined,
  roots: ConversationResourceRoot[]
): { kind: 'resolved'; root: ConversationResourceRoot } | { kind: 'ambiguous'; reason: string } | { kind: 'unresolved'; reason: string } {
  if (!roots.length) return { kind: 'unresolved', reason: 'no available conversation root' };
  if (rootId) {
    const root = roots.find((item) => item.rootId === rootId);
    if (!root) return { kind: 'unresolved', reason: `unknown rootId ${rootId}` };
    return { kind: 'resolved', root };
  }
  const primary = roots.find((item) => item.primary);
  if (primary) return { kind: 'resolved', root: primary };
  if (roots.length === 1) return { kind: 'resolved', root: roots[0]! };
  return { kind: 'ambiguous', reason: 'search request must include rootId when multiple roots are available' };
}

type ResolvedRequestPath =
  | { kind: 'resolved'; root: ConversationResourceRoot; relativePath: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unresolved'; reason: string };

function resolveRequestPath(
  requestedPath: string,
  rootId: string | undefined,
  roots: ConversationResourceRoot[]
): ResolvedRequestPath {
  const trimmed = requestedPath.trim();
  if (!trimmed) return { kind: 'unresolved', reason: 'empty path' };
  if (!roots.length) return { kind: 'unresolved', reason: 'no available conversation root' };

  if (rootId) {
    const root = roots.find((item) => item.rootId === rootId);
    if (!root) return { kind: 'unresolved', reason: `unknown rootId ${rootId}` };
    const relativePath = relativePathForRoot(trimmed, root, true);
    if (!relativePath) return { kind: 'unresolved', reason: `path is outside root ${rootId}` };
    return { kind: 'resolved', root, relativePath };
  }

  if (isAbsolutePath(trimmed)) {
    const matches = roots
      .map((root) => ({ root, relativePath: relativePathForRoot(trimmed, root, true) }))
      .filter((item): item is { root: ConversationResourceRoot; relativePath: string } => Boolean(item.relativePath))
      .sort((left, right) => comparablePath(right.root.absolutePath ?? right.root.displayPath).length - comparablePath(left.root.absolutePath ?? left.root.displayPath).length);
    if (matches.length === 0) return { kind: 'unresolved', reason: 'absolute path is outside explicit attachments and project roots' };
    return { kind: 'resolved', root: matches[0].root, relativePath: matches[0].relativePath };
  }

  const explicitMatches = roots
    .map((root) => ({ root, relativePath: relativePathForRoot(trimmed, root, false) }))
    .filter((item): item is { root: ConversationResourceRoot; relativePath: string } => Boolean(item.relativePath));
  if (explicitMatches.length > 0) {
    explicitMatches.sort((left, right) => right.root.displayPath.length - left.root.displayPath.length);
    return { kind: 'resolved', root: explicitMatches[0].root, relativePath: explicitMatches[0].relativePath };
  }

  const relativePath = normalizeRelativePath(trimmed);
  if (!relativePath) return { kind: 'unresolved', reason: 'path traversal or empty relative path is not allowed' };
  const sorted = [...roots].sort((left, right) => rootPriority(left) - rootPriority(right));
  const bestPriority = rootPriority(sorted[0]);
  const candidates = sorted.filter((root) => rootPriority(root) === bestPriority);
  if (candidates.length === 1) {
    return { kind: 'resolved', root: candidates[0], relativePath };
  }
  return {
    kind: 'ambiguous',
    reason: `multiple roots at the same priority: ${candidates.map((root) => root.rootId).join(', ')}`,
  };
}

function relativePathForRoot(
  requestedPath: string,
  root: ConversationResourceRoot,
  allowPlainRelative: boolean
): string | undefined {
  const normalized = normalizeSlashes(requestedPath);
  const rootKeys = [
    root.rootId,
    root.displayPath,
    root.absolutePath,
    basename(root.displayPath),
    root.absolutePath ? basename(root.absolutePath) : undefined,
  ].filter((item): item is string => Boolean(item && item.trim()));

  for (const key of rootKeys) {
    const normalizedKey = normalizeSlashes(key).replace(/\/+$/g, '');
    if (!normalizedKey) continue;
    if (normalized === normalizedKey) return '.';
    if (normalized.startsWith(`${normalizedKey}/`)) {
      return normalizeRelativePath(normalized.slice(normalizedKey.length + 1));
    }
  }

  if (isAbsolutePath(normalized)) {
    const rootPath = root.absolutePath ? normalizeSlashes(root.absolutePath).replace(/\/+$/g, '') : undefined;
    if (!rootPath) return undefined;
    if (normalized === rootPath) return '.';
    if (!normalized.startsWith(`${rootPath}/`)) return undefined;
    return normalizeRelativePath(normalized.slice(rootPath.length + 1));
  }

  return allowPlainRelative ? normalizeRelativePath(normalized) : undefined;
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeSlashes(value).replace(/^\.\/+/, '').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return undefined;
    parts.push(part);
  }
  return parts.join('/') || '.';
}

function normalizeSlashes(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function comparablePath(value: string): string {
  return normalizeSlashes(value).replace(/\/+$/g, '');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}

function basename(value: string): string {
  const normalized = normalizeSlashes(value).replace(/\/+$/g, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function rootPriority(root: ConversationResourceRoot): number {
  if (root.primary) return -1;
  if (root.source === 'currentAttachment') return 0;
  if (root.source === 'sessionAttachment') return 1;
  if (root.source === 'projectWorkingDirectory') return 2;
  if (root.source === 'recentAttachment') return 3;
  return 4;
}

function resourceResolutionDiagnostic(resolution: ResourceRequestResolution): string {
  const details = [
    resolution.unresolved.length ? `无法定位：${resolution.unresolved.join('; ')}` : '',
    resolution.ambiguous.length ? `存在多个候选根目录：${resolution.ambiguous.join('; ')}` : '',
  ].filter(Boolean).join('\n');
  const roots = resolution.availableRoots.length
    ? resolution.availableRoots.map((root) => `${root.rootId} -> ${root.displayPath}`).join('\n')
    : '无可用附件或项目目录。';
  return [
    '模型请求的资源无法在当前附件或项目目录中定位，Session 已拒绝该请求。',
    details,
    '可用项目/附件根目录：',
    roots,
    '请重新指定明确附件、rootId 或相对路径。',
  ].filter(Boolean).join('\n');
}

function addDiscoveredManifestEntries(manifest: ResourceManifest, packet: ResourcePacket): void {
  const existing = new Set(manifest.entries.map((entry) => entry.id));
  for (const item of packet.items) {
    if (manifest.entries.length >= MAX_DERIVED_MANIFEST_ENTRIES) return;
    if (item.contentKind !== 'directoryTree') continue;
    const raw = item as ResourcePacketItem & { nodes?: unknown; absolutePath?: string; path?: string };
    const root = typeof raw.absolutePath === 'string' ? raw.absolutePath : undefined;
    if (!root || !Array.isArray(raw.nodes)) continue;
    for (const node of flattenNodes(raw.nodes)) {
      if (manifest.entries.length >= MAX_DERIVED_MANIFEST_ENTRIES) return;
      const nodePath = typeof node.path === 'string' ? node.path : '';
      const nodeType = node.type === 'directory' ? 'directory' : node.type === 'file' ? 'file' : undefined;
      if (!nodePath || !nodeType) continue;
      const id = `${item.manifestEntryId}:${sanitizeId(nodePath)}`;
      if (existing.has(id)) continue;
      existing.add(id);
      manifest.entries.push({
        id,
        kind: nodeType,
        label: `${nodeType === 'directory' ? 'Directory' : 'File'} ${nodePath}`,
        resourceRef: joinFsPath(root, nodePath),
        readPolicy: 'autoRead',
        reason: `Discovered inside explicit directory attachment ${item.manifestEntryId}.`,
      });
    }
  }
}

function flattenNodes(nodes: unknown[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  const stack = nodes.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  while (stack.length) {
    const node = stack.shift()!;
    output.push(node);
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child && typeof child === 'object' && !Array.isArray(child)) stack.push(child as Record<string, unknown>);
      }
    }
  }
  return output;
}

function findStateContract(events: unknown[]): KernelStateContractRef | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const contract = objectRecord(record?.stateContract);
    if (contract) return contract as unknown as KernelStateContractRef;
  }
  return undefined;
}

function findDriverRequest(events: unknown[]): DriverRequestRef | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const driverRequest = objectRecord(record?.driverRequest);
    if (driverRequest) return driverRequest as unknown as DriverRequestRef;
  }
  return undefined;
}

function firstString(events: unknown[], key: string): string | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function findResourcePacket(events: unknown[]): ResourcePacket | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    const payload = objectRecord(record?.payload);
    const packet = objectRecord(record?.packet) ?? objectRecord(payload?.output);
    if (!packet) continue;
    const items = Array.isArray(packet.items) ? packet.items : [];
    return {
      id: typeof packet.id === 'string' ? packet.id : 'resource-packet',
      workspaceScopeKey: typeof packet.workspaceScopeKey === 'string' ? packet.workspaceScopeKey : 'workspace',
      requestId: typeof packet.requestId === 'string' ? packet.requestId : 'resource-request',
      items: items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .map(resourcePacketItemFromKernel),
    };
  }
  return undefined;
}

function recentResourcePackets(events: unknown[]): ResourcePacket[] {
  const packets: ResourcePacket[] = [];
  for (const event of [...events].reverse()) {
    const record = objectRecord(event);
    const payload = objectRecord(record?.payload);
    if (record?.kind !== 'tool_result' && !objectRecord(record?.packet)) continue;
    const packet = objectRecord(record?.packet) ?? objectRecord(payload?.output);
    if (!packet) continue;
    const items = Array.isArray(packet.items) ? packet.items : [];
    packets.push({
      id: typeof packet.id === 'string' ? packet.id : `resource-packet-${packets.length + 1}`,
      workspaceScopeKey: typeof packet.workspaceScopeKey === 'string' ? packet.workspaceScopeKey : 'workspace',
      requestId: typeof packet.requestId === 'string' ? packet.requestId : 'resource-request',
      items: items
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        .map(resourcePacketItemFromKernel),
    });
    if (packets.length >= 8) break;
  }
  return packets.reverse();
}

function resourcePacketItemFromKernel(item: Record<string, unknown>): ResourcePacketItem {
  const status = item.status === 'resolved' || item.status === 'provided'
    ? item.status
    : item.status === 'denied'
      ? 'denied'
      : item.status === 'needsUserApproval'
        ? 'needsUserApproval'
        : 'error';
  const nodes = Array.isArray(item.nodes) ? item.nodes : undefined;
  const content = typeof item.content === 'string'
    ? item.content
    : nodes
      ? JSON.stringify(nodes, null, 2)
      : undefined;
  const promptContent = content ?? (typeof item.promptContent === 'string' ? item.promptContent : undefined);
  return {
    ...(item as unknown as Record<string, unknown>),
    requestItemId: typeof item.requestItemId === 'string' ? item.requestItemId : 'item',
    manifestEntryId: typeof item.manifestEntryId === 'string' ? item.manifestEntryId : 'entry',
    readPolicy: 'autoRead',
    status,
    contentKind: typeof item.contentKind === 'string' ? item.contentKind as ResourcePacketItem['contentKind'] : undefined,
    contentSummary: typeof item.contentSummary === 'string' ? item.contentSummary : typeof item.message === 'string' ? item.message : undefined,
    promptContent,
    truncated: Boolean(item.truncated),
    originalBytes: typeof item.originalBytes === 'number'
      ? item.originalBytes
      : typeof item.sizeBytes === 'number'
        ? item.sizeBytes
        : undefined,
    offsetBytes: typeof item.offsetBytes === 'number' ? item.offsetBytes : undefined,
    limitBytes: typeof item.limitBytes === 'number' ? item.limitBytes : undefined,
    returnedBytes: typeof item.returnedBytes === 'number' ? item.returnedBytes : undefined,
    rangeComplete: typeof item.rangeComplete === 'boolean' ? item.rangeComplete : undefined,
    denialReason: typeof item.reason === 'string' ? item.reason : typeof item.message === 'string' ? item.message : undefined,
    evidenceRefs: Array.isArray(item.evidenceRefs)
      ? item.evidenceRefs.filter((value): value is string => typeof value === 'string')
      : [],
    sourceKind: 'kernelResource',
  };
}

function projectKernelEvent(sessionId: string, event: unknown, ts: string, id: string): AgentEvent {
  const record = objectRecord(event) ?? {};
  const kind = typeof record.kind === 'string' ? record.kind : 'kernel.event';
 if (kind === 'proposal.reviewed') {
    const report = objectRecord(record.report) ?? {};
    const status = typeof report.status === 'string' ? report.status : 'awaitingUserApproval';
    const planId = typeof report.planId === 'string' ? report.planId : 'agent-plan';
    const summary = typeof report.kernelGeneratedPermissionSummary === 'string' && report.kernelGeneratedPermissionSummary.trim()
      ? report.kernelGeneratedPermissionSummary
      : 'Kernel PlanReview 已完成，请确认是否同意计划。';
    return {
      id,
      sessionId,
      ts,
      kind: 'plan_review',
      payload: {
        title: '计划确认',
        summary,
        status,
        runId: typeof record.runId === 'string' ? record.runId : undefined,
        planId,
        confirmable: false,
        auditOnly: true,
        requiredPermissions: Array.isArray(report.requiredPermissions) ? report.requiredPermissions : [],
        permissionGaps: Array.isArray(report.permissionGaps) ? report.permissionGaps : [],
        requiredFileOperations: requiredFileOperationsFromReport(report),
        facts: planReviewFacts(report),
        channel: 'trace',
        visibility: 'debug',
        presentation: 'collapsible',
        report,
        kernelEvent: record,
      },
    };
  }
  if (kind === 'permission.requested') {
    const request = objectRecord(record.request) ?? {};
    const permissionId = stringValue(request.id) ?? stringValue(record.permissionId) ?? stringValue(record.toolCallId) ?? id;
    const capability = stringValue(request.capability) ?? stringValue(record.capability) ?? 'workspace.write';
    const toolName = stringValue(record.toolName) ?? stringValue(request.toolName) ?? capability;
    return {
      id,
      sessionId,
      ts,
      kind: 'permission_request',
      payload: {
        id: permissionId,
        toolName,
        capability,
        riskLevel: stringValue(request.riskLevel) ?? stringValue(request.risk_level) ?? stringValue(record.riskLevel) ?? 'medium',
        summary: stringValue(request.summary) ?? stringValue(record.summary) ?? `Permission requested for ${toolName}.`,
        argumentsPreview: request.argsPreview ?? record.argsPreview ?? null,
        runId: stringValue(record.runId),
        workUnitId: stringValue(record.workUnitId),
        actionId: stringValue(record.actionId),
        planId: stringValue(record.planId),
        operationKind: stringValue(record.operationKind),
        channel: 'tool',
        visibility: 'conversation',
        kernelEvent: record,
      },
    };
  }
  if (kind === 'permission.resolved') {
    return {
      id,
      sessionId,
      ts,
      kind: 'permission_result',
      payload: {
        permissionId: stringValue(record.permissionId),
        decision: record.decision,
        runId: stringValue(record.runId),
        channel: 'tool',
        visibility: 'conversation',
        kernelEvent: record,
      },
    };
  }
  if (kind === 'proposal.rejected' || kind === 'work_unit.failed') {
    return {
      id,
      sessionId,
      ts,
      kind: 'error',
      payload: {
        message: kernelFailureMessage(kind, record),
        channel: 'error',
        visibility: 'conversation',
        kernelEvent: record,
      },
    };
  }
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: kind,
      status: kind.endsWith('produced') || kind.endsWith('accepted') ? 'completed' : 'running',
      summary: kernelEventSummary(kind, record),
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      kernelEvent: record,
    },
  };
}

function kernelFailureMessage(kind: string, record: Record<string, unknown>): string {
  const error = objectRecord(record.error);
  const reason = stringValue(record.reason)
    ?? stringValue(record.summary)
    ?? stringValue(error?.message)
    ?? stringValue(error?.reason)
    ?? stringValue(record.message);
  if (kind === 'work_unit.failed') {
    const workUnitId = stringValue(record.workUnitId)
      ?? stringValue(objectRecord(record.workUnit)?.id)
      ?? stringValue(record.actionId);
    const suffix = reason ? `：${reason}` : '。';
    return workUnitId
      ? `Kernel work unit ${workUnitId} 执行失败${suffix}`
      : `Kernel work unit 执行失败${suffix}`;
  }
  if (kind === 'proposal.rejected') {
    return reason ? `Kernel 拒绝 proposal：${reason}` : 'Kernel 拒绝 proposal。';
  }
  return reason ?? 'Kernel 返回失败事件。';
}

function kernelEventSummary(kind: string, record: Record<string, unknown>): string {
  if (kind === 'driver.request_produced') return 'Session DriverRequest produced by Kernel.';
  if (kind === 'state.entered') return 'Kernel state contract entered.';
  if (kind === 'resource.packet_produced') return 'Kernel ResourcePacket produced.';
  if (kind === 'proposal.accepted') return 'Kernel accepted proposal envelope.';
  return typeof record.summary === 'string' ? record.summary : kind;
}

function resourcePacketEvent(sessionId: string, packet: ResourcePacket, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'tool_result',
    payload: {
      toolName: 'kernel.resourceResolve',
      status: packet.items.some((item) => item.status === 'error' || item.status === 'denied') ? 'error' : 'ok',
      summary: `Kernel resolved ${packet.items.length} resource item(s).`,
      output: packet,
      channel: 'tool',
      visibility: 'conversation',
      presentation: 'collapsible',
    },
  };
}

function answerEvent(
  sessionId: string,
  proposal: ProposalEnvelope,
  ts: string,
  id: string,
  metadata: Record<string, unknown> = {}
): AgentEvent {
  const content = answerContent(proposal);
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'final',
      visibility: 'conversation',
      label: 'DeepCode',
      proposalId: proposal.proposalId,
      ...metadata,
    },
  };
}

function answerContent(proposal: ProposalEnvelope): string {
  const payload = objectRecord(proposal.payload) ?? {};
  const answer = objectRecord(payload.answer) ?? payload;
  return typeof answer.content === 'string' ? answer.content : '';
}

function guidanceRevisionTransitionEvent(
  sessionId: string,
  runId: string,
  guidanceIds: string[],
  userRequest: string,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content: guidanceRevisionTransitionMessage(visibleLanguageForRequest(userRequest)),
      channel: 'progress',
      source: 'session',
      visibility: 'conversation',
      presentation: 'body',
      label: 'DeepCode',
      runId,
      guidanceIds,
    },
  };
}

function guidanceRevisionDiagnosticEvent(sessionId: string, message: string, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'error',
    payload: {
      message,
      status: 'error',
      channel: 'error',
      visibility: 'conversation',
      source: 'session',
    },
  };
}

function answerNarrationEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent | null {
  const content = proposal.narration?.trim();
  if (!content) return null;
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'progress',
      source: 'llm',
      visibility: 'conversation',
      presentation: 'body',
      label: 'DeepCode',
      proposalId: proposal.proposalId,
    },
  };
}

function guidanceRevisionOverlay(
  originalRequest: string,
  draftAnswer: ProposalEnvelope,
  guidance: UserGuidanceEvent[]
): string {
  return [
    'Terminal user guidance revision:',
    'A draft answer was generated but has not been shown to the user because new user guidance arrived before the final response was committed.',
    'Return a JSON ProposalEnvelope with kind="answer" only. Do not return resourceRequest, decisionRequest, actionBundle, or diagnostic.',
    'Include a short top-level narration sentence that naturally acknowledges the guidance merge before the final answer.',
    `Original user request:\n${clip(originalRequest, 1800)}`,
    `Unshown draft answer:\n${clip(answerContent(draftAnswer), 3200)}`,
    'Latest user guidance to apply:',
    ...guidance.map((item) => `- id=${item.id} ${clip(item.content, 800)}`),
  ].join('\n\n');
}

function finalDiagnosticEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'final',
      visibility: 'conversation',
      label: 'DeepCode',
      diagnostic: true,
    },
  };
}

function thinkingEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'reasoning',
      visibility: 'conversation',
      presentation: 'collapsible',
      label: 'Thinking',
    },
  };
}

function reasoningEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'reasoning',
      visibility: 'conversation',
      presentation: 'collapsible',
      label: 'Thinking',
    },
  };
}

function readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined {
  const payload = objectRecord(proposal.payload);
  const actionBundle = objectRecord(payload?.actionBundle);
  return actionBundle as unknown as ActionBundleDraft | undefined;
}

function parseAndValidateProposal(input: {
  raw: string | Record<string, unknown>;
  runId: string;
  sessionId?: string;
  source?: 'llm' | 'user' | 'system' | 'cache';
}): ProposalEnvelope {
  const proposal = parseProposalEnvelope(input);
  validateProposalSemantics(proposal);
  return proposal;
}

function validateProposalSemantics(proposal: ProposalEnvelope): void {
  if (proposal.kind !== 'actionBundle') return;
  const payload = objectRecord(proposal.payload) ?? {};
  const bundle = readActionBundle(proposal);
  if (!bundle) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle must include an actionBundle object.');
  }
  if (typeof bundle.id !== 'string' || !bundle.id.trim()) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.id must be a non-empty string.');
  }
  if (bundle.version !== '1') {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.version must be "1".');
  }
  if (typeof bundle.goal !== 'string' || !bundle.goal.trim()) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.goal must be a non-empty string.');
  }
  if (!Array.isArray(bundle.actions) || bundle.actions.length === 0) {
    throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.actions must not be empty.');
  }
  if (bundle.actions.length > MAX_ACTION_BUNDLE_ACTIONS) {
    throw new AgentPlanParseError(
      'action_bundle_budget_exceeded',
      `ActionBundle has ${bundle.actions.length} actions; output only the next implementation batch with at most ${MAX_ACTION_BUNDLE_ACTIONS} actions.`
    );
  }
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
  if (codeBlocks.length > MAX_ACTION_BUNDLE_CODE_BLOCKS) {
    throw new AgentPlanParseError(
      'action_bundle_budget_exceeded',
      `ActionBundle has ${codeBlocks.length} codeBlocks; output only the next implementation batch with at most ${MAX_ACTION_BUNDLE_CODE_BLOCKS} codeBlocks.`
    );
  }
  const codeBlockIds = new Set<string>();
  let totalCodeBytes = 0;
  for (const [index, block] of codeBlocks.entries()) {
    const record = objectRecord(block);
    const blockId = typeof record?.id === 'string' ? record.id.trim() : '';
    if (!blockId) {
      throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}].id must be a non-empty string.`);
    }
    codeBlockIds.add(blockId);
    const content = typeof record?.content === 'string' ? record.content : '';
    const size = utf8Bytes(content);
    totalCodeBytes += size;
    const operation = typeof record?.operation === 'string' ? record.operation : '';
    const allowEmptyContent = record?.allowEmptyContent === true;
    if (size === 0 && !(allowEmptyContent && ['createEmpty', 'patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(operation))) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `codeBlocks[${index}].content must be non-empty unless allowEmptyContent is explicitly set for a createEmpty or patch operation.`
      );
    }
    if (size > MAX_ACTION_BUNDLE_CODE_BLOCK_BYTES) {
      throw new AgentPlanParseError(
        'action_bundle_budget_exceeded',
        `codeBlocks[${index}] is ${size} bytes; split implementation output so each codeBlock is at most ${MAX_ACTION_BUNDLE_CODE_BLOCK_BYTES} bytes.`
      );
    }
  }
  if (totalCodeBytes > MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES) {
    throw new AgentPlanParseError(
      'action_bundle_budget_exceeded',
      `codeBlocks total content is ${totalCodeBytes} bytes; output only the next implementation batch with at most ${MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES} bytes of code.`
    );
  }
  for (const [index, action] of bundle.actions.entries()) {
    if (typeof action.id !== 'string' || !action.id.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].id must be a non-empty string.`);
    }
    if (typeof action.title !== 'string' || !action.title.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].title must be a non-empty string.`);
    }
    if (typeof action.capability !== 'string' || !action.capability.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].capability must be a non-empty string.`);
    }
    if (!Array.isArray(action.resourceScope)) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].resourceScope must be an array.`);
    }
    const actionKind = typeof action.kind === 'string' ? action.kind : '';
    const isPatchAction = ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(actionKind);
    const replacementBlockId = typeof action.replacementBlockId === 'string'
      ? action.replacementBlockId.trim()
      : '';
    if (action.capability === 'workspace.delete') {
      const deleteTargetError = deleteActionTargetError(action);
      if (deleteTargetError) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${deleteTargetError}`);
      }
      if (action.sourceBlockId?.trim() || replacementBlockId) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] workspace.delete must not reference codeBlocks/sourceBlockId.`);
      }
    }
    if ((action.capability === 'workspace.write' || action.capability === 'workspace.create') && !isPatchAction && !action.sourceBlockId?.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${action.capability} must include sourceBlockId.`);
    }
    if (isPatchAction && !(replacementBlockId || action.sourceBlockId?.trim())) {
      throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] patch action must include replacementBlockId or sourceBlockId.`);
    }
    if (isPatchAction) {
      const patchSpecError = patchActionSpecError(action);
      if (patchSpecError) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${patchSpecError}`);
      }
    }
    if (action.sourceBlockId && !codeBlockIds.has(action.sourceBlockId)) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `actionBundle.actions[${index}].sourceBlockId "${action.sourceBlockId}" does not match any codeBlocks[].id.`
      );
    }
    if (replacementBlockId && !codeBlockIds.has(replacementBlockId)) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `actionBundle.actions[${index}].replacementBlockId "${replacementBlockId}" does not match any codeBlocks[].id.`
      );
    }
  }
  const sideEffectful = bundle.actions.some((action) => SIDE_EFFECT_CAPABILITIES.has(action.capability));
  if (!sideEffectful) return;
  for (const [index, block] of codeBlocks.entries()) {
    const record = objectRecord(block);
    const hasPath = typeof record?.path === 'string' && record.path.trim();
    const hasTargetPath = typeof record?.targetPath === 'string' && record.targetPath.trim();
    if (!hasPath && !hasTargetPath) {
      throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}] must include path or targetPath.`);
    }
    if (typeof record?.content !== 'string') {
      throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}].content must be a string.`);
    }
  }
  const userPlan = typeof payload.userPlan === 'string' ? payload.userPlan.trim() : '';
  validateDetailedUserPlan(userPlan);
  const validationExpectations = Array.isArray(bundle.validationExpectations) ? bundle.validationExpectations : [];
  const reviewExpectations = Array.isArray(bundle.reviewExpectations) ? bundle.reviewExpectations : [];
  if (!validationExpectations.some((item) => item?.description?.trim())) {
    throw new AgentPlanParseError(
      'action_bundle_evidence_required',
      'Side-effect actionBundle must include non-empty validationExpectations describing reviewable evidence.'
    );
  }
  if (!reviewExpectations.some((item) => item?.description?.trim())) {
    throw new AgentPlanParseError(
      'action_bundle_review_required',
      'Side-effect actionBundle must include non-empty reviewExpectations describing user review obligations.'
    );
  }
}

function deleteActionTargetError(action: ActionBundleDraft['actions'][number]): string | undefined {
  const kind = stringValue(action.kind);
  if (kind !== 'delete') {
    return 'workspace.delete must use kind="delete".';
  }
  const target = stringValue(action.targetPath) ?? stringArrayValue(action.resourceScope)[0];
  if (!target) {
    return 'workspace.delete must include a concrete targetPath or resourceScope[0].';
  }
  const normalized = normalizeSlashes(target);
  if (!normalized || normalized === '.' || normalized === './') {
    return 'workspace.delete target cannot be empty or the workspace root.';
  }
  if (isAbsolutePath(normalized)) {
    return 'workspace.delete target must be relative to the primary workspace root.';
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return 'workspace.delete target cannot escape the primary workspace root.';
  }
  if (normalized.includes('*')) {
    return 'workspace.delete target must name concrete files; wildcard cleanup is not allowed.';
  }
  if (normalized.endsWith('/')) {
    return 'workspace.delete target must name concrete files, not a directory root.';
  }
  return undefined;
}

function patchActionSpecError(action: ActionBundleDraft['actions'][number]): string | undefined {
  const patchSpec = objectRecord(action.patchSpec);
  if (!patchSpec) {
    return 'patch action must include patchSpec.';
  }
  const match = objectRecord(patchSpec.match);
  if (!match) {
    return 'patch action must include patchSpec.match.';
  }
  const matchKind = stringValue(match.kind);
  if (matchKind !== 'exactBlock') {
    return 'patchSpec.match.kind must be "exactBlock".';
  }
  const text = stringValue(match.text);
  if (!text) {
    return 'patchSpec.match.text must be a non-empty exact block from current ResourcePacket evidence.';
  }
  return undefined;
}

function validateDetailedUserPlan(userPlan: string): void {
  if (userPlan.length < 240) {
    throw new AgentPlanParseError(
      'action_bundle_plan_required',
      'Side-effect actionBundle must include a detailed Markdown userPlan, not a one-line summary.'
    );
  }
  const headings = userPlan
    .split(/\r?\n/)
    .filter((line) => /^#{1,3}\s+\S/.test(line.trim()));
  const listItems = userPlan
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*+]\s+\S/.test(line));
  if (headings.length < 4 || listItems.length < 3) {
    throw new AgentPlanParseError(
      'action_bundle_plan_required',
      'Side-effect actionBundle.userPlan must use structured Markdown with multiple headings and concrete reviewable items; localized headings are accepted.'
    );
  }
}

function actionBundlePlanCardEvent(
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  report: Record<string, unknown> | undefined,
  ts: string,
  id: string
): AgentEvent {
  const payload = objectRecord(proposal.payload) ?? {};
  const actionBundle = readActionBundle(proposal);
  const userPlan = typeof payload.userPlan === 'string' && payload.userPlan.trim()
    ? payload.userPlan
    : actionBundle?.goal ?? 'Agent plan';
  const status = stringValue(report?.status) ?? 'pending';
  const planId = actionBundle?.id ?? proposal.proposalId;
  const confirmable = planReviewStatusAwaitingUser(status);
  return {
    id,
    sessionId: state.sessionId,
    ts,
    kind: 'plan_card',
    payload: {
      title: 'Plan',
      summary: userPlan,
      content: userPlan,
      runId: proposal.runId,
      planId,
      proposalId: proposal.proposalId,
      status,
      confirmable,
      decisionOwner: {
        kind: 'plan',
        runId: proposal.runId,
        targetId: planId,
        planId,
        source: 'plan_card',
      },
      implementationBatch: state.implementationBatch,
      actionBundle,
      codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
      commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
      expectedValidation: typeof payload.expectedValidation === 'string' ? payload.expectedValidation : '',
      reviewGuide: typeof payload.reviewGuide === 'string' ? payload.reviewGuide : '',
      planReviewReport: report,
      requiredFileOperations: requiredFileOperationsFromReport(report),
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function implementationPlanCardEvent(
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  ts: string,
  id: string
): AgentEvent {
  const implementationPlan = objectRecord(proposal.payload) ?? {};
  const language = visibleLanguageForRequest(state.userRequest);
  const planId = stringValue(implementationPlan.id) ?? proposal.proposalId;
  const title = stringValue(implementationPlan.title) ?? localizedImplementationPlanHeading(language, 'title');
  const summary = stringValue(implementationPlan.summary) ?? title;
  const content = renderImplementationPlanMarkdown(implementationPlan, summary, language);
  return {
    id,
    sessionId: state.sessionId,
    ts,
    kind: 'plan_card',
    payload: {
      title,
      summary,
      content,
      runId: proposal.runId,
      planId,
      proposalId: proposal.proposalId,
      status: 'pending',
      confirmable: true,
      decisionOwner: {
        kind: 'plan',
        runId: proposal.runId,
        targetId: planId,
        planId,
        source: 'plan_card',
      },
      implementationBatch: state.implementationBatch,
      implementationPlan,
      actionBundle: {
        version: '1',
        id: planId,
        goal: summary,
        actions: [],
        continuationExpectations: [],
        validationExpectations: [],
        reviewExpectations: [],
      },
      codeBlocks: [],
      commandBlocks: [],
      expectedValidation: '',
      reviewGuide: language === 'zh-CN'
        ? '请先审查任务清单、验收标准和失败重规划条件；确认后再生成编辑内容。'
        : 'Review the task checklist, acceptance criteria, and failure criteria before edits are generated.',
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function renderImplementationPlanMarkdown(
  plan: Record<string, unknown>,
  fallbackSummary: string,
  language: VisibleLanguage
): string {
  const headings = implementationPlanMarkdownLabels(language);
  const lines = [`## ${headings.plan}`, '', fallbackSummary, ''];
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (tasks.length) {
    lines.push(`## ${headings.checklist}`, '');
    for (const task of tasks) {
      const record = objectRecord(task) ?? {};
      const title = stringValue(record.title) ?? stringValue(record.taskId) ?? headings.task;
      lines.push(`- ${title}`);
      const target = stringArrayValue(record.target);
      if (target.length) lines.push(`  - Target: ${target.join(', ')}`);
      const scope = stringValue(record.scope);
      if (scope) lines.push(`  - Scope: ${scope}`);
      const capability = stringValue(record.capability);
      if (capability) lines.push(`  - Capability: ${capability}`);
      const acceptance = stringArrayValue(record.acceptanceCriteria);
      if (acceptance.length) lines.push(`  - Acceptance: ${acceptance.join('; ')}`);
      const failure = stringArrayValue(record.failureCriteria);
      if (failure.length) lines.push(`  - Stop/Replan: ${failure.join('; ')}`);
    }
    lines.push('');
  }
  const risks = stringArrayValue(plan.risks);
  if (risks.length) {
    lines.push(`## ${headings.risks}`, '', ...risks.map((item) => `- ${item}`), '');
  }
  const checkpoints = stringArrayValue(plan.reviewCheckpoints);
  if (checkpoints.length) {
    lines.push(`## ${headings.reviewCheckpoints}`, '', ...checkpoints.map((item) => `- ${item}`), '');
  }
  lines.push(`## ${headings.boundary}`, '', `- ${headings.boundaryMessage}`);
  return lines.join('\n');
}

function localizedImplementationPlanHeading(language: VisibleLanguage, key: 'title'): string {
  if (language === 'zh-CN') {
    return key === 'title' ? '实现计划' : '实现计划';
  }
  return 'Implementation plan';
}

function implementationPlanMarkdownLabels(language: VisibleLanguage): {
  plan: string;
  checklist: string;
  task: string;
  risks: string;
  reviewCheckpoints: string;
  boundary: string;
  boundaryMessage: string;
} {
  if (language === 'zh-CN') {
    return {
      plan: '计划',
      checklist: '任务清单',
      task: '任务',
      risks: '风险',
      reviewCheckpoints: 'Review 节点',
      boundary: '边界',
      boundaryMessage: '这只是计划，不是执行结果；代码和命令只会在用户确认后生成。',
    };
  }
  return {
    plan: 'Plan',
    checklist: 'Checklist',
    task: 'Task',
    risks: 'Risks',
    reviewCheckpoints: 'Review Checkpoints',
    boundary: 'Boundary',
    boundaryMessage: 'This plan is not execution. Code and commands are generated only after user acceptance.',
  };
}

function findPlanReviewReport(events: unknown[]): Record<string, unknown> | undefined {
  for (const event of events) {
    const record = objectRecord(event);
    if (record?.kind !== 'proposal.reviewed') continue;
    const report = objectRecord(record.report);
    if (report) return report;
  }
  return undefined;
}

function planReviewNeedsRepair(report: Record<string, unknown>): boolean {
  if (
    report.status === 'denied' &&
    planReviewDiagnosticSummary(report).includes('actionBundle payload failed Kernel schema validation')
  ) {
    return true;
  }
  if (report.status !== 'needsRevision') return false;
  const repairableCodes = new Set(['completion_evidence_required']);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  return findings.some((finding) => {
    const record = objectRecord(finding);
    return typeof record?.code === 'string' && repairableCodes.has(record.code);
  });
}

function planReviewDenied(report: Record<string, unknown>): boolean {
  return report.status === 'denied' || report.status === 'interfaceOnly';
}

function planReviewStatusAwaitingUser(status: string | undefined): boolean {
  return status === 'awaitingUserApproval' ||
    status === 'awaitingTemporaryGrant' ||
    status === 'pending' ||
    status === undefined;
}

function planReviewDiagnosticSummary(report: Record<string, unknown>): string {
  const denied = Array.isArray(report.deniedReasons)
    ? report.deniedReasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const blocked = Array.isArray(report.blockedReasons)
    ? report.blockedReasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const summary = typeof report.kernelGeneratedPermissionSummary === 'string' ? report.kernelGeneratedPermissionSummary : '';
  return [...denied, ...blocked, summary].filter(Boolean).join('；') || '计划审查未通过。';
}

function shouldAttemptActionBundleCompactionRepair(state: SessionDriverLoopRunState): boolean {
  const allowed = state.stateContract?.allowedProposals ?? state.driverRequest?.stateContract?.allowedProposals ?? [];
  if (allowed.length && !allowed.includes('actionBundle')) return false;
  const capabilities = state.stateContract?.capabilityProjection ?? state.driverRequest?.stateContract?.capabilityProjection ?? [];
  return capabilities.some((capability) => SIDE_EFFECT_CAPABILITIES.has(capability));
}

function planReviewFacts(report: Record<string, unknown> | undefined): string[] {
  if (!report) return [];
  const facts: string[] = [];
  const summary = typeof report.kernelGeneratedPermissionSummary === 'string' ? report.kernelGeneratedPermissionSummary : '';
  if (summary) facts.push(summary);
  for (const key of ['blockedReasons', 'deniedReasons', 'permissionGaps', 'hardFloorHits'] as const) {
    const values = Array.isArray(report[key]) ? report[key] : [];
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) facts.push(`${key}: ${value}`);
    }
  }
  const findings = Array.isArray(report.findings) ? report.findings : [];
  for (const finding of findings) {
    const record = objectRecord(finding);
    const code = typeof record?.code === 'string' ? record.code : '';
    const message = typeof record?.message === 'string' ? record.message : '';
    if (code || message) facts.push(`finding: ${[code, message].filter(Boolean).join(' - ')}`);
  }
  for (const operation of requiredFileOperationsFromReport(report)) {
    facts.push(`fileOperation: ${operation.operation} ${operation.targetPath} (${operation.capability})`);
  }
  return facts;
}

interface SessionPlanContext {
  sessionId: string;
  runId: string;
  planId: string;
  proposalId?: string;
  userPlan: string;
  actionBundle: Record<string, unknown>;
  codeBlocks: unknown[];
  commandBlocks: unknown[];
  expectedValidation: string;
  reviewGuide: string;
  planReviewReport?: Record<string, unknown>;
  implementationPlan?: Record<string, unknown>;
}

interface SessionReviewContext {
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

interface PendingPermissionContext {
  id: string;
  runId?: string;
  planId?: string;
}

function findPendingPermissionContext(events: AgentEvent[], permissionId?: string): PendingPermissionContext | null {
  const resolved = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const result = permissionResultContext(event);
    if (result?.id) {
      resolved.add(result.id);
      continue;
    }
    const request = permissionRequestContext(event);
    if (!request?.id) continue;
    if (permissionId && request.id !== permissionId) continue;
    if (resolved.has(request.id)) continue;
    return request;
  }
  return null;
}

function permissionResultContext(event: AgentEvent): PendingPermissionContext | null {
  if (event.kind === 'permission_result') {
    const payload = objectRecord(event.payload);
    const id = stringValue(payload?.permissionId) ?? stringValue(payload?.id);
    return id ? { id, runId: stringValue(payload?.runId) } : null;
  }
  const payload = objectRecord(event.payload);
  const kernelEvent = objectRecord(payload?.kernelEvent);
  if (kernelEvent?.kind === 'permission.resolved') {
    const id = stringValue(kernelEvent.permissionId);
    return id ? { id, runId: stringValue(kernelEvent.runId) } : null;
  }
  return null;
}

function permissionRequestContext(event: AgentEvent): PendingPermissionContext | null {
  if (event.kind === 'permission_request') {
    const payload = objectRecord(event.payload);
    const id = stringValue(payload?.id);
    return id ? {
      id,
      runId: stringValue(payload?.runId),
      planId: stringValue(payload?.planId),
    } : null;
  }
  const payload = objectRecord(event.payload);
  const kernelEvent = objectRecord(payload?.kernelEvent);
  if (kernelEvent?.kind !== 'permission.requested') return null;
  const request = objectRecord(kernelEvent.request);
  const id = stringValue(request?.id) ?? stringValue(kernelEvent.permissionId) ?? stringValue(kernelEvent.toolCallId);
  return id ? {
    id,
    runId: stringValue(kernelEvent.runId),
    planId: stringValue(kernelEvent.planId),
  } : null;
}

function findPlanCard(events: AgentEvent[], runId?: string, planId?: string): SessionPlanContext | null {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload);
    const candidate = payload ? planContextFromEvent(event, payload) : null;
    if (!candidate) continue;
    if (runId && candidate.runId !== runId) continue;
    if (planId && !planAliases(candidate).has(planId)) continue;
    return candidate;
  }
  return null;
}

function latestExecutablePlan(events: AgentEvent[], previousRunId?: string): SessionPlanContext | null {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload);
    const candidate = payload ? planContextFromEvent(event, payload) : null;
    if (!candidate) continue;
    if (previousRunId && candidate.runId === previousRunId) continue;
    if (planAlreadyResolved(events, candidate)) continue;
    return candidate;
  }
  return null;
}

function planContextFromEvent(event: AgentEvent, payload: Record<string, unknown>): SessionPlanContext | null {
  const implementationPlan = objectRecord(payload.implementationPlan) ?? undefined;
  const actionBundle = objectRecord(payload.actionBundle) ?? (implementationPlan ? {
    id: stringValue(payload.planId) ?? stringValue(implementationPlan.id) ?? stringValue(payload.proposalId),
    version: '1',
    actions: [],
  } : undefined);
  if (!actionBundle) return null;
  const planId = stringValue(payload.planId)
    ?? stringValue(actionBundle.id)
    ?? stringValue(implementationPlan?.id)
    ?? stringValue(payload.proposalId);
  const runId = stringValue(payload.runId);
  if (!planId || !runId) return null;
  return {
    sessionId: event.sessionId,
    runId,
    planId,
    proposalId: stringValue(payload.proposalId),
    userPlan: stringValue(payload.content) ?? stringValue(payload.summary) ?? 'Agent plan',
    actionBundle: actionBundle as unknown as Record<string, unknown>,
    codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
    commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
    expectedValidation: stringValue(payload.expectedValidation) ?? '',
    reviewGuide: stringValue(payload.reviewGuide) ?? '',
    planReviewReport: objectRecord(payload.planReviewReport) ?? undefined,
    implementationPlan,
  };
}

function planAliases(plan: SessionPlanContext): Set<string> {
  const aliases = new Set<string>([plan.planId]);
  if (plan.proposalId) aliases.add(plan.proposalId);
  const bundleId = stringValue(plan.actionBundle.id);
  if (bundleId) aliases.add(bundleId);
  const reportPlanId = stringValue(plan.planReviewReport?.planId);
  if (reportPlanId) aliases.add(reportPlanId);
  return aliases;
}

function planAlreadyResolved(events: AgentEvent[], plan: SessionPlanContext): boolean {
  const aliases = planAliases(plan);
  return events.some((event) => {
    if (event.kind !== 'plan_review') return false;
    const payload = objectRecord(event.payload);
    if (!payload) return false;
    const status = stringValue(payload.status);
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
    const runId = stringValue(payload.runId);
    const planId = stringValue(payload.planId);
    return runId === plan.runId && (!planId || aliases.has(planId));
  });
}

function planAutoExecutableAfterRequirement(plan: SessionPlanContext): boolean {
  const report = plan.planReviewReport;
  const status = stringValue(report?.status);
  if (status === 'denied' || status === 'needsRevision' || status === 'interfaceOnly') return false;
  const hardFloorHits = Array.isArray(report?.hardFloorHits) ? report?.hardFloorHits : [];
  const deniedReasons = Array.isArray(report?.deniedReasons) ? report?.deniedReasons : [];
  const blockedReasons = Array.isArray(report?.blockedReasons) ? report?.blockedReasons : [];
  return hardFloorHits.length === 0 && deniedReasons.length === 0 && blockedReasons.length === 0;
}

function acceptedImplementationPlanContext(
  plan: SessionPlanContext,
  interventionLevel?: InterventionLevel,
  executionRoot?: AcceptedImplementationPlanExecutionRoot
): AcceptedImplementationPlanContext {
  const rawPlan = plan.implementationPlan ?? {};
  const tasks = Array.isArray(rawPlan.tasks) ? rawPlan.tasks : [];
  const taskContexts = tasks.flatMap((item, index): AcceptedImplementationPlanTaskContext[] => {
    const record = objectRecord(item);
    if (!record) return [];
    const taskId = stringValue(record.taskId) ?? stringValue(record.id) ?? `task-${index + 1}`;
    return [{
      taskId,
      title: stringValue(record.title),
      capability: stringValue(record.capability),
      targets: stringArrayValue(record.target).map(normalizePlanScope).filter(Boolean),
    }];
  });
  const capabilities = [...new Set(taskContexts.map((task) => task.capability).filter((item): item is string => Boolean(item)))];
  const targetScopes = [...new Set(taskContexts.flatMap((task) => task.targets).filter(Boolean))];
  return {
    planId: plan.planId,
    runId: plan.runId,
    title: stringValue(rawPlan.title),
    summary: stringValue(rawPlan.summary),
    tasks: taskContexts,
    capabilities,
    targetScopes,
    executionRoot,
    interventionLevel,
    batchIndex: 1,
    completedTaskIds: [],
    rawPlan,
  };
}

function acceptedPlanExecutionRootFromDecision(
  input: SessionDecisionResolverInput,
  events: AgentEvent[]
): AcceptedImplementationPlanExecutionRoot | undefined {
  if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
    const workingDirectory = input.projectWorkingDirectory;
    const ref = workingDirectory.absolutePath ?? workingDirectory.displayPath;
    return {
      attachment: {
        kind: 'directory',
        path: workingDirectory.displayPath,
        absolutePath: workingDirectory.absolutePath,
        source: 'userSelected',
        scope: 'session',
      },
      ref,
      source: 'projectWorkingDirectory',
    };
  }
  if (input.workspaceBinding?.openPath) {
    return {
      attachment: {
        kind: 'directory',
        path: input.workspaceBinding.openPath,
        absolutePath: input.workspaceBinding.openPath,
        source: 'userSelected',
        scope: 'session',
      },
      ref: input.workspaceBinding.openPath,
      source: 'workspaceBinding',
    };
  }
  const recentDirectories = uniqueAttachments(recentAttachmentFacts(events))
    .filter((attachment) => attachment.kind === 'directory');
  const uniqueRefs = [...new Set(recentDirectories.map((attachment) => comparablePath(attachment.absolutePath ?? attachment.path)))];
  if (uniqueRefs.length !== 1) return undefined;
  const attachment = recentDirectories.find((item) => comparablePath(item.absolutePath ?? item.path) === uniqueRefs[0]);
  if (!attachment) return undefined;
  const ref = attachment.absolutePath ?? attachment.path;
  return {
    attachment: {
      ...attachment,
      path: attachment.path || ref,
      scope: 'session',
    },
    ref,
    source: 'recentAttachment',
  };
}

function acceptedPlanExecutionContext(
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  planReviewReport: Record<string, unknown>
): SessionPlanContext {
  const accepted = state.acceptedImplementationPlan;
  const payload = objectRecord(proposal.payload) ?? {};
  const actionBundle = readActionBundle(proposal) ?? {
    id: accepted?.planId ?? proposal.proposalId,
    version: '1',
    goal: stringValue(accepted?.summary) ?? 'Accepted implementation plan batch',
    actions: [],
    validationExpectations: [],
    reviewExpectations: [],
  };
  return {
    sessionId: state.sessionId,
    runId: state.runId,
    planId: accepted?.planId ?? stringValue(actionBundle.id) ?? proposal.proposalId,
    proposalId: proposal.proposalId,
    userPlan: stringValue(payload.userPlan) ?? stringValue(accepted?.summary) ?? 'Accepted implementation plan batch',
    actionBundle: actionBundle as unknown as Record<string, unknown>,
    codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
    commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
    expectedValidation: stringValue(payload.expectedValidation) ?? '',
    reviewGuide: stringValue(payload.reviewGuide) ?? '',
    planReviewReport,
    implementationPlan: accepted?.rawPlan,
  };
}

function validateAcceptedImplementationPlanActionBundle(
  accepted: AcceptedImplementationPlanContext,
  proposal: ProposalEnvelope,
  resourcePackets: ResourcePacket[] = []
): AcceptedPlanBatchValidationResult {
  const actionBundle = readActionBundle(proposal);
  if (!actionBundle) return { ok: false, reasons: ['当前 provider 输出不包含 actionBundle，无法按已确认计划自动执行。'] };
  const reasons: string[] = [];
  const allowedCapabilities = new Set(accepted.capabilities);
  const allowedScopes = accepted.targetScopes.map(normalizePlanScope).filter(Boolean);
  const batchTargets = acceptedPlanProposalTargetScopes(proposal, accepted);
  for (const target of batchTargets) {
    const targetError = acceptedPlanRelativeTargetError(target, accepted);
    if (targetError) reasons.push(targetError);
  }
  for (const action of actionBundle.actions ?? []) {
    const capability = action.capability;
    if (!acceptedPlanAutoExecutableCapability(capability)) {
      reasons.push(`能力 ${capability || '[empty]'} 需要单独用户介入，不能在 accepted implementationPlan 后自动执行。`);
      continue;
    }
    if (!allowedCapabilities.has(capability)) {
      reasons.push(`能力 ${capability} 未出现在已确认 implementationPlan 的任务能力列表中。`);
    }
    const scopes = actionPlanTargetScopes(action, proposal)
      .map((scope) => normalizeAcceptedPlanTargetScope(scope, accepted))
      .filter(Boolean);
    if (scopes.length === 0) {
      reasons.push(`动作 ${action.id || action.title || '[unnamed]'} 缺少 target/resourceScope，不能证明其落在已确认计划范围内。`);
      continue;
    }
    for (const scope of scopes) {
      if (!scopeCoveredByAcceptedPlan(scope, allowedScopes)) {
        reasons.push(`目标 ${scope} 超出已确认 implementationPlan 的 target 范围。`);
      }
    }
  }
  reasons.push(...patchEvidenceValidationReasons(proposal, resourcePackets));
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function patchEvidenceValidationReasons(
  proposal: ProposalEnvelope,
  resourcePackets: ResourcePacket[]
): string[] {
  const actionBundle = readActionBundle(proposal);
  const reasons: string[] = [];
  for (const [index, action] of (actionBundle?.actions ?? []).entries()) {
    const actionKind = stringValue(action.kind);
    if (!['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(actionKind ?? '')) continue;
    const match = objectRecord(objectRecord(action.patchSpec)?.match);
    const matchText = stringValue(match?.text);
    if (!matchText) continue;
    const targets = actionPlanTargetScopes(action, proposal).map(normalizePlanScope).filter(Boolean);
    if (!resourceEvidenceContainsExactBlock(resourcePackets, targets, matchText)) {
      const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
      reasons.push(`patch action ${action.id || action.title || index} 缺少当前文件/search 证据：patchSpec.match.text 必须来自最近 ResourcePacket 的 fileText/searchResults（target=${targetLabel}）。请先返回 resourceRequest kind="search" 或读取目标文件/range。`);
    }
  }
  return reasons;
}

function resourceEvidenceContainsExactBlock(
  packets: ResourcePacket[],
  targets: string[],
  matchText: string
): boolean {
  if (!packets.length) return false;
  const normalizedMatch = normalizeLineEndings(matchText);
  const normalizedTargets = targets.map(normalizePlanScope).filter(Boolean);
  const candidateItems = packets.flatMap((packet) => packet.items ?? [])
    .filter((item) => item.status === 'resolved' || item.status === 'provided');
  const pathMatchedItems = normalizedTargets.length
    ? candidateItems.filter((item) => resourcePacketItemMatchesAnyTarget(item, normalizedTargets))
    : candidateItems;
  const items = pathMatchedItems.length ? pathMatchedItems : candidateItems;
  return items.some((item) => {
    const evidence = resourcePacketItemEvidenceText(item);
    if (!evidence) return false;
    return normalizeLineEndings(evidence).includes(normalizedMatch);
  });
}

function resourcePacketItemMatchesAnyTarget(item: ResourcePacketItem, targets: string[]): boolean {
  const candidates = [
    item.path,
    item.absolutePath,
  ]
    .map((value) => typeof value === 'string' ? normalizePlanScope(value) : '')
    .filter(Boolean);
  if (!candidates.length) return false;
  return targets.some((target) =>
    candidates.some((candidate) =>
      candidate === target ||
      candidate.endsWith(`/${target}`) ||
      target.endsWith(`/${candidate}`)
    )
  );
}

function resourcePacketItemEvidenceText(item: ResourcePacketItem): string {
  const parts = [
    item.promptContent,
    item.contentSummary,
    Array.isArray(item.matches) ? JSON.stringify(item.matches) : '',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return parts.join('\n');
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function acceptedPlanProposalTargetScopes(
  proposal: ProposalEnvelope,
  accepted: AcceptedImplementationPlanContext
): AcceptedPlanTargetScope[] {
  const actionBundle = readActionBundle(proposal);
  const targets: string[] = [];
  for (const action of actionBundle?.actions ?? []) {
    targets.push(...actionPlanTargetScopes(action, proposal));
  }
  const payload = objectRecord(proposal.payload) ?? {};
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
  for (const block of codeBlocks) {
    const record = objectRecord(block);
    if (!record) continue;
    targets.push(...stringArrayValue(record.path), ...stringArrayValue(record.targetPath));
  }
  const output: AcceptedPlanTargetScope[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const normalized = normalizeAcceptedPlanTargetScope(raw, accepted);
    const key = `${raw}\u0000${normalized}`;
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push({ raw, normalized });
  }
  return output;
}

function acceptedPlanRelativeTargetError(
  target: AcceptedPlanTargetScope,
  accepted: AcceptedImplementationPlanContext
): string | undefined {
  const raw = target.raw;
  const normalized = target.normalized;
  if (!normalized) return 'actionBundle 目标路径为空，不能自动执行。';
  if (normalized === '.' || normalized === '..') {
    return `目标 ${raw} 指向 primary root 目录本身，不是可写入文件。`;
  }
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return `目标 ${raw} 不能包含跨出 primary root 的相对路径。`;
  }
  const rootRef = accepted.executionRoot?.ref;
  if (isAbsolutePath(raw)) {
    if (!rootRef) {
      return `目标 ${raw} 必须是相对 workspace root 的路径；当前没有可归一化的 attachment root。`;
    }
    const root = comparablePath(rootRef);
    const candidate = comparablePath(raw);
    if (candidate !== root && !candidate.startsWith(`${root}/`)) {
      return `目标 ${raw} 是绝对路径，但不在已确认 primary root ${rootRef} 内。`;
    }
  }
  if (rootRef) {
    const rootName = basename(rootRef);
    const rawNormalized = normalizePlanScope(raw);
    if (rootName && rawNormalized === rootName) {
      return `目标 ${raw} 指向 primary root 目录本身，不是可写入文件。`;
    }
  }
  return undefined;
}

function acceptedPlanBatchProgress(
  accepted: AcceptedImplementationPlanContext,
  proposal: ProposalEnvelope,
  kernelEvents: unknown[]
): AcceptedPlanBatchProgress {
  const actionBundle = readActionBundle(proposal);
  const actions = actionBundle?.actions ?? [];
  const actionIds = actions
    .map((action) => {
      const record = objectRecord(action) ?? {};
      return stringValue(record.actionId) ?? stringValue(record.id) ?? stringValue(record.title);
    })
    .filter((item): item is string => Boolean(item));
  const actionCapabilities = new Set(actions.map((action) => stringValue(action.capability)).filter((item): item is string => Boolean(item)));
  const targetPaths = [...new Set(acceptedPlanProposalTargetScopes(proposal, accepted)
    .map((target) => target.normalized)
    .filter((target) => target && target !== '.' && target !== '..'))];
  const workUnitIds = workUnitIdsFromKernelEvents(kernelEvents);
  const priorCompleted = new Set(accepted.completedTaskIds);
  const newlyCompleted = new Set<string>();
  for (const task of accepted.tasks) {
    if (priorCompleted.has(task.taskId)) continue;
    if (acceptedPlanTaskCoveredByBatch(task, targetPaths, actionCapabilities)) {
      newlyCompleted.add(task.taskId);
    }
  }
  if (!newlyCompleted.size && !actionBatchHasFailureOrBlocker(kernelEvents)) {
    const currentTask = accepted.tasks[Math.max(0, accepted.batchIndex - 1)];
    if (currentTask && !priorCompleted.has(currentTask.taskId)) {
      newlyCompleted.add(currentTask.taskId);
    }
  }
  const completedTaskIds = [...new Set([...accepted.completedTaskIds, ...newlyCompleted])];
  const completed = new Set(completedTaskIds);
  const remainingTaskIds = accepted.tasks
    .map((task) => task.taskId)
    .filter((taskId) => !completed.has(taskId));
  return {
    actionIds: [...new Set(actionIds)],
    targetPaths,
    workUnitIds,
    newlyCompletedTaskIds: [...newlyCompleted],
    completedTaskIds,
    remainingTaskIds,
  };
}

function acceptedPlanTaskCoveredByBatch(
  task: AcceptedImplementationPlanTaskContext,
  targetPaths: string[],
  actionCapabilities: Set<string>
): boolean {
  if (task.capability && actionCapabilities.size && !actionCapabilities.has(task.capability)) return false;
  if (!task.targets.length) return !task.capability || actionCapabilities.has(task.capability);
  if (!targetPaths.length) return false;
  return task.targets.every((taskTarget) => {
    const normalizedTaskTarget = normalizePlanScope(taskTarget);
    return targetPaths.some((targetPath) =>
      planScopeCovers(normalizedTaskTarget, targetPath) ||
      planScopeCovers(targetPath, normalizedTaskTarget)
    );
  });
}

function acceptedPlanAfterBatch(
  accepted: AcceptedImplementationPlanContext,
  completedTaskIds: string[]
): AcceptedImplementationPlanContext {
  const completed = new Set(completedTaskIds);
  const nextIndex = accepted.tasks.findIndex((task) => !completed.has(task.taskId));
  return {
    ...accepted,
    completedTaskIds,
    batchIndex: nextIndex >= 0 ? nextIndex + 1 : accepted.tasks.length + 1,
  };
}

function acceptedPlanComplete(accepted: AcceptedImplementationPlanContext): boolean {
  if (!accepted.tasks.length) return true;
  const completed = new Set(accepted.completedTaskIds);
  return accepted.tasks.every((task) => completed.has(task.taskId));
}

function workUnitIdsFromKernelEvents(kernelEvents: unknown[]): string[] {
  const ids = new Set<string>();
  for (const event of kernelEvents) {
    const record = objectRecord(event);
    if (!record) continue;
    const workUnit = objectRecord(record.workUnit);
    const id = stringValue(record.workUnitId) ?? stringValue(workUnit?.id);
    if (id) ids.add(id);
  }
  return [...ids];
}

function normalizeAcceptedPlanTargetScope(
  value: string,
  accepted: AcceptedImplementationPlanContext
): string {
  const normalized = normalizePlanScope(value);
  const rootRef = accepted.executionRoot?.ref;
  if (!rootRef) return normalized;
  const root = comparablePath(rootRef);
  const candidate = comparablePath(value);
  if (isAbsolutePath(value) || isAbsolutePath(normalized)) {
    if (candidate === root) return '.';
    if (candidate.startsWith(`${root}/`)) return normalizePlanScope(candidate.slice(root.length + 1));
    return normalized;
  }
  const rootName = basename(rootRef);
  if (rootName && normalized === rootName) return '.';
  if (rootName && normalized.startsWith(`${rootName}/`)) {
    return normalizePlanScope(normalized.slice(rootName.length + 1));
  }
  return normalized;
}

function acceptedPlanAutoExecutableCapability(capability: string): boolean {
  return [
    'workspace.read',
    'workspace.write',
    'workspace.create',
    'workspace.delete',
    'workspace.rename',
    'process.exec',
    'network.egress',
    'git.read',
    'git.write',
    'git.push',
    'config.modify',
    'browser.control',
    'provider.egress',
  ].includes(capability);
}

function actionPlanTargetScopes(action: { resourceScope?: unknown; targetPath?: unknown; sourceBlockId?: unknown; replacementBlockId?: unknown }, proposal: ProposalEnvelope): string[] {
  const scopes = stringArrayValue(action.resourceScope).concat(stringArrayValue(action.targetPath));
  const payload = objectRecord(proposal.payload) ?? {};
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
  const blockIds = new Set([
    stringValue(action.sourceBlockId),
    stringValue(action.replacementBlockId),
  ].filter((item): item is string => Boolean(item)));
  for (const block of codeBlocks) {
    const record = objectRecord(block);
    const blockId = stringValue(record?.id);
    if (!blockId || !blockIds.has(blockId)) continue;
    scopes.push(...stringArrayValue(record?.path), ...stringArrayValue(record?.targetPath));
  }
  return scopes;
}

function scopeCoveredByAcceptedPlan(scope: string, acceptedScopes: string[]): boolean {
  if (acceptedScopes.length === 0) return false;
  return acceptedScopes.some((accepted) => planScopeCovers(accepted, scope));
}

function planScopeCovers(accepted: string, candidate: string): boolean {
  if (!accepted || !candidate) return false;
  if (accepted === candidate) return true;
  const acceptedDir = accepted.endsWith('/') ? accepted : `${accepted}/`;
  return candidate.startsWith(acceptedDir);
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function nonAcceptedPlanPermissionGaps(report: Record<string, unknown>, accepted: AcceptedImplementationPlanContext): string[] {
  const gaps = Array.isArray(report.permissionGaps)
    ? report.permissionGaps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const acceptedCapabilities = new Set(accepted.capabilities);
  return gaps.filter((capability) => !planAcceptedAutoGrantCapability(capability) && !acceptedCapabilities.has(capability));
}

function acceptedPlanOutOfScopeDecisionProposal(
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  validation: AcceptedPlanBatchValidationResult,
  proposalId: string
): ProposalEnvelope {
  const language = visibleLanguageForRequest(state.userRequest);
  const accepted = state.acceptedImplementationPlan;
  const summary = language === 'en-US'
    ? 'The next batch is outside the accepted implementation plan.'
    : '下一批 actionBundle 超出已确认 implementationPlan 范围。';
  const reasons = validation.reasons.length ? validation.reasons : [summary];
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    proposalId,
    runId: state.runId,
    sessionId: state.sessionId,
    source: 'system',
    kind: 'decisionRequest',
    payload: {
      id: `accepted-plan-scope-${safeSegment(accepted?.planId ?? proposal.proposalId)}`,
      goal: summary,
      summary: `${summary}\n${reasons.map((reason) => `- ${reason}`).join('\n')}`,
      question: language === 'en-US'
        ? 'How should DeepCode continue?'
        : '接下来如何继续？',
      options: language === 'en-US'
        ? [
          {
            id: 'regenerate-in-scope',
            label: 'Regenerate in scope',
            description: 'Keep the accepted plan and ask the agent to output the next batch within its targets and capabilities.',
            recommended: true,
          },
          {
            id: 'revise-plan',
            label: 'Revise plan scope',
            description: 'Treat the new targets or capabilities as a plan revision before continuing.',
          },
        ]
        : [
          {
            id: 'regenerate-in-scope',
            label: '重新生成合规批次',
            description: '保持已确认计划不变，让 Agent 重新输出落在目标和能力范围内的下一批。',
            recommended: true,
          },
          {
            id: 'revise-plan',
            label: '修订计划范围',
            description: '把新增目标或能力作为计划修订先确认，再继续执行。',
          },
        ],
      allowsFreeform: true,
      risks: reasons,
      affectedAreas: accepted?.targetScopes ?? [],
      constraints: [
        'Accepted implementationPlan controls automatic batch execution scope.',
        'Kernel permissions remain authoritative.',
      ],
    },
    referencedResourcePacketRefs: [],
    referencedEvidenceRefs: [],
  };
}

function planReviewDecisionEvent(
  sessionId: string,
  plan: SessionPlanContext,
  status: 'accepted' | 'rejected' | 'needsRevision',
  summary: string | undefined,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'plan_review',
    payload: {
      title: '计划确认',
      summary: summary || (status === 'accepted' ? '用户已确认计划，准备进入执行。' : '用户要求修改计划。'),
      status,
      runId: plan.runId,
      planId: plan.planId,
      confirmable: false,
      facts: planReviewFacts(plan.planReviewReport),
      requiredFileOperations: requiredFileOperationsFromReport(plan.planReviewReport),
      channel: status === 'accepted' ? 'progress' : 'final',
      visibility: 'conversation',
      presentation: 'body',
      report: plan.planReviewReport,
    },
  };
}

function sessionRunStateEvent(input: {
  sessionId: string;
  runId: string;
  phase: SessionTurnPhase;
  status?: 'waiting' | 'running' | 'completed' | 'cancelled';
  reason: 'requirement' | 'plan_review' | 'permission' | 'review' | 'accepted_plan_execution';
  decisionOwner: DecisionOwnerRef;
  ts: string;
  id: string;
}): AgentEvent {
  const status = input.status ?? 'waiting';
  return {
    id: input.id,
    sessionId: input.sessionId,
    ts: input.ts,
    kind: 'session_run_state',
    payload: {
      status,
      phase: input.phase,
      reason: input.reason,
      runId: input.runId,
      decisionKind: input.decisionOwner.kind,
      targetId: input.decisionOwner.targetId,
      decisionOwner: input.decisionOwner,
      summary: sessionRunStateSummary(input.reason, status),
      channel: 'task',
      visibility: 'debug',
      presentation: 'stageSummary',
    },
  };
}

function sessionRunStateSummary(
  reason: 'requirement' | 'plan_review' | 'permission' | 'review' | 'accepted_plan_execution',
  status: 'waiting' | 'running' | 'completed' | 'cancelled'
): string {
  if (status === 'cancelled') return '用户已忽略当前介入点，本轮会话已中止。';
  if (status === 'completed' && reason === 'review') return 'Review 已通过，本次计划执行完成。';
  if (status === 'completed') return 'Session run is completed.';
  if (reason === 'accepted_plan_execution') return 'Session run is executing the accepted implementation plan.';
  if (status === 'running') return 'Session run is running.';
  if (reason === 'requirement') return 'Session run is waiting for requirement confirmation.';
  if (reason === 'permission') return 'Session run is waiting for a permission decision.';
  if (reason === 'review') return 'Session run is waiting for user review.';
  return 'Session run is waiting for plan review.';
}

function acceptedPlanBatchCheckpointEvent(
  sessionId: string,
  runId: string,
  accepted: AcceptedImplementationPlanContext,
  proposal: ProposalEnvelope,
  kernelEvents: unknown[],
  progress: AcceptedPlanBatchProgress,
  ts: string,
  id: string
): AgentEvent {
  const failedOrBlocked = actionBatchHasFailureOrBlocker(kernelEvents);
  const complete = !failedOrBlocked && progress.remainingTaskIds.length === 0;
  const summary = failedOrBlocked
    ? '已确认计划的当前执行批次存在失败或阻塞，已暂停自动推进。'
    : complete
      ? '已确认计划的任务清单已执行完成，准备进入最终 Review。'
      : '已确认计划的当前执行批次已完成，Session 将继续生成下一批。';
  return {
    id,
    sessionId,
    ts,
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.batch_checkpoint',
      status: failedOrBlocked ? 'blocked' : 'completed',
      summary,
      runId,
      planId: accepted.planId,
      proposalId: proposal.proposalId,
      batchIndex: accepted.batchIndex,
      actionIds: progress.actionIds,
      targetPaths: progress.targetPaths,
      workUnitIds: progress.workUnitIds,
      newlyCompletedTaskIds: progress.newlyCompletedTaskIds,
      completedTaskIds: progress.completedTaskIds,
      remainingTaskIds: progress.remainingTaskIds,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
    },
  };
}

function temporaryGrantsForPlan(plan: SessionPlanContext): Record<string, unknown>[] {
  const report = plan.planReviewReport ?? {};
  const gaps = Array.isArray(report.permissionGaps)
    ? report.permissionGaps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const gapSet = new Set(gaps);
  const fileOperations = requiredFileOperationsFromReport(report);
  const grants: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const operation of fileOperations) {
    const capability = operation.capability;
    if (!gapSet.has(capability)) continue;
    if (!planAcceptedAutoGrantCapability(capability)) continue;
    const targetPath = concreteFileOperationTarget(operation.targetPath);
    if (!targetPath) continue;
    const key = `${capability}\0${targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    grants.push(temporaryGrant(plan, capability, targetPath));
  }
  return grants;
}

interface RequiredFileOperationProjection {
  operation: string;
  targetPath: string;
  capability: string;
  actionId?: string;
}

function requiredFileOperationsFromReport(report: Record<string, unknown> | undefined): RequiredFileOperationProjection[] {
  const operations = Array.isArray(report?.requiredFileOperations) ? report.requiredFileOperations : [];
  const output: RequiredFileOperationProjection[] = [];
  const seen = new Set<string>();
  for (const item of operations) {
    const record = objectRecord(item);
    if (!record) continue;
    const operation = stringValue(record.operation);
    const targetPath = concreteFileOperationTarget(stringValue(record.targetPath) ?? '');
    const capability = stringValue(record.capability);
    if (!operation || !targetPath || !capability) continue;
    const actionId = stringValue(record.actionId);
    const key = `${operation}\0${capability}\0${targetPath}\0${actionId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ operation, targetPath, capability, actionId });
  }
  return output;
}

function concreteFileOperationTarget(value: string): string | undefined {
  const normalized = normalizePlanScope(value);
  if (!normalized || normalized === '.' || normalized === './') return undefined;
  if (isAbsolutePath(normalized)) return undefined;
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  if (normalized.includes('*')) return undefined;
  if (normalized.endsWith('/')) return undefined;
  return normalized;
}

function planAcceptedAutoGrantCapability(capability: string): boolean {
  return ['workspace.write', 'workspace.create', 'workspace.delete', 'workspace.rename'].includes(capability);
}

function temporaryGrant(plan: SessionPlanContext, capability: string, resourcePath?: string): Record<string, unknown> {
  return {
    id: `grant-${safeSegment(plan.planId)}-${safeSegment(capability)}-${resourcePath ? safeSegment(resourcePath) : 'run'}`,
    capability,
    resourceKind: resourceKindForCapability(capability),
    resourcePath,
    reason: resourcePath
      ? `Plan ${plan.planId} accepted by user through Session DecisionResolver; Kernel-reviewed file operation grant is scoped to ${resourcePath} and expires when ReviewGate closes.`
      : `Plan ${plan.planId} accepted by user through Session DecisionResolver; capability grant is scoped to the current batch/run and expires when ReviewGate closes.`,
    permissionBundle: {
      source: 'kernelPlanReview',
      planId: plan.planId,
      capability,
      groupedBy: resourcePath ? 'fileOperation' : 'capability',
    },
  };
}

function resourceKindForCapability(capability: string): string {
  if (['workspace.write', 'workspace.delete', 'workspace.rename', 'workspace.create'].includes(capability)) return 'workspaceFile';
  if (capability === 'git.write' || capability === 'git.push') return 'git';
  if (capability === 'config.modify') return 'config';
  if (capability === 'process.exec') return 'process';
  if (capability === 'network.egress') return 'network';
  if (capability === 'browser.control') return 'browser';
  if (capability === 'secret.read') return 'secret';
  return 'capability';
}

function reviewSummaryEvent(
  sessionId: string,
  plan: SessionPlanContext,
  kernelEvents: unknown[],
  ts: string,
  id: string
): AgentEvent {
  const facts = reviewFactLines(kernelEvents);
  const reviewFacts = findReviewFacts(kernelEvents);
  const gitReview = reviewFacts ? objectRecord(reviewFacts.gitReview) : undefined;
  const completed = reviewFacts
    ? arrayLength(reviewFacts.completedWorkUnits)
    : kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.completed').length;
  const failed = reviewFacts
    ? arrayLength(reviewFacts.failedWorkUnits)
    : kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.failed').length;
  const blocked = reviewFacts
    ? arrayLength(reviewFacts.blockedWorkUnits)
    : kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.blocked').length;
  const toolResults = reviewFacts
    ? arrayLength(reviewFacts.toolResults)
    : kernelEvents.filter((event) => objectRecord(event)?.kind === 'tool.completed').length;
  const continuations = concreteContinuationExpectations(plan.actionBundle.continuationExpectations);
  const summary = failed || blocked
    ? '当前批次已推进，但存在失败或阻塞项，请审查 Kernel facts 后决定是否修订。'
    : '当前批次已执行，请审查 Kernel tool facts 与验证结果。';
  return {
    id,
    sessionId,
    ts,
    kind: 'review_summary',
    payload: {
      title: 'Review',
      summary,
      content: waitingReviewContent(plan, facts, summary, completed, failed, blocked, toolResults, continuations, gitReview, reviewFacts),
      status: 'waitingUserReview',
      runId: plan.runId,
      reviewId: `${plan.runId}:${plan.planId}`,
      sourcePlanId: plan.planId,
      confirmable: true,
      continuationRequested: false,
      continuationCount: continuations.length,
      continuations,
      reviewExpectations: Array.isArray(plan.actionBundle.reviewExpectations) ? plan.actionBundle.reviewExpectations : [],
      reviewFacts,
      gitReview,
      facts,
      factCounts: {
        workUnitsCompleted: completed,
        workUnitsFailed: failed,
        workUnitsBlocked: blocked,
        toolResults,
      },
      channel: 'review',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function actionBatchReadyForReview(kernelEvents: unknown[]): boolean {
  if (kernelEventsContainPermissionRequest(kernelEvents)) {
    return false;
  }
  if (kernelEvents.some((event) => {
    const record = objectRecord(event);
    return record?.kind === 'stage.changed' && stringValue(record.phase) === 'review';
  })) {
    return true;
  }
  const queued = new Set<string>();
  const terminal = new Set<string>();
  for (const event of kernelEvents) {
    const record = objectRecord(event);
    if (record?.kind === 'work_unit.queued') {
      const workUnit = objectRecord(record.workUnit);
      const id = stringValue(workUnit?.id);
      if (id) queued.add(id);
    } else if (
      record?.kind === 'work_unit.completed' ||
      record?.kind === 'work_unit.failed' ||
      record?.kind === 'work_unit.blocked'
    ) {
      const id = stringValue(record.workUnitId);
      if (id) terminal.add(id);
    }
  }
  return queued.size > 0 && [...queued].every((id) => terminal.has(id));
}

function actionBatchHasFailureOrBlocker(kernelEvents: unknown[]): boolean {
  return kernelEvents.some((event) => {
    const record = objectRecord(event);
    return record?.kind === 'work_unit.failed' ||
      record?.kind === 'work_unit.blocked' ||
      (record?.kind === 'stage.changed' && ['blocked', 'failed'].includes(stringValue(record.phase) ?? ''));
  });
}

function kernelEventsContainPermissionRequest(kernelEvents: unknown[]): boolean {
  return kernelEvents.some((event) => objectRecord(event)?.kind === 'permission.requested');
}

function permissionIdFromKernelEvents(kernelEvents: unknown[]): string | undefined {
  for (const event of kernelEvents) {
    const record = objectRecord(event);
    if (record?.kind !== 'permission.requested') continue;
    const request = objectRecord(record.request);
    const id = stringValue(request?.id) ?? stringValue(record.permissionId) ?? stringValue(record.toolCallId);
    if (id) return id;
  }
  return undefined;
}

function runIdFromKernelEvents(kernelEvents: unknown[]): string | undefined {
  for (const event of kernelEvents) {
    const record = objectRecord(event);
    const runId = stringValue(record?.runId);
    if (runId) return runId;
  }
  return undefined;
}

function waitingReviewContent(
  plan: SessionPlanContext,
  facts: string[],
  summary: string,
  completed: number,
  failed: number,
  blocked: number,
  toolResults: number,
  continuations: unknown[],
  gitReview?: Record<string, unknown>,
  reviewFacts?: Record<string, unknown>
): string {
  const reviewLines = reviewExpectationLines(plan);
  const gitLines = gitReviewSummaryLines(gitReview);
  const generatedLines = reviewGeneratedArtifactLines(reviewFacts);
  const normalizationLines = reviewPathNormalizationLines(reviewFacts);
  return [
    '## Review',
    '',
    summary,
    '',
    '### 执行结果',
    `- WorkUnit 完成：${completed}`,
    `- WorkUnit 失败：${failed}`,
    `- WorkUnit 阻塞：${blocked}`,
    `- Tool facts：${toolResults}`,
    '',
    '### Kernel facts',
    facts.length ? facts.join('\n') : '- 当前批次没有可展示的 Kernel facts。',
    '',
    '### 本轮 Agent 生成产物',
    generatedLines.length ? generatedLines.join('\n') : '- 当前 ReviewFacts 没有记录 agentGenerated 产物。',
    '',
    '### 路径归一化诊断',
    normalizationLines.length ? normalizationLines.join('\n') : '- 当前没有路径前缀剥离或重复根路径诊断。',
    '',
    '### Git 变更',
    gitLines.length ? gitLines.join('\n') : '- 当前没有可展示的 Git 变更事实。',
    '',
    '### 原计划摘要',
    clip(plan.userPlan, 1200),
    '',
    '### 验证与启动建议',
    reviewLines.length ? reviewLines.join('\n') : '- 当前计划未提供可执行验证命令，需要下一轮补充。',
    '',
    '### 后续决策',
    failed || blocked
      ? '- 空输入通过并结束当前批次，不会自动执行失败项；如需修复，请在输入框输入 Review 修改意见，系统会重新进入 Plan。'
      : '- 空输入通过并结束当前批次；输入文字会作为 Review 修订意见，系统会重新进入 Plan。',
    continuations.length
      ? `- 当前计划登记了 ${continuations.length} 个后续意图；Review 通过后会按 agent.reviewContinuationMode 处理。自动模式会生成下一批 Plan；新 Plan 仍需确认，确认后的合规 actionBundle 会自动提交 Kernel 执行。`
      : '- 当前计划没有登记后续批次。',
  ].join('\n');
}

function gitReviewSummaryLines(gitReview?: Record<string, unknown>): string[] {
  if (!gitReview) return [];
  if (gitReview.available === false) {
    const reason = stringValue(gitReview.reason) ?? 'Git review is unavailable.';
    return [`- Git diff 不可用：${reason}`];
  }
  const lines: string[] = [];
  const summary = stringValue(gitReview.summary);
  if (summary) lines.push(`- ${summary}`);
  const stats = objectRecord(gitReview.stats);
  const changedFiles = typeof stats?.changedFiles === 'number' ? stats.changedFiles : undefined;
  const stagedBytes = typeof stats?.stagedDiffBytes === 'number' ? stats.stagedDiffBytes : 0;
  const unstagedBytes = typeof stats?.unstagedDiffBytes === 'number' ? stats.unstagedDiffBytes : 0;
  if (changedFiles !== undefined) {
    lines.push(`- 文件数：${changedFiles}；staged diff：${stagedBytes} bytes；unstaged diff：${unstagedBytes} bytes。`);
  }
  const files = Array.isArray(gitReview.files) ? gitReview.files : [];
  for (const item of files.slice(0, 12)) {
    const record = objectRecord(item);
    const path = stringValue(record?.path);
    if (path) lines.push(`- \`${path}\``);
  }
  if (files.length > 12) lines.push(`- 另有 ${files.length - 12} 个文件未在摘要中展开。`);
  const diffBlocks = Array.isArray(gitReview.diffBlocks) ? gitReview.diffBlocks : [];
  if (diffBlocks.length) lines.push('- 完整 diff 已附加为可折叠 Review 证据。');
  return lines;
}

function reviewGeneratedArtifactLines(reviewFacts?: Record<string, unknown>): string[] {
  const artifacts = Array.isArray(reviewFacts?.generatedArtifacts) ? reviewFacts.generatedArtifacts : [];
  return artifacts.slice(0, 24).map((item) => {
    const record = objectRecord(item) ?? {};
    const path = stringValue(record.path) ?? stringValue(record.absolutePath) ?? 'unknown';
    const operation = stringValue(record.operation) ?? stringValue(record.toolName) ?? 'write';
    const hash = stringValue(record.contentHash);
    return `- \`${path}\` operation=${operation}${hash ? ` contentHash=${hash}` : ''}`;
  }).concat(artifacts.length > 24 ? [`- 另有 ${artifacts.length - 24} 个 agentGenerated 产物未展开。`] : []);
}

function reviewPathNormalizationLines(reviewFacts?: Record<string, unknown>): string[] {
  const diagnostics = Array.isArray(reviewFacts?.pathNormalizationDiagnostics)
    ? reviewFacts.pathNormalizationDiagnostics
    : [];
  return diagnostics.slice(0, 24).map((item) => {
    const record = objectRecord(item) ?? {};
    const path = stringValue(record.path) ?? 'unknown';
    const normalization = objectRecord(record.pathNormalization) ?? {};
    const original = stringValue(normalization.originalPath);
    const normalized = stringValue(normalization.normalizedTargetPath);
    const stripped = Array.isArray(normalization.strippedPathPrefixes)
      ? normalization.strippedPathPrefixes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const duplicate = record.duplicateRootPathDetected === true || normalization.duplicateRootPathDetected === true;
    return `- \`${path}\`${original ? ` original=${original}` : ''}${normalized ? ` normalized=${normalized}` : ''}${stripped.length ? ` stripped=${stripped.join(', ')}` : ''}${duplicate ? ' duplicateRootPathDetected=true' : ''}`;
  }).concat(diagnostics.length > 24 ? [`- 另有 ${diagnostics.length - 24} 条路径归一化诊断未展开。`] : []);
}

function reviewFactLines(kernelEvents: unknown[]): string[] {
  const facts = findReviewFacts(kernelEvents);
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

function findReviewFacts(kernelEvents: unknown[]): Record<string, unknown> | undefined {
  for (const event of [...kernelEvents].reverse()) {
    const record = objectRecord(event);
    if (record?.kind !== 'review.facts_produced') continue;
    return objectRecord(record.facts) ?? undefined;
  }
  return undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function reviewExpectationLines(plan: SessionPlanContext): string[] {
  const lines: string[] = [];
  if (plan.expectedValidation.trim()) lines.push(`- 验证要求：${plan.expectedValidation.trim()}`);
  if (plan.reviewGuide.trim()) lines.push(`- Review 指引：${plan.reviewGuide.trim()}`);
  const expectations = Array.isArray(plan.actionBundle.reviewExpectations) ? plan.actionBundle.reviewExpectations : [];
  for (const item of expectations) {
    const record = objectRecord(item);
    const text = stringValue(record?.description) ?? stringValue(record?.summary) ?? stringValue(record?.command);
    if (text?.trim()) lines.push(`- ${text.trim()}`);
  }
  return lines;
}

function findWaitingReview(events: AgentEvent[], runId?: string): SessionReviewContext | null {
  const active = findActiveDriverInteraction(events);
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
      sessionId: event.sessionId,
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

function reviewAlreadyResolved(events: AgentEvent[], review: SessionReviewContext): boolean {
  return events.some((event) => {
    if (event.kind !== 'review_summary') return false;
    const payload = objectRecord(event.payload);
    if (!payload) return false;
    const status = stringValue(payload.status);
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
    return stringValue(payload.runId) === review.runId &&
      (stringValue(payload.reviewId) === review.reviewId || stringValue(payload.sourcePlanId) === review.sourcePlanId);
  });
}

function reviewDecisionEvent(
  sessionId: string,
  review: SessionReviewContext,
  status: 'accepted' | 'needsRevision' | 'rejected',
  content: string,
  continuationRequested: boolean,
  ts: string,
  id: string
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind: 'review_summary',
    payload: {
      title: '审查',
      summary: status === 'accepted'
        ? '用户已通过 Review，本批次结束。'
        : status === 'rejected'
          ? '用户已忽略 Review，本轮会话已中止。'
          : '用户要求补充或修改。',
      content,
      status,
      runId: review.runId,
      reviewId: review.reviewId,
      sourcePlanId: review.sourcePlanId,
      confirmable: false,
      continuationRequested,
      continuationCount: review.continuations.length,
      continuations: review.continuations,
      channel: status === 'accepted' ? 'progress' : 'final',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function acceptedReviewContent(review: SessionReviewContext, terminalAcceptedPlan = false): string {
  const lines = [
    '## Review 已通过',
    '',
    '用户已通过当前批次 Review；Kernel facts 已作为本批次事实源保留。',
    '',
    '### 后续意图',
  ];
  if (terminalAcceptedPlan) {
    lines.push('- 已确认 implementationPlan 的任务清单已经完成；即使旧 actionBundle 带有 continuationExpectations，本次 Review 通过也会结束当前 run，不会自动发起新 Plan。');
  } else if (!review.continuations.length) {
    lines.push('- 当前计划没有登记后续批次。');
  } else {
    lines.push(`- 当前计划登记了 ${review.continuations.length} 个后续意图。Review 通过会按 agent.reviewContinuationMode 设置决定是否生成下一批 Plan；新 Plan 仍需确认，确认后的合规 actionBundle 会自动提交 Kernel 执行。`);
    for (const continuation of review.continuations.slice(0, 6)) lines.push(`- ${continuationSummary(continuation)}`);
  }
  lines.push('', '### 决策边界', '- Review 通过只关闭当前批次。', '- 后续批次只能重新生成 Plan；新 Plan 经用户确认后，范围内 actionBundle 由 Session 自动提交 Kernel 执行。');
  return lines.join('\n');
}

function reviewIsTerminalAcceptedPlan(events: AgentEvent[], review: SessionReviewContext): boolean {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'workflow_stage') continue;
    const payload = objectRecord(event.payload);
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

function kernelReviewGateStatus(kernelEvents: unknown[] | undefined): string | undefined {
  for (const event of [...(kernelEvents ?? [])].reverse()) {
    const record = objectRecord(event);
    if (stringValue(record?.kind) !== 'review_gate.evaluated') continue;
    const result = objectRecord(record?.result);
    const status = stringValue(result?.status);
    if (status) return status;
  }
  return undefined;
}

function reviewContinuationRequest(review: SessionReviewContext): string {
  const continuations = review.continuations.map(continuationSummary).filter(Boolean);
  return [
    '根据当前批次 Review 已通过的事实，继续规划下一批可审查 Plan。',
    '这是一轮 Review accept 后的 continuation planning，不是已授权执行。',
    '上一批 Plan 和 continuation expectations 只是 intentContext；只有 Kernel facts、ToolCompleted(ok=true)、WorkUnitCompleted 或 ResourcePacket 才能作为已生成文件事实。',
    review.content ? `上一批 Review 卡内容：\n${review.content}` : '',
    review.facts.length ? `上一批 Kernel facts：\n${review.facts.join('\n')}` : '上一批 Kernel facts：当前 Review 没有登记可复用事实。',
    review.userPlan ? `上一批 Plan intent：\n${review.userPlan}` : '',
    continuations.length ? `后续批次意图：\n${continuations.map((item) => `- ${item}`).join('\n')}` : '后续批次意图：当前没有登记后续批次。',
    [
      '下一步要求：',
      '- 如需基于现有代码继续修改，先用 resourceRequest kind="search" 或 file/range 读取相关文件事实。',
      '- 然后输出新的详细 Agent Protocol v3 actionBundle。',
      '- 每个 workspace.write/create/patch action 必须引用本轮 codeBlocks 的 sourceBlockId 或 replacementBlockId；patch 必须包含 patchSpec.match.kind="exactBlock" 和当前 ResourcePacket 证据中的 exact text。',
      '- workspace.delete action 必须使用 kind="delete"、capability="workspace.delete"、明确相对文件 targetPath/resourceScope；不得使用 codeBlocks/sourceBlockId、空内容写入或 workspace.write 伪装删除。',
      '- 新 Plan 必须等待用户确认，不要假定已经执行。',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function implementationPlanExecutionRequest(
  plan: SessionPlanContext,
  acceptedPlan: AcceptedImplementationPlanContext,
  guidance?: string
): string {
  const planJson = JSON.stringify(plan.implementationPlan ?? {}, null, 2);
  const currentTask = acceptedPlan.tasks[Math.max(0, acceptedPlan.batchIndex - 1)];
  return [
    '用户已接受 implementationPlan。现在进入 Edit 阶段，生成下一批可自动执行 actionBundle。',
    'implementationPlan 是 intent/checklist，不是执行事实；不得声称文件已创建、测试已通过或权限已授予。',
    '选择当前任务清单中的下一组相关工作，允许在同一个 actionBundle 中输出多个相关文件或动作；不要一次性输出整个大型项目。',
    currentTask
      ? `当前任务：taskId=${currentTask.taskId}; title=${currentTask.title ?? '未命名'}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; capability=${currentTask.capability ?? 'none'}。`
      : '当前任务无法从 batchIndex 唯一定位；请输出最小合规 actionBundle，或返回 decisionRequest/implementationPlan 修订。',
    acceptedPlan.completedTaskIds.length
      ? `已完成 taskId：${acceptedPlan.completedTaskIds.join(', ')}。不要重复生成已完成任务，除非 Kernel facts 显示失败或用户要求修订。`
      : '当前 accepted implementationPlan 尚无已完成任务。',
    acceptedPlan.executionRoot
      ? `primary root：${acceptedPlan.executionRoot.ref}。所有 targetPath、resourceScope、codeBlock.path/codeBlock.targetPath 必须相对该 root，例如 include/MemoryPool.h；禁止绝对路径、禁止包含 root 目录名、禁止 ../。`
      : '所有 targetPath、resourceScope、codeBlock.path/codeBlock.targetPath 必须是相对 workspace root 的路径，禁止绝对路径和 ../。',
    '该 actionBundle 如果落在 accepted implementationPlan 的 target/capability 范围内，会由 Session 直接提交 Kernel 执行，不会再次展示 Plan 确认卡。',
    '不要重新询问 implementationPlan 中已经确认的技术路线、目录结构、Docker/script workflow、模块拆分或验证策略。',
    '如果发现必须新增 target/capability，或缺少关键技术选择，请返回 kind="decisionRequest" 或 kind="implementationPlan" 修订，而不是输出超范围 actionBundle。',
    '本轮 actionBundle 必须包含具体 codeBlocks/commandBlocks（如需要）和 Kernel 可审查的 validationExpectations/reviewExpectations。',
    '修改已有文件时，先使用 resourceRequest kind="search" 或 file/range 读取当前锚点；patch action 必须包含 patchSpec.match.kind="exactBlock" 和从当前 ResourcePacket fileText/searchResults 复制的非空 patchSpec.match.text。',
    '删除文件时必须输出 workspace.delete action：kind="delete"、capability="workspace.delete"、targetPath/resourceScope 为已确认任务范围内的相对文件路径；删除 action 不需要也不得引用 codeBlocks/sourceBlockId。',
    '不要一次性输出整个项目源码；剩余任务放入 actionBundle.continuationExpectations，Session 会在 Kernel facts 返回后继续后续 checkpoint。',
    guidance?.trim() ? `用户确认计划时补充的 guidance：\n${guidance.trim()}` : '',
    `Accepted implementationPlan:\n${planJson}`,
  ].filter(Boolean).join('\n\n');
}

function reviewRevisionRequest(review: SessionReviewContext, guidance?: string): string {
  const continuations = review.continuations.map(continuationSummary).filter(Boolean);
  return [
    '根据用户 Review 修订意见，重新理解需求并生成下一批可审查 Plan。',
    '这是一轮 Review revise，不是 Review accept；不得把用户修订意见当成已授权执行。',
    '上一批 Plan、Review guidance、continuation expectations 都是 intentContext；只有 Kernel facts、ToolCompleted(ok=true)、WorkUnitCompleted 或 ResourcePacket 才能作为已生成文件事实。',
    guidance?.trim() ? `用户 Review 修订意见：\n${guidance.trim()}` : '用户 Review 修订意见：用户要求补充或修改当前批次。',
    review.content ? `上一批 Review 卡内容：\n${review.content}` : '',
    review.facts.length ? `上一批 Kernel facts：\n${review.facts.join('\n')}` : '上一批 Kernel facts：当前 Review 没有登记可复用事实。',
    review.userPlan ? `上一批 Plan intent：\n${review.userPlan}` : '',
    continuations.length ? `上一批 continuation intent：\n${continuations.map((item) => `- ${item}`).join('\n')}` : '',
    [
      '下一步要求：',
      '- 如需基于现有代码继续修改，先用 resourceRequest kind="search" 或 file/range 读取相关文件事实，例如构建脚本、入口源码、头文件、测试或容器配置。',
      '- 然后输出新的详细 Agent Protocol v3 actionBundle。',
      '- 每个 workspace.write/create/patch action 必须引用本轮 codeBlocks 的 sourceBlockId 或 replacementBlockId；patch 必须包含 patchSpec.match.kind="exactBlock" 和当前 ResourcePacket 证据中的 exact text。',
      '- workspace.delete action 必须使用 kind="delete"、capability="workspace.delete"、明确相对文件 targetPath/resourceScope；不得使用 codeBlocks/sourceBlockId、空内容写入或 workspace.write 伪装删除。',
      '- 新 Plan 等待用户确认，不要假定已经执行。',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function continuationSummary(value: unknown): string {
  const record = objectRecord(value);
  return stringValue(record?.title) ?? stringValue(record?.description) ?? stringValue(record?.id) ?? clipJson(value, 160);
}

function continuationDecisionPromptEvent(sessionId: string, review: SessionReviewContext, ts: string, id: string): AgentEvent {
  const continuations = review.continuations.map(continuationSummary).filter(Boolean);
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      title: '后续批次确认',
      content: [
        '## 后续批次确认',
        '',
        '当前批次 Review 已通过，计划中登记了后续意图。当前设置要求先询问用户是否继续生成下一批 Plan。',
        '',
        continuations.length ? continuations.map((item) => `- ${item}`).join('\n') : '- 当前没有可展示的后续意图。',
        '',
        '如需继续，请在输入框描述下一步；系统会重新组装 Kernel facts 并生成新的 Plan，仍不会自动执行。',
      ].join('\n'),
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function traceEvent(
  sessionId: string,
  kind: AgentEvent['kind'],
  summary: string,
  ts: string,
  id: string,
  extra: Record<string, unknown>
): AgentEvent {
  return {
    id,
    sessionId,
    ts,
    kind,
    payload: {
      title: 'Session decision',
      summary,
      status: 'noop',
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'collapsible',
      ...extra,
    },
  };
}

function collectQueuedUserGuidanceEvents(events: AgentEvent[], runId?: string): UserGuidanceEvent[] {
  const consumedIds = new Set<string>();
  for (const event of events.slice(-120)) {
    if (event.kind !== 'user_guidance') continue;
    const payload = objectRecord(event.payload);
    if (!payload || stringValue(payload.status) !== 'consumed') continue;
    consumedIds.add(stringValue(payload.guidanceId) ?? event.id);
  }

  const collected: UserGuidanceEvent[] = [];
  const seen = new Set<string>();
  for (const event of events.slice(-80)) {
    if (event.kind !== 'user_guidance') continue;
    const payload = objectRecord(event.payload);
    if (!payload || stringValue(payload.status) === 'consumed') continue;
    const eventRunId = stringValue(payload.targetRunId) ?? stringValue(payload.runId);
    if (runId && eventRunId && eventRunId !== runId) continue;
    const guidanceId = stringValue(payload.guidanceId) ?? event.id;
    if (consumedIds.has(guidanceId) || seen.has(guidanceId)) continue;
    const content = stringValue(payload.content) ?? stringValue(payload.guidance) ?? stringValue(payload.summary);
    if (!content) continue;
    seen.add(guidanceId);
    collected.push({
      id: guidanceId,
      ts: event.ts,
      content: clip(content, 600),
      source: 'user',
      checkpointKind: 'nextProviderCall',
    });
  }
  return collected.slice(-8);
}

type DriverInteraction =
  | { kind: 'review'; runId: string }
  | { kind: 'plan'; runId: string; planId: string }
  | { kind: 'requirement'; runId: string; requirementId: string };

function findActiveDriverInteraction(events: AgentEvent[]): DriverInteraction | null {
  const review = findLatestActiveReviewInteraction(events);
  if (review) return review;
  const plan = findLatestActivePlanInteraction(events);
  if (plan) return plan;
  return findLatestActiveRequirementInteraction(events);
}

function findLatestActiveReviewInteraction(events: AgentEvent[]): DriverInteraction | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'review_summary') continue;
    const payload = objectRecord(event.payload);
    if (!payload || stringValue(payload.status) !== 'waitingUserReview') continue;
    if (hasLaterTerminalInteraction(events, index)) continue;
    const runId = stringValue(payload.runId);
    if (!runId) continue;
    const review: SessionReviewContext = {
      sessionId: event.sessionId,
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
    };
    if (reviewAlreadyResolved(events, review)) continue;
    return { kind: 'review', runId };
  }
  return null;
}

function findLatestActivePlanInteraction(events: AgentEvent[]): DriverInteraction | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'plan_review' && event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload);
    if (!payload) continue;
    if (hasLaterTerminalInteraction(events, index)) continue;
    const waiting = event.kind === 'plan_card'
      ? planCardAwaitingDecision(payload)
      : planReviewEventAwaitingDecision(payload);
    const runId = stringValue(payload.runId);
    const planId = stringValue(payload.planId);
    if (!waiting || !runId || !planId) continue;
    const plan = event.kind === 'plan_card'
      ? planContextFromEvent(event, payload)
      : findPlanCard(events.slice(0, index + 1), runId, planId);
    if (!plan || planAlreadyResolved(events, plan)) continue;
    return { kind: 'plan', runId, planId };
  }
  return null;
}

function planCardAwaitingDecision(payload: Record<string, unknown>): boolean {
  const confirmable = payload.confirmable;
  if (confirmable === false) return false;
  const status = stringValue(payload.status);
  if (!status) return true;
  return planReviewStatusAwaitingUser(status);
}

function planReviewEventAwaitingDecision(payload: Record<string, unknown>): boolean {
  if (payload.confirmable === false) return false;
  return planReviewStatusAwaitingUser(stringValue(payload.status));
}

function findLatestActiveRequirementInteraction(events: AgentEvent[]): DriverInteraction | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind !== 'requirement_confirmation') continue;
    const payload = objectRecord(event.payload);
    if (!payload || payload.confirmable !== true) continue;
    if (hasLaterTerminalInteraction(events, index)) continue;
    const runId = stringValue(payload.runId);
    const requirementId = stringValue(payload.requirementId);
    if (!runId || !requirementId || stringValue(payload.status) !== 'waitingUserConfirmation') continue;
    if (requirementAlreadyResolved(events, runId, requirementId)) continue;
    return { kind: 'requirement', runId, requirementId };
  }
  return null;
}

function hasLaterTerminalInteraction(events: AgentEvent[], index: number): boolean {
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

function requirementAlreadyResolved(events: AgentEvent[], runId: string, requirementId: string): boolean {
  return events.some((event) => {
    if (event.kind !== 'requirement_decision') return false;
    const payload = objectRecord(event.payload);
    if (!payload) return false;
    const status = stringValue(payload.status);
    if (status !== 'accepted' && status !== 'rejected' && status !== 'needsRevision') return false;
    return stringValue(payload.runId) === runId && stringValue(payload.requirementId) === requirementId;
  });
}

function findRequirementConfirmation(events: AgentEvent[], runId?: string, requirementId?: string): AgentEvent | null {
  const active = findActiveDriverInteraction(events);
  if (
    !active ||
    active.kind !== 'requirement' ||
    (runId && active.runId !== runId) ||
    (requirementId && active.requirementId !== requirementId)
  ) {
    return null;
  }
  return [...events].reverse().find((event) => {
    if (event.kind !== 'requirement_confirmation') return false;
    const payload = objectRecord(event.payload);
    if (!payload || payload.confirmable !== true) return false;
    if (runId && stringValue(payload.runId) !== runId) return false;
    if (requirementId && stringValue(payload.requirementId) !== requirementId) return false;
    return stringValue(payload.status) === 'waitingUserConfirmation';
  }) ?? null;
}

function requirementDecisionEvent(
  sessionId: string,
  event: AgentEvent,
  decision: 'accept' | 'reject' | 'revise',
  guidance: string | undefined,
  ts: string,
  id: string
): AgentEvent {
  const payload = objectRecord(event.payload) ?? {};
  const decisionRequest = objectRecord(payload.decisionRequest);
  const selectedOption = decision === 'accept'
    ? selectedDecisionOptionFromGuidance(decisionRequest, guidance)
    : undefined;
  const language = visibleLanguageForRequest(stringValue(payload.originalUserRequest) ?? '');
  const summary = requirementDecisionSummary(decision, selectedOption, language);
  return {
    id,
    sessionId,
    ts,
    kind: 'requirement_decision',
    payload: {
      title: 'Requirement decision',
      summary,
      status: decision === 'accept' ? 'accepted' : decision === 'revise' ? 'needsRevision' : 'rejected',
      runId: stringValue(payload.runId),
      requirementId: stringValue(payload.requirementId),
      decision,
      guidance,
      selectedOption,
      channel: 'progress',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function requirementDecisionSummary(
  decision: 'accept' | 'reject' | 'revise',
  selectedOption: RequirementDecisionOption | undefined,
  language: VisibleLanguage
): string {
  if (language === 'en-US') {
    if (decision === 'accept' && selectedOption?.label) return `Selected option: ${selectedOption.label}`;
    if (decision === 'accept') return 'The user confirmed the requirement understanding.';
    if (decision === 'revise') return 'The user requested requirement revisions.';
    return 'The user rejected the current requirement understanding.';
  }
  if (decision === 'accept' && selectedOption?.label) return `已选择方案：${selectedOption.label}`;
  if (decision === 'accept') return '用户已确认需求理解。';
  if (decision === 'revise') return '用户要求修订需求理解。';
  return '用户拒绝当前需求理解。';
}

interface RequirementDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

function isDecisionRequestPayload(value: Record<string, unknown> | undefined): boolean {
  return decisionRequestOptions(value).length >= 2;
}

function decisionRequestSummary(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  return stringValue(value.summary)
    ?? stringValue(value.question)
    ?? stringValue(value.reason)
    ?? stringValue(value.goal);
}

function decisionRequestOptions(value: Record<string, unknown> | undefined): RequirementDecisionOption[] {
  if (!Array.isArray(value?.options)) return [];
  return value.options.flatMap((item): RequirementDecisionOption[] => {
    const record = objectRecord(item);
    if (!record) return [];
    const id = stringValue(record.id) ?? stringValue(record.label);
    const label = stringValue(record.label) ?? id;
    if (!id || !label) return [];
    const description = stringValue(record.description)
      ?? stringValue(record.impact)
      ?? stringValue(record.tradeoff);
    return [{
      id,
      label,
      description,
      recommended: record.recommended === true,
    }];
  });
}

function selectedDecisionOptionFromGuidance(
  decisionRequest: Record<string, unknown> | undefined,
  guidance: string | undefined
): RequirementDecisionOption | undefined {
  const options = decisionRequestOptions(decisionRequest);
  if (!options.length) return undefined;
  const selectedId = guidance?.match(/^- id:\s*(.+)$/m)?.[1]?.trim();
  const selectedLabel = guidance?.match(/^- label:\s*(.+)$/m)?.[1]?.trim();
  return (selectedId ? options.find((option) => option.id === selectedId) : undefined)
    ?? (selectedLabel ? options.find((option) => option.label === selectedLabel) : undefined)
    ?? options.find((option) => option.recommended)
    ?? options[0];
}

function requirementRecordFromEvent(event: AgentEvent, status: RequirementRecord['status']): RequirementRecord | undefined {
  const payload = objectRecord(event.payload);
  const raw = objectRecord(payload?.requirement);
  if (!raw) return undefined;
  const checklist = objectRecord(raw.checklist);
  return {
    requirementId: stringValue(raw.requirementId) ?? stringValue(payload?.requirementId) ?? event.id,
    sessionId: stringValue(raw.sessionId) ?? event.sessionId,
    initialUserRequest: stringValue(raw.initialUserRequest) ?? stringValue(payload?.initialUserRequest) ?? stringValue(payload?.originalUserRequest) ?? '',
    checklist: checklist ? {
      goal: stringValue(checklist.goal) ?? '',
      explicitTasks: stringArray(checklist.explicitTasks),
      inferredTasks: stringArray(checklist.inferredTasks),
      outOfScope: stringArray(checklist.outOfScope),
      affectedAreaCandidates: stringArray(checklist.affectedAreaCandidates),
      resourceRequests: stringArray(checklist.resourceRequests),
      acceptanceCriteriaCandidates: stringArray(checklist.acceptanceCriteriaCandidates),
      clarificationQuestions: stringArray(checklist.clarificationQuestions),
      riskNotes: stringArray(checklist.riskNotes),
    } satisfies RequirementChecklist : undefined,
    status,
    createdAt: stringValue(raw.createdAt) ?? event.ts,
    updatedAt: new Date().toISOString(),
  };
}

function requirementOriginalRequest(event: AgentEvent): string {
  const payload = objectRecord(event.payload);
  return stringValue(payload?.originalUserRequest) ?? requirementRecordFromEvent(event, 'confirmed')?.initialUserRequest ?? '';
}

function requirementAttachments(event: AgentEvent): AgentContextAttachment[] {
  const payload = objectRecord(event.payload);
  return Array.isArray(payload?.attachments)
    ? payload.attachments.filter((item): item is AgentContextAttachment => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'item';
}

function clipJson(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return clip(text ?? '', maxChars);
}

function repairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  invalidOutput: string,
  parseError: { code: string; message: string }
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'Do not add execution facts, permissions, or tool results.',
        'Repair once using the original request context, ResourcePacket facts, invalid output, and parser error.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        `Parser error code: ${parseError.code}`,
        `Parser error message: ${parseError.message}`,
        'Invalid model output:',
        fenced(invalidOutput),
      ].join('\n\n'),
    },
  ];
}

function actionBundleCompactionRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  reason: string,
  invalidOutput: string
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 implementation batch repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'If proposing executable work, return kind="actionBundle" for only the next small reviewable implementation batch.',
        `Batch budget: at most ${MAX_ACTION_BUNDLE_CODE_BLOCKS} codeBlocks, at most ${MAX_ACTION_BUNDLE_ACTIONS} actions, at most ${MAX_ACTION_BUNDLE_TOTAL_CODE_BYTES} bytes total codeBlock content, and at most ${MAX_ACTION_BUNDLE_CODE_BLOCK_BYTES} bytes per codeBlock.`,
        'Put remaining work into actionBundle.continuationExpectations; do not emit the full implementation in one response.',
        'If current facts are insufficient, return kind="resourceRequest" using manifestEntryId, rootId+path, or kind="search" with a non-empty query under the listed conversation roots.',
        'Do not claim execution, permissions, tests passed, or task completion.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        'Implementation batch context:',
        fenced(JSON.stringify(state.implementationBatch, null, 2)),
        `Repair reason: ${reason}`,
        'Invalid or empty model output:',
        fenced(invalidOutput || '[empty response]'),
      ].join('\n\n'),
    },
  ];
}

function sideEffectNativeToolRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  toolCall: NativeToolCallProposal,
  turn: LlmTurnResult
): LlmChatRequest['messages'] {
  const afterAcceptedPlan = Boolean(state.acceptedImplementationPlan) || state.implementationBatch.batchIndex > 1;
  const requestedKind = afterAcceptedPlan ? 'actionBundle' : 'decisionRequest-or-implementationPlan';
  const guardrail = afterAcceptedPlan
    ? 'A plan has already been accepted. Return kind="actionBundle" for the next related automatically executable batch within the accepted plan scope. Multiple related files are allowed when all target paths stay in scope. Use relative target paths only.'
    : 'No implementation plan has been accepted for this side-effect work. Return kind="decisionRequest" if a material engineering choice needs user selection; otherwise return kind="implementationPlan".';
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 native-tool repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'Provider-native side-effect tools are disabled in Session Runtime. Do not call tools.',
        guardrail,
        'Never claim that files were written, commands ran, permissions were granted, or validation passed.',
        'If returning decisionRequest, ask one concise question with 2-3 mutually exclusive options, exactly one recommended option, impact descriptions, allowsFreeform=true, and user-visible text in the current user language.',
        'If returning implementationPlan, include task checklist, targets, capabilities, acceptanceCriteria, and failureCriteria; do not include codeBlocks, commandBlocks, patches, or full source code.',
        'If returning actionBundle, include only a small reviewable batch with codeBlocks or commandBlocks and concrete validationExpectations/reviewExpectations.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Requested repair kind: ${requestedKind}`,
        `Blocked native tool: ${toolCall.name}`,
        `Tool call id: ${toolCall.callId}`,
        'Tool arguments:',
        fenced(JSON.stringify(toolCall.arguments, null, 2)),
        'Provider narration before blocked tool:',
        fenced(turn.content || '[empty]'),
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        'Implementation batch context:',
        fenced(JSON.stringify(state.implementationBatch, null, 2)),
      ].join('\n\n'),
    },
  ];
}

function resourceRequestRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  resolution: ResourceRequestResolution
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 resource request repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'Use kind="answer" if the available ResourcePacket facts are enough.',
        'Use kind="resourceRequest" only when requesting manifestEntryId, root-relative path, or kind="search" with a non-empty query under the listed conversation roots.',
        'Do not invent arbitrary absolute local paths.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        'Invalid or unresolved resourceRequest proposal:',
        fenced(JSON.stringify(proposal.payload, null, 2)),
        'Resolution diagnostic:',
        fenced(resourceResolutionDiagnostic(resolution)),
      ].join('\n\n'),
    },
  ];
}

function planReviewRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  report: Record<string, unknown>
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 plan review repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'Repair the actionBundle so Kernel PlanReview can evaluate concrete completion evidence.',
        'Do not claim execution, permissions, tests passed, or task completion.',
        'Do not add capabilities or expand scope unless the Kernel report explicitly requires it.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        'Original ProposalEnvelope:',
        fenced(JSON.stringify(proposal, null, 2)),
        'Kernel PlanReview report:',
        fenced(JSON.stringify(report, null, 2)),
        'Repair requirement:',
        fenced('For side-effect actions, include a detailed structured Markdown userPlan. It must cover summary, changes, interfaces or affected surfaces, validation or test plan, and assumptions or constraints; headings may be localized to the user language. Include non-empty actionBundle.validationExpectations and actionBundle.reviewExpectations. Each validation expectation must describe evidence Kernel or the user can inspect after execution.'),
      ].join('\n\n'),
    },
  ];
}

function acceptedPlanScopeRepairMessages(
  prompt: PromptEnvelope,
  state: SessionDriverLoopRunState,
  proposal: ProposalEnvelope,
  validation: AcceptedPlanBatchValidationResult
): LlmChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You are the DeepCode Agent Protocol v3 accepted-plan scope repair step.',
        'Return exactly one valid JSON object using schemaVersion "deepcode.agent.protocol.v3".',
        'A user has already accepted an implementationPlan. Repair the current batch so it stays inside the accepted task targets and capabilities.',
        'If executable work is still valid, return kind="actionBundle" with one related implementation batch. Multiple related files are allowed when all targets are inside the accepted plan.',
        'If a patch needs current file evidence, return kind="resourceRequest" with kind="search" or a focused file/range read under the conversation roots; Session will resolve it and resume the accepted plan.',
        'Patch actions must use patchSpec.match.kind="exactBlock" and patchSpec.match.text copied from current ResourcePacket fileText/searchResults evidence.',
        'If the accepted plan is missing a required target, capability, or material technical choice, return kind="decisionRequest" or kind="implementationPlan" revision.',
        'Do not claim execution, permissions, tests passed, or task completion.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original stable prompt:',
        fenced(prompt.stablePrefix),
        'Original dynamic prompt:',
        fenced(prompt.dynamicSuffix),
        'ResourcePacket facts:',
        fenced(JSON.stringify(state.resourcePackets, null, 2)),
        'Accepted implementationPlan:',
        fenced(JSON.stringify(state.acceptedImplementationPlan?.rawPlan ?? {}, null, 2)),
        'Invalid ProposalEnvelope:',
        fenced(JSON.stringify(proposal, null, 2)),
        'Session validation reasons:',
        fenced(validation.reasons.map((reason) => `- ${reason}`).join('\n')),
        'Repair requirement:',
        fenced('Return a corrected actionBundle within the accepted plan scope. If current patch evidence is missing, return resourceRequest search/read first. Return decisionRequest/implementationPlan revision only if scope expansion is truly required.'),
      ].join('\n\n'),
    },
  ];
}

function shouldRequestRequirementConfirmation(
  input: SessionDriverLoopInput,
  _state: SessionDriverLoopRunState
): boolean {
  if (input.confirmedRequirement) return false;
  const mode = input.requirementConfirmationMode ?? 'auto';
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return false;
}

function requirementRecordFromProposal(
  proposal: ProposalEnvelope,
  input: SessionDriverLoopInput,
  state: SessionDriverLoopRunState,
  timestamp: string
): RequirementRecord {
  const draft = objectRecord(proposal.payload) ?? {};
  const requirementId = stringValue(draft.requirementId)
    ?? stringValue(draft.id)
    ?? proposal.proposalId
    ?? `requirement-${state.runId}`;
  const checklist: RequirementChecklist = {
    goal: stringValue(draft.goal) ?? stringValue(draft.summary) ?? stringValue(draft.reason) ?? input.content,
    explicitTasks: stringArrayValue(draft.scope)
      .concat(stringArrayValue(draft.explicitTasks))
      .filter(Boolean),
    inferredTasks: stringArrayValue(draft.inferredTasks)
      .concat(stringArrayValue(draft.constraints))
      .filter(Boolean),
    outOfScope: stringArrayValue(draft.outOfScope).concat(stringArrayValue(draft.nonGoals)),
    affectedAreaCandidates: stringArrayValue(draft.affectedAreas)
      .concat(stringArrayValue(draft.affectedAreaCandidates)),
    resourceRequests: stringArrayValue(draft.resourceRequests),
    acceptanceCriteriaCandidates: stringArrayValue(draft.acceptanceCriteria)
      .concat(stringArrayValue(draft.acceptanceCriteriaCandidates)),
    clarificationQuestions: stringArrayValue(draft.openQuestions)
      .concat(stringArrayValue(draft.clarificationQuestions)),
    riskNotes: stringArrayValue(draft.risks).concat(stringArrayValue(draft.riskNotes)),
  };
  return {
    requirementId,
    sessionId: state.sessionId,
    initialUserRequest: input.content,
    checklist,
    status: 'probing',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function requirementConfirmationEvent(input: {
  sessionId: string;
  runId: string;
  requirement: RequirementRecord;
  proposal: ProposalEnvelope;
  originalUserRequest: string;
  attachments: AgentContextAttachment[];
  ts: string;
  id: string;
}): AgentEvent {
  const decisionRequest = objectRecord(input.proposal.payload);
  const language = visibleLanguageForRequest(input.originalUserRequest);
  const content = decisionRequest && isDecisionRequestPayload(decisionRequest)
    ? renderDecisionRequestMarkdown(decisionRequest, language)
    : renderRequirementConfirmationMarkdown(input.requirement);
  const summary = decisionRequestSummary(decisionRequest) ?? requirementSummary(input.requirement);
  return {
    id: input.id,
    sessionId: input.sessionId,
    ts: input.ts,
    kind: 'requirement_confirmation',
    payload: {
      title: '用户介入请求',
      summary,
      content,
      status: 'waitingUserConfirmation',
      confirmable: true,
      runId: input.runId,
      requirementId: input.requirement.requirementId,
      requirement: input.requirement,
      decisionRequest: input.proposal.payload,
      proposalId: input.proposal.proposalId,
      originalUserRequest: input.originalUserRequest,
      attachments: input.attachments,
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
}

function isResourceBudgetConfirmation(event: AgentEvent): boolean {
  const payload = objectRecord(event.payload);
  const requirementId = stringValue(payload?.requirementId);
  return Boolean(requirementId?.startsWith(`${RESOURCE_BUDGET_REQUIREMENT_PREFIX}-`));
}

function renderRequirementConfirmationMarkdown(requirement: RequirementRecord): string {
  const checklist = requirement.checklist;
  const sections = [
    ['目标', checklist?.goal ? [checklist.goal] : []],
    ['范围', checklist?.explicitTasks ?? []],
    ['非目标', checklist?.outOfScope ?? []],
    ['约束', checklist?.inferredTasks ?? []],
    ['风险点', checklist?.riskNotes ?? []],
    ['验收标准', checklist?.acceptanceCriteriaCandidates ?? []],
    ['仍不明确的问题', checklist?.clarificationQuestions ?? []],
  ] as const;
  return sections
    .map(([heading, items]) => {
      const body = items.length
        ? items.map((item) => `- ${item}`).join('\n')
        : '- 暂无。';
      return `## ${heading}\n${body}`;
    })
    .join('\n\n');
}

function renderDecisionRequestMarkdown(
  decisionRequest: Record<string, unknown>,
  language: VisibleLanguage
): string {
  const options = decisionRequestOptions(decisionRequest);
  const summary = decisionRequestSummary(decisionRequest);
  const labels = language === 'en-US'
    ? {
      heading: 'Decision needed',
      options: 'Options',
      recommended: 'recommended',
      supplement: 'Supplemental input',
      supplementText: 'Use the input box to choose an option or add constraints before continuing.',
    }
    : {
      heading: '需要确认的选择',
      options: '可选方案',
      recommended: '推荐',
      supplement: '补充信息',
      supplementText: '可在输入框选择方案编号，或补充约束后再继续。',
    };
  const lines = [`## ${labels.heading}`];
  if (summary) lines.push('', summary);
  lines.push('', `## ${labels.options}`, '');
  options.forEach((option, index) => {
    const recommended = option.recommended ? `（${labels.recommended}）` : '';
    lines.push(`${index + 1}. ${option.label}${recommended}`);
    if (option.description) lines.push(`   ${option.description}`);
  });
  lines.push('', `## ${labels.supplement}`, '', labels.supplementText);
  return lines.join('\n');
}

function requirementSummary(requirement: RequirementRecord): string {
  return requirement.checklist?.goal || requirement.initialUserRequest;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeParseError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentPlanParseError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'parse_failed', message: error.message };
  return { code: 'parse_failed', message: String(error) };
}

function collectReasoning(result: LlmChatResult): string {
  const chunks = result.chunks
    .filter((chunk) => chunk.type === 'reasoning_delta' && typeof chunk.content === 'string')
    .map((chunk) => chunk.content)
    .join('');
  return result.assistantMessage?.reasoningContent ?? chunks;
}

function proposalNarrationEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent | null {
  if (proposal.source !== 'llm') return null;
  if (proposal.kind === 'answer') return null;
  const content = proposal.narration?.trim();
  if (!content) return null;
  return {
    id,
    sessionId,
    ts,
    kind: 'assistant_msg',
    payload: {
      content,
      channel: 'progress',
      source: 'llm',
      visibility: 'conversation',
      presentation: 'body',
      label: 'DeepCode',
      proposalId: proposal.proposalId,
    },
  };
}

function planInitialUserRequest(plan: SessionPlanContext): string {
  return plan.userPlan;
}

function cacheTelemetryEvent(
  sessionId: string,
  profileId: string | undefined,
  state: SessionDriverLoopRunState,
  stage: string,
  result: LlmChatResult,
  ts: string,
  id: string
): AgentEvent | null {
  const usage = objectRecord(result.usage);
  const normalized = normalizeProviderUsage(usage);
  const promptSegmentDigests = state.contextAssembly?.segments.map((segment) => ({
    id: segment.id,
    name: segment.name,
    cacheClass: segment.cacheClass,
    stablePrefix: segment.stablePrefix,
    auditOnly: segment.auditOnly,
    contentHash: segment.contentHash,
    charLength: segment.charLength,
  })) ?? [];
  if (
    normalized.promptCacheHitTokens === undefined &&
    normalized.promptCacheMissTokens === undefined &&
    normalized.cachedTokens === undefined &&
    normalized.promptTokens === undefined &&
    normalized.completionTokens === undefined &&
    normalized.totalTokens === undefined &&
    promptSegmentDigests.length === 0
  ) {
    return null;
  }

  return {
    id,
    sessionId,
    ts,
    kind: 'cache_telemetry',
    payload: {
      provider: profileId ?? state.contextAssembly?.provider ?? 'unknown',
      providerProfileId: profileId,
      model: state.contextAssembly?.model,
      stage,
      promptCacheHitTokens: normalized.promptCacheHitTokens,
      promptCacheMissTokens: normalized.promptCacheMissTokens,
      cachedTokens: normalized.cachedTokens,
      promptTokens: normalized.promptTokens,
      completionTokens: normalized.completionTokens,
      totalTokens: normalized.totalTokens,
      normalizedUsage: normalized,
      rawUsage: usage,
      promptSegmentDigests,
      stablePrefixHash: state.contextAssembly?.stablePrefixHash,
      dynamicSuffixHash: state.contextAssembly?.dynamicSuffixHash,
      cacheHash: state.contextAssembly?.cacheHash,
      cacheAffectsCorrectness: false,
    },
  };
}

function normalizeProviderUsage(usage: Record<string, unknown> | undefined): Record<string, number | undefined> {
  const promptTokens = numberValue(usage?.prompt_tokens) ?? numberValue(usage?.input_tokens);
  const completionTokens = numberValue(usage?.completion_tokens) ?? numberValue(usage?.output_tokens);
  const totalTokens = numberValue(usage?.total_tokens)
    ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
  const cachedTokens = numberValue(usage?.cached_tokens)
    ?? numberAtPath(usage, ['prompt_tokens_details', 'cached_tokens'])
    ?? numberAtPath(usage, ['input_tokens_details', 'cached_tokens']);
  const promptCacheHitTokens = numberValue(usage?.prompt_cache_hit_tokens)
    ?? numberValue(usage?.cache_read_input_tokens)
    ?? cachedTokens;
  const promptCacheMissTokens = numberValue(usage?.prompt_cache_miss_tokens)
    ?? numberValue(usage?.cache_creation_input_tokens)
    ?? (promptTokens !== undefined && promptCacheHitTokens !== undefined
      ? Math.max(0, promptTokens - promptCacheHitTokens)
      : undefined);
  return {
    promptCacheHitTokens,
    promptCacheMissTokens,
    cachedTokens,
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function numberAtPath(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    const record = objectRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return numberValue(current);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

type VisibleLanguage = 'zh-CN' | 'en-US';

function visibleLanguageForRequest(userRequest: string): VisibleLanguage {
  return /[\u3400-\u9fff]/.test(userRequest) ? 'zh-CN' : 'en-US';
}

function providerStageSummary(stage: string, phase: 'request' | 'response', language: VisibleLanguage = 'zh-CN'): string {
  const label = stage
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (value) => value.toUpperCase());
  if (language === 'en-US') {
    return phase === 'request'
      ? `${label}: requesting a structured model response.`
      : `${label}: model response received; parsing protocol output.`;
  }
  return phase === 'request'
    ? `${label}: 请求模型生成结构化回复。`
    : `${label}: 模型已返回，等待协议解析。`;
}

function nativeToolResolveRunningSummary(toolName: string, language: VisibleLanguage): string {
  return language === 'en-US'
    ? `${toolName} is being resolved by Kernel ResourceResolve.`
    : `${toolName} 正在通过 Kernel ResourceResolve 解析。`;
}

function nativeToolResolveCompletedSummary(toolName: string, language: VisibleLanguage): string {
  return language === 'en-US'
    ? `Kernel resolved native tool resource for ${toolName}.`
    : `Kernel 已完成 ${toolName} 的原生工具资源解析。`;
}

function providerToolCallPreparingSummary(toolName: string, language: VisibleLanguage): string {
  return language === 'en-US'
    ? `Provider is preparing native tool call ${toolName}.`
    : `Provider 正在准备原生工具调用 ${toolName}。`;
}

function providerToolCallStreamingSummary(language: VisibleLanguage): string {
  return language === 'en-US'
    ? 'Provider is streaming native tool call arguments.'
    : 'Provider 正在流式输出原生工具调用参数。';
}

function providerUsageSummary(language: VisibleLanguage): string {
  return language === 'en-US'
    ? 'Provider usage telemetry received.'
    : '已收到 provider 用量遥测。';
}

function userGuidanceConsumedSummary(language: VisibleLanguage): string {
  return language === 'en-US'
    ? 'User guidance entered the provider resume prompt.'
    : '用户引导已进入 provider resume prompt。';
}

function guidanceRevisionTransitionMessage(language: VisibleLanguage): string {
  return language === 'en-US'
    ? 'I received your update and will merge it into the current response before finalizing.'
    : '收到你的补充，我会把这条引导合并到当前回复里重新整理。';
}

interface ProviderTraceArchiveRecord {
  schemaVersion: 'deepcode.session.provider-trace-archive.v1';
  traceArchiveMode: 'compact';
  stage: string;
  kind: 'request' | 'response' | 'generic';
  request?: {
    profileId?: string;
    messageCount: number;
    totalContentChars: number;
    messages: ProviderTraceMessageDigest[];
    responseFormat?: unknown;
    toolCount: number;
    tools?: ProviderTraceToolDefinitionDigest[];
  };
  response?: {
    usage?: unknown;
    assistantMessage?: ProviderTraceMessageDigest;
    chunkSummary: ProviderTraceChunkSummary;
    toolCalls: ProviderTraceToolCallDigest[];
  };
  payload?: unknown;
  cachePlan?: unknown;
  contextAssembly?: unknown;
  taskGraph?: unknown;
}

interface ProviderTraceToolDefinitionDigest {
  index: number;
  name?: string;
  descriptionHash?: string;
  parameterHash?: string;
}

interface ProviderTraceMessageDigest {
  index?: number;
  role?: string;
  contentCharLength: number;
  contentHash: string;
  contentPreview: string;
  reasoningCharLength?: number;
  reasoningHash?: string;
  toolCallCount?: number;
  toolCalls?: ProviderTraceToolCallDigest[];
  toolCallId?: string;
}

interface ProviderTraceToolCallDigest {
  index?: number;
  id?: string;
  name?: string;
  argumentsCharLength: number;
  argumentsHash: string;
  argumentsPreview: string;
}

interface ProviderTraceChunkSummary {
  chunkCount: number;
  byType: Record<string, number>;
  contentCharLength: number;
  reasoningCharLength: number;
  toolCallDeltaCharLength: number;
  toolCallDeltaCount: number;
  rawProviderCount: number;
  rawProviderCharLength: number;
  usageChunkCount: number;
  finishReasons: string[];
}

function archiveProviderTracePayload(stage: string, payload: unknown): ProviderTraceArchiveRecord {
  const record = objectRecord(payload);
  if (record && (Array.isArray(record.messages) || record.contextAssembly || record.cachePlan || record.taskGraph)) {
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const messageDigests = messages.map((message, index) => providerTraceMessageDigest(message, index));
    return {
      schemaVersion: 'deepcode.session.provider-trace-archive.v1',
      traceArchiveMode: 'compact',
      stage,
      kind: 'request',
      request: {
        profileId: stringValue(record.profileId),
        messageCount: messages.length,
        totalContentChars: messageDigests.reduce((sum, item) => sum + item.contentCharLength, 0),
        messages: messageDigests,
        responseFormat: compactArchiveValue(record.responseFormat),
        toolCount: Array.isArray(record.tools) ? record.tools.length : 0,
        tools: providerTraceToolDefinitions(record.tools),
      },
      cachePlan: compactArchiveValue(record.cachePlan),
      contextAssembly: compactArchiveValue(record.contextAssembly),
      taskGraph: compactArchiveValue(record.taskGraph),
    };
  }

  if (record && (Array.isArray(record.chunks) || record.assistantMessage || record.usage)) {
    const chunks = Array.isArray(record.chunks) ? record.chunks : [];
    return {
      schemaVersion: 'deepcode.session.provider-trace-archive.v1',
      traceArchiveMode: 'compact',
      stage,
      kind: 'response',
      response: {
        usage: compactArchiveValue(record.usage),
        assistantMessage: record.assistantMessage ? providerTraceMessageDigest(record.assistantMessage) : undefined,
        chunkSummary: providerTraceChunkSummary(chunks),
        toolCalls: providerTraceAssistantToolCalls(record.assistantMessage),
      },
    };
  }

  return {
    schemaVersion: 'deepcode.session.provider-trace-archive.v1',
    traceArchiveMode: 'compact',
    stage,
    kind: 'generic',
    payload: compactArchiveValue(payload),
  };
}

function providerTraceMessageDigest(value: unknown, index?: number): ProviderTraceMessageDigest {
  const record = objectRecord(value);
  const content = stringValue(record?.content) ?? compactString(record?.content);
  const reasoning = stringValue(record?.reasoningContent) ?? stringValue(record?.reasoning_content);
  const toolCalls = providerTraceAssistantToolCalls(value);
  return {
    ...(typeof index === 'number' ? { index } : {}),
    role: stringValue(record?.role),
    contentCharLength: content.length,
    contentHash: stableHash(content),
    contentPreview: clip(content, 800),
    ...(reasoning
      ? {
        reasoningCharLength: reasoning.length,
        reasoningHash: stableHash(reasoning),
      }
      : {}),
    ...(toolCalls.length
      ? {
        toolCallCount: toolCalls.length,
        toolCalls,
      }
      : {}),
    ...(stringValue(record?.toolCallId) ? { toolCallId: stringValue(record?.toolCallId) } : {}),
  };
}

function providerTraceAssistantToolCalls(value: unknown): ProviderTraceToolCallDigest[] {
  const record = objectRecord(value);
  const calls = Array.isArray(record?.toolCalls)
    ? record.toolCalls
    : Array.isArray(record?.tool_calls)
      ? record.tool_calls
      : [];
  return calls.map((call, index) => providerTraceToolCallDigest(call, index));
}

function providerTraceToolCallDigest(value: unknown, index?: number): ProviderTraceToolCallDigest {
  const record = objectRecord(value);
  const functionRecord = objectRecord(record?.function);
  const name = stringValue(record?.name) ?? stringValue(functionRecord?.name);
  const rawArguments = record?.arguments ?? functionRecord?.arguments;
  const argumentsText = typeof rawArguments === 'string' ? rawArguments : compactString(rawArguments);
  return {
    ...(typeof index === 'number' ? { index } : {}),
    id: stringValue(record?.id),
    name,
    argumentsCharLength: argumentsText.length,
    argumentsHash: stableHash(argumentsText),
    argumentsPreview: clip(argumentsText, 800),
  };
}

function providerTraceToolDefinitions(value: unknown): ProviderTraceToolDefinitionDigest[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 64).map((tool, index) => {
    const record = objectRecord(tool);
    return {
      index,
      name: stringValue(record?.name),
      descriptionHash: stableHash(stringValue(record?.description) ?? ''),
      parameterHash: stableHash(compactString(record?.inputSchema ?? record?.parameters)),
    };
  });
}

function providerTraceChunkSummary(chunks: unknown[]): ProviderTraceChunkSummary {
  const summary: ProviderTraceChunkSummary = {
    chunkCount: chunks.length,
    byType: {},
    contentCharLength: 0,
    reasoningCharLength: 0,
    toolCallDeltaCharLength: 0,
    toolCallDeltaCount: 0,
    rawProviderCount: 0,
    rawProviderCharLength: 0,
    usageChunkCount: 0,
    finishReasons: [],
  };
  const finishReasons = new Set<string>();
  for (const chunk of chunks) {
    const record = objectRecord(chunk);
    const type = stringValue(record?.type) ?? 'unknown';
    summary.byType[type] = (summary.byType[type] ?? 0) + 1;
    if (type === 'delta') summary.contentCharLength += stringValue(record?.content)?.length ?? 0;
    if (type === 'reasoning_delta') summary.reasoningCharLength += stringValue(record?.content)?.length ?? 0;
    const toolCallDelta = objectRecord(record?.toolCallDelta);
    const argumentsDelta = stringValue(toolCallDelta?.argumentsDelta);
    if (argumentsDelta) {
      summary.toolCallDeltaCount += 1;
      summary.toolCallDeltaCharLength += argumentsDelta.length;
    }
    if (record?.rawProvider !== undefined) {
      summary.rawProviderCount += 1;
      summary.rawProviderCharLength += compactString(record.rawProvider).length;
    }
    if (record?.usage !== undefined) summary.usageChunkCount += 1;
    const finishReason = stringValue(record?.finishReason);
    if (finishReason) finishReasons.add(finishReason);
  }
  summary.finishReasons = [...finishReasons].sort();
  return summary;
}

function compactArchiveValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return clip(value, 4000);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 80).map((item) => compactArchiveValue(item, depth + 1));
    if (value.length > 80) items.push({ omittedItems: value.length - 80 });
    return items;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      output[key] = '[redacted]';
    } else if (key === 'messages' && Array.isArray(item)) {
      output[key] = item.map((message, index) => providerTraceMessageDigest(message, index));
    } else if (key === 'chunks' && Array.isArray(item)) {
      output[key] = providerTraceChunkSummary(item);
    } else if ((key === 'assistantMessage' || key === 'assistant_message') && item && typeof item === 'object') {
      output[key] = providerTraceMessageDigest(item);
    } else if (depth >= 8) {
      output[key] = compactString(item);
    } else {
      output[key] = compactArchiveValue(item, depth + 1);
    }
  }
  return output;
}

function redactForArchive(value: unknown): unknown {
  return compactArchiveValue(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return ['secret', 'apikey', 'api_key', 'authorization', 'password', 'bearer', 'credential', 'cookie', 'token']
    .some((needle) => normalized.includes(needle));
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseProviderPartFrame(raw: string): AgentStreamPartFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = objectRecord(parsed);
  if (!record || record.schemaVersion !== 'deepcode.agent.stream.part.v1') return null;
  const partKind = stringValue(record.partKind);
  if (!partKind || !isAgentStreamPartKind(partKind)) return null;
  return {
    schemaVersion: 'deepcode.agent.stream.part.v1',
    partKind,
    draftId: stringValue(record.draftId),
    frameId: stringValue(record.frameId),
    runId: stringValue(record.runId),
    targetPath: stringValue(record.targetPath),
    language: stringValue(record.language),
    capability: stringValue(record.capability),
    blockId: stringValue(record.blockId),
    actionId: stringValue(record.actionId),
    sequence: typeof record.sequence === 'number' ? record.sequence : undefined,
    chunk: typeof record.chunk === 'string' ? record.chunk : undefined,
    contentHash: stringValue(record.contentHash),
    summary: stringValue(record.summary),
    diagnostic: objectRecord(record.diagnostic) as AgentStreamPartFrame['diagnostic'],
    resumeHandle: stringValue(record.resumeHandle),
    metadata: objectRecord(record.metadata),
  };
}

function stripProviderPartFrames(content: string): string {
  return content.replace(/<deepcode-part>[\s\S]*?<\/deepcode-part>/g, '').trim();
}

function isAgentStreamPartKind(value: string): value is AgentStreamPartFrame['partKind'] {
  return value === 'thinkingDelta'
    || value === 'codeBlockChunk'
    || value === 'actionDraftChunk'
    || value === 'fileDone'
    || value === 'batchDone'
    || value === 'diagnostic';
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}... [truncated]`;
}

function compactString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'resource';
}

function joinFsPath(root: string, child: string): string {
  const cleanRoot = root.replace(/\/+$/g, '');
  const cleanChild = child.replace(/^\/+/g, '');
  return `${cleanRoot}/${cleanChild}`;
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}
